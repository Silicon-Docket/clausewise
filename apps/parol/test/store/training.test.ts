import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { authorizeMatter, authorizeMatterDelete } from "../../src/auth/authorize.js";
import { seedDemo } from "../../src/seed.js";
import {
  DEFAULT_MIGRATIONS_DIR,
  DEMO_USER_IDS,
  createRepository,
  openDatabase,
  tablesHoldingMatter,
  type Repository,
} from "../../src/store/index.js";
import { startTraining } from "../../src/training/start.js";
import { cleanupWorlds, simulatedWorld } from "../training/support.js";
import { messageOf } from "./fixtures.js";

/**
 * The training key of a matter: the column, the index and the four triggers of migration 7, and
 * what they do to the rest of the store. Raw SQL is written the way a bug or someone with the
 * database file would write it, and each case says what the database must refuse. Every matter,
 * document and person is synthetic.
 */

const dirs: string[] = [];
afterAll(() => {
  cleanupWorlds();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repoWithUsers(): Repository {
  const repo = createRepository(openDatabase(":memory:"));
  repo.seedDemoUsers();
  return repo;
}

/** The matters that carry a key, by the column and not by anything the repository offers. */
const trainingIds = (repo: Repository): string[] =>
  (
    repo.db.prepare("SELECT id FROM matters WHERE training_key IS NOT NULL ORDER BY id").all() as {
      id: string;
    }[]
  ).map((r) => r.id);

const ordinary = (repo: Repository, createdBy: string = DEMO_USER_IDS.associate) =>
  repo.createMatter({ name: "An NDA", clientLegalName: "Marlowe Analytics, Inc.", createdBy });
const training = (repo: Repository, createdBy: string = DEMO_USER_IDS.associate) =>
  repo.createMatter({
    name: "Training: an NDA (T01)",
    clientLegalName: "Marlowe Analytics, Inc.",
    createdBy,
    trainingKey: "T01",
  });

/** A matter row written by hand, with the columns the cases change. */
function rawInsert(repo: Repository, over: Record<string, string | number | null> = {}) {
  const row: Record<string, string | number | null> = {
    id: `mat_${Math.random().toString(16).slice(2, 18).padEnd(16, "0")}`,
    name: "Raw",
    client_legal_name: "Raw Client",
    playbook_version_id: null,
    status: "draft",
    current_inputs_sha256: null,
    synthetic: 1,
    created_by: DEMO_USER_IDS.associate,
    created_at: "2026-11-01T09:00:00.000Z",
    retain_until: "2026-12-01T09:00:00.000Z",
    deleted_at: null,
    training_key: null,
    ...over,
  };
  const columns = Object.keys(row);
  return () =>
    repo.db
      .prepare(
        `INSERT INTO matters (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      )
      .run(...columns.map((c) => row[c] ?? null));
}

describe("the key on a matter", () => {
  it("is carried by a matter made with it and by no other, whether just made or read back", () => {
    const repo = repoWithUsers();
    const plain = ordinary(repo);
    const keyed = training(repo);
    expect(plain.trainingKey).toBeNull();
    expect(keyed.trainingKey).toBe("T01");
    expect(repo.getMatter(plain.id)?.trainingKey).toBeNull();
    expect(repo.getMatter(keyed.id)?.trainingKey).toBe("T01");
    const listed = repo.listMattersForUser(DEMO_USER_IDS.associate);
    expect(listed.map((m) => [m.id, m.trainingKey]).sort()).toEqual(
      [
        [plain.id, null],
        [keyed.id, "T01"],
      ].sort(),
    );
    // A training matter is synthetic, and a measure that adds the condition leaves it out.
    expect(keyed.synthetic).toBe(true);
    expect(trainingIds(repo)).toEqual([keyed.id]);
  });

  it("is refused by the store when it is not a key that exists, before the database is asked", () => {
    const repo = repoWithUsers();
    expect(() =>
      repo.createMatter({
        name: "x",
        clientLegalName: "y",
        createdBy: DEMO_USER_IDS.associate,
        trainingKey: "T02" as never,
      }),
    ).toThrow(TypeError);
    expect(repo.listMatterIds()).toEqual([]);
  });

  it("cannot be changed or cleared, by UPDATE or by INSERT OR REPLACE", () => {
    const repo = repoWithUsers();
    const keyed = training(repo);
    const plain = ordinary(repo);
    const update =
      (sql: string, ...params: string[]) =>
      () =>
        repo.db.prepare(sql).run(...params);
    expect(
      messageOf(update("UPDATE matters SET training_key = NULL WHERE id = ?", keyed.id)),
    ).toMatch(/training key of a matter is set when it is created and never changes/);
    expect(
      messageOf(update("UPDATE matters SET training_key = 'T02' WHERE id = ?", keyed.id)),
    ).toMatch(/never changes/);
    // An ordinary matter cannot be made a training matter later either.
    expect(
      messageOf(update("UPDATE matters SET training_key = 'T01' WHERE id = ?", plain.id)),
    ).toMatch(/never changes/);
    expect(repo.getMatter(keyed.id)?.trainingKey).toBe("T01");
    expect(repo.getMatter(plain.id)?.trainingKey).toBeNull();
    // A replace deletes the row the key is on, and is refused before it can.
    expect(
      messageOf(
        rawInsert(repo, { id: keyed.id, training_key: null, created_by: DEMO_USER_IDS.associate }),
      ),
    ).toMatch(/matters are never replaced/);
    expect(
      messageOf(() =>
        repo.db
          .prepare(
            `INSERT OR REPLACE INTO matters (id, name, client_legal_name, status, synthetic, created_by, created_at, retain_until)
             VALUES (?, 'x', 'y', 'draft', 1, ?, '2026-11-01T09:00:00.000Z', '2026-12-01T09:00:00.000Z')`,
          )
          .run(keyed.id, DEMO_USER_IDS.associate),
      ),
    ).toMatch(/matters are never replaced/);
    expect(repo.getMatter(keyed.id)?.trainingKey).toBe("T01");
    // Other columns of the same row still change.
    repo.db.prepare("UPDATE matters SET name = 'Renamed' WHERE id = ?").run(keyed.id);
    expect(repo.getMatter(keyed.id)?.name).toBe("Renamed");
  });

  it("is held once per creator, and deleting the matter frees it", async () => {
    const repo = repoWithUsers();
    const first = training(repo);
    expect(() => training(repo)).toThrow(/UNIQUE|constraint/i);
    // Another person has their own, and one person's ordinary matters are not limited.
    expect(training(repo, DEMO_USER_IDS.reviewer).trainingKey).toBe("T01");
    ordinary(repo);
    ordinary(repo);
    expect(repo.listMattersForUser(DEMO_USER_IDS.associate)).toHaveLength(3);
    await repo.deleteMatter(first.id, { actorId: DEMO_USER_IDS.associate });
    expect(training(repo).trainingKey).toBe("T01");
  });

  it("is a T and two digits, and nothing else", () => {
    const repo = repoWithUsers();
    for (const key of ["T1", "T001", "t01", "X01", "T0A", "", "T01 ", "T0\n1", "01T"])
      expect(messageOf(rawInsert(repo, { training_key: key })), JSON.stringify(key)).toMatch(
        /CHECK constraint/,
      );
    // The shape is all the database checks: which keys exist is the code's to say.
    expect(
      rawInsert(repo, { training_key: "T99", created_by: DEMO_USER_IDS.reviewer }),
    ).not.toThrow();
    expect(rawInsert(repo, { training_key: null })).not.toThrow();
  });

  it("belongs to a synthetic matter only", () => {
    const repo = repoWithUsers();
    expect(
      messageOf(() =>
        repo.createMatter({
          name: "x",
          clientLegalName: "y",
          createdBy: DEMO_USER_IDS.associate,
          synthetic: false,
          trainingKey: "T01",
        }),
      ),
    ).toMatch(/a training matter is synthetic/);
    expect(messageOf(rawInsert(repo, { training_key: "T01", synthetic: 0 }))).toMatch(
      /a training matter is synthetic/,
    );
    expect(repo.listMatterIds()).toEqual([]);
    // An ordinary matter may be marked as not synthetic, as before.
    expect(
      repo.createMatter({
        name: "Real",
        clientLegalName: "y",
        createdBy: DEMO_USER_IDS.associate,
        synthetic: false,
      }).synthetic,
    ).toBe(false);
  });
});

describe("the migration", () => {
  it("applies to a database that already holds matters, which then have no key and keep every column", () => {
    const dir = mkdtempSync(join(tmpdir(), "parol-training-migration-"));
    dirs.push(dir);
    const before = join(dir, "migrations-before");
    cpSync(DEFAULT_MIGRATIONS_DIR, before, { recursive: true });
    // The database as migration 6 left it: migration 7 and every later one is taken out, so that
    // a migration added after this one leaves no gap in the numbers.
    for (const name of readdirSync(before))
      if (Number.parseInt(name.slice(0, 3), 10) >= 7) rmSync(join(before, name));
    const file = join(dir, "old.sqlite");
    const old = openDatabase(file, { migrationsDir: before });
    expect(
      (old.prepare("PRAGMA table_info(matters)").all() as { name: string }[]).map((c) => c.name),
    ).not.toContain("training_key");
    old
      .prepare(
        "INSERT INTO users (id, display_name, global_role, demo) VALUES ('u1', 'U', 'member', 1)",
      )
      .run();
    old
      .prepare(
        `INSERT INTO matters (id, name, client_legal_name, status, synthetic, created_by, created_at, retain_until)
         VALUES ('mat_old', 'Old NDA', 'Old Client', 'draft', 1, 'u1', '2026-11-01T09:00:00.000Z', '2026-12-01T09:00:00.000Z')`,
      )
      .run();
    old.close();

    const db = openDatabase(file);
    const versions = (
      db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
        version: number;
      }[]
    ).map((r) => r.version);
    expect(versions.at(-1)).toBeGreaterThanOrEqual(7);
    const repo = createRepository(db);
    const matter = repo.getMatter("mat_old")!;
    expect(matter.trainingKey).toBeNull();
    expect(matter.name).toBe("Old NDA");
    // The new rules apply to the new column from then on.
    expect(
      messageOf(() =>
        db.prepare("UPDATE matters SET training_key = 'T01' WHERE id = 'mat_old'").run(),
      ),
    ).toMatch(/never changes/);
    db.close();
  });

  it("adds the column, the index and the four triggers, and nothing else", () => {
    const db = openDatabase(":memory:");
    const names = (type: string) =>
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name LIKE ? ORDER BY name")
          .all(type, "%train%") as { name: string }[]
      ).map((r) => r.name);
    expect(names("index")).toEqual(["matters_one_training_key_per_creator"]);
    expect(names("trigger")).toEqual([
      "eval_slot_results_not_training",
      "matters_training_is_synthetic",
      "matters_training_key_immutable",
      "runs_not_eval_on_training",
    ]);
    db.close();
  });
});

describe("evaluation", () => {
  it("is refused on a training matter, whoever asks (the cases of test/training/isolation.test.ts, here by name)", async () => {
    const w = simulatedWorld();
    const report = await seedDemo({ repo: w.repo, files: w.files, training: true });
    const workflow = w.repo.listWorkflowVersions()[0]!;
    const manifest = w.repo.buildRunManifest(report.training!.matterId, {
      workflowVersionId: workflow.id,
      modelProvider: "simulated",
      model: "parol-simulated-reader",
    });
    expect(
      messageOf(() =>
        w.repo.createRun(report.training!.matterId, {
          manifest,
          startedBy: DEMO_USER_IDS.associate,
          purpose: "eval",
        }),
      ),
    ).toMatch(/training matters are never used in evaluation/);
    // The same request for a review that is not for evaluation is made.
    expect(
      w.repo.createRun(report.training!.matterId, {
        manifest,
        startedBy: DEMO_USER_IDS.associate,
      }).purpose,
    ).toBe("matter");
  });
});

describe("deleting a training matter", () => {
  it("leaves no table holding its id, frees the key, and lets the person start again", async () => {
    const w = simulatedWorld();
    const report = await seedDemo({ repo: w.repo, files: w.files, training: true });
    const alex = w.principal(DEMO_USER_IDS.associate);
    const id = report.training!.matterId;
    // Give it a review so that runs, findings and the rest are there to be deleted.
    const runAm = authorizeMatter(w.repo, alex, id, "run.start");
    w.services.runs.start(runAm, { workflowLabel: "v2" });
    await w.services.runs.idle();
    expect(tablesHoldingMatter(w.repo.db, id).length).toBeGreaterThan(5);

    await w.services.matters.delete(authorizeMatterDelete(w.repo, alex, id));
    expect(tablesHoldingMatter(w.repo.db, id)).toEqual([]);
    expect(w.repo.getMatter(id)).toBeUndefined();
    expect(trainingIds(w.repo)).toEqual([]);

    const again = await startTraining(
      { services: w.services, repo: w.repo, relaxedSegregation: false },
      alex,
      {
        playbookVersionId: w.repo.findPlaybookVersion("parol-nda-recipient", "1.0.1")!.id,
        reviewerUserId: DEMO_USER_IDS.reviewer,
        trainerUserId: null,
      },
    );
    expect(again.created).toBe(true);
    expect(again.matterId).not.toBe(id);
  });
});

describe("the record of it", () => {
  it("names the key in the creation event of a training matter and nowhere on an ordinary one, and the chain verifies", async () => {
    const w = simulatedWorld();
    const report = await seedDemo({ repo: w.repo, files: w.files, training: true });
    const events = w.repo.listAuditEvents({ action: "matter.create", limit: 100 });
    const byMatter = new Map(events.map((e) => [e.matterId, e.detail]));
    expect(byMatter.get(report.training!.matterId)).toMatchObject({ training: "T01" });
    for (const matter of report.matters)
      expect(byMatter.get(matter.matterId)).not.toHaveProperty("training");
    // The detail holds codes, ids and dates, and no text of a document.
    expect(JSON.stringify(byMatter.get(report.training!.matterId))).not.toMatch(/Lanternfish|NDA/);
    expect(w.repo.verifyAuditChain().ok).toBe(true);
  });
});
