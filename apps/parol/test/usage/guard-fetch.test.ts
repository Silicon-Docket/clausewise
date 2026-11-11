import { beforeEach, describe, expect, it } from "vitest";
import { createRepository, openDatabase, type Repository } from "../../src/store/index.js";
import { SpendStop } from "../../src/usage/errors.js";
import { createSpendGuard, worstCaseUsd, type SpendGuard } from "../../src/usage/guard.js";
import { parsePriceTable } from "../../src/usage/prices.js";
import { createRunScope, runStore } from "../../src/usage/scope.js";

/**
 * The cap on each request, without an engine: what the guarded `fetch` lets through, holds back
 * and refuses, and what it does when a response arrives. The requests are small JSON bodies the
 * test writes, the rates are invented and the network is a function that counts what reaches it.
 */

// $2 per million input tokens and $10 per million output tokens (invented).
const PRICE = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
const TABLE = parsePriceTable({ "model-a": PRICE });

/** A request body: `maxTokens` of output at $10 per million is `maxTokens / 100000` dollars, and the prompt is on top. */
const body = (maxTokens: unknown, prompt = "p"): string =>
  JSON.stringify({ max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] });
const INIT = (maxTokens: unknown = 10_000, signal?: AbortSignal): RequestInit => ({
  method: "POST",
  body: body(maxTokens),
  ...(signal === undefined ? {} : { signal }),
});
// 10,000 output tokens: $0.1 and a prompt of a few bytes.
const WORST = worstCaseUsd(body(10_000), PRICE);

let repo: Repository;
let guard: SpendGuard;
const stops: SpendStop[] = [];
const logs: string[] = [];
let reaching: number;
let network: typeof globalThis.fetch;

const usage = (inputTokens: number, outputTokens = 0) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

function build(limits: { perReviewUsd: number; perDayUsd: number }): void {
  guard = createSpendGuard({
    limits: { ...limits, assumedOutputTokens: 1500 },
    provider: "anthropic",
    model: "model-a",
    priceTable: TABLE,
    price: PRICE,
    repo,
    log: (line) => logs.push(line),
  });
}

/** Runs `fn` as the work of a run that the guard knows. */
const inRun = <T>(runId: string, fn: () => Promise<T>): Promise<T> =>
  runStore.run(createRunScope(runId), fn);

function begin(runId: string, hold = { boundUsd: 0.5, spentUsd: 0 }): void {
  guard.reserve(runId, hold);
  guard.begin(runId, (stop) => void stops.push(stop));
}

beforeEach(() => {
  repo = createRepository(openDatabase(":memory:"), {
    now: () => new Date("2026-11-03T10:00:00.000Z"),
  });
  stops.length = 0;
  logs.length = 0;
  reaching = 0;
  network = async () => {
    reaching += 1;
    return new Response("{}", { status: 200 });
  };
  build({ perReviewUsd: 1, perDayUsd: 10 });
});

describe("a request that fits", () => {
  it("is sent as it was, and its response is returned as it came", async () => {
    begin("run_a");
    const response = await inRun("run_a", () =>
      guard.guardFetch(network)("https://x.invalid", INIT()),
    );
    expect(reaching).toBe(1);
    expect(await response.text()).toBe("{}");
    expect(stops).toEqual([]);
  });
});

describe("a request that could pass the limit for one review", () => {
  it("is not sent: the run is told to stop with the kind, and the request fails with the same stop", async () => {
    build({ perReviewUsd: WORST * 0.9, perDayUsd: 10 });
    begin("run_a");
    const failed = inRun("run_a", () => guard.guardFetch(network)("https://x.invalid", INIT()));
    await expect(failed).rejects.toBeInstanceOf(SpendStop);
    await failed.catch((error: SpendStop) => expect(error.kind).toBe("review_limit"));
    expect(reaching).toBe(0);
    expect(stops.map((s) => s.kind)).toEqual(["review_limit"]);
    // The stop carries a fixed message, with no figure and no text of the request.
    expect(stops[0]?.message).toBe("the review was stopped by the spend limit");
  });

  it("counts what the review used before it was resumed", async () => {
    build({ perReviewUsd: WORST * 1.5, perDayUsd: 10 });
    begin("run_a", { boundUsd: 0.5, spentUsd: WORST });
    await expect(
      inRun("run_a", () => guard.guardFetch(network)("https://x.invalid", INIT())),
    ).rejects.toBeInstanceOf(SpendStop);
    expect(stops.map((s) => s.kind)).toEqual(["review_limit"]);
  });
});

