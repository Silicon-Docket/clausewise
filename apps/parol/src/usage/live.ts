import { createObjectGenerator, type AnthropicUsage, type LlmConfig } from "@clausewise/llm";
import type { ObjectGenerator } from "@clausewise/llm";
import { createUsageSink, meteringFetch } from "./metering.js";
import { USAGE_PROVIDER } from "./summary.js";

/**
 * The one place the application builds a generator for a provider it does not control.
 *
 * Only the `anthropic` provider reports usage and takes a `fetch` of its own, so it is the only one
 * that is metered: its adapter is handed the usage hook and a `fetch` that reads the model named by
 * each response (`metering.ts`). The others are built as they are and record nothing; the run page
 * says so. Nothing else under `apps/parol/src` calls `createObjectGenerator`, so a live generator
 * cannot be built that skips the metering (a test scans for it).
 */
export function createLiveGenerator(
  llm: LlmConfig,
  options: {
    /** Stands in for the network. Default: the global `fetch`. For a test over a scripted wire. */
    fetch?: typeof globalThis.fetch;
    /** Also told of the usage of each response, after the call being made has been. */
    onUsage?: (usage: AnthropicUsage) => void;
  } = {},
): ObjectGenerator {
  if (llm.provider !== USAGE_PROVIDER) return createObjectGenerator(llm);
  return createObjectGenerator(llm, {
    onUsage: createUsageSink(options.onUsage),
    fetch: meteringFetch(options.fetch ?? globalThis.fetch),
  });
}
