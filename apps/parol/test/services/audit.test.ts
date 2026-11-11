import { afterAll, describe, expect, it, vi } from "vitest";
import { GLOBAL_ACTIONS, globalRoleAllows } from "../../src/auth/actions.js";
import type { AuditEvent } from "../../src/store/index.js";
import { AUDIT_BREAK_TEXT } from "../../src/store/index.js";
import { runRetention } from "../../src/retention/job.js";
import { ForbiddenError } from "../../src/services/errors.js";
import { readRetentionRun, type AuditPageView } from "../../src/services/audit.js";
import { dropAuditTriggers } from "../store/audit-tamper.js";
import { cleanup, makeWorld, newMatter, type World } from "./support.js";

/**
 * The service behind the audit log page (package W2.7, slice C): who may call it, what the view
 * holds for an intact log, a broken one, matters the events do not explain and a retention run, and
 * that nothing a row holds reaches the view unless it was checked against a closed list or a fixed
 * shape first. The log is the thing that may have been tampered with, so the tests tamper with it.
 */

afterAll(cleanup);

const MARK = "QZMARK-audit-page-91d3";

/** A world with `count` matters, made through the services, so that the log has real events. */
function worldWith(count: number, now?: () => Date): { w: World; ids: string[] } {
  const w = makeWorld(now === undefined ? {} : { now });
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push(newMatter(w, `Matter ${i} ${MARK}`).matterId);
  return { w, ids };
}

const view = (w: World): AuditPageView => w.services.audit.check(w.admin);

describe("who may check the log", () => {
  it("refuses everyone whose global role the table does not list, before it reads anything", () => {
    const { w } = worldWith(1);
    const reads = [
      vi.spyOn(w.repo, "checkAudit"),
      vi.spyOn(w.repo, "countAuditEvents"),
      vi.spyOn(w.repo, "listMatterIds"),
      vi.spyOn(w.repo, "listExpiredMatters"),
      vi.spyOn(w.repo, "latestAuditEvent"),
    ];
    for (const principal of [w.associate, w.reviewer, w.engineer]) {
      expect(() => w.services.audit.check(principal), principal.userId).toThrow(ForbiddenError);
    }
    for (const read of reads) expect(read).not.toHaveBeenCalled();
  });

  it("lets in the administrator, and only the roles GLOBAL_ACTIONS lists for audit.read", () => {
    const { w } = worldWith(1);
    expect(GLOBAL_ACTIONS["audit.read"]).toEqual(["admin"]);
    for (const principal of [w.associate, w.reviewer, w.engineer, w.admin]) {
      const allowed = globalRoleAllows(principal.globalRole, "audit.read");
      if (allowed) expect(() => w.services.audit.check(principal)).not.toThrow();
      else expect(() => w.services.audit.check(principal)).toThrow(ForbiddenError);
    }
    expect(view(w).chain.ok).toBe(true);
  });
});

describe("the view of an intact log", () => {
  it("counts the events, names the head, and accounts for every matter", () => {
    const { w } = worldWith(2);
    const v = view(w);
    const total = w.repo.countAuditEvents();
    const head = w.repo.auditHead()!;
    expect(total).toBeGreaterThanOrEqual(2);
    expect(v.eventsInLog).toBe(total);
    expect(v.chain).toEqual({ ok: true, events: total });
    expect(v.head).toEqual({ seq: head.seq, hash: head.hash });
    expect(v.head?.seq).toBe(total);
    expect(v.matters).toEqual({
      created: 2,
      present: 2,
      deleted: 0,
      goneWithoutDeleteEvent: { count: 0, ids: [] },
      presentWithoutCreateEvent: { count: 0, ids: [] },
      deletedButPresent: { count: 0, ids: [] },
    });
  });

  it("is made at the time the service is asked, and says so", () => {
    const { w } = worldWith(0);
    expect(view(w).checkedAt).toBe(w.deps.now().toISOString());
  });

  it("is the view of a log with no events when there are none", () => {
    const w = makeWorld();
    dropAuditTriggers(w.repo.db);
    w.repo.db.exec("DELETE FROM audit_events");
    w.repo.db.exec("DELETE FROM sqlite_sequence WHERE name = 'audit_events'");
    const v = view(w);
    expect(v.eventsInLog).toBe(0);
    expect(v.chain).toEqual({ ok: true, events: 0 });
    expect(v.head).toBeNull();
    expect(v.retention).toEqual({
      totalMatters: 0,
      pastDate: 0,
      lastRun: null,
      lastRunUnreadable: false,
    });
  });

  it("holds no name: a marker in a matter's name and client reaches nothing in the view", () => {
    const { w } = worldWith(2);
    const text = JSON.stringify(view(w));
    expect(text).not.toContain(MARK);
    expect(text).not.toContain("Lanternfish");
  });

  it("is stable: the same log gives the same view", () => {
    const { w } = worldWith(2);
    expect(view(w)).toEqual(view(w));
  });
});