describe("a request that could pass the limit for the day", () => {
  it("is not sent, whoever's spend filled the day", async () => {
    build({ perReviewUsd: 100, perDayUsd: 0.5 });
    repo.addSpend({
      responses: 1,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.5 - WORST * 0.5,
      unpricedResponses: 0,
    });
    begin("run_a");
    await expect(
      inRun("run_a", () => guard.guardFetch(network)("https://x.invalid", INIT())),
    ).rejects.toBeInstanceOf(SpendStop);
    expect(reaching).toBe(0);
    expect(stops.map((s) => s.kind)).toEqual(["daily_limit"]);
  });
});

describe("a request that fits only when the requests in flight have settled", () => {
  // Room for one request at its worst case and not for two: the second waits for the first.
  const limits = { perReviewUsd: WORST * 1.5, perDayUsd: 100 };

  it("waits, and is sent once the first has given back what it reserved", async () => {
    build(limits);
    begin("run_a");
    const fetch = guard.guardFetch(async () => {
      reaching += 1;
      return new Response("{}", { status: 200 });
    });
    const order: string[] = [];
    await inRun("run_a", async () => {
      const first = fetch("https://x.invalid", INIT()).then(() => order.push("first sent"));
      const second = fetch("https://x.invalid", INIT()).then(() => order.push("second sent"));
      await first;
      // Let the second reach the wait, then settle the first: its response brings its usage.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(reaching).toBe(1);
      guard.onUsage(usage(1000, 100));
      await second;
    });
    expect(order).toEqual(["first sent", "second sent"]);
    expect(reaching).toBe(2);
    expect(stops).toEqual([]);
  });

  it("is stopped instead if it would not fit even then", async () => {
    build({ perReviewUsd: WORST * 1.5, perDayUsd: 100 });
    begin("run_a", { boundUsd: 0.5, spentUsd: 0 });
    const fetch = guard.guardFetch(network);
    await inRun("run_a", async () => {
      await fetch("https://x.invalid", INIT());
      // A response that cost nearly what the request was allowed to: $0.1 of the limit is used.
      guard.onUsage(usage(0, 10_000));
      await expect(fetch("https://x.invalid", INIT())).rejects.toBeInstanceOf(SpendStop);
    });
    expect(stops.map((s) => s.kind)).toEqual(["review_limit"]);
    expect(reaching).toBe(1);
  });

  it("stops waiting when the request's own signal is aborted", async () => {
    build(limits);
    begin("run_a");
    const fetch = guard.guardFetch(network);
    const controller = new AbortController();
    await inRun("run_a", async () => {
      await fetch("https://x.invalid", INIT());
      const waiting = fetch("https://x.invalid", INIT(10_000, controller.signal));
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.abort(new Error("cancelled"));
      await expect(waiting).rejects.toThrow("cancelled");
    });
    expect(reaching).toBe(1);
    expect(stops).toEqual([]);
  });

  it("is let through when the run that held room has ended", async () => {
    build({ perReviewUsd: 100, perDayUsd: WORST * 1.5 });
    begin("run_a");
    begin("run_b");
    const fetch = guard.guardFetch(network);
    await inRun("run_a", () => fetch("https://x.invalid", INIT()));
    const second = inRun("run_b", () => fetch("https://x.invalid", INIT()));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reaching).toBe(1);
    // The first run ends without a response being recorded: its reservation is given back.
    guard.release("run_a");
    await second;
    expect(reaching).toBe(2);
  });

  it("gives the room back when a response is an error", async () => {
    build(limits);
    begin("run_a");
    let answer = 503;
    const fetch = guard.guardFetch(async () => {
      reaching += 1;
      return new Response("{}", { status: answer });
    });
    await inRun("run_a", async () => {
      await fetch("https://x.invalid", INIT());
      answer = 200;
      // Nothing is waiting for a settle, because the error gave its share back.
      await fetch("https://x.invalid", INIT());
    });
    expect(reaching).toBe(2);
  });

  it("gives the room back when the network fails", async () => {
    build(limits);
    begin("run_a");
    let fail = true;
    const fetch = guard.guardFetch(async () => {
      if (fail) throw new TypeError("network");
      reaching += 1;
      return new Response("{}", { status: 200 });
    });
    await inRun("run_a", async () => {
      await expect(fetch("https://x.invalid", INIT())).rejects.toThrow("network");
      fail = false;
      await fetch("https://x.invalid", INIT());
    });
    expect(reaching).toBe(1);
  });
});

