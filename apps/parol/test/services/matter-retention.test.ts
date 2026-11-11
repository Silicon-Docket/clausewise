import { afterAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "../../src/services/errors.js";
import {
  DEFAULT_RETAIN_DAYS,
  MAX_RETAIN_DAYS,
  ValidationError,
  type MatterRow,
} from "../../src/store/index.js";
import {
  cleanup,
  decideAll,
  gate,
  makeWorld,
  newMatter,
  uploadCase,
  type World,
} from "./support.js";

/**
 * How long a matter is kept, as the matter service shows it and changes it (package W2.7, slice B).
 * The store's own rules for the date (the range, the trigger, the audit event) are tested in
 * test/store/retention.test.ts; what is under test here is what the service adds to them: the clock
 * it judges "past" by, the days left it states, who may change the date, and that changing it leaves
 * the review alone.
 */

afterAll(cleanup);

const DAY = 86_400_000;

/** A world whose services read the clock this test moves; the store keeps its own. */
function worldAt(start: string): { w: World; setClock(at: string): void } {
  let at = new Date(start);
  const w = makeWorld({ now: () => new Date(at) });
  return {
    w,
    setClock: (next) => {
      at = new Date(next);
    },
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

describe("the retention date in the view of a matter and in the list", () => {
  it("states the whole days left, rounded up, and the store's own default and ceiling", () => {
    const { w, setClock } = worldAt("2026-11-04T09:00:00.000Z");
    const { matterId, am } = newMatter(w);
    const until = Date.parse(w.repo.getMatter(matterId)!.retainUntil);

    for (const [now, daysLeft] of [
      [until - 3 * DAY - 1000, 4],
      [until - 3 * DAY, 3],
      [until - 3 * DAY + 1000, 3],
      [until - DAY, 1],
      [until - 1000, 1],
    ] as const) {
      setClock(iso(now));
      const retention = w.services.matters.view(am).retention;
      expect(retention, iso(now)).toEqual({
        retainUntil: iso(until),
        daysLeft,
        pastDate: false,
        defaultDays: DEFAULT_RETAIN_DAYS,
        maxDays: MAX_RETAIN_DAYS,
      });
    }
  });

  it("counts the boundary as passed, as the store's own query does, and then says no days are left", () => {
    const { w, setClock } = worldAt("2026-11-04T09:00:00.000Z");
    const { matterId, am } = newMatter(w);
    const until = Date.parse(w.repo.getMatter(matterId)!.retainUntil);

    for (const now of [until, until + 1, until + 40 * DAY]) {
      setClock(iso(now));
      const view = w.services.matters.view(am);
      expect(view.retention, iso(now)).toMatchObject({ pastDate: true, daysLeft: 0 });
      expect(view.matter.pastRetention, iso(now)).toBe(true);
      expect(w.services.matters.list(w.associate).map((m) => m.pastRetention)).toEqual([true]);
      // The service and the store agree on which matters are expired at that instant.
      expect(w.repo.listExpiredMatters(iso(now)).map((m: MatterRow) => m.id)).toEqual([matterId]);
    }
    setClock(iso(until - 1));
    expect(w.services.matters.view(am).matter.pastRetention).toBe(false);
    expect(w.repo.listExpiredMatters(iso(until - 1))).toEqual([]);
  });

  it("marks each matter of the list by its own date", () => {
    const { w, setClock } = worldAt("2026-11-04T09:00:00.000Z");
    const short = newMatter(w, "short");
    const long = newMatter(w, "long");
    w.repo.setRetention(short.matterId, 2, { actorId: w.associate.userId });
    w.repo.setRetention(long.matterId, 60, { actorId: w.associate.userId });
    setClock("2026-11-30T00:00:00.000Z");
    const past = Object.fromEntries(
      w.services.matters.list(w.associate).map((m) => [m.name, m.pastRetention]),
    );
    // The store's clock started on 3 November, so the short date is a few seconds after 5 November.
    expect(past).toEqual({ short: true, long: false });
  });

  it("is filled for a reviewer too, who is shown the date and not the form", () => {
    const { w } = worldAt("2026-11-04T09:00:00.000Z");
    const { matterId } = newMatter(w);
    const view = w.services.matters.view(w.grant(w.reviewer, matterId));
    expect(view.retention?.retainUntil).toBe(w.repo.getMatter(matterId)!.retainUntil);
    expect(view.matter.role).toBe("reviewer");
  });
});

describe("a matter made with a number of days to keep it", () => {
  it("keeps it for that many days from its creation, and for 30 when none is given", () => {
    const w = makeWorld();
    const make = (extra: { retainDays?: number }) =>
      w.services.matters.create(w.associate, {
        name: "kept",
        clientLegalName: "Lanternfish Software, Inc.",
        playbookVersionId: null,
        reviewerUserId: null,
        ...extra,
      });
    for (const days of [1, 7, 45, MAX_RETAIN_DAYS]) {
      const created = make({ retainDays: days });
      expect(Date.parse(created.retainUntil) - Date.parse(created.createdAt), `${days}`).toBe(
        days * DAY,
      );
    }
    const defaulted = make({});
    expect(Date.parse(defaulted.retainUntil) - Date.parse(defaulted.createdAt)).toBe(
      DEFAULT_RETAIN_DAYS * DAY,
    );
    expect(DEFAULT_RETAIN_DAYS).toBe(30);
  });

  it("is refused for 0, 91 and a fraction with the retention code, and no matter is made", () => {
    const w = makeWorld();
    const before = w.services.matters.list(w.associate).length;
    for (const retainDays of [0, -3, MAX_RETAIN_DAYS + 1, 1.5, Number.NaN]) {
      let error: unknown;
      try {
        w.services.matters.create(w.associate, {
          name: "refused",
          clientLegalName: "Lanternfish Software, Inc.",
          playbookVersionId: null,
          reviewerUserId: null,
          retainDays,
        });
      } catch (e) {
        error = e;
      }
      expect(error, String(retainDays)).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe("retention_days");
    }
    expect(w.services.matters.list(w.associate)).toHaveLength(before);
  });
});

describe("changing the date", () => {
  it("is the associate's: it moves the date, records one event and returns the view with the new date", () => {
    const { w } = worldAt("2026-11-04T09:00:00.000Z");
    const { matterId, am } = newMatter(w);
    const first = w.repo.getMatter(matterId)!.retainUntil;

    const view = w.services.matters.setRetention(am, 60);

    const now = w.repo.getMatter(matterId)!.retainUntil;
    expect(now).not.toBe(first);
    expect(view.retention?.retainUntil).toBe(now);
    expect(view.matter.retainUntil).toBe(now);
    const events = w.repo.listAuditEvents({ matterId, action: "matter.retention" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorId: w.associate.userId,
      detail: { from: first, to: now, days: 60 },
    });
    // The store's clock started on 3 November: 60 days from then, within the minutes the test took.
    const from = Date.parse("2026-11-03T09:00:00.000Z") + 60 * DAY;
    expect(Date.parse(now)).toBeGreaterThan(from);
    expect(Date.parse(now)).toBeLessThan(from + 10 * 60_000);
  });

  it("is not a reviewer's or a viewer's: they are forbidden and nothing changes", () => {
    const { w } = worldAt("2026-11-04T09:00:00.000Z");
    const { matterId } = newMatter(w);
    w.repo.addMember(matterId, w.admin.userId, "viewer", { actorId: w.associate.userId });
    const before = w.repo.getMatter(matterId)!.retainUntil;
    const audit = w.repo.listAuditEvents({ matterId }).length;
    for (const person of [w.reviewer, w.admin]) {
      expect(() => w.services.matters.setRetention(w.grant(person, matterId), 45)).toThrow(
        ForbiddenError,
      );
    }
    expect(w.repo.getMatter(matterId)!.retainUntil).toBe(before);
    expect(w.repo.listAuditEvents({ matterId })).toHaveLength(audit);
  });

  it("refuses a number the store refuses, with the store's code, and changes nothing", () => {
    const { w } = worldAt("2026-11-04T09:00:00.000Z");
    const { matterId, am } = newMatter(w);
    const before = w.repo.getMatter(matterId)!.retainUntil;
    for (const days of [0, MAX_RETAIN_DAYS + 1, 2.5]) {
      let error: unknown;
      try {
        w.services.matters.setRetention(am, days);
      } catch (e) {
        error = e;
      }
      expect((error as ValidationError).code, String(days)).toBe("retention_days");
    }
    expect(w.repo.getMatter(matterId)!.retainUntil).toBe(before);
  });

  it("clears the sign of a matter that is past its date when the new date is ahead of the clock", () => {
    const { w, setClock } = worldAt("2026-11-04T09:00:00.000Z");
    const { matterId, am } = newMatter(w);
    const until = Date.parse(w.repo.getMatter(matterId)!.retainUntil);
    setClock(iso(until + 2 * DAY));
    expect(w.services.matters.view(am).matter.pastRetention).toBe(true);

    const view = w.services.matters.setRetention(am, 45);

    // The store counts from its own clock, which still reads November: 45 days from then is
    // ahead of the service's clock, so the matter is no longer past.
    expect(view.matter.pastRetention).toBe(false);
    expect(view.retention?.pastDate).toBe(false);
    expect(w.services.matters.list(w.associate).map((m) => m.pastRetention)).toEqual([false]);
  });

  it("leaves everything the review rests on as it was: findings, decisions, the memo and the run", async () => {
    const { w } = worldAt("2026-11-04T09:00:00.000Z");
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, { workflowLabel: "v2" });
    await w.services.runs.idle();
    const reviewerAm = w.grant(w.reviewer, matterId);
    decideAll(w, reviewerAm, w.services.runs.issues(am, run.id));
    await w.services.reviews.exportMemo(reviewerAm);

    const rowsOf = (table: string): unknown[] =>
      w.repo.db.prepare(`SELECT * FROM ${table} WHERE matter_id = ?`).all(matterId);
    // The annotations hang from the spans of the matter and carry no matter id of their own.
    const annotations = (): unknown[] =>
      w.repo.db
        .prepare(
          `SELECT a.* FROM span_annotations a JOIN source_spans s ON s.id = a.span_id
            WHERE s.matter_id = ? ORDER BY a.span_id, a.kind, a.value`,
        )
        .all(matterId);
    const snapshot = (): string =>
      JSON.stringify({
        matter: { ...w.repo.getMatter(matterId), retainUntil: "-" },
        annotations: annotations(),
        ...Object.fromEntries(
          ["runs", "findings", "reviews", "memos", "source_spans", "documents"].map((t) => [
            t,
            rowsOf(t),
          ]),
        ),
      });
    const before = snapshot();
    expect(w.repo.getMatter(matterId)?.status).toBe("exported");

    w.services.matters.setRetention(am, 45);

    expect(snapshot()).toBe(before);
    expect(w.repo.getMatter(matterId)?.status).toBe("exported");
    const view = w.services.matters.view(am);
    expect(view.currentRun?.id).toBe(run.id);
    expect(view.memos.map((m) => m.status)).toEqual(["current"]);
  });

  it("does not stop a review that is running", async () => {
    const held = gate();
    const w = makeWorld({ model: { before: () => held.pass() } });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, { workflowLabel: "v2" });
    await held.reached(1);

    const view = w.services.matters.setRetention(am, 45);

    expect(view.activeRun?.id).toBe(run.id);
    expect(w.repo.getRun(matterId, run.id)?.status).not.toBe("superseded");
    held.open();
    await w.services.runs.idle();
    expect(w.repo.getRun(matterId, run.id)?.status).toBe("succeeded");
    expect(w.services.matters.view(am).currentRun?.id).toBe(run.id);
  });
});
