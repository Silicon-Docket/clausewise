import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { render } from "../../src/server/pages/index.js";
import { RetentionSection } from "../../src/server/pages/retention.js";
import { formatDateTime } from "../../src/server/views/format.js";
import {
  DEFAULT_MAX_MATTERS_PER_RUN,
  RetentionUsageError,
  runRetention,
  type RetentionDeps,
} from "../../src/retention/job.js";
import {
  ConflictError,
  FileStore,
  createRepository,
  openDatabase,
  openDatabaseReadOnly,
  type Repository,
} from "../../src/store/index.js";
import { censusOf } from "../store/trace-scan.js";
import { buildChrome } from "../pages/support.js";
import { cleanup, gate, makeWorld, uploadCase, type World } from "../services/support.js";

/**
 * The retention job against a real database file and a real file store in a temporary folder,
 * with the real services making the matters. The job is run in this process; the command around
 * it is tested in cli.test.ts. The clock is injected: a matter's retention date is set with
 * `setRetention` (days from the world's own clock, which starts on 3 November 2026), and the job
 * judges expiry at `LATER`.
 */

afterAll(cleanup);

const NAME_MARK = "QZNAME-7d41";
const CLIENT_MARK = "QZCLIENT-5e92";

/** Long after the one-day matters of these tests are due, and before the ninety-day ones are. */
const LATER = new Date("2026-11-10T00:00:00.000Z");
const clock =
  (at: Date = LATER) =>
  (): Date =>
    at;

/** A matter of the world with the case's documents uploaded, due in `days` days. */
async function matter(w: World, label: string, days: number): Promise<string> {
  const created = w.services.matters.create(w.associate, {
    name: `Matter ${label} ${NAME_MARK}`,
    clientLegalName: `Client ${label} ${CLIENT_MARK}, Inc.`,
    playbookVersionId: w.playbookVersionId,
    reviewerUserId: w.reviewer.userId,
  });
  await uploadCase(w, created.id);
  w.repo.setRetention(created.id, days, { actorId: w.associate.userId });
  return created.id;
}

const deps = (w: World, at: Date = LATER): RetentionDeps => ({
  repo: w.repo,
  files: w.files,
  now: clock(at),
});

const apply = (maxMatters = DEFAULT_MAX_MATTERS_PER_RUN) => ({ apply: true, maxMatters });
const dryRun = (extra: { asOf?: Date } = {}) => ({
  apply: false,
  maxMatters: DEFAULT_MAX_MATTERS_PER_RUN,
  ...extra,
});

const retentionRuns = (w: World) => w.repo.listAuditEvents({ action: "retention.run" });
const deletions = (w: World) => w.repo.listAuditEvents({ action: "matter.delete" });
const exists = (w: World, id: string): boolean => w.repo.getMatter(id) !== undefined;

