import { readFileSync } from "node:fs";
import { z } from "zod";
import { hashOf } from "../canonical.js";
import type { CallRecord } from "../contracts.js";

/**
 * Prices, and the cost they give to a call.
 *
 * Parol has no built-in price list: a price is a statement about money that only the operator can
 * make, and a figure Parol made up would look like a fact. The operator names a JSON file
 * (PAROL_PRICES_FILE) in the format of `evals/prices.json`, USD per million tokens, and Parol
 * records the SHA-256 of the table it used on every call it priced. A model with no entry is not
 * priced: the cost is left empty and the page says so. A near match is never used.
 *
 * Nothing here reads the file system but `loadPriceFile`, and nothing prints a value from the file.
 */

/** USD per million tokens. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** What one response, or the sum of several, consumed. Cached tokens are counted apart from input. */
export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface PriceTable {
  readonly prices: ReadonlyMap<string, Price>;
  /** Over every model and price in the table, so that a changed price is a changed hash. */
  readonly sha256: string;
}

/** The price file cannot be used. The message names the variable and the fix, never a value or a path. */
export class PriceFileError extends Error {
  override name = "PriceFileError";
}

const MAX_FILE_BYTES = 1024 * 1024;
const MODEL_KEY = /^[A-Za-z0-9][\w.:/@+-]{0,99}$/;

const rate = z.number().finite().min(0);
const PriceSchema = z.strictObject({
  input: rate,
  output: rate,
  cacheRead: rate,
  cacheWrite: rate,
});

/** The same function the evaluation uses for its pin (evals/src/parol/results.ts). */
export function priceTableSha256(prices: ReadonlyMap<string, Price>): string {
  return hashOf(Object.fromEntries([...prices].sort(([a], [b]) => (a < b ? -1 : 1))));
}

/**
 * Turns the parsed JSON of a price file into a table. Keys that start with an underscore are notes
 * and are ignored. An entry with an extra field, a missing field, a negative or non-finite rate is
 * refused, and so is a model name that could not be one.
 */
export function parsePriceTable(raw: unknown): PriceTable {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new PriceFileError(
      "PAROL_PRICES_FILE must hold a JSON object that maps model names to prices. Fix the file, or unset the variable.",
    );
  const prices = new Map<string, Price>();
  for (const [model, value] of Object.entries(raw)) {
    if (model.startsWith("_")) continue;
    if (!MODEL_KEY.test(model))
      throw new PriceFileError(
        "PAROL_PRICES_FILE has a model name that is not a plain model name. Fix the file, or unset the variable.",
      );
    const parsed = PriceSchema.safeParse(value);
    if (!parsed.success)
      throw new PriceFileError(
        `PAROL_PRICES_FILE has a bad entry for "${model}": it needs input, output, cacheRead and cacheWrite, each a number of USD per million tokens, 0 or more, and nothing else. Fix the file, or unset the variable.`,
      );
    prices.set(model, parsed.data);
  }
  return { prices, sha256: priceTableSha256(prices) };
}

/** Reads and checks a price file. Synchronous: the server reads it once, while it starts. */
export function loadPriceFile(path: string): PriceTable {
  let text: string;
  try {
    const bytes = readFileSync(path);
    if (bytes.length > MAX_FILE_BYTES)
      throw new PriceFileError(
        "PAROL_PRICES_FILE names a file that is too large to be a price table. Fix the variable, or unset it.",
      );
    text = bytes.toString("utf8");
  } catch (error) {
    if (error instanceof PriceFileError) throw error;
    throw new PriceFileError(
      "PAROL_PRICES_FILE names a file that cannot be read. Fix the variable, or unset it.",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PriceFileError(
      "PAROL_PRICES_FILE is not valid JSON. Fix the file, or unset the variable.",
    );
  }
  return parsePriceTable(raw);
}

/** The price of exactly this model name, or null. A near match is never used. */
export function priceFor(table: PriceTable, model: string): Price | null {
  return table.prices.get(model) ?? null;
}

export function costOf(tokens: TokenCounts, price: Price): number {
  return (
    (tokens.inputTokens * price.input +
      tokens.outputTokens * price.output +
      tokens.cacheReadTokens * price.cacheRead +
      tokens.cacheWriteTokens * price.cacheWrite) /
    1_000_000
  );
}

/** A call as it is written to `model_calls`: the record, with its estimated cost when it has one. */
export type PricedCall = CallRecord & {
  costUsdEstimate: number | null;
  priceTableSha256: string | null;
};

/** What the engine asks when a unit finishes: give each call its cost, where there is one. */
export interface CallPricer {
  /**
   * `model` is the model name the calls were requested with, which is how the price file names it.
   * A call that reported no tokens has no cost, and neither has a call of a model with no price.
   */
  priceCalls(calls: readonly CallRecord[], model: string): PricedCall[];
}

export const NO_PRICING: CallPricer = {
  priceCalls: (calls) =>
    calls.map((call) => ({ ...call, costUsdEstimate: null, priceTableSha256: null })),
};

export function createCallPricer(table: PriceTable): CallPricer {
  return {
    priceCalls(calls, model) {
      const price = priceFor(table, model);
      return calls.map((call) => {
        if (
          price === null ||
          call.inputTokens === null ||
          call.outputTokens === null ||
          call.cacheReadTokens === null ||
          call.cacheWriteTokens === null
        )
          return { ...call, costUsdEstimate: null, priceTableSha256: null };
        return {
          ...call,
          costUsdEstimate: costOf(
            {
              inputTokens: call.inputTokens,
              outputTokens: call.outputTokens,
              cacheReadTokens: call.cacheReadTokens,
              cacheWriteTokens: call.cacheWriteTokens,
            },
            price,
          ),
          priceTableSha256: table.sha256,
        };
      });
    },
  };
}