describe("retention in the view", () => {
  it("counts the matters past their date against all of them, at the time of the check", () => {
    const early = worldWith(3);
    expect(view(early.w).retention).toMatchObject({ totalMatters: 3, pastDate: 0 });

    // The matters were made on 3 November 2026 with the default 30 days; the check is made later.
    const late = worldWith(3, () => new Date("2027-01-15T09:00:00.000Z"));
    expect(view(late.w).retention).toMatchObject({ totalMatters: 3, pastDate: 3 });
  });

  it("counts the boundary as past: a matter whose date is the moment of the check, and not one a millisecond before it", () => {
    let current = new Date("2026-11-04T09:00:00.000Z");
    const w = makeWorld({ now: () => current });
    const { matterId } = newMatter(w);
    const keptUntil = Date.parse(w.repo.getMatter(matterId)!.retainUntil);
    current = new Date(keptUntil - 1);
    expect(view(w).retention).toMatchObject({ totalMatters: 1, pastDate: 0 });
    current = new Date(keptUntil);
    expect(view(w).retention).toMatchObject({ totalMatters: 1, pastDate: 1 });
  });

  it("reports no run when the log has none", () => {
    const { w } = worldWith(1);
    expect(view(w).retention.lastRun).toBeNull();
    expect(view(w).retention.lastRunUnreadable).toBe(false);
  });

  it("reads the run the retention job wrote, and the newest of several", () => {
    const late = new Date("2027-01-15T09:00:00.000Z");
    const { w, ids } = worldWith(3, () => late);
    // A first run, judged at the moment of the check, deletes all three.
    const first = runRetention(
      { repo: w.repo, files: w.files, now: () => late },
      { apply: true, maxMatters: 25 },
    );
    expect(first.deleted).toBe(3);
    const afterFirst = view(w).retention.lastRun!;
    expect(afterFirst).toMatchObject({
      expired: first.expired,
      deleted: first.deleted,
      skipped: first.skipped,
      failed: first.failed,
      orphansRemoved: first.orphansRemoved,
      orphansFailed: first.orphansFailed,
      compaction: first.compaction,
      refused: false,
    });
    expect(afterFirst.at).toBe(w.repo.latestAuditEvent("retention.run")!.at);

    // A second run, with nothing to delete, is the newest.
    const second = runRetention(
      { repo: w.repo, files: w.files, now: () => late },
      { apply: true, maxMatters: 25 },
    );
    const latest = view(w).retention.lastRun!;
    expect(second.deleted).toBe(0);
    expect(latest.seq).toBeGreaterThan(afterFirst.seq);
    expect(latest).toMatchObject({ expired: 0, deleted: 0, skipped: 0, failed: 0 });
    // The matters of the first run are gone and have their deletion events: the log accounts for them.
    expect(view(w).matters).toMatchObject({
      created: ids.length,
      present: 0,
      deleted: ids.length,
      goneWithoutDeleteEvent: { count: 0 },
    });
    expect(view(w).retention.totalMatters).toBe(0);
  });

  it("reads a run that refused: more matters past their date than its limit", () => {
    const late = new Date("2027-01-15T09:00:00.000Z");
    const { w } = worldWith(3, () => late);
    runRetention({ repo: w.repo, files: w.files, now: () => late }, { apply: true, maxMatters: 2 });
    const run = view(w).retention.lastRun!;
    expect(run).toMatchObject({ expired: 3, deleted: 0, refused: true, compaction: "not_run" });
    expect(view(w).retention).toMatchObject({ totalMatters: 3, pastDate: 3 });
  });

  it("does not show a dry run: only an apply is a run", () => {
    const late = new Date("2027-01-15T09:00:00.000Z");
    const { w } = worldWith(2, () => late);
    runRetention(
      { repo: w.repo, files: w.files, now: () => late },
      { apply: false, maxMatters: 25 },
    );
    expect(view(w).retention.lastRun).toBeNull();
  });
});