/** Path and SHA-256 of every file under a folder, for a before and after. */
function filesUnder(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[relative(dir, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return out;
}

/** The dry run as the command does it: through a handle that cannot write, in what is a separate process in production. */
function readOnly(world: World) {
  const db = openDatabaseReadOnly(join(world.root, "parol.sqlite"));
  const repo = createRepository(db);
  const files = new FileStore(world.files.root);
  return { db, repo, files };
}

const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("a dry run", () => {
  it("changes nothing: no row, no file, no event, and not a byte of the database file", async () => {
    const w = makeWorld({ onDisk: true });
    const due = await matter(w, "due", 1);
    await matter(w, "fresh", 90);
    const database = join(w.root, "parol.sqlite");
    const census = censusOf(w.repo.db);
    const head = w.repo.auditHead();
    const files = filesUnder(w.files.root);
    // Closed here and opened read only: a write by the job would be refused by the handle, not
    // merely missed by the comparison below.
    w.repo.db.close();
    const before = sha(database);
    const { db, repo } = readOnly(w);

    const report = runRetention(
      { repo, files: new FileStore(w.files.root), now: clock() },
      dryRun(),
    );

    expect(report).toMatchObject({
      mode: "dry_run",
      compaction: "not_run",
      totalMatters: 2,
      expired: 1,
      deleted: 0,
      skipped: 0,
      failed: 0,
      refusedByLimit: false,
    });
    expect(report.lines).toHaveLength(1);
    expect(report.lines[0]).toMatchObject({ matterId: due, outcome: "would_delete" });
    expect(report.chain.ok).toBe(true);

    expect(filesUnder(w.files.root)).toEqual(files);
    expect(repo.auditHead()).toEqual(head);
    expect(censusOf(db)).toEqual(census);
    db.close();
    expect(sha(database)).toBe(before);
    // Nothing but SQLite's own sidecars of a read-only open was added to the folder.
    expect(readdirSync(w.root).filter((name) => !name.startsWith("parol.sqlite"))).toEqual([
      "matters",
    ]);
    // The report names ids, not people's words.
    expect(JSON.stringify(report)).not.toContain(NAME_MARK);
    expect(JSON.stringify(report)).not.toContain(CLIENT_MARK);
  });

  it("says that a matter with a run in flight would be skipped, beside the run, and still changes nothing", async () => {
    const hold = gate();
    const w = makeWorld({
      onDisk: true,
      model: {
        before: async (call) => {
          if (call.kind === "analyze") await hold.pass();
        },
      },
    });
    const busy = await matter(w, "busy", 1);
    const due = await matter(w, "due", 1);
    w.services.runs.start(w.grant(w.associate, busy), { workflowLabel: "v2" });
    await hold.reached(1);
    const census = censusOf(w.repo.db);
    const head = w.repo.auditHead();

    const { db, repo } = readOnly(w);
    const report = runRetention(
      { repo, files: new FileStore(w.files.root), now: clock() },
      dryRun(),
    );

    expect(report).toMatchObject({ expired: 2, deleted: 0, skipped: 0 });
    // In the order of their dates: the busy one was made, and given its date, first.
    expect(report.lines.map((l) => [l.matterId, l.outcome, l.reason])).toEqual([
      [busy, "would_skip", "run_in_flight"],
      [due, "would_delete", undefined],
    ]);
    expect(censusOf(db)).toEqual(census);
    expect(repo.auditHead()).toEqual(head);
    db.close();
    hold.open();
    await w.services.runs.idle();
  });

  it("judges at the time it is given, and the boundary counts as expired", async () => {
    const w = makeWorld({ onDisk: true });
    const id = await matter(w, "edge", 2);
    const due = Date.parse(w.repo.getMatter(id)!.retainUntil);
    const judged = (at: number) => runRetention(deps(w), dryRun({ asOf: new Date(at) })).expired;
    expect(judged(due - 1)).toBe(0);
    expect(judged(due)).toBe(1);
    expect(judged(due + 1)).toBe(1);
  });

  it("is refused an apply with a time of its own, and an apply that cannot delete", () => {
    const w = makeWorld({ onDisk: true });
    expect(() => runRetention(deps(w), { apply: true, maxMatters: 5, asOf: LATER })).toThrow(
      RetentionUsageError,
    );
    expect(() => runRetention({ ...deps(w), files: { listMatterIds: () => [] } }, apply())).toThrow(
      RetentionUsageError,
    );
    for (const maxMatters of [0, 1001, 1.5, Number.NaN])
      expect(() => runRetention(deps(w), { apply: false, maxMatters }), String(maxMatters)).toThrow(
        RetentionUsageError,
      );
  });
});

describe("apply", () => {
  it("deletes exactly the matters that are past their date, and leaves the others whole", async () => {
    const w = makeWorld({ onDisk: true });
    const first = await matter(w, "first", 1);
    const keep = await matter(w, "keep", 90);
    const second = await matter(w, "second", 2);
    const dueFirst = w.repo.getMatter(first)!.retainUntil;
    const dueSecond = w.repo.getMatter(second)!.retainUntil;
    const keptFiles = w.repo.listVersions(keep).map((v) => v.storagePath);

    const report = runRetention(deps(w), apply());

    expect(report).toMatchObject({
      mode: "apply",
      totalMatters: 3,
      expired: 2,
      deleted: 2,
      skipped: 0,
      failed: 0,
      refusedByLimit: false,
      compaction: "done",
    });
    expect(report.at).toBe(LATER.toISOString());
    // In the order of their dates, with the rows and the files that went.
    expect(report.lines.map((l) => [l.matterId, l.outcome])).toEqual([
      [first, "deleted"],
      [second, "deleted"],
    ]);
    for (const line of report.lines) {
      expect(line.rows).toBeGreaterThan(10);
      expect(line.filesRemoved).toBe(2);
    }
    expect(report.chain).toMatchObject({ ok: true });

    expect(exists(w, first)).toBe(false);
    expect(exists(w, second)).toBe(false);
    expect(existsSync(join(w.files.root, first))).toBe(false);
    expect(existsSync(join(w.files.root, second))).toBe(false);
    // The matter that is not due is whole: its record, its people, its files.
    expect(exists(w, keep)).toBe(true);
    expect(w.services.matters.view(w.grant(w.associate, keep)).documents).toHaveLength(2);
    for (const path of keptFiles) expect(w.files.exists(path)).toBe(true);

    // One deletion event each: by nobody (the system), by retention, with the date that was in force.
    const events = deletions(w);
    expect(events.map((e) => [e.matterId, e.actorId])).toEqual([
      [first, null],
      [second, null],
    ]);
    expect(events.map((e) => e.detail["reason"])).toEqual(["retention", "retention"]);
    expect(events.map((e) => e.detail["retainUntil"])).toEqual([dueFirst, dueSecond]);
    // And one event for the run, with its totals.
    const runs = retentionRuns(w);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ actorId: null, matterId: null, targetType: "retention" });
    expect(runs[0]!.detail).toEqual({
      mode: "apply",
      at: LATER.toISOString(),
      expired: 2,
      deleted: 2,
      skipped: 0,
      failed: 0,
      orphansRemoved: 0,
      orphansFailed: 0,
      compaction: "done",
      refused: false,
    });
    expect(w.repo.verifyAuditChain().ok).toBe(true);
    // The words of the matters are in none of the events, and not in the report.
    for (const text of [
      JSON.stringify(w.repo.listAuditEvents({ limit: 10_000 })),
      JSON.stringify(report),
    ]) {
      expect(text).not.toContain(NAME_MARK);
      expect(text).not.toContain(CLIENT_MARK);
    }
  });

  it("deletes a matter whose date is the judged time, and not one a millisecond later", async () => {
    const w = makeWorld({ onDisk: true });
    const id = await matter(w, "edge", 2);
    const due = Date.parse(w.repo.getMatter(id)!.retainUntil);

    const early = runRetention(deps(w, new Date(due - 1)), apply());
    expect(early).toMatchObject({ expired: 0, deleted: 0 });
    expect(exists(w, id)).toBe(true);

    const exact = runRetention(deps(w, new Date(due)), apply());
    expect(exact).toMatchObject({ expired: 1, deleted: 1 });
    expect(exists(w, id)).toBe(false);
  });

  it("skips a matter with a run in flight, says so, and deletes it on the next run once the run is cancelled", async () => {
    const hold = gate();
    const w = makeWorld({
      onDisk: true,
      model: {
        before: async (call) => {
          if (call.kind === "analyze") await hold.pass();
        },
      },
    });
    const busy = await matter(w, "busy", 1);
    const idle = await matter(w, "idle", 1);
    const am = w.grant(w.associate, busy);
    const run = w.services.runs.start(am, { workflowLabel: "v2" });
    await hold.reached(1);

    const first = runRetention(deps(w), apply());
    expect(first).toMatchObject({ expired: 2, deleted: 1, skipped: 1, failed: 0 });
    const skipped = first.lines.find((l) => l.matterId === busy)!;
    expect(skipped).toMatchObject({ outcome: "skipped", reason: "run_in_flight" });
    expect(skipped.rows).toBeUndefined();
    // The other one went; the busy one is untouched, run and all.
    expect(exists(w, idle)).toBe(false);
    expect(exists(w, busy)).toBe(true);
    expect(w.services.runs.get(am, run.id).status).not.toBe("cancelled");
    expect(w.repo.listAuditEvents({ matterId: busy, action: "matter.delete" })).toEqual([]);

    w.services.runs.cancel(am, run.id);
    hold.open();
    await w.services.runs.idle();
    const second = runRetention(deps(w), apply());
    expect(second).toMatchObject({ expired: 1, deleted: 1, skipped: 0 });
    expect(exists(w, busy)).toBe(false);
    expect(existsSync(join(w.files.root, busy))).toBe(false);
  });

  it("counts a run that started after the check as skipped, not failed", async () => {
    const w = makeWorld({ onDisk: true });
    const id = await matter(w, "race", 1);
    let refused = 0;
    const racing = {
      ...w.repo,
      deleteMatter: () => {
        refused += 1;
        throw new ConflictError(
          "matter_running",
          "the matter has a run in flight; cancel it first",
        );
      },
    } as unknown as Repository;
    const report = runRetention({ ...deps(w), repo: racing }, apply());
    expect(refused).toBe(1);
    expect(report).toMatchObject({ expired: 1, deleted: 0, skipped: 1, failed: 0 });
    expect(report.lines[0]).toMatchObject({
      matterId: id,
      outcome: "skipped",
      reason: "run_in_flight",
    });
    expect(exists(w, id)).toBe(true);
  });

  it("deletes nothing when more matters are past their date than it may delete, and says so", async () => {
    const w = makeWorld({ onDisk: true });
    const ids = [await matter(w, "a", 1), await matter(w, "b", 1), await matter(w, "c", 1)];
    const head = w.repo.auditHead()!.seq;

    const report = runRetention(deps(w), apply(2));

    expect(report).toMatchObject({
      expired: 3,
      deleted: 0,
      skipped: 0,
      failed: 0,
      refusedByLimit: true,
      compaction: "not_run",
    });
    expect(report.lines.map((l) => l.outcome)).toEqual([
      "would_delete",
      "would_delete",
      "would_delete",
    ]);
    for (const id of ids) expect(exists(w, id)).toBe(true);
    expect(deletions(w)).toEqual([]);
    // The run is on record all the same, and says it refused.
    expect(w.repo.auditHead()!.seq).toBe(head + 1);
    expect(retentionRuns(w)[0]!.detail).toMatchObject({ expired: 3, deleted: 0, refused: true });

    // At the limit it goes ahead.
    expect(runRetention(deps(w), apply(3))).toMatchObject({ deleted: 3, refusedByLimit: false });
  });

  it("goes on after one matter fails, and removes the folder that could not be removed on the next run", async () => {
    const w = makeWorld({ onDisk: true });
    const good = await matter(w, "good", 1);
    const bad = await matter(w, "bad", 1);
    const real = w.files;
    let blocked = true;
    const files: RetentionDeps["files"] = {
      listMatterIds: () => real.listMatterIds(),
      deleteMatter: (id) => {
        if (blocked && id === bad) throw new Error("the disk is full of cats");
        return real.deleteMatter(id);
      },
      sweepOrphans: (known) => {
        if (blocked) throw new Error("still full of cats");
        return real.sweepOrphans(known);
      },
    };

    const first = runRetention({ ...deps(w), files }, apply());
    expect(first).toMatchObject({
      expired: 2,
      deleted: 1,
      failed: 1,
      orphansFailed: 1,
      orphansRemoved: 0,
    });
    expect(first.lines.find((l) => l.matterId === good)!.outcome).toBe("deleted");
    const failure = first.lines.find((l) => l.matterId === bad)!;
    // An error class, never its message.
    expect(failure).toMatchObject({ outcome: "failed", failure: "files_not_removed" });
    expect(JSON.stringify(first)).not.toContain("cats");
    // Its rows are gone, its folder is not, and the other matter went all the way.
    expect(exists(w, bad)).toBe(false);
    expect(existsSync(join(w.files.root, bad))).toBe(true);
    expect(existsSync(join(w.files.root, good))).toBe(false);
    expect(first.orphanFolders).toEqual([bad]);

    blocked = false;
    const second = runRetention({ ...deps(w), files }, apply());
    expect(second).toMatchObject({
      expired: 0,
      deleted: 0,
      orphansRemoved: 1,
      orphansFailed: 0,
      compaction: "done",
    });
    expect(existsSync(join(w.files.root, bad))).toBe(false);
  });

  it("reports a matter the store refused as an error class, and goes on", async () => {
    const w = makeWorld({ onDisk: true });
    const refused = await matter(w, "refused", 1);
    const fine = await matter(w, "fine", 1);
    // A table the deletion was not taught about makes the store roll that matter back.
    w.repo.db.exec("CREATE TABLE zz_extra (matter_id TEXT)");
    w.repo.db.prepare("INSERT INTO zz_extra (matter_id) VALUES (?)").run(refused);
    const report = runRetention(deps(w), apply());
    expect(report.lines.find((l) => l.matterId === refused)).toMatchObject({
      outcome: "failed",
      failure: "store_refused",
    });
    // The other is not spared by it: the same table holds no row of it.
    expect(report.lines.find((l) => l.matterId === fine)!.outcome).toBe("deleted");
    expect(report).toMatchObject({ deleted: 1, failed: 1 });
    // The matter that was refused is whole, with its files.
    expect(exists(w, refused)).toBe(true);
    expect(w.services.matters.view(w.grant(w.associate, refused)).documents).toHaveLength(2);
    expect(JSON.stringify(report)).not.toContain("zz_extra");
  });

  it("lists the folders no matter names, and removes them on apply; others are left alone", async () => {
    const w = makeWorld({ onDisk: true });
    await matter(w, "present", 90);
    const orphan = "mat_0123456789abcdef";
    mkdirSync(join(w.files.root, orphan));
    writeFileSync(join(w.files.root, orphan, "f_leftover"), "synthetic leftover");
    mkdirSync(join(w.files.root, "not-a-matter"));
    writeFileSync(join(w.files.root, "not-a-matter", "keep.txt"), "not ours");

    const dry = runRetention(deps(w), dryRun());
    expect(dry.orphanFolders).toEqual([orphan]);
    expect(existsSync(join(w.files.root, orphan))).toBe(true);

    const report = runRetention(deps(w), apply());
    expect(report).toMatchObject({ expired: 0, deleted: 0, orphansRemoved: 1, compaction: "done" });
    expect(existsSync(join(w.files.root, orphan))).toBe(false);
    expect(existsSync(join(w.files.root, "not-a-matter", "keep.txt"))).toBe(true);
    expect(retentionRuns(w)[0]!.detail).toMatchObject({ orphansRemoved: 1 });
  });

  it("deletes a matter from the time its page names, not before and not a day later", async () => {
    const w = makeWorld({ onDisk: true });
    const id = await matter(w, "due", 3);
    const view = w.services.matters.view(w.grant(w.associate, id));
    const until = view.retention!.retainUntil;
    // The date is the creation time plus whole days, so it falls partway through its calendar day.
    expect(until).not.toMatch(/T00:00:00\.000Z$/);

    // What the matter page tells the person: the instant, in UTC, to the minute.
    const pane = RetentionSection({
      chrome: buildChrome(),
      matterId: id,
      retention: view.retention,
      canUpdate: true,
    });
    const html = pane === null ? "" : render(pane);
    const named = formatDateTime(until);
    expect(html).toContain(`This matter is kept until ${named},`);
    // The minute is cut, never rounded up: the job does not delete before the time named.
    const namedAt = Date.parse(`${until.slice(0, 16)}:00.000Z`);
    expect(namedAt).toBeLessThanOrEqual(Date.parse(until));
    expect(Date.parse(until) - namedAt).toBeLessThan(60_000);

    // And the job: one millisecond before the instant nothing is due, at the instant it is.
    const before = runRetention(deps(w, new Date(Date.parse(until) - 1)), dryRun());
    expect(before.expired).toBe(0);
    const at = runRetention(deps(w, new Date(until)), dryRun());
    expect(at.expired).toBe(1);
    expect(at.lines[0]?.matterId).toBe(id);
  });

  it("tries the compaction again on the next run when it failed, even with nothing to delete", async () => {
    const w = makeWorld({ onDisk: true });
    await matter(w, "due", 1);
    let calls = 0;
    const flaky = {
      ...w.repo,
      compact: () => {
        calls += 1;
        throw new ConflictError("busy", "a reader holds the log");
      },
    } as Repository;

    const first = runRetention({ ...deps(w), repo: flaky }, apply());
    expect(first).toMatchObject({ deleted: 1, compaction: "failed" });
    expect(retentionRuns(w)[0]!.detail).toMatchObject({ compaction: "failed" });

    // Nothing is due any more, but the last run says its compaction failed.
    const second = runRetention(deps(w), apply());
    expect(second).toMatchObject({ expired: 0, deleted: 0, compaction: "done" });
    expect(retentionRuns(w)[1]!.detail).toMatchObject({ compaction: "done" });

    // And once it has worked, a run with nothing to do does not compact.
    const third = runRetention(deps(w), apply());
    expect(third.compaction).toBe("not_needed");
    expect(calls).toBe(1);
  });

  it("reports the compaction as failed while a real reader holds the log, and compacts on the next run", async () => {
    const w = makeWorld({ onDisk: true });
    await matter(w, "due", 1);
    const file = join(w.root, "parol.sqlite");
    // The job's own connection, with a short wait for the lock, so the blocked checkpoint comes back
    // quickly (it reports busy after the wait; it does not throw).
    const jobDb = openDatabase(file, { busyTimeoutMs: 50 });
    const jobRepo = createRepository(jobDb);
    // A real second connection inside a read transaction: what a dry run or the audit check is.
    const reader = new DatabaseSync(file, { readOnly: true });
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) AS n FROM matters").get();
    try {
      const first = runRetention({ ...deps(w), repo: jobRepo }, apply());
      expect(first).toMatchObject({ deleted: 1, compaction: "failed" });
      expect(jobRepo.latestAuditEvent("retention.run")?.detail).toMatchObject({
        compaction: "failed",
      });
    } finally {
      reader.exec("ROLLBACK");
      reader.close();
    }

    // Nothing is due any more, but the last run says its compaction failed: this run compacts.
    const second = runRetention({ ...deps(w), repo: jobRepo }, apply());
    expect(second).toMatchObject({ expired: 0, deleted: 0, compaction: "done" });
    jobDb.close();
  });

  it("writes one more event for a run that finds nothing, so a quiet job and a job that never ran differ", async () => {
    const w = makeWorld({ onDisk: true });
    await matter(w, "due", 1);
    runRetention(deps(w), apply());
    const census = censusOf(w.repo.db);
    const head = w.repo.auditHead()!.seq;

    const again = runRetention(deps(w), apply());

    expect(again).toMatchObject({ expired: 0, deleted: 0, skipped: 0, failed: 0 });
    expect(retentionRuns(w)).toHaveLength(2);
    expect(retentionRuns(w)[1]!.detail).toMatchObject({
      expired: 0,
      deleted: 0,
      skipped: 0,
      failed: 0,
      orphansRemoved: 0,
      compaction: "not_needed",
      refused: false,
    });
    const after = censusOf(w.repo.db);
    expect(after["audit_events"]).toBe((census["audit_events"] as number) + 1);
    expect(w.repo.auditHead()!.seq).toBe(head + 1);
    for (const table of Object.keys(census))
      if (table !== "audit_events") expect(after[table], table).toBe(census[table]);
  });

  it("reports a broken audit log by its event number, and still deletes what is due", async () => {
    const w = makeWorld({ onDisk: true });
    const id = await matter(w, "due", 1);
    for (const name of ["audit_events_no_update"]) w.repo.db.exec(`DROP TRIGGER ${name}`);
    w.repo.db.prepare("UPDATE audit_events SET actor_id = ? WHERE seq = 3").run("usr_demo_admin");

    const report = runRetention(deps(w), apply());

    expect(report.deleted).toBe(1);
    expect(exists(w, id)).toBe(false);
    expect(report.chain).toMatchObject({ ok: false, firstBrokenSeq: 3, reason: "hash_mismatch" });
  });
});
