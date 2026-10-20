import { describe, expect, it } from "vitest";
import { createObjectGenerator } from "../src/index.js";
import { createScriptedGenerator } from "../src/testing.js";
import { makeConfig } from "./anthropic-support.js";

// The documented minimum cacheable prompt length per model, times four characters per token.
describe("minCacheableChars", () => {
  it.each([
    ["claude-sonnet-5-5", 512],
    ["claude-opus-5-5", 512],
    ["claude-opus-5", 512],
    ["claude-haiku-5-5", 512],
    ["claude-fable-5", 512],
    ["claude-fable-5-1", 512],
    ["claude-mythos-5", 512],
    ["claude-mythos-5-1", 512],
    ["claude-sonnet-5", 1024],
    ["claude-opus-4-8", 1024],
    ["claude-sonnet-4-6", 1024],
    ["claude-sonnet-4-5", 1024],
    ["claude-sonnet-4-5-20250929", 1024],
    ["claude-opus-4-1-20250805", 1024],
    ["claude-opus-4-20250514", 1024],
    ["claude-sonnet-4-20250514", 1024],
    ["claude-opus-4-7", 2048],
    ["claude-mythos-preview", 2048],
    ["claude-3-5-haiku-20241022", 2048],
    ["claude-opus-4-6", 4096],
    ["claude-opus-4-5", 4096],
    ["claude-haiku-4-5", 4096],
    ["claude-haiku-4-5-20251001", 4096],
    ["Claude-Sonnet-5-5", 512],
  ])("is four characters per token of the documented minimum for %s", (model, tokens) => {
    const generator = createObjectGenerator(makeConfig({ model }));
    expect(generator.minCacheableChars).toBe(tokens * 4);
    expect(generator.cachesSharedPrefix).toBe(true);
  });

  it("is 2048 characters for the default model", () => {
    expect(createObjectGenerator(makeConfig()).minCacheableChars).toBe(2048);
  });

  it.each([
    "my-gateway-alias",
    "claude-future-9",
    "claude-sonnet-5-5-extended",
    "claude-opus-5-6",
    "",
  ])("is left unset for %j, whose minimum is not documented", (model) => {
    const generator = createObjectGenerator(makeConfig({ model }));
    expect(generator.minCacheableChars).toBeUndefined();
    expect(generator).not.toHaveProperty("minCacheableChars");
    expect(generator.cachesSharedPrefix).toBe(true);
  });

  it.each(["openai", "openai-compatible"] as const)("is left unset for %s", (provider) => {
    const generator = createObjectGenerator(
      makeConfig({
        provider,
        model: "claude-sonnet-5-5",
        baseUrl: "http://localhost:11434/v1",
        apiKey: undefined,
      }),
    );
    expect(generator).not.toHaveProperty("minCacheableChars");
    expect(generator.cachesSharedPrefix).toBeUndefined();
  });
});

describe("the scripted generator", () => {
  it("states a floor only when it is given one", () => {
    expect(createScriptedGenerator(() => ({}))).not.toHaveProperty("minCacheableChars");
    expect(
      createScriptedGenerator(() => ({}), { cachesSharedPrefix: true, minCacheableChars: 100 })
        .minCacheableChars,
    ).toBe(100);
  });
});