describe("the view of a log that has been tampered with", () => {
  /** Changes the actor of event `seq` by SQL, as someone who can write the file would. */
  function alter(w: World, seq: number, column: string, value: string): void {
    dropAuditTriggers(w.repo.db);
    w.repo.db.prepare(`UPDATE audit_events SET ${column} = ? WHERE seq = ?`).run(value, seq);
  }

  it("says where the chain breaks, why, and how many events check out out of how many there are", () => {
    const { w } = worldWith(3);
    const total = w.repo.countAuditEvents();
    alter(w, 2, "actor_id", `usr_${MARK}`);
    const v = view(w);
    expect(v.chain).toEqual({
      ok: false,
      events: 1,
      firstBrokenSeq: 2,
      reason: "hash_mismatch",
      reasonText: AUDIT_BREAK_TEXT.hash_mismatch,
    });
    expect(v.eventsInLog).toBe(total);
    expect(v.eventsInLog).toBeGreaterThan(v.chain.events);
  });

  it("holds none of the altered row", () => {
    const { w } = worldWith(3);
    alter(w, 2, "actor_id", `usr_${MARK}`);
    alter(w, 2, "target_id", `${MARK}-target`);
    alter(w, 3, "detail_json", `{"note":"${MARK}"}`);
    expect(JSON.stringify(view(w))).not.toContain(MARK);
  });

  it("reports a log cut back as missing its newest events", () => {
    const { w } = worldWith(3);
    const head = w.repo.auditHead()!;
    dropAuditTriggers(w.repo.db);
    w.repo.db.prepare("DELETE FROM audit_events WHERE seq = ?").run(head.seq);
    const v = view(w);
    expect(v.chain).toMatchObject({ ok: false, reason: "truncated", firstBrokenSeq: head.seq });
    expect(v.eventsInLog).toBe(head.seq - 1);
  });

  it("shows no head hash that is not a hash", () => {
    const { w } = worldWith(2);
    const head = w.repo.auditHead()!;
    alter(w, head.seq, "hash", `<b>${MARK}</b>`);
    const v = view(w);
    expect(v.head).toEqual({ seq: head.seq, hash: null });
    expect(JSON.stringify(v)).not.toContain(MARK);
    expect(v.chain.ok).toBe(false);
  });

  it("lists a matter gone with no deletion event, by its id, and counts it against those created", () => {
    const { w, ids } = worldWith(3);
    w.repo.db.prepare("DELETE FROM matters WHERE id = ?").run(ids[1]!);
    const v = view(w);
    expect(v.chain.ok).toBe(true);
    expect(v.matters.created).toBe(3);
    expect(v.matters.present).toBe(2);
    expect(v.matters.goneWithoutDeleteEvent).toEqual({ count: 1, ids: [ids[1]] });
    expect(v.matters.deleted).toBe(0);
  });

  it("lists a deletion event whose matter is still there", () => {
    const { w, ids } = worldWith(2);
    w.repo.appendAudit({
      actorId: null,
      matterId: ids[0]!,
      action: "matter.delete",
      targetType: "matter",
      targetId: ids[0]!,
      detail: {},
    });
    const v = view(w);
    expect(v.matters.deletedButPresent).toEqual({ count: 1, ids: [ids[0]] });
    expect(v.matters.goneWithoutDeleteEvent.count).toBe(0);
  });

  it("lists at most twenty ids and keeps the exact count", () => {
    const { w } = worldWith(23);
    w.repo.db.exec("DELETE FROM matters");
    const gone = view(w).matters.goneWithoutDeleteEvent;
    expect(gone.count).toBe(23);
    expect(gone.ids).toHaveLength(20);
  });

  it("counts an id that is not a matter id and does not list it", () => {
    const { w, ids } = worldWith(2);
    // The creation event of the first matter now names something that is not a matter id.
    const create = w.repo.db
      .prepare("SELECT seq FROM audit_events WHERE action = 'matter.create' AND matter_id = ?")
      .get(ids[0]!) as { seq: number };
    alter(w, create.seq, "matter_id", `<b>${MARK}</b>`);
    const v = view(w);
    // The hostile id is a created matter that is not present; the real one is present with no creation event.
    expect(v.matters.goneWithoutDeleteEvent.count).toBe(1);
    expect(v.matters.goneWithoutDeleteEvent.ids).toEqual([]);
    expect(v.matters.presentWithoutCreateEvent).toEqual({ count: 1, ids: [ids[0]] });
    expect(JSON.stringify(v)).not.toContain(MARK);
  });

  it("reports a retention run whose detail is not what the job writes as unreadable, and shows none of it", () => {
    const { w } = worldWith(1);
    w.repo.appendAudit({
      actorId: null,
      matterId: null,
      action: "retention.run",
      targetType: "retention",
      targetId: "retention",
      detail: { mode: "apply", expired: 1, deleted: 1, compaction: MARK },
    });
    const v = view(w);
    expect(v.retention.lastRun).toBeNull();
    expect(v.retention.lastRunUnreadable).toBe(true);
    expect(JSON.stringify(v)).not.toContain(MARK);
  });

  it("reports a retention run whose detail is not even JSON as unreadable, and does not fail", () => {
    const { w } = worldWith(1);
    w.repo.appendAudit({
      actorId: null,
      matterId: null,
      action: "retention.run",
      targetType: "retention",
      targetId: "retention",
      detail: { mode: "apply" },
    });
    const seq = w.repo.auditHead()!.seq;
    alter(w, seq, "detail_json", `not json ${MARK}`);
    const v = view(w);
    expect(v.retention.lastRunUnreadable).toBe(true);
    expect(v.chain).toMatchObject({ ok: false, firstBrokenSeq: seq });
    expect(JSON.stringify(v)).not.toContain(MARK);
  });
});

