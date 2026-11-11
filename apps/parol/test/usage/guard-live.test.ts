import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { callModel, type ModelCall } from "../../src/stages/analyze-call.js";
import { createRepository, openDatabase, type Repository } from "../../src/store/index.js";
import type { SpendStop } from "../../src/usage/errors.js";
import { createSpendGuard, type SpendGuard } from "../../src/usage/guard.js";
import { createLiveGenerator } from "../../src/usage/live.js";
import { parsePriceTable } from "../../src/usage/prices.js";
import { createRunScope, runStore } from "../../src/usage/scope.js";
import { anthropicConfig, messagesReply, pause, scriptedWire } from "./support.js";

/**
 * The spend guard around the real Anthropic adapter, over a wire the test scripts: nothing leaves
 * the machine and no key is real. What is shown is what the guard does with replies that a
 * conforming API does not send and a gateway can: usage that cannot be read, and a reply that is
 * not a Messages reply at all. A live provider has never answered these code paths.
 */

// $2 per million input tokens and $10 per million output tokens (invented).
const PRICE = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
const TABLE = parsePriceTable({ "model-a": PRICE });
// The request asks for 4,000 output tokens, which is $0.04 at the output rate, and a short prompt.
const CAP = 0.07;
const OK = { answer: "yes" };
const schema = z.object({ answer: z.string() });

const call = (
  generator: ModelCall<{ answer: string }>["generator"],
): ModelCall<{ answer: string }> => ({
  generator,
  signal: undefined,
  stage: "analyze",
  ruleKey: null,
  promptVersionId: "analyze.p1",
  attempt: 1,
  system: "system text",
  prompt: "prompt text",
  sharedPrefix: undefined,
  schema,
  schemaName: "scripted",
});

