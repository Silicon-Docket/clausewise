import { describe, expect, it } from "vitest";
import { createTokenMeter } from "../src/tokens.js";

describe("the token meter", () => {
  it("has nothing to say before the provider reports a response", () => {
    expect(createTokenMeter().line()).toBeUndefined();
  });

  it("adds the responses up and counts cached tokens as input", () => {
    const meter = createTokenMeter();
    meter.add({
      inputTokens: 3130,
      outputTokens: 2000,
      cacheReadTokens: 30000,
      cacheWriteTokens: 0,
    });
    meter.add({ inputTokens: 0, outputTokens: 1980, cacheReadTokens: 8100, cacheWriteTokens: 0 });

    expect(meter.line()).toBe("Tokens: 41,230 input (38,100 from cache), 3,980 output");
  });

  it("names cache writes and leaves out a cache that was not used", () => {
    const written = createTokenMeter();
    written.add({ inputTokens: 100, outputTokens: 5, cacheReadTokens: 40, cacheWriteTokens: 2500 });
    const plain = createTokenMeter();
    plain.add({ inputTokens: 1200, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 });

    expect(written.line()).toBe(
      "Tokens: 2,640 input (40 from cache, 2,500 written to cache), 5 output",
    );
    expect(plain.line()).toBe("Tokens: 1,200 input, 80 output");
  });

  it("ignores a figure that is not a usable number", () => {
    const meter = createTokenMeter();
    meter.add({
      inputTokens: Number.NaN,
      outputTokens: -5,
      cacheReadTokens: Number.POSITIVE_INFINITY,
      cacheWriteTokens: 7,
    });

    expect(meter.line()).toBe("Tokens: 7 input (7 written to cache), 0 output");
  });
});
