import { ModelOutputError } from "@clausewise/llm";
import type { GenerateObjectRequest, ObjectGenerator } from "@clausewise/llm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { callModel, type ModelCall } from "../../src/stages/analyze-call.js";
import { createUsageSink, noteModel } from "../../src/usage/metering.js";
import { currentCall } from "../../src/usage/scope.js";
import { pause } from "../usage/support.js";

/**
 * What `callModel` writes into a call record's token fields: what the hooks reported while the call
 * ran, summed, and nothing when they reported nothing. The generators here report the way the
 * Anthropic adapter does, by calling the sink from inside `generate`.
 */

const sink = createUsageSink();
const schema = z.object({ answer: z.string() });

function generatorOf(
  generate: (request: GenerateObjectRequest<unknown>) => Promise<unknown>,
): ObjectGenerator {
  return {
    provider: "anthropic",
    model: "model-a",
    disclosure: "a scripted wire",
    generate: (request) => generate(request as GenerateObjectRequest<unknown>) as never,
  };
}

const callOf = (generator: ObjectGenerator, prompt = "prompt"): ModelCall<{ answer: string }> => ({
  generator,
  signal: undefined,
  stage: "analyze",
  ruleKey: "dur-1",
  promptVersionId: "analyze.p1",
  attempt: 1,
  system: "system",
  prompt,
  sharedPrefix: undefined,
  schema,
  schemaName: "scripted",
});

const usage = (input: number, output = 0, read = 0, write = 0) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: read,
  cacheWriteTokens: write,
});

const NULLS = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
};

describe("callModel and usage", () => {
  it("records the tokens the provider reported while the call ran", async () => {
    const generator = generatorOf(async () => {
      await pause(1);
      sink(usage(100, 20, 30, 10));
      return { answer: "yes" };
    });
    const result = await callModel(callOf(generator));
    expect(result.ok && result.record("ok")).toMatchObject({
      outcome: "ok",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
    });
  });

  it("records null in all four when nothing was reported, as a scripted generator leaves them", async () => {
    const result = await callModel(callOf(generatorOf(async () => ({ answer: "yes" }))));
    expect(result.ok && result.record("ok")).toMatchObject(NULLS);
    // A model name alone is not usage.
    const named = await callModel(
      callOf(
        generatorOf(async () => {
          noteModel("model-a");
          return { answer: "yes" };
        }),
      ),
    );
    expect(named.ok && named.record("ok")).toMatchObject(NULLS);
  });

  it("records the tokens of a call that then failed, because the provider billed them", async () => {
    const generator = generatorOf(async () => {
      sink(usage(40, 4));
      throw new ModelOutputError("the reply did not fit");
    });
    const result = await callModel(callOf(generator));
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.record).toMatchObject({
      outcome: "schema_error",
      inputTokens: 40,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("sums the responses of a call that was tried again inside the generator", async () => {
    const generator = generatorOf(async () => {
      sink(usage(10, 1));
      sink(usage(20, 2));
      return { answer: "yes" };
    });
    const result = await callModel(callOf(generator));
    expect(result.ok && result.record("semantic_error")).toMatchObject({
      outcome: "semantic_error",
      inputTokens: 30,
      outputTokens: 3,
    });
  });

  it("does not count a response whose numbers cannot be tokens", async () => {
    const generator = generatorOf(async () => {
      sink(usage(-5));
      sink(usage(1.5));
      return { answer: "yes" };
    });
    const result = await callModel(callOf(generator));
    expect(result.ok && result.record("ok")).toMatchObject(NULLS);
  });

  it("keeps the usage of calls in flight together apart, whichever answers first", async () => {
    const slow = generatorOf(async () => {
      await pause(40);
      sink(usage(1000, 100));
      return { answer: "slow" };
    });
    const fast = generatorOf(async () => {
      await pause(2);
      sink(usage(7, 1));
      return { answer: "fast" };
    });
    const [a, b] = await Promise.all([callModel(callOf(slow)), callModel(callOf(fast))]);
    expect(a.ok && a.record("ok").inputTokens).toBe(1000);
    expect(b.ok && b.record("ok").inputTokens).toBe(7);
  });

  it("ends the latency before it waits for the copy of a response to be read", async () => {
    const generator = generatorOf(async () => {
      // The adapter has its answer; a copy of the body is still being read for the model name.
      currentCall()?.track(pause(150));
      sink(usage(5));
      return { answer: "yes" };
    });
    const started = performance.now();
    const result = await callModel(callOf(generator));
    const total = performance.now() - started;
    expect(total).toBeGreaterThanOrEqual(140);
    expect(result.ok && result.record("ok").latencyMs).toBeLessThan(100);
    expect(result.ok && result.record("ok").inputTokens).toBe(5);
  });

  it("waits for that read before it fails a call too, and still never throws for a model failure", async () => {
    const generator = generatorOf(async () => {
      currentCall()?.track(pause(60));
      sink(usage(9));
      throw new Error("the provider said something with words in it");
    });
    const started = performance.now();
    const result = await callModel(callOf(generator));
    expect(performance.now() - started).toBeGreaterThanOrEqual(50);
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.record).toMatchObject({
      outcome: "transport",
      inputTokens: 9,
    });
    expect(JSON.stringify(result)).not.toContain("words in it");
  });

  it("still lets an abort through, and records nothing for it", async () => {
    const controller = new AbortController();
    const generator = generatorOf(async () => {
      sink(usage(3));
      controller.abort(new Error("stopped"));
      throw new DOMException("aborted", "AbortError");
    });
    await expect(callModel({ ...callOf(generator), signal: controller.signal })).rejects.toThrow();
  });
});
