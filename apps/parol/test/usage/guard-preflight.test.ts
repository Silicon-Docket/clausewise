import { beforeEach, describe, expect, it } from "vitest";
import { createRepository, openDatabase, type Repository } from "../../src/store/index.js";
import { SpendRefusedError } from "../../src/usage/errors.js";
import { createSpendGuard, type SpendGuard, type SpendLimits } from "../../src/usage/guard.js";
import { unitKey, upperBoundUsd, type RunPlan } from "../../src/usage/plan.js";
import { parsePriceTable } from "../../src/usage/prices.js";
import { createRunScope, runStore } from "../../src/usage/scope.js";

/**
 * The decision made before a review starts or resumes: whether the most it can cost fits under the
 * limit for one review and under what is left of the day. The plan is written out by hand so that
 * the arithmetic can be checked on paper, and the prices are invented. Nothing here calls a model.
 */

// Invented rates, USD per million tokens.
const PRICE = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
const TABLE = parsePriceTable({ "model-a": PRICE });

// Extract (1,000 input tokens), two rules (500 input tokens, 900 with the repair call). By hand:
// input 2,800 tokens at $2 per million is $0.0056, and 5 calls of 1,500 output tokens at $10 is $0.075.
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
    {
      stage: "analyze",
      unit: "a-1",
      calls: 1,
      callsWithRepair: 2,
      inputTokens: 500,
      inputTokensWithRepair: 900,
    },
    {
      stage: "analyze",
      unit: "b-1",
      calls: 1,
      callsWithRepair: 2,
      inputTokens: 500,
      inputTokensWithRepair: 900,
    },
  ],
  assumedOutputTokens: 1500,
  calls: 3,
  callsWithRepairs: 5,
  inputTokens: 2000,
  inputTokensWithRepairs: 2800,
};
const BOUND = 0.0806;

let now = new Date("2026-11-03T10:00:00.000Z");
let repo: Repository;
const logs: string[] = [];
beforeEach(() => {
  now = new Date("2026-11-03T10:00:00.000Z");
  repo = createRepository(openDatabase(":memory:"), { now: () => now });
  logs.length = 0;
});

const guardWith = (limits: Partial<SpendLimits>): SpendGuard =>
  createSpendGuard({
    limits: { perReviewUsd: 1, perDayUsd: 10, assumedOutputTokens: 1500, ...limits },
    provider: "anthropic",
    model: "model-a",
    priceTable: TABLE,
    price: PRICE,
    repo,
    log: (line) => logs.push(line),
  });
const start = {
  kind: "start" as const,
  plan: PLAN,
  finishedUnits: new Set<string>(),
  spentOnRunUsd: 0,
};

