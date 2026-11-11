import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/canonical.js";
import { ConflictError, FileStore, NotFoundError } from "../../src/store/index.js";
import {
  ACTORS,
  addMatter,
  decideAll,
  exported,
  makeWorld,
  reviewable,
  startRun,
  type World,
} from "./fixtures.js";

let w: World;
beforeEach(() => {
  w = makeWorld();
});

type Db = World["db"];

/** Every table and column that mentions `needle`, found by reading the whole database. */
function mentions(db: Db, needle: string): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  for (const { name } of tables) {
    const columns = db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[];
    for (const column of columns) {
      const row = db
        .prepare(
          `SELECT count(*) AS n FROM "${name}" WHERE instr(CAST("${column.name}" AS TEXT), ?) > 0`,
        )
        .get(needle) as { n: number };
      if (row.n > 0) (found[name] ??= []).push(column.name);
    }
  }
  return found;
}

/** A matter with everything attached: documents, spans, a run, stages, calls, findings, decisions, a memo, feedback and an evaluation result. */
function everything(world: World, name: string) {
  const { repo } = world;
  // Stages and model calls are written while the run is in flight, before it is finished.
  const e = exported(world, { amendment: true, name }, (run, m) => {
    repo.recordStageStart(m.id, run.id, {
      stage: "extract",
      inputSha256: sha256Hex(`in-${name}`),
    });
    repo.recordStageResult(m.id, run.id, {
      stage: "extract",
      attempt: 1,
      status: "succeeded",
      output: { located: [m.id] },
    });
    repo.insertModelCalls(m.id, run.id, [
      {
        stage: "extract",
        ruleKey: null,
        promptVersionId: "extract.p1",
        requestSha256: sha256Hex("req"),
        attempt: 1,
        outcome: "ok",
        latencyMs: 4,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ]);
  });
  const feedback = repo.addFeedback(e.m.id, {
    userId: ACTORS.reviewer,
    kind: "finding_reason",
    runId: e.run.id,
    findingId: e.findings[0]?.id as string,
    reasonCode: "unclear",
  });
  const dataset = repo.createEvalDataset({
    label: `set ${name}`,
    devSha256: "a".repeat(64),
    heldoutSha256: "b".repeat(64),
  });
  const evalRun = repo.createEvalRun(
    {
      datasetId: dataset.id,
      split: "dev",
      workflowVersionId: world.workflow.id,
      playbookVersionId: world.playbook.id,
      model: "m",
      repeats: 1,
      priceTableSha256: "c".repeat(64),
      resultsPath: "r.json",
    },
    { actorId: null },
  );
  repo.recordEvalSlotResult(
    e.m.id,
    {
      evalRunId: evalRun.id,
      caseKey: `case-${name}`,
      ruleKey: "dur-1",
      repeat: 0,
      runId: e.run.id,
      expectedStatus: "compliant",
      gotStatus: "compliant",
      scores: { match: true },
    },
    { actorId: null },
  );
  const ids = [
    e.m.id,
    e.m.nda.documentId,
    e.m.nda.versionId,
    ...e.m.nda.spanIds,
    e.m.amendment?.documentId as string,
    e.m.amendment?.versionId as string,
    e.run.id,
    ...e.findings.map((f) => f.id),
    ...e.findings.flatMap((f) => f.evidence.map((x) => x.id)),
    ...e.reviews.map((r) => r.id),
    e.memo.id,
    feedback.id,
  ];
  return { ...e, feedback, evalRun, ids };
}

const tableCounts = (db: Db): Record<string, number> => {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      (db.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n,
    ]),
  );
};

