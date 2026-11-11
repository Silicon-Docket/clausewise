import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/canonical.js";
import { NotFoundError, ValidationError } from "../../src/store/index.js";
import { ACTORS, addMatter, makeWorld, startRun, type World } from "./fixtures.js";

let w: World;
beforeEach(() => {
  w = makeWorld();
});

const PRICES = sha256Hex("price table");
const call = (over: object = {}) => ({
  stage: "analyze" as const,
  ruleKey: "dur-1",
  promptVersionId: "analyze.p1",
  requestSha256: sha256Hex("request"),
  attempt: 1,
  outcome: "ok" as const,
  latencyMs: 12,
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 300,
  cacheWriteTokens: 40,
  ...over,
});
const NO_TOKENS = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
};

/** The message of the database's refusal, or "" when the statement was accepted. */
function refusal(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("usage on a call: what the database accepts", () => {
  it("stores all four counts, a cost and the hash of the table that priced it", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const [row] = w.repo.insertModelCalls(m.id, run.id, [
      call({ costUsdEstimate: 0.0042, priceTableSha256: PRICES }),
    ]);
    expect(row).toMatchObject({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 300,
      cacheWriteTokens: 40,
      costUsdEstimate: 0.0042,
      priceTableSha256: PRICES,
    });
  });

  it("stores a call with no counts at all, and with counts but no cost", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const rows = w.repo.insertModelCalls(m.id, run.id, [call(NO_TOKENS), call()]);
    expect(rows[0]).toMatchObject({ ...NO_TOKENS, costUsdEstimate: null, priceTableSha256: null });
    expect(rows[1]).toMatchObject({ inputTokens: 1000, costUsdEstimate: null });
  });

  it("refuses a call with some of the four counts and not the others, writing none of the calls", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    for (const partial of [
      { cacheWriteTokens: null },
      { cacheReadTokens: null },
      { inputTokens: null },
      { outputTokens: null },
      { inputTokens: null, outputTokens: null, cacheReadTokens: null },
    ]) {
      const message = refusal(() => w.repo.insertModelCalls(m.id, run.id, [call(), call(partial)]));
      expect(message, JSON.stringify(partial)).toContain("all reported or all absent");
    }
    expect(w.repo.listModelCalls(m.id, run.id)).toEqual([]);
  });

  it("refuses a negative count, from a caller that skips the store's own check", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]) {
      // The store checks first; the trigger is what holds when a statement is written around it.
      expect(() => w.repo.insertModelCalls(m.id, run.id, [call({ [field]: -1 })])).toThrow(
        ValidationError,
      );
    }
    const raw = (tokens: number) =>
      w.db
        .prepare(
          `INSERT INTO model_calls (id, run_id, stage, rule_key, prompt_version_id, request_sha256, attempt, outcome,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, latency_ms)
           VALUES ('mcl_x', ?, 'analyze', NULL, 'analyze.p1', ?, 1, 'ok', ?, 1, 1, 1, 1)`,
        )
        .run(run.id, sha256Hex("x"), tokens);
    expect(refusal(() => raw(-1))).toContain("all reported or all absent");
    expect(refusal(() => raw(1))).toBe("");
  });

  it("refuses a cost without counts, without a hash, or with a hash that is not 64 characters", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const bad = [
      call({ ...NO_TOKENS, costUsdEstimate: 0.1, priceTableSha256: PRICES }),
      call({ costUsdEstimate: 0.1 }),
      call({ costUsdEstimate: 0.1, priceTableSha256: "abc" }),
      call({ priceTableSha256: PRICES }),
    ];
    for (const one of bad)
      expect(
        refusal(() => w.repo.insertModelCalls(m.id, run.id, [one])),
        JSON.stringify(one),
      ).not.toBe("");
    // The trigger holds when the store is written around.
    const raw = (cost: number | null, hash: string | null, input: number | null) =>
      w.db
        .prepare(
          `INSERT INTO model_calls (id, run_id, stage, rule_key, prompt_version_id, request_sha256, attempt, outcome,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, latency_ms, cost_usd_estimate, price_table_sha256)
           VALUES ('mcl_' || hex(randomblob(4)), ?, 'analyze', NULL, 'analyze.p1', ?, 1, 'ok', ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(run.id, sha256Hex("x"), input, input, input, input, cost, hash);
    expect(refusal(() => raw(0.1, PRICES, null))).toContain(
      "a cost needs tokens and a price table",
    );
    expect(refusal(() => raw(0.1, null, 1))).toContain("a cost needs tokens and a price table");
    expect(refusal(() => raw(0.1, "abc", 1))).toContain("a cost needs tokens and a price table");
    expect(refusal(() => raw(-0.1, PRICES, 1))).toContain("a cost needs tokens and a price table");
    expect(refusal(() => raw(null, PRICES, 1))).toContain("a cost needs tokens and a price table");
    expect(refusal(() => raw(0, PRICES, 0))).toBe("");
  });

  it("never lets a recorded call be edited", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const [row] = w.repo.insertModelCalls(m.id, run.id, [call()]);
    const id = row?.id as string;
    for (const set of [
      "input_tokens = 1",
      "cost_usd_estimate = 1",
      "outcome = 'transport'",
      "latency_ms = 9",
    ])
      expect(
        refusal(() => w.db.prepare(`UPDATE model_calls SET ${set} WHERE id = ?`).run(id)),
        set,
      ).toContain("model calls are never edited");
    expect(w.repo.listModelCalls(m.id, run.id)[0]).toMatchObject({ inputTokens: 1000 });
  });
});

describe("the reported model of a run", () => {
  const reported = (matterId: string, runId: string) =>
    w.repo.getRun(matterId, runId)?.modelReported;

  it("is recorded as sorted, distinct names joined by a comma and a space", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    expect(reported(m.id, run.id)).toBeNull();
    w.repo.recordReportedModels(m.id, run.id, ["model-b", "model-a", "model-b"]);
    expect(reported(m.id, run.id)).toBe("model-a, model-b");
  });

  it("is kept when the run is in any state, and an empty list never overwrites it", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    w.repo.updateRunStatus(m.id, run.id, "cancelled", { actorId: ACTORS.associate });
    w.repo.recordReportedModels(m.id, run.id, ["model-a"]);
    expect(reported(m.id, run.id)).toBe("model-a");
    w.repo.recordReportedModels(m.id, run.id, []);
    expect(reported(m.id, run.id)).toBe("model-a");
    // A later list replaces it: the engine records the whole set seen so far.
    w.repo.recordReportedModels(m.id, run.id, ["model-a", "model-c"]);
    expect(reported(m.id, run.id)).toBe("model-a, model-c");
  });

  it("is not changed by a status change of the run", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    w.repo.recordReportedModels(m.id, run.id, ["model-a"]);
    w.repo.updateRunStatus(m.id, run.id, "failed", { errorKind: "interrupted", actorId: null });
    expect(reported(m.id, run.id)).toBe("model-a");
  });

  it("refuses a name that is not a plain model name, and writes nothing", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const bad = [
      "",
      "a b",
      "model\nname",
      "x".repeat(101),
      "-model",
      "model<script>",
      "mödel",
      "a,b",
    ];
    for (const name of bad)
      expect(
        () => w.repo.recordReportedModels(m.id, run.id, ["model-a", name]),
        JSON.stringify(name),
      ).toThrow(ValidationError);
    expect(reported(m.id, run.id)).toBeNull();
  });

  it("keeps the names that fit when the list is longer than the column", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const names = ["a", "b", "c", "d"].map((c) => `${c}${"x".repeat(98)}`);
    w.repo.recordReportedModels(m.id, run.id, names);
    const value = reported(m.id, run.id) ?? "";
    expect(value.length).toBeLessThanOrEqual(300);
    expect(value.split(", ")).toEqual(names.slice(0, 2));
  });

  it("is plain printable text of at most 300 characters, whoever writes it", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const write = (value: string) => () =>
      w.db.prepare("UPDATE runs SET model_reported = ? WHERE id = ?").run(value, run.id);
    expect(refusal(write("model\nname"))).toContain("a reported model is plain text");
    expect(refusal(write("modèl"))).toContain("a reported model is plain text");
    expect(refusal(write("x".repeat(301)))).toContain("at most 300 characters");
    expect(refusal(write("x".repeat(300)))).toBe("");
  });

  it("is refused for a run of another matter, as a missing run is", () => {
    const a = addMatter(w);
    const b = addMatter(w);
    const run = startRun(w, b);
    expect(() => w.repo.recordReportedModels(a.id, run.id, ["model-a"])).toThrow(NotFoundError);
    expect(reported(b.id, run.id)).toBeNull();
  });
});

describe("the usage of a run, added up", () => {
  it("adds the counts and costs of its calls, with the number of calls each is out of", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    w.repo.insertModelCalls(m.id, run.id, [
      call({ costUsdEstimate: 0.5, priceTableSha256: PRICES }),
      call({
        inputTokens: 10,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsdEstimate: 0.25,
        priceTableSha256: PRICES,
      }),
      call(NO_TOKENS),
      call(),
    ]);
    expect(w.repo.summarizeRunUsage(m.id, run.id)).toEqual({
      calls: 4,
      callsWithUsage: 3,
      inputTokens: 2010,
      outputTokens: 401,
      cacheReadTokens: 600,
      cacheWriteTokens: 80,
      callsPriced: 2,
      costUsd: 0.75,
      priceTables: 1,
      priceTableSha256: PRICES,
    });
  });

  it("has no cost and no table when no call was priced, and no hash when the tables differ", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    expect(w.repo.summarizeRunUsage(m.id, run.id)).toEqual({
      calls: 0,
      callsWithUsage: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      callsPriced: 0,
      costUsd: null,
      priceTables: 0,
      priceTableSha256: null,
    });
    const other = sha256Hex("another table");
    w.repo.insertModelCalls(m.id, run.id, [
      call({ costUsdEstimate: 0.1, priceTableSha256: PRICES }),
      call({ costUsdEstimate: 0.1, priceTableSha256: other }),
    ]);
    expect(w.repo.summarizeRunUsage(m.id, run.id)).toMatchObject({
      callsPriced: 2,
      priceTables: 2,
      priceTableSha256: null,
    });
  });

  it("reads the calls of the run in its own matter only", () => {
    const a = addMatter(w);
    const b = addMatter(w);
    const runA = startRun(w, a);
    const runB = startRun(w, b);
    w.repo.insertModelCalls(b.id, runB.id, [call()]);
    expect(w.repo.summarizeRunUsage(a.id, runB.id).calls).toBe(0);
    expect(w.repo.summarizeRunUsage(b.id, runB.id).calls).toBe(1);
    expect(w.repo.summarizeRunUsage(a.id, runA.id).calls).toBe(0);
  });
});