describe("a request that cannot be sized", () => {
  it("is not sent, whatever the limits are, and ends the run as a fault of Parol", async () => {
    begin("run_a");
    for (const init of [
      { method: "POST", body: body(undefined) },
      { method: "POST", body: body("4000") },
      { method: "POST", body: "{ not json" },
      { method: "POST" },
      { method: "POST", body: new Uint8Array([1]) as unknown as string },
    ]) {
      await expect(
        inRun("run_a", () => guard.guardFetch(network)("https://x.invalid", init)),
      ).rejects.toBeInstanceOf(SpendStop);
    }
    expect(reaching).toBe(0);
    expect(new Set(stops.map((s) => s.kind))).toEqual(new Set(["unsizable_request"]));
  });
});

describe("a request that belongs to no run", () => {
  it("is not sent: nothing it cost could be counted against a review", async () => {
    // Outside any scope, and inside the scope of a run the guard does not hold.
    await expect(guard.guardFetch(network)("https://x.invalid", INIT())).rejects.toMatchObject({
      kind: "no_run_scope",
    });
    await expect(
      inRun("run_unknown", () => guard.guardFetch(network)("https://x.invalid", INIT())),
    ).rejects.toMatchObject({ kind: "no_run_scope" });
    expect(reaching).toBe(0);
    expect(stops).toEqual([]);
  });

  it("is counted in the ledger when its usage arrives, and in no run", () => {
    guard.onUsage(usage(1_000_000, 0));
    expect(repo.spendToday()).toMatchObject({ costUsd: 2, responses: 1 });
    expect(stops).toEqual([]);
  });
});

describe("the usage of a response", () => {
  it("is priced at the configured model's rates and written to the ledger at once, with its counts", async () => {
    begin("run_a");
    await inRun("run_a", async () =>
      guard.onUsage({
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 300,
        cacheWriteTokens: 40,
      }),
    );
    // 1000 x 2 + 200 x 10 + 300 x 0.2 + 40 x 2.5 = 4160, per million.
    expect(repo.spendToday().costUsd).toBeCloseTo(0.00416, 12);
    expect(
      repo.db
        .prepare(
          "SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, responses FROM spend_ledger",
        )
        .get(),
    ).toEqual({
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_tokens: 300,
      cache_write_tokens: 40,
      responses: 1,
    });
  });

  it("is not counted when a figure is not a whole number of 0 or more", async () => {
    begin("run_a");
    await inRun("run_a", async () => {
      guard.onUsage({ inputTokens: -1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
      guard.onUsage({ inputTokens: 1.5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
      guard.onUsage({
        inputTokens: Number.NaN,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    });
    expect(repo.spendToday()).toMatchObject({ costUsd: 0, responses: 0 });
  });

  it("stops the review when the recorded spend passes its limit, and does not throw", async () => {
    build({ perReviewUsd: 0.01, perDayUsd: 10 });
    begin("run_a");
    await inRun("run_a", async () => {
      expect(() => guard.onUsage(usage(10_000, 0))).not.toThrow();
    });
    // $0.02 against a limit of $0.01.
    expect(stops.map((s) => s.kind)).toEqual(["review_limit"]);
  });

  it("stops the review when the day's recorded spend passes its limit", async () => {
    build({ perReviewUsd: 100, perDayUsd: 0.01 });
    begin("run_a");
    await inRun("run_a", async () => guard.onUsage(usage(10_000, 0)));
    expect(stops.map((s) => s.kind)).toEqual(["daily_limit"]);
  });

  it("does not stop a review that is under both", async () => {
    begin("run_a");
    await inRun("run_a", async () => guard.onUsage(usage(10_000, 0)));
    expect(stops).toEqual([]);
  });

  it("uses a stop that is told once to each run: a stop for one run is not sent to another", async () => {
    build({ perReviewUsd: 0.01, perDayUsd: 100 });
    const other: SpendStop[] = [];
    guard.reserve("run_b", { boundUsd: 0.1, spentUsd: 0 });
    guard.begin("run_b", (stop) => void other.push(stop));
    begin("run_a");
    await inRun("run_a", async () => guard.onUsage(usage(10_000, 0)));
    expect(stops).toHaveLength(1);
    expect(other).toEqual([]);
  });
});

describe("a run that was not reserved", () => {
  it("is held to the limits all the same, counting what this execution used", async () => {
    build({ perReviewUsd: WORST * 1.5, perDayUsd: 10 });
    // `begin` without `reserve`: a run that did not come through the run service.
    guard.begin("run_loose", (stop) => void stops.push(stop));
    const fetch = guard.guardFetch(network);
    await inRun("run_loose", async () => {
      await fetch("https://x.invalid", INIT());
      guard.onUsage(usage(0, 10_000));
      await expect(fetch("https://x.invalid", INIT())).rejects.toBeInstanceOf(SpendStop);
    });
    expect(stops.map((s) => s.kind)).toEqual(["review_limit"]);
  });
});
