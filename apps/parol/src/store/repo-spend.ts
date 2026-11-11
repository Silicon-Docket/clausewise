import type { Ctx } from "./context.js";
import { ValidationError } from "./errors.js";

/**
 * The daily spend ledger (package W2.x): aggregate counters of what the model calls cost, by UTC
 * day, with no matter, run, user or text in them.
 *
 * It exists apart from `model_calls` because those rows are deleted with their matter, and a daily
 * limit that a deletion could lower would not be a limit. The ledger is therefore not removed with
 * a matter and not touched by the retention job: it holds a date and numbers. The database refuses
 * to lower a counter and to delete a row (migration 004).
 *
 * It is written when a response's usage arrives (usage/guard.ts), not when a unit finishes, so a
 * unit cut short by a stop or a cancel still counts in the day's total.
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

const COUNTS = [
  "responses",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "unpricedResponses",
] as const;

interface RawToday {
  cost_usd: number;
  responses: number;
  unpriced_responses: number;
}

/** The UTC day of an ISO timestamp, as `2026-11-10`. */
const dayOf = (iso: string): string => iso.slice(0, 10);

export function createSpendApi(ctx: Ctx) {
  return {
    /**
     * Adds to the row of the UTC day of the clock, creating it. One statement, so two writers
     * cannot lose an update. Not audited: these are aggregate counters with no actor, like the
     * rows of `model_calls` the engine writes.
     */
    addSpend(usage: SpendUsage): void {
      for (const name of COUNTS) {
        const value = usage[name];
        if (!Number.isSafeInteger(value) || value < 0)
          throw new ValidationError(
            "bad_spend",
            "a spend count must be a whole number of 0 or more",
          );
      }
      if (!Number.isFinite(usage.costUsd) || usage.costUsd < 0)
        throw new ValidationError("bad_spend", "spend cost must be a number of 0 or more");
      const at = ctx.now();
      ctx.run(
        `INSERT INTO spend_ledger
           (day, responses, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
            cost_usd, unpriced_responses, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (day) DO UPDATE SET
           responses = responses + excluded.responses,
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
           cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
           cost_usd = cost_usd + excluded.cost_usd,
           unpriced_responses = unpriced_responses + excluded.unpriced_responses,
           updated_at = excluded.updated_at`,
        dayOf(at),
        usage.responses,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheReadTokens,
        usage.cacheWriteTokens,
        usage.costUsd,
        usage.unpricedResponses,
        at,
      );
    },

    /** Today's total: zero on a day with no row. */
    spendToday(): SpendToday {
      const row = ctx.get<RawToday>(
        "SELECT cost_usd, responses, unpriced_responses FROM spend_ledger WHERE day = ?",
        dayOf(ctx.now()),
      );
      return {
        costUsd: row?.cost_usd ?? 0,
        responses: row?.responses ?? 0,
        unpricedResponses: row?.unpriced_responses ?? 0,
      };
    },
  };
}
