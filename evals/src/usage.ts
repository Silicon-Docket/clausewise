import type { AnthropicUsage, ObjectGenerator } from "@clausewise/llm";
import { costOf, type Price, type TokenCounts } from "./prices.js";

/** Token counts summed over the responses the API returned. */
export interface UsageTotals extends TokenCounts {
  /** Responses that reported usage. A call that is retried reports once per response. */
  responses: number;
}

export const emptyUsage = (): UsageTotals => ({
  responses: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export function addUsage(into: UsageTotals, usage: AnthropicUsage): void {
  into.responses += 1;
  into.inputTokens += usage.inputTokens;
  into.outputTokens += usage.outputTokens;
  into.cacheReadTokens += usage.cacheReadTokens;
  into.cacheWriteTokens += usage.cacheWriteTokens;
}

export function sumUsage(items: readonly UsageTotals[]): UsageTotals {
  const total = emptyUsage();
  for (const item of items) {
    total.responses += item.responses;
    total.inputTokens += item.inputTokens;
    total.outputTokens += item.outputTokens;
    total.cacheReadTokens += item.cacheReadTokens;
    total.cacheWriteTokens += item.cacheWriteTokens;
  }
  return total;
}

export interface CacheStats {
  /** Every token of every prompt, cached or not. */
  promptTokens: number;
  /** The share of prompt tokens that was read from the cache. */
  readShare: number | null;
  /** What the same tokens would have cost with no caching at all. */
  costWithoutCaching: number;
  costWithCaching: number;
  /** The share of that cost the cache saved. Negative when writing the cache cost more. */
  saving: number | null;
}

/** How well prompt caching worked, which is what makes a review of many rules affordable. */
export function cacheStats(usage: UsageTotals, price: Price): CacheStats {
  const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const costWithCaching = costOf(usage, price);
  const costWithoutCaching = costOf(
    { ...usage, inputTokens: promptTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
    price,
  );
  return {
    promptTokens,
    readShare: promptTokens === 0 ? null : usage.cacheReadTokens / promptTokens,
    costWithoutCaching,
    costWithCaching,
    saving: costWithoutCaching === 0 ? null : 1 - costWithCaching / costWithoutCaching,
  };
}

/**
 * Wraps a generator to count its calls. The wrapper keeps `cachesSharedPrefix` because the
 * pipeline changes the order of its calls for a provider that caches, and a count taken with a
 * different order would not be of the real thing.
 */
export function counted(inner: ObjectGenerator, onCall: () => void): ObjectGenerator {
  return {
    provider: inner.provider,
    model: inner.model,
    disclosure: inner.disclosure,
    ...(inner.cachesSharedPrefix === undefined
      ? {}
      : { cachesSharedPrefix: inner.cachesSharedPrefix }),
    generate: (request) => {
      onCall();
      return inner.generate(request);
    },
  };
}