function refusal(fn: () => unknown): SpendRefusedError {
  try {
    fn();
  } catch (error) {
    if (error instanceof SpendRefusedError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("the bound", () => {
  it("is the plan priced the way the evaluation prices it, worked out by hand", () => {
    expect(upperBoundUsd(PLAN, PRICE)).toBeCloseTo(BOUND, 12);
    expect(guardWith({}).preflight(start).boundUsd).toBeCloseTo(BOUND, 12);
  });
});

describe("the limit for one review", () => {
  it("refuses a bound above it, with the figures, and writes nothing", () => {
    const guard = guardWith({ perReviewUsd: 0.05 });
    const error = refusal(() => guard.preflight(start));
    expect(error.code).toBe("spend_over_review_limit");
    expect(error.kind).toBe("start");
    expect(error.figures.boundUsd).toBeCloseTo(BOUND, 12);
    expect(error.figures).toMatchObject({ limitUsd: 0.05, usedUsd: 0, heldUsd: 0 });
    expect(repo.db.prepare("SELECT COUNT(*) AS n FROM spend_ledger").get()).toEqual({ n: 0 });
  });

  it("accepts a bound equal to it, and refuses one the least bit above", () => {
    const bound = upperBoundUsd(PLAN, PRICE);
    expect(guardWith({ perReviewUsd: bound }).preflight(start).boundUsd).toBe(bound);
    expect(() => guardWith({ perReviewUsd: bound * (1 - 1e-9) }).preflight(start)).toThrow(
      SpendRefusedError,
    );
  });

  it("counts, for a resume, only the units that did not finish, and what the review has already used", () => {
    const finished = new Set(["extract:*", "analyze:a-1"]);
    const resume = { kind: "resume" as const, plan: PLAN, finishedUnits: finished };
    // One unit is left: 900 input tokens and two calls of 1,500 output tokens, $0.0318.
    const accepted = guardWith({ perReviewUsd: 0.1 }).preflight({ ...resume, spentOnRunUsd: 0.06 });
    expect(accepted.boundUsd).toBeCloseTo(0.0318, 12);
    // 0.0318 + 0.07 is over $0.1: refused, in the words of a resume, with what was used.
    const error = refusal(() =>
      guardWith({ perReviewUsd: 0.1 }).preflight({ ...resume, spentOnRunUsd: 0.07 }),
    );
    expect(error.kind).toBe("resume");
    expect(error.figures).toMatchObject({ usedUsd: 0.07, limitUsd: 0.1, heldUsd: 0 });
    expect(error.figures.boundUsd).toBeCloseTo(0.0318, 12);
    // The whole review, at the same spend, would have been refused sooner.
    expect(() =>
      guardWith({ perReviewUsd: 0.1 }).preflight({ ...start, spentOnRunUsd: 0.06 }),
    ).toThrow(SpendRefusedError);
  });

  it("has nothing to count for a review whose units all finished", () => {
    const all = new Set(PLAN.units.map(unitKey));
    expect(
      guardWith({ perReviewUsd: 0.01 }).preflight({
        kind: "resume",
        plan: PLAN,
        finishedUnits: all,
        spentOnRunUsd: 0.005,
      }).boundUsd,
    ).toBe(0);
  });
});

describe("the limit for a day", () => {
  it("counts what the ledger holds for the day, and refuses a bound that would pass the limit", () => {
    repo.addSpend({
      responses: 4,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.5,
      unpricedResponses: 0,
    });
    const guard = guardWith({ perDayUsd: 0.5 + BOUND - 0.0001 });
    const error = refusal(() => guard.preflight(start));
    expect(error.code).toBe("spend_over_daily_limit");
    expect(error.figures).toMatchObject({ usedUsd: 0.5, heldUsd: 0 });
    expect(error.figures.boundUsd).toBeCloseTo(BOUND, 12);
    // Equality is accepted.
    expect(
      guardWith({ perDayUsd: 0.5 + upperBoundUsd(PLAN, PRICE) }).preflight(start).boundUsd,
    ).toBeCloseTo(BOUND, 12);
  });

  it("does not count yesterday, and counts the new day from nothing", () => {
    repo.addSpend({
      responses: 1,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 9,
      unpricedResponses: 0,
    });
    const guard = guardWith({ perDayUsd: 9.05 });
    expect(() => guard.preflight(start)).toThrow(SpendRefusedError);
    now = new Date("2026-11-04T00:00:00.000Z");
    expect(guard.preflight(start).boundUsd).toBeCloseTo(BOUND, 12);
  });

  it("sets aside the bound of a review in progress, so that a start at the same moment sees it", () => {
    const guard = guardWith({ perDayUsd: BOUND * 1.5 });
    const first = guard.preflight(start);
    guard.reserve("run_a", { boundUsd: first.boundUsd, spentUsd: 0 });
    const error = refusal(() => guard.preflight(start));
    expect(error.code).toBe("spend_over_daily_limit");
    expect(error.figures.heldUsd).toBeCloseTo(BOUND, 12);
    expect(error.figures.usedUsd).toBe(0);
    // The words add the two: what is used and what is set aside.
    expect(error.userText()).toContain("$0.0806 is used or set aside");
  });

  it("accepts again once the review in progress has ended and released its hold", () => {
    const guard = guardWith({ perDayUsd: BOUND * 1.5 });
    guard.reserve("run_a", { boundUsd: BOUND, spentUsd: 0 });
    expect(() => guard.preflight(start)).toThrow(SpendRefusedError);
    guard.release("run_a");
    expect(guard.preflight(start).boundUsd).toBeCloseTo(BOUND, 12);
  });

  it("sets aside only what a review in progress has still to spend: its responses are in the ledger", async () => {
    const guard = guardWith({ perDayUsd: BOUND * 1.2 });
    guard.reserve("run_a", { boundUsd: BOUND, spentUsd: 0 });
    guard.begin("run_a", () => undefined);
    // Half the bound is spent by a response of the review: $0.04 in the ledger, $0.0406 still held.
    await runStore.run(createRunScope("run_a"), () =>
      guard.onUsage({
        inputTokens: 20_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    );
    expect(repo.spendToday().costUsd).toBeCloseTo(0.04, 12);
    const error = refusal(() => guard.preflight(start));
    expect(error.figures.usedUsd).toBeCloseTo(0.04, 12);
    expect(error.figures.heldUsd).toBeCloseTo(BOUND - 0.04, 12);
  });
});

describe("the order of the two limits", () => {
  it("refuses on the limit for one review before it looks at the day", () => {
    const guard = guardWith({ perReviewUsd: 0.01, perDayUsd: 0.01 });
    expect(refusal(() => guard.preflight(start)).code).toBe("spend_over_review_limit");
  });
});

describe("the words of a refusal", () => {
  it("name the limit, the bound and what to do, and nothing from a document or a person", () => {
    const review = refusal(() => guardWith({ perReviewUsd: 0.05 }).preflight(start)).userText();
    expect(review).toBe(
      "This review could cost up to $0.0806, and the limit for one review is $0.0500. Remove a " +
        "document you do not need, or ask whoever runs this server to raise the limit " +
        "(PAROL_MAX_REVIEW_COST_USD). The $0.0806 is an upper bound planned from the documents, " +
        "not a price quote.",
    );
    const day = refusal(() => guardWith({ perDayUsd: 0.05 }).preflight(start)).userText();
    expect(day).toContain("Today's limit of $0.0500 would be passed");
    expect(day).toContain("midnight UTC");
    expect(day).toContain("PAROL_MAX_DAILY_COST_USD");
    for (const text of [review, day])
      expect([...text].map((c) => c.codePointAt(0))).not.toEqual(expect.arrayContaining([0x2013]));
    for (const text of [review, day])
      expect([...text].map((c) => c.codePointAt(0))).not.toEqual(expect.arrayContaining([0x2014]));
  });
});
