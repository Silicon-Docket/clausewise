import { beforeEach, describe, expect, it } from "vitest";
import type { SpendToday, SpendUsage } from "../../src/store/repo-spend.js";
import { SpendRefusedError } from "../../src/usage/errors.js";
import { createSpendGuard, type SpendGuard } from "../../src/usage/guard.js";
import { unitKey, type RunPlan } from "../../src/usage/plan.js";
import { parsePriceTable } from "../../src/usage/prices.js";
import { createRunScope, runStore } from "../../src/usage/scope.js";

/**
 * A ledger that cannot be written. The guard writes the usage of each response as it arrives; when
 * the database refuses, the amount is not lost: it is logged by the class of the failure alone,
 * counted in every check until it is written, and written with the next write that works. The
 * ledger here is a stand-in that fails when told to; the rates are invented.
 */

const PRICE = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
const TABLE = parsePriceTable({ "model-a": PRICE });
const PLAN: RunPlan = {
  units: [
    {
      stage: "extract",
      unit: "*",
      calls: 1,
      callsWithRepair: 1,
      inputTokens: 1000,
      inputTokensWithRepair: 1000,
    },
  ],
  assumedOutputTokens: 1500,
  calls: 1,
  callsWithRepairs: 1,
  inputTokens: 1000,
  inputTokensWithRepairs: 1000,
};
// 1,000 input tokens at $2 per million and 1,500 output tokens at $10 per million.
const BOUND = 0.017;

class DiskFull extends Error {
  override name = "DiskFull";
}

let ledger: SpendUsage[];
let failing: boolean;
let today: number;
let logs: string[];
let guard: SpendGuard;

/** A guard over the stand-in ledger, with a limit for the day of `perDayUsd`. */
function build(perDayUsd: number): SpendGuard {
  return createSpendGuard({
    limits: { perReviewUsd: 100, perDayUsd, assumedOutputTokens: 1500 },
    provider: "anthropic",
    model: "model-a",
    priceTable: TABLE,
    price: PRICE,
    repo: {
      addSpend(usage) {
        // The message of a driver's error can quote a path or a statement.
        if (failing) throw new DiskFull("/secret/path/parol.sqlite is full");
        ledger.push(usage);
        today += usage.costUsd;
      },
      spendToday: (): SpendToday => ({
        costUsd: today,
        responses: ledger.length,
        unpricedResponses: 0,
      }),
    },
    log: (line) => logs.push(line),
  });
}

beforeEach(() => {
  ledger = [];
  failing = false;
  today = 0;
  logs = [];
  // Room for three reviews at their bound: the failures below are not stopped by the limit.
  guard = build(BOUND * 3);
});

const usage = (inputTokens: number) => ({
  inputTokens,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});
const start = {
  kind: "start" as const,
  plan: PLAN,
  finishedUnits: new Set<string>(),
  spentOnRunUsd: 0,
};
const inRun = <T>(fn: () => T): T => runStore.run(createRunScope("run_a"), fn);

describe("a response whose usage the ledger could not take", () => {
  it("is logged by the class of the failure and nothing else, and does not stop the review", () => {
    guard = build(1000);
    guard.reserve("run_a", { boundUsd: BOUND, spentUsd: 0 });
    guard.begin("run_a", () => {
      throw new Error("the review must not be stopped by a ledger that fails");
    });
    failing = true;
    expect(() => inRun(() => guard.onUsage(usage(500_000)))).not.toThrow();
    expect(logs).toEqual([
      "spend ledger: could not write the day's usage (DiskFull), will try again",
    ]);
    expect(logs.join("\n")).not.toContain("secret");
    expect(ledger).toEqual([]);
  });

  it("counts in the next check although it is not in the ledger", () => {
    failing = true;
    inRun(() => guard.onUsage(usage(5_000_000)));
    // $10 of the day is used and not written: the day's limit is $0.051.
    const error = (() => {
      try {
        guard.preflight(start);
      } catch (e) {
        return e as SpendRefusedError;
      }
      throw new Error("expected a refusal");
    })();
    expect(error.code).toBe("spend_over_daily_limit");
    expect(error.figures.usedUsd).toBeCloseTo(10, 12);
    expect(today).toBe(0);
  });

  it("is written with the next write that works, once, together with it", () => {
    guard = build(1000);
    failing = true;
    inRun(() => guard.onUsage(usage(1_000_000)));
    inRun(() => guard.onUsage(usage(500_000)));
    expect(ledger).toEqual([]);
    expect(logs).toHaveLength(2);
    failing = false;
    inRun(() => guard.onUsage(usage(250_000)));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ responses: 3, inputTokens: 1_750_000 });
    expect(ledger[0]?.costUsd).toBeCloseTo(3.5, 12);
    expect(today).toBeCloseTo(3.5, 12);
    // Nothing is left over to be counted twice.
    expect(() =>
      guard.preflight({ ...start, finishedUnits: new Set(PLAN.units.map(unitKey)) }),
    ).not.toThrow();
    inRun(() => guard.onUsage(usage(1_000_000)));
    expect(ledger).toHaveLength(2);
    expect(ledger[1]).toMatchObject({ responses: 1, inputTokens: 1_000_000 });
  });

  it("is written when the run ends, if the ledger works by then", () => {
    guard.reserve("run_a", { boundUsd: BOUND, spentUsd: 0 });
    guard.begin("run_a", () => undefined);
    failing = true;
    inRun(() => guard.onUsage(usage(1_000_000)));
    expect(ledger).toEqual([]);
    failing = false;
    guard.release("run_a");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ responses: 1, costUsd: 2 });
  });

  it("is tried again at the end of a run, and logged again if it still fails", () => {
    guard.reserve("run_a", { boundUsd: BOUND, spentUsd: 0 });
    failing = true;
    inRun(() => guard.onUsage(usage(1_000_000)));
    guard.release("run_a");
    expect(logs).toHaveLength(2);
    expect(ledger).toEqual([]);
  });
});
