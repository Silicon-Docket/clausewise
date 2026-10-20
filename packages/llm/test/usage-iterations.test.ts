import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createAnthropicGenerator,
  type AnthropicUsage,
  type AnthropicUsageAttempt,
} from "../src/index.js";
import { PROMPT_TEXT, makeConfig, messageResponse, recordingFetch } from "./anthropic-support.js";

const schema = z.object({ verdict: z.enum(["ok", "bad"]) });
const request = { system: "You review contracts.", prompt: PROMPT_TEXT, schema };
const answer = JSON.stringify({ verdict: "ok" });

function iteration(
  type: string,
  model: string,
  counts: [number, number, number, number],
): Record<string, unknown> {
  return {
    type,
    model,
    input_tokens: counts[0],
    output_tokens: counts[1],
    cache_read_input_tokens: counts[2],
    cache_creation_input_tokens: counts[3],
  };
}

async function usageOf(
  usage: Record<string, unknown>,
  config = makeConfig({ fallback: "default" }),
): Promise<AnthropicUsage> {
  const seen: AnthropicUsage[] = [];
  const { fetch } = recordingFetch(() => messageResponse(answer, { usage }));
  await createAnthropicGenerator(config, { fetch, onUsage: (item) => seen.push(item) }).generate(
    request,
  );
  expect(seen).toHaveLength(1);
  return seen[0] as AnthropicUsage;
}

describe("usage when server-side fallback ran", () => {
  // The top level describes only the attempt that produced the message. The declined attempt ran on
  // another model and is billed too, and only the iterations list it.
  const declined = iteration("message", "claude-sonnet-5-5", [1000, 40, 0, 200]);
  const served = iteration("fallback_message", "claude-sonnet-4-6", [1100, 25, 900, 0]);
  const topLevel = {
    input_tokens: 1100,
    output_tokens: 25,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 0,
  };

  it("sums the attempts instead of reporting the last one alone", async () => {
    const usage = await usageOf({ ...topLevel, iterations: [declined, served] });
    expect(usage).toMatchObject({
      inputTokens: 2100,
      outputTokens: 65,
      cacheReadTokens: 900,
      cacheWriteTokens: 200,
    });
  });

  it("lists each attempt with its model, so the cost can be priced per model", async () => {
    const usage = await usageOf({ ...topLevel, iterations: [declined, served] });
    const attempts = usage.attempts as readonly AnthropicUsageAttempt[];
    expect(attempts).toEqual([
      {
        model: "claude-sonnet-5-5",
        inputTokens: 1000,
        outputTokens: 40,
        cacheReadTokens: 0,
        cacheWriteTokens: 200,
      },
      {
        model: "claude-sonnet-4-6",
        inputTokens: 1100,
        outputTokens: 25,
        cacheReadTokens: 900,
        cacheWriteTokens: 0,
      },
    ]);
  });

  it("sums three attempts as well", async () => {
    const third = iteration("message", "claude-opus-5-5", [5, 5, 5, 5]);
    const usage = await usageOf({ ...topLevel, iterations: [declined, third, served] });
    expect(usage.inputTokens).toBe(2105);
    expect(usage.attempts).toHaveLength(3);
  });

  it("reports the top level alone when the API lists no iterations", async () => {
    for (const iterations of [undefined, null, []]) {
      const usage = await usageOf({ ...topLevel, iterations });
      expect(usage).toEqual({
        inputTokens: 1100,
        outputTokens: 25,
        cacheReadTokens: 900,
        cacheWriteTokens: 0,
      });
      expect(usage).not.toHaveProperty("attempts");
    }
  });

  it("reports the top level alone for a single iteration, which is the same figure", async () => {
    const usage = await usageOf({ ...topLevel, iterations: [served] });
    expect(usage).toEqual({
      inputTokens: 1100,
      outputTokens: 25,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
    });
  });

  it.each([
    ["an entry that is not an object", [declined, "nope"]],
    ["an entry without token counts", [declined, { type: "message", model: "m" }]],
    ["a negative count", [declined, iteration("message", "m", [-1, 1, 0, 0])]],
    ["a count that is not a number", [declined, { ...served, output_tokens: "25" }]],
    ["something that is not a list", { 0: declined, 1: served }],
  ])(
    "falls back to the top level when there is %s, rather than a total that is short",
    async (_name, iterations) => {
      const usage = await usageOf({ ...topLevel, iterations });
      expect(usage).toEqual({
        inputTokens: 1100,
        outputTokens: 25,
        cacheReadTokens: 900,
        cacheWriteTokens: 0,
      });
    },
  );

  it("carries only counts and model names, no text", async () => {
    const usage = await usageOf({ ...topLevel, iterations: [declined, served] });
    expect(Object.keys(usage).sort()).toEqual([
      "attempts",
      "cacheReadTokens",
      "cacheWriteTokens",
      "inputTokens",
      "outputTokens",
    ]);
  });

  it("applies to a response that comes through the plain endpoint as well", async () => {
    const usage = await usageOf({ ...topLevel, iterations: [declined, served] }, makeConfig());
    expect(usage.inputTokens).toBe(2100);
  });
});
