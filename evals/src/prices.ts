import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { EvalError, quoted } from "./errors.js";

/** USD per million tokens. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** What one model response or a sum of them consumed. Cached tokens are counted apart from input. */
export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type PriceTable = ReadonlyMap<string, Price>;

export const BUILT_IN_PRICES = fileURLToPath(new URL("../prices.json", import.meta.url));

export const PRICE_WARNING =
  "Check evals/prices.json against the provider's current price list before trusting a cost figure.";

const rate = z.number().finite().min(0);
const PriceSchema = z.strictObject({
  input: rate,
  output: rate,
  cacheRead: rate,
  cacheWrite: rate,
});

async function readTable(path: string, label: string): Promise<Map<string, Price>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const why =
      error instanceof SyntaxError ? "it is not valid JSON" : (code ?? "it cannot be read");
    throw new EvalError(`Cannot use the ${label} ${path}: ${why}.`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new EvalError(
      `The ${label} ${path} must be a JSON object that maps model ids to prices.`,
    );
  }
  const table = new Map<string, Price>();
  for (const [model, value] of Object.entries(raw)) {
    // Underscore keys carry notes, because JSON has no comments.
    if (model.startsWith("_")) continue;
    const parsed = PriceSchema.safeParse(value);
    if (!parsed.success) {
      throw new EvalError(
        `The ${label} ${path} has a bad entry for "${model}": it needs input, output, cacheRead ` +
          "and cacheWrite, each a number of USD per million tokens, 0 or more.",
      );
    }
    table.set(model, parsed.data);
  }
  return table;
}

/** The built-in table, with the entries of an extra file added on top. The extra file wins. */
export async function loadPriceTable(extraPath: string | undefined): Promise<PriceTable> {
  const table = await readTable(BUILT_IN_PRICES, "price table");
  if (extraPath !== undefined) {
    for (const [model, price] of await readTable(extraPath, "prices file")) table.set(model, price);
  }
  return table;
}

/** An unknown model is an error, never a guess from a similar name. */
export function priceFor(table: PriceTable, model: string): Price {
  const price = table.get(model);
  if (price !== undefined) return price;
  const known = [...table.keys()].join(", ");
  throw new EvalError(
    `The model ${quoted(model, "model name")} is not in the price table, so a cost cannot be worked out. ` +
      `Known models: ${known === "" ? "none" : known}. Add it to evals/prices.json, or pass ` +
      'a file with --prices that maps the model id to { "input", "output", "cacheRead", ' +
      '"cacheWrite" } in USD per million tokens.',
  );
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
