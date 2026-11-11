import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashOf, sha256Hex } from "../../src/canonical.js";
import { createRepository, openDatabase, ValidationError } from "../../src/store/index.js";
import type { SpendUsage } from "../../src/store/repo-spend.js";
import {
  ACTORS,
  PLAYBOOK_YAML,
  RULES,
  WORKFLOW_MANIFEST,
  addMatter,
  makeClock,
  makeWorld,
  seedPrompts,
  startRun,
  type World,
} from "./fixtures.js";

/**
 * The daily spend ledger: one row for each UTC day, written as responses arrive, and kept when a
 * matter is deleted. It is what makes a daily limit a limit: the `model_calls` rows it could be
 * summed from go with their matter. Every figure here is invented.
 */

let w: World;
beforeEach(() => {
  w = makeWorld();
});

const usage = (over: Partial<SpendUsage> = {}): SpendUsage => ({
  responses: 1,
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 300,
  cacheWriteTokens: 40,
  costUsd: 0.25,
  unpricedResponses: 0,
  ...over,
});

/** The message of the database's refusal, or "" when the statement was accepted. */
function refusal(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const rows = (world: World = w) =>
  world.db.prepare("SELECT * FROM spend_ledger ORDER BY day").all() as unknown as Record<
    string,
    unknown
  >[];

describe("adding to the day", () => {
  it("is zero on a day with no row", () => {
    expect(w.repo.spendToday()).toEqual({ costUsd: 0, responses: 0, unpricedResponses: 0 });
    expect(rows()).toEqual([]);
  });

  it("makes the row of the UTC day of the clock, and adds to it afterwards", () => {
    w.clock.set("2026-11-03T10:00:00.000Z");
    w.repo.addSpend(usage());
    w.clock.set("2026-11-03T22:30:00.000Z");
    w.repo.addSpend(usage({ responses: 2, costUsd: 0.5, unpricedResponses: 1 }));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      day: "2026-11-03",
      responses: 3,
      input_tokens: 2000,
      output_tokens: 400,
      cache_read_tokens: 600,
      cache_write_tokens: 80,
      cost_usd: 0.75,
      unpriced_responses: 1,
      updated_at: "2026-11-03T22:30:00.000Z",
    });
    expect(w.repo.spendToday()).toEqual({ costUsd: 0.75, responses: 3, unpricedResponses: 1 });
  });

  it("starts a new row a moment after midnight UTC, and today's total starts again at zero", () => {
    w.clock.set("2026-11-03T23:59:59.999Z");
    w.repo.addSpend(usage({ costUsd: 1 }));
    expect(w.repo.spendToday().costUsd).toBe(1);
    w.clock.set("2026-11-04T00:00:00.000Z");
    expect(w.repo.spendToday()).toEqual({ costUsd: 0, responses: 0, unpricedResponses: 0 });
    w.repo.addSpend(usage({ costUsd: 0.5 }));
    expect(rows().map((r) => [r.day, r.cost_usd])).toEqual([
      ["2026-11-03", 1],
      ["2026-11-04", 0.5],
    ]);
    // Yesterday is still there, and is not today's.
    expect(w.repo.spendToday().costUsd).toBe(0.5);
  });

  it("refuses a count that is not a whole number of 0 or more, and a cost that is not a number of 0 or more, and writes nothing", () => {
    for (const bad of [
      usage({ responses: -1 }),
      usage({ inputTokens: 1.5 }),
      usage({ outputTokens: Number.NaN }),
      usage({ cacheReadTokens: Number.POSITIVE_INFINITY }),
      usage({ cacheWriteTokens: -0.5 }),
      usage({ unpricedResponses: -2 }),
      usage({ costUsd: -0.01 }),
      usage({ costUsd: Number.NaN }),
      usage({ costUsd: Number.POSITIVE_INFINITY }),
    ])
      expect(() => w.repo.addSpend(bad)).toThrow(ValidationError);
    expect(rows()).toEqual([]);
  });
});

describe("what the database holds to", () => {
  beforeEach(() => {
    w.clock.set("2026-11-03T10:00:00.000Z");
    w.repo.addSpend(usage({ unpricedResponses: 1 }));
  });

  it("only ever grows: a counter cannot be lowered, and the day cannot be changed", () => {
    for (const column of [
      "responses",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "cost_usd",
      "unpriced_responses",
    ])
      expect(
        refusal(() => w.db.prepare(`UPDATE spend_ledger SET ${column} = 0`).run()),
        column,
      ).toContain("the spend ledger only grows");
    expect(
      refusal(() => w.db.prepare("UPDATE spend_ledger SET day = '2026-11-04'").run()),
    ).toContain("the spend ledger only grows");
    // Raising one is allowed, which is what the upsert does.
    expect(refusal(() => w.db.prepare("UPDATE spend_ledger SET responses = 9").run())).toBe("");
  });

  it("is never emptied: a row cannot be deleted, one at a time or all together", () => {
    expect(refusal(() => w.db.prepare("DELETE FROM spend_ledger").run())).toContain(
      "the spend ledger is never emptied",
    );
    expect(
      refusal(() => w.db.prepare("DELETE FROM spend_ledger WHERE day = '2026-11-03'").run()),
    ).toContain("the spend ledger is never emptied");
    expect(rows()).toHaveLength(1);
  });

  it("holds a real date, and counts that are not negative", () => {
    for (const day of ["tomorrow", "2026-1-3", "2026-11-3x", ""])
      expect(
        refusal(() =>
          w.db
            .prepare(
              "INSERT INTO spend_ledger (day, updated_at) VALUES (?, '2026-11-03T10:00:00.000Z')",
            )
            .run(day),
        ),
        day,
      ).not.toBe("");
    expect(
      refusal(() =>
        w.db
          .prepare(
            "INSERT INTO spend_ledger (day, cost_usd, updated_at) VALUES ('2026-11-09', -1, 'x')",
          )
          .run(),
      ),
    ).not.toBe("");
  });

  it("holds numbers and a date and nothing that names a matter, a run, a person or text", () => {
    const columns = (
      w.db.prepare("PRAGMA table_info(spend_ledger)").all() as unknown as { name: string }[]
    ).map((c) => c.name);
    expect(columns.sort()).toEqual([
      "cache_read_tokens",
      "cache_write_tokens",
      "cost_usd",
      "day",
      "input_tokens",
      "output_tokens",
      "responses",
      "unpriced_responses",
      "updated_at",
    ]);
  });
});

