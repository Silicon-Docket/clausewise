import { AsyncLocalStorage } from "node:async_hooks";
import type { AnthropicUsage } from "@clausewise/llm";

/**
 * Who a piece of usage belongs to.
 *
 * The provider's adapter reports usage and the model that answered through two hooks that carry no
 * identity: a callback with the token counts, and a `fetch` that sees the response. The engine runs
 * the three rules of one review at once and two reviews at once, so a counter that the hooks write
 * to would mix the calls up. Two `AsyncLocalStorage` stores say where the hooks are being called
 * from instead. `callModel` opens a collector around each call it makes, and the engine opens a
 * scope around each run. The adapter calls the hooks from the async chain that `generate` started,
 * so the store set around `generate` is the one they read.
 *
 * Nothing here holds text. A collector holds counts and plain model names.
 */

/** What the provider reported for the responses of ONE call, summed. */
export interface CallUsage {
  /** Responses that reported usage. A retry and a failed attempt each count. */
  responses: number;
  /** The uncached part of the prompt, as the adapter reports it. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The usage and the model names that arrived while one `generate` call was running. */
export class CallCollector {
  #usage: CallUsage | null = null;
  readonly #models = new Set<string>();
  readonly #reads = new Set<Promise<void>>();

  /**
   * Adds the usage of one response. A response whose counts are not whole numbers of 0 or more is
   * not counted: a gateway that sends such numbers is not giving the provider's accounting, and a
   * recorded figure must be a figure the provider reported.
   */
  add(usage: AnthropicUsage): void {
    if (
      !isCount(usage.inputTokens) ||
      !isCount(usage.outputTokens) ||
      !isCount(usage.cacheReadTokens) ||
      !isCount(usage.cacheWriteTokens)
    )
      return;
    const total = this.#usage ?? {
      responses: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    this.#usage = {
      responses: total.responses + 1,
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
    };
  }

  /** A plain model name from `modelOfResponse`. */
  addModel(model: string): void {
    this.#models.add(model);
  }

  /** Registers the read of a copied response body that is still running. */
  track(read: Promise<void>): void {
    this.#reads.add(read);
    void read.finally(() => this.#reads.delete(read));
  }

  /** Resolves once every tracked read is done. Never rejects. */
  async settled(): Promise<void> {
    while (this.#reads.size > 0) await Promise.allSettled([...this.#reads]);
  }

  /** The summed usage, or null when no response reported any. */
  usage(): CallUsage | null {
    return this.#usage === null ? null : { ...this.#usage };
  }

  /** The distinct model names, sorted. */
  models(): string[] {
    return [...this.#models].sort();
  }
}

/** Per run, opened by the engine around the whole job. */
export interface RunScope {
  readonly runId: string;
  /** Every plain model name any response of the run named. */
  readonly models: Set<string>;
}

export const createRunScope = (runId: string): RunScope => ({ runId, models: new Set() });

export const callStore = new AsyncLocalStorage<CallCollector>();
export const runStore = new AsyncLocalStorage<RunScope>();

export const currentCall = (): CallCollector | undefined => callStore.getStore();
export const currentRun = (): RunScope | undefined => runStore.getStore();
