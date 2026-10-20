import type { AnthropicUsage } from "@clausewise/llm";

const count = (value: number): string => value.toLocaleString("en-US");

/** Adds up what the model reported for each response of one review. */
export interface TokenMeter {
  add(usage: AnthropicUsage): void;
  /** One line for the person who pays, or undefined when the provider reported nothing. */
  line(): string | undefined;
}

export function createTokenMeter(): TokenMeter {
  let responses = 0;
  let uncached = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  // A figure that is not a number would turn the whole total into NaN.
  const whole = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

  return {
    add(usage) {
      responses += 1;
      uncached += whole(usage.inputTokens);
      output += whole(usage.outputTokens);
      cacheRead += whole(usage.cacheReadTokens);
      cacheWrite += whole(usage.cacheWriteTokens);
    },
    line() {
      if (responses === 0) return undefined;
      const cached = [
        ...(cacheRead > 0 ? [`${count(cacheRead)} from cache`] : []),
        ...(cacheWrite > 0 ? [`${count(cacheWrite)} written to cache`] : []),
      ];
      const input = `${count(uncached + cacheRead + cacheWrite)} input`;
      return `Tokens: ${input}${cached.length > 0 ? ` (${cached.join(", ")})` : ""}, ${count(output)} output`;
    },
  };
}
