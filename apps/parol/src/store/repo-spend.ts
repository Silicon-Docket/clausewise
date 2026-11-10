import type { Ctx } from "./context.js";

/**
 * The daily spend ledger (package W2.x): aggregate counters of what the model calls cost, by UTC
 * day, with no matter, run, user or text in them. The ledger is not removed with a matter.
 *
 * Contract commit CC1: the signatures are the design's (W2.x section 4) and the bodies are the
 * stubs. The mount in `repo.ts` is final, so W2.x edits this file and not the one W2.7 owns.
 */

/** What one call adds to the day's row. Counts and a cost, never text. */
export interface SpendUsage {
  responses: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  unpricedResponses: number;
}

/** What the guard reads: today's total, by the UTC day of the repository's clock. */
export interface SpendToday {
  costUsd: number;
  responses: number;
  unpricedResponses: number;
}

export function createSpendApi(_ctx: Ctx) {
  return {
    /** An upsert on the UTC day of the clock, in one statement. Not audited: aggregate counters, no actor. */
    addSpend(_usage: SpendUsage): void {
      throw new Error("stub: W2.x"); // STUB(W2.x)
    },
    spendToday(): SpendToday {
      throw new Error("stub: W2.x"); // STUB(W2.x)
    },
  };
}