describe("deleteMatter", () => {
  it("removes every row that belongs to the matter, and only the audit log may still mention it", () => {
    const doomed = everything(w, "doomed");
    const kept = everything(w, "kept");
    const before = tableCounts(w.db);
    expect(Object.keys(mentions(w.db, doomed.m.id)).length).toBeGreaterThan(8);

    w.repo.deleteMatter(doomed.m.id, { actorId: ACTORS.associate });

    expect(Object.keys(mentions(w.db, doomed.m.id))).toEqual(["audit_events"]);
    // Nor does any other id that belonged to it survive anywhere but in the log.
    for (const id of doomed.ids)
      expect(
        Object.keys(mentions(w.db, id)).filter((t) => t !== "audit_events"),
        id,
      ).toEqual([]);
    expect(w.repo.getMatter(doomed.m.id)).toBeUndefined();

    // The other matter is whole.
    expect(w.repo.getMatter(kept.m.id)?.status).toBe("exported");
    expect(w.repo.getExportReadiness(kept.m.id, kept.run.id).ready).toBe(true);
    expect(w.repo.listSpans(kept.m.id, [kept.m.nda.versionId])).toHaveLength(4);
    expect(w.repo.listEvalSlotResults(kept.evalRun.id)).toHaveLength(1);
    expect(w.repo.listStages(kept.m.id, kept.run.id)).toHaveLength(1);

    // Every row of the doomed matter is gone: the counts fell by the same amounts the audit event reports.
    const after = tableCounts(w.db);
    const event = w.repo.listAuditEvents({ matterId: doomed.m.id, action: "matter.delete" })[0];
    expect(event?.detail).toMatchObject({
      documents: 2,
      versions: 2,
      spans: 6,
      runs: 1,
      findings: 3,
      reviews: 3,
      memos: 1,
      feedback: 1,
      evalSlotResults: 1,
      files: 3,
    });
    const fell = (table: string) => (before[table] as number) - (after[table] as number);
    expect(fell("documents")).toBe(2);
    expect(fell("source_spans")).toBe(6);
    expect(fell("findings")).toBe(3);
    expect(fell("finding_evidence")).toBe(3);
    expect(fell("verification_results")).toBe(3);
    expect(fell("reviews")).toBe(3);
    expect(fell("runs")).toBe(1);
    expect(fell("matters")).toBe(1);
    expect(fell("matter_members")).toBe(1);
    // Playbooks, prompts, workflows, users and evaluation runs are not matter data.
    for (const table of [
      "playbook_versions",
      "playbook_rules",
      "prompt_versions",
      "workflow_versions",
      "users",
      "eval_runs",
      "eval_datasets",
    ])
      expect(after[table], table).toBe(before[table]);
  });

  it("leaves the audit log whole: earlier events kept, one deletion event added, chain intact", () => {
    const doomed = everything(w, "doomed");
    const eventsBefore = w.repo.listAuditEvents({ matterId: doomed.m.id });
    expect(w.repo.verifyAuditChain().ok).toBe(true);

    const paths = w.repo.deleteMatter(doomed.m.id, { actorId: ACTORS.admin });

    const eventsAfter = w.repo.listAuditEvents({ matterId: doomed.m.id });
    expect(eventsAfter.slice(0, eventsBefore.length)).toEqual(eventsBefore);
    expect(eventsAfter).toHaveLength(eventsBefore.length + 1);
    expect(eventsAfter.at(-1)).toMatchObject({
      action: "matter.delete",
      actorId: ACTORS.admin,
      matterId: doomed.m.id,
      targetId: doomed.m.id,
    });
    expect(w.repo.verifyAuditChain()).toEqual({
      ok: true,
      events: w.repo.listAuditEvents().length,
    });
    expect(paths).toHaveLength(3);
    // The audit log holds ids, hashes and counts: nothing in it is a path or a name.
    expect(JSON.stringify(eventsAfter)).not.toContain("Mutual NDA");
  });

  it("returns the storage paths of the documents and the memos, ready for the file store", () => {
    const doomed = everything(w, "doomed");
    const expected = [
      ...w.repo.listVersions(doomed.m.id).map((v) => v.storagePath),
      ...w.repo.listMemos(doomed.m.id).map((m) => m.storagePath),
    ].sort();
    const paths = w.repo.deleteMatter(doomed.m.id, { actorId: ACTORS.associate });
    expect([...paths].sort()).toEqual(expected);
    expect(paths.every((p) => p.startsWith(`${doomed.m.id}/`))).toBe(true);
  });

  describe("with the files", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "parol-retention-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("the caller deletes what it returns, and the folder goes with it", () => {
      const store = new FileStore(join(dir, "files"));
      const doomed = everything(w, "doomed");
      const kept = everything(w, "kept");
      // Put real files where the rows say they are.
      for (const id of [doomed.m.id, kept.m.id])
        for (const p of [
          ...w.repo.listVersions(id).map((v) => v.storagePath),
          ...w.repo.listMemos(id).map((m) => m.storagePath),
        ]) {
          mkdirSync(dirname(join(store.root, p)), { recursive: true, mode: 0o700 });
          writeFileSync(join(store.root, p), "synthetic file");
        }
      const paths = w.repo.deleteMatter(doomed.m.id, { actorId: ACTORS.associate });
      for (const p of paths) store.remove(p);
      expect(store.deleteMatter(doomed.m.id)).toBe(0);
      expect(existsSync(join(store.root, doomed.m.id))).toBe(false);
      expect(readdirSync(join(store.root, kept.m.id))).toHaveLength(3);
    });
  });

  it("refuses while a run is in flight, and works once it is cancelled", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    expect(() => w.repo.deleteMatter(m.id, { actorId: ACTORS.associate })).toThrow(ConflictError);
    expect(() => w.repo.deleteMatter(m.id, { actorId: ACTORS.associate })).toThrow(
      /cancel it first/,
    );
    expect(w.repo.getMatter(m.id)).toBeDefined();
    w.repo.updateRunStatus(m.id, run.id, "cancelled");
    expect(() => w.repo.deleteMatter(m.id, { actorId: ACTORS.associate })).not.toThrow();
  });

  it("treats an unknown matter, and a matter already deleted, as not found", () => {
    expect(() => w.repo.deleteMatter("mat_ffffffffffffffff", { actorId: null })).toThrow(
      NotFoundError,
    );
    const m = addMatter(w);
    w.repo.deleteMatter(m.id, { actorId: null });
    expect(() => w.repo.deleteMatter(m.id, { actorId: null })).toThrow(NotFoundError);
  });

  it("is one transaction: a failure on the last step leaves the matter exactly as it was", () => {
    const doomed = everything(w, "doomed");
    const before = tableCounts(w.db);
    const chain = w.repo.listAuditEvents().length;
    w.db.exec(`CREATE TEMP TRIGGER fail_delete_event BEFORE INSERT ON audit_events
      WHEN NEW.action = 'matter.delete' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    expect(() => w.repo.deleteMatter(doomed.m.id, { actorId: ACTORS.associate })).toThrow(
      "injected failure",
    );
    expect(tableCounts(w.db)).toEqual(before);
    expect(w.repo.getMatter(doomed.m.id)?.status).toBe("exported");
    expect(w.repo.listAuditEvents()).toHaveLength(chain);
    w.db.exec("DROP TRIGGER fail_delete_event");
    expect(() => w.repo.deleteMatter(doomed.m.id, { actorId: ACTORS.associate })).not.toThrow();
  });

  it("deletes a matter in any state it can be in when it expires", () => {
    const draft = w.repo.createMatter({
      name: "d",
      clientLegalName: "c",
      createdBy: ACTORS.associate,
    });
    const ready = addMatter(w, { name: "ready" });
    const stale = reviewable(w, { name: "stale" }).m;
    w.repo.applyInputChange(stale.id, { reason: "rerun_requested", actorId: null });
    const inReview = reviewable(w, { name: "review" }).m;
    const reviewComplete = (() => {
      const r = reviewable(w, { name: "complete" });
      decideAll(w, r.m.id, r.findings);
      return r.m;
    })();
    const done = exported(w, { name: "done" }).m;
    const all = [draft.id, ready.id, stale.id, inReview.id, reviewComplete.id, done.id];
    expect(all.map((id) => w.repo.getMatter(id)?.status).sort()).toEqual(
      ["draft", "exported", "in_review", "ready", "review_complete", "stale"].sort(),
    );
    for (const id of all) {
      w.repo.deleteMatter(id, { actorId: null });
      expect(w.repo.getMatter(id)).toBeUndefined();
    }
  });
});

describe("listExpiredMatters", () => {
  it("returns the matters whose retention date has come, oldest first, whatever their state", () => {
    const short = w.repo.createMatter({
      name: "short",
      clientLegalName: "c",
      createdBy: ACTORS.associate,
      retainDays: 1,
    });
    w.clock.tick(1000);
    const two = w.repo.createMatter({
      name: "two",
      clientLegalName: "c",
      createdBy: ACTORS.associate,
      retainDays: 2,
    });
    const long = exported(w, { name: "long" });
    const t0 = Date.parse(short.createdAt);
    const at = (days: number, extra = 0) => new Date(t0 + days * 86_400_000 + extra);

    expect(w.repo.listExpiredMatters(at(0))).toEqual([]);
    expect(w.repo.listExpiredMatters(at(1, -1)).map((m) => m.id)).toEqual([]);
    // The boundary itself counts as expired.
    expect(w.repo.listExpiredMatters(at(1)).map((m) => m.id)).toEqual([short.id]);
    expect(w.repo.listExpiredMatters(at(2, 1000)).map((m) => m.id)).toEqual([short.id, two.id]);
    expect(w.repo.listExpiredMatters(at(31)).map((m) => m.id)).toEqual([
      short.id,
      two.id,
      long.m.id,
    ]);
    // Strings work as well as dates; the default is the clock.
    expect(w.repo.listExpiredMatters(at(1).toISOString()).map((m) => m.id)).toEqual([short.id]);
    w.clock.set(at(10).toISOString());
    expect(w.repo.listExpiredMatters().map((m) => m.id)).toEqual([short.id, two.id]);
  });

  it("feeds deleteMatter: the retention job in four lines", () => {
    const old = w.repo.createMatter({
      name: "old",
      clientLegalName: "c",
      createdBy: ACTORS.associate,
      retainDays: 1,
    });
    const fresh = w.repo.createMatter({
      name: "fresh",
      clientLegalName: "c",
      createdBy: ACTORS.associate,
      retainDays: 30,
    });
    w.clock.tick(2 * 86_400_000);
    for (const matter of w.repo.listExpiredMatters())
      w.repo.deleteMatter(matter.id, { actorId: null });
    expect(w.repo.getMatter(old.id)).toBeUndefined();
    expect(w.repo.getMatter(fresh.id)).toBeDefined();
    expect(
      w.repo.listAuditEvents({ matterId: old.id, action: "matter.delete" })[0]?.actorId,
    ).toBeNull();
  });
});

describe("compacting after a deletion", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "parol-compact-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const bytesOf = (file: string): Buffer => {
    const parts = [file, `${file}-wal`].filter((p) => existsSync(p)).map((p) => readFileSync(p));
    return Buffer.concat(parts);
  };

  it("leaves none of the deleted matter's text in the database file", () => {
    const file = join(dir, "parol.db");
    const world = makeWorld({ file });
    const e = exported(world, { amendment: true });
    expect(bytesOf(file).includes(Buffer.from("Quillfeather Partners LLC"))).toBe(true);
    expect(bytesOf(file).includes(Buffer.from("years from the date of each disclosure"))).toBe(
      true,
    );

    world.repo.deleteMatter(e.m.id, { actorId: ACTORS.associate });
    world.repo.compact();
    world.db.close();

    const remaining = bytesOf(file);
    expect(remaining.includes(Buffer.from("Quillfeather"))).toBe(false);
    // The playbook's own wording is not matter data and stays; the clause as the document words it must not.
    expect(remaining.includes(Buffer.from("years from the date of each disclosure"))).toBe(false);
    expect(remaining.includes(Buffer.from("Marlowe Analytics"))).toBe(false);
  });

  it("will not run inside a transaction", () => {
    expect(() => w.repo.transaction(() => w.repo.compact())).toThrow(ConflictError);
    expect(() => w.repo.compact()).not.toThrow();
  });
});