describe("deleting a matter", () => {
  it("does not lower the day's total, although the matter's calls go with it", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    w.repo.insertModelCalls(m.id, run.id, [
      {
        stage: "analyze",
        ruleKey: "dur-1",
        promptVersionId: "analyze.p1",
        requestSha256: sha256Hex("request"),
        attempt: 1,
        outcome: "ok",
        latencyMs: 12,
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsdEstimate: 0.25,
        priceTableSha256: sha256Hex("table"),
      },
    ]);
    // The guard writes the response to the ledger as it arrives, apart from the call's row.
    w.repo.addSpend(usage({ costUsd: 0.25 }));
    expect(w.repo.summarizeRunUsage(m.id, run.id).costUsd).toBe(0.25);
    const before = rows();

    // A matter with a run in flight cannot be deleted, so the run ends first.
    w.repo.updateRunStatus(m.id, run.id, "cancelled");
    w.repo.deleteMatter(m.id, { actorId: ACTORS.admin });

    expect(w.db.prepare("SELECT COUNT(*) AS n FROM model_calls").get()).toEqual({ n: 0 });
    expect(w.repo.spendToday().costUsd).toBe(0.25);
    expect(rows()).toEqual(before);
  });
});

describe("migration 004, the ledger part", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "parol-ledger-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("upgrades a database made at version 3: an empty ledger is added and the calls it already held are left as they were", () => {
    const old = join(dir, "migrations-to-3");
    mkdirSync(old);
    for (const name of ["001_init.sql", "002_integrity.sql", "003_ingest_warnings.sql"])
      copyFileSync(
        fileURLToPath(new URL(`../../migrations/${name}`, import.meta.url)),
        join(old, name),
      );
    const location = join(dir, "old.sqlite");
    const atThree = openDatabase(location, { migrationsDir: old });
    expect(
      atThree.prepare("SELECT name FROM sqlite_master WHERE name = 'spend_ledger'").all(),
    ).toEqual([]);
    const clock = makeClock();
    const repo = createRepository(atThree, { now: clock.now });
    repo.seedDemoUsers();
    const playbook = repo.approvePlaybookVersion(
      repo.importPlaybookDraft(
        {
          slug: "test-playbook",
          version: "1.0.0",
          yaml: PLAYBOOK_YAML,
          sha256: sha256Hex(PLAYBOOK_YAML),
          rules: RULES,
        },
        { actorId: ACTORS.legalEngineer },
      ).id,
      { actorId: ACTORS.admin },
    );
    seedPrompts(repo);
    const workflow = repo.upsertWorkflowVersion({
      manifest: WORKFLOW_MANIFEST,
      sha256: hashOf(WORKFLOW_MANIFEST),
    });
    const world = { db: atThree, repo, clock, playbook, workflow } as unknown as World;
    const m = addMatter(world);
    const run = startRun(world, m);
    // A call as the code before this migration wrote it: every count empty.
    const [call] = repo.insertModelCalls(m.id, run.id, [
      {
        stage: "analyze",
        ruleKey: "dur-1",
        promptVersionId: "analyze.p1",
        requestSha256: sha256Hex("r"),
        attempt: 1,
        outcome: "ok",
        latencyMs: 3,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      },
    ]);
    atThree.close();

    const upgraded = openDatabase(location);
    const after = createRepository(upgraded, { now: clock.now });
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM spend_ledger").get()).toEqual({ n: 0 });
    const triggers = (
      upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    expect(triggers).toContain("spend_ledger_only_grows");
    expect(triggers).toContain("spend_ledger_never_emptied");
    expect(after.listModelCalls(m.id, run.id)).toEqual([call]);
    // The guard can write to it, and the day's total starts from what is written.
    expect(after.spendToday().costUsd).toBe(0);
    after.addSpend(usage({ costUsd: 0.5 }));
    expect(after.spendToday().costUsd).toBe(0.5);
    upgraded.close();
  });

  it("adds exactly one table and two triggers to a fresh database for the ledger", () => {
    const tables = (
      w.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    expect(tables).toContain("spend_ledger");
    const triggers = (
      w.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'spend_ledger'",
        )
        .all() as { name: string }[]
    ).map((t) => t.name);
    expect(triggers.sort()).toEqual(["spend_ledger_never_emptied", "spend_ledger_only_grows"]);
  });
});