describe("reading a retention run out of an event", () => {
  const GOOD = {
    mode: "apply",
    at: "2027-01-15T09:00:00.000Z",
    expired: 4,
    deleted: 3,
    skipped: 1,
    failed: 0,
    orphansRemoved: 2,
    orphansFailed: 1,
    compaction: "done",
    refused: false,
  };
  const event = (detail: Record<string, unknown>, at = "2027-01-15T09:00:01.000Z"): AuditEvent =>
    ({
      seq: 9,
      at,
      actorId: null,
      matterId: null,
      action: "retention.run",
      targetType: "retention",
      targetId: "retention",
      detail,
      prevHash: "0".repeat(64),
      hash: "1".repeat(64),
    }) as AuditEvent;

  it("reads exactly what the job writes, with the time of the event and not the time it judged at", () => {
    expect(readRetentionRun(event(GOOD))).toEqual({
      seq: 9,
      at: "2027-01-15T09:00:01.000Z",
      expired: 4,
      deleted: 3,
      skipped: 1,
      failed: 0,
      orphansRemoved: 2,
      orphansFailed: 1,
      compaction: "done",
      refused: false,
    });
  });

  it("takes a run written before the job counted folders it could not remove as having none", () => {
    const { orphansFailed: _omitted, ...older } = GOOD;
    void _omitted;
    expect(readRetentionRun(event(older))?.orphansFailed).toBe(0);
  });

  it("accepts each of the four words for the compaction and no other", () => {
    for (const word of ["done", "not_needed", "failed", "not_run"])
      expect(readRetentionRun(event({ ...GOOD, compaction: word }))?.compaction).toBe(word);
    for (const word of ["Done", "ok", "", MARK, "constructor"])
      expect(readRetentionRun(event({ ...GOOD, compaction: word })), word).toBeNull();
  });

  const BAD: [string, Record<string, unknown>][] = [
    ["a dry run", { ...GOOD, mode: "dry_run" }],
    ["no mode", { ...GOOD, mode: undefined }],
    ["a negative count", { ...GOOD, deleted: -1 }],
    ["a fractional count", { ...GOOD, skipped: 0.5 }],
    ["a count as text", { ...GOOD, failed: "0" }],
    ["a count past the safe integers", { ...GOOD, expired: 2 ** 60 }],
    ["a missing count", { ...GOOD, expired: undefined }],
    ["a flag as text", { ...GOOD, refused: "false" }],
    ["a missing flag", { ...GOOD, refused: undefined }],
    ["a folder count as text", { ...GOOD, orphansFailed: "1" }],
  ];
  for (const [name, detail] of BAD)
    it(`reads ${name} as no run`, () => {
      expect(readRetentionRun(event(detail))).toBeNull();
    });

  it("reads an event whose own time is not an ISO time as no run", () => {
    expect(readRetentionRun(event(GOOD, "last Tuesday"))).toBeNull();
    expect(readRetentionRun(event(GOOD, "2027-01-15"))).toBeNull();
    expect(readRetentionRun(event(GOOD, `2027-01-15T09:00:00.000Z ${MARK}`))).toBeNull();
  });
});