/** A Messages reply whose usage is whatever the test puts in it. */
const replyWithUsage = (usage: Record<string, unknown>): Response =>
  new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "model-a",
      content: [{ type: "text", text: JSON.stringify(OK) }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

let repo: Repository;
let guard: SpendGuard;
const stops: SpendStop[] = [];
const logs: string[] = [];

function setUp(limits: { perReviewUsd: number; perDayUsd: number }): void {
  guard = createSpendGuard({
    limits: { ...limits, assumedOutputTokens: 1500 },
    provider: "anthropic",
    model: "model-a",
    priceTable: TABLE,
    price: PRICE,
    repo,
    log: (line) => logs.push(line),
  });
  guard.reserve("run_x", { boundUsd: 0.1, spentUsd: 0 });
  guard.begin("run_x", (stop) => void stops.push(stop));
}

const inRun = <T>(work: () => Promise<T>): Promise<T> =>
  runStore.run(createRunScope("run_x"), work);

const settledWithin = async <T>(promise: Promise<T>, ms = 3000): Promise<T | "waiting"> =>
  Promise.race([promise, pause(ms).then(() => "waiting" as const)]);

beforeEach(() => {
  repo = createRepository(openDatabase(":memory:"), {
    now: () => new Date("2026-11-03T10:00:00.000Z"),
  });
  stops.length = 0;
  logs.length = 0;
});

describe("a reply whose usage cannot be read", () => {
  const BAD: [string, Record<string, unknown>][] = [
    ["a fractional input count", { input_tokens: 1.5, output_tokens: 3999 }],
    ["a negative input count", { input_tokens: -7, output_tokens: 3999 }],
    ["an input count beyond a safe integer", { input_tokens: 1e300, output_tokens: 3999 }],
    [
      "a cache count that is a string",
      { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: "5" },
    ],
  ];

  for (const [name, usage] of BAD)
    it(`is charged at the worst case of its request, not counted as free: ${name}`, async () => {
      setUp({ perReviewUsd: CAP, perDayUsd: 10 });
      const wire = scriptedWire([() => replyWithUsage(usage)]);
      const generator = createLiveGenerator(anthropicConfig({ maxRetries: 0 }), {
        fetch: wire.fetch,
        guard,
      });
      const result = await inRun(() => callModel(call(generator)));
      // The answer is a normal one and it is used.
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The record of the call keeps what the provider did not report as not reported.
      expect(result.record("ok")).toMatchObject({
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      });
      // The guard did not take it for free.
      const spent = repo.spendToday();
      expect(spent.responses).toBe(1);
      expect(spent.costUsd).toBeGreaterThan(0.04);
      expect(spent.costUsd).toBeLessThan(CAP);

      // A second call would pass the limit of one review with the first one's charge in it.
      const second = await inRun(() => callModel(call(generator)));
      expect(second.ok).toBe(false);
      expect(wire.sent).toBe(1);
      expect(stops.map((s) => s.kind)).toEqual(["review_limit"]);
    });

  it("is charged for every call, so that the daily limit can trip", async () => {
    setUp({ perReviewUsd: 10, perDayUsd: 0.1 });
    const wire = scriptedWire([() => replyWithUsage({ input_tokens: 0.5, output_tokens: 1 })]);
    const generator = createLiveGenerator(anthropicConfig({ maxRetries: 0 }), {
      fetch: wire.fetch,
      guard,
    });
    for (let n = 0; n < 5; n++) await inRun(() => callModel(call(generator)));
    expect(stops.map((s) => s.kind)).toContain("daily_limit");
    expect(wire.sent).toBeLessThanOrEqual(3);
    expect(repo.spendToday().costUsd).toBeGreaterThan(0.04 * (wire.sent - 1));
  });

  it("does not change what a readable reply is charged", async () => {
    setUp({ perReviewUsd: CAP, perDayUsd: 10 });
    const wire = scriptedWire([
      () => messagesReply({ answer: OK, usage: { input: 10, output: 20 } }),
    ]);
    const generator = createLiveGenerator(anthropicConfig({ maxRetries: 0 }), {
      fetch: wire.fetch,
      guard,
    });
    const result = await inRun(() => callModel(call(generator)));
    expect(result.ok).toBe(true);
    // 10 x 2 + 20 x 10, per million.
    expect(repo.spendToday().costUsd).toBeCloseTo(0.00022, 12);
    expect(logs).toEqual([]);
  });
});

describe("a reply that is not a Messages reply", () => {
  const gateway = (): Response =>
    new Response(JSON.stringify({ error: "gateway" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("does not leave the next call of the run waiting for a response that never comes", async () => {
    // Room for one request at its worst case and not for two.
    setUp({ perReviewUsd: CAP, perDayUsd: 10 });
    const wire = scriptedWire([gateway]);
    const generator = createLiveGenerator(anthropicConfig({ maxRetries: 0 }), {
      fetch: wire.fetch,
      guard,
    });
    for (let n = 0; n < 4; n++) {
      const result = await settledWithin(inRun(() => callModel(call(generator))));
      expect(result, `call ${n + 1}`).not.toBe("waiting");
      if (result === "waiting") return;
      expect(result.ok).toBe(false);
    }
    expect(wire.sent).toBe(4);
    // Nothing was spent and nothing stopped the run: every call failed as a call.
    expect(repo.spendToday()).toMatchObject({ costUsd: 0, responses: 0 });
    expect(stops).toEqual([]);
  });

  it("still sends the retry of a call whose first reply was an error (a control: the share of an error was always given back)", async () => {
    // The adapter sends the request again after a stream that broke with a transient error; the
    // first request's usage never arrived. Here the first reply is a 529, whose retry is the SDK's.
    setUp({ perReviewUsd: CAP, perDayUsd: 10 });
    const wire = scriptedWire([
      () => new Response("{}", { status: 529, headers: { "retry-after-ms": "1" } }),
      () => messagesReply({ answer: OK, usage: { input: 10, output: 20 } }),
    ]);
    const generator = createLiveGenerator(anthropicConfig({ maxRetries: 2 }), {
      fetch: wire.fetch,
      guard,
    });
    const result = await settledWithin(inRun(() => callModel(call(generator))));
    expect(result).not.toBe("waiting");
    expect(wire.sent).toBe(2);
  });
});
