import { createObjectGenerator, type AnthropicUsage, type LlmConfig } from "@clausewise/llm";
import type { ObjectGenerator } from "@clausewise/llm";
import type { Repository } from "../store/index.js";
import { SpendConfigError } from "./errors.js";
import { createSpendGuard, type SpendGuard, type SpendLimits } from "./guard.js";
import { createUsageSink, meteringFetch } from "./metering.js";
import { PriceFileError, loadPriceFile, priceFor, type Price, type PriceTable } from "./prices.js";
import { USAGE_PROVIDER } from "./summary.js";

/**
 * The one place the application builds a generator for a provider it does not control, and the
 * place its spend settings are checked.
 *
 * Only the `anthropic` provider reports usage and takes a `fetch` of its own, so it is the only
 * one that is metered and capped: its adapter is handed the usage hook and a `fetch` that reads the
 * model named by each response (`metering.ts`) and holds back a request that could pass a limit
 * (`guard.ts`). The others are built as they are and record nothing; the run page says so, and the
 * server starts with them only when the operator has accepted that only the bound planned before a
 * review is checked (PAROL_SPEND_BOUND_ONLY=1). Nothing else under `apps/parol/src` calls
 * `createObjectGenerator`, so a live generator cannot be built that skips the metering (a test
 * scans for it).
 */
export function createLiveGenerator(
  llm: LlmConfig,
  options: {
    /** Stands in for the network. Default: the global `fetch`. For a test over a scripted wire. */
    fetch?: typeof globalThis.fetch;
    /** Also told of the usage of each response, after the call being made has been. */
    onUsage?: (usage: AnthropicUsage) => void;
    /** Holds each request back when it could pass a limit, and counts each response in the ledger. */
    guard?: SpendGuard;
  } = {},
): ObjectGenerator {
  if (llm.provider !== USAGE_PROVIDER) return createObjectGenerator(llm);
  const { guard } = options;
  const network = options.fetch ?? globalThis.fetch;
  const also = (usage: AnthropicUsage): void => {
    options.onUsage?.(usage);
    guard?.onUsage(usage);
  };
  return createObjectGenerator(llm, {
    onUsage: createUsageSink(also),
    fetch: meteringFetch(guard === undefined ? network : guard.guardFetch(network)),
  });
}

// ---------------------------------------------------------------------------------------------
// Spend settings
// ---------------------------------------------------------------------------------------------

/** What the environment says about spending, as `parseEnv` read it. */
export interface SpendSettings {
  /** PAROL_MAX_REVIEW_COST_USD: the most one review may cost. Null when not set. */
  maxReviewCostUsd: number | null;
  /** PAROL_MAX_DAILY_COST_USD: the most all reviews may cost in one UTC day. Null when not set. */
  maxDailyCostUsd: number | null;
  /** PAROL_PRICES_FILE. Null when not set. */
  pricesFile: string | null;
  /** PAROL_ASSUMED_OUTPUT_TOKENS, with its default. */
  assumedOutputTokens: number;
  /** PAROL_SPEND_BOUND_ONLY. */
  spendBoundOnly: boolean;
}

/** The settings once they have been checked against the configured model. */
export interface SpendSetup {
  limits: SpendLimits;
  provider: string;
  model: string;
  priceTable: PriceTable;
  price: Price;
}

/** At most this many model names of the price file are listed in a message. */
const LISTED_MODELS = 20;

/**
 * Checks everything a live provider needs before the server may serve it: both limits, a readable
 * and valid price file, a price for the configured model, a provider whose usage can be counted (or
 * the explicit choice not to count it), and no fallback model. Synchronous and free of the
 * database, so it runs while the server starts and before anything is opened.
 *
 * Every message names the variable and the fix and never prints a value.
 */
export function checkSpend(settings: SpendSettings, llm: LlmConfig): SpendSetup {
  const { maxReviewCostUsd, maxDailyCostUsd } = settings;
  if (maxReviewCostUsd === null || maxDailyCostUsd === null) {
    const missing = [
      ...(maxReviewCostUsd === null ? ["PAROL_MAX_REVIEW_COST_USD"] : []),
      ...(maxDailyCostUsd === null ? ["PAROL_MAX_DAILY_COST_USD"] : []),
    ].join(" and ");
    throw new SpendConfigError(
      `${missing} ${missing.includes(" and ") ? "are" : "is"} not set. A server that calls a model ` +
        "needs a limit in US dollars for what one review may cost (PAROL_MAX_REVIEW_COST_USD) and for " +
        "what all reviews may cost in one UTC day (PAROL_MAX_DAILY_COST_USD). Parol has no default " +
        "limits, because a limit is a statement about money that only whoever runs the server can make.",
    );
  }
  if (maxDailyCostUsd < maxReviewCostUsd)
    throw new SpendConfigError(
      "PAROL_MAX_DAILY_COST_USD must be at least PAROL_MAX_REVIEW_COST_USD. Fix the values.",
    );
  if (settings.pricesFile === null)
    throw new SpendConfigError(
      "PAROL_PRICES_FILE is not set. A server that calls a model needs a JSON file of prices, in USD per " +
        "million tokens, in the format of evals/prices.json. Parol has no built-in prices and never guesses one.",
    );
  let priceTable: PriceTable;
  try {
    priceTable = loadPriceFile(settings.pricesFile);
  } catch (error) {
    if (error instanceof PriceFileError) throw new SpendConfigError(error.message);
    throw error;
  }
  const price = priceFor(priceTable, llm.model);
  if (price === null) {
    const known = [...priceTable.prices.keys()].sort().slice(0, LISTED_MODELS);
    throw new SpendConfigError(
      "PAROL_PRICES_FILE has no price for the configured model (CLAUSEWISE_MODEL, or the default of " +
        `the provider). Parol never guesses a price. ${
          known.length === 0
            ? "The file holds no model."
            : `The file holds prices for: ${known.join(", ")}.`
        } Add the model to the file, or change the model.`,
    );
  }
  // A hosted provider is never free. A price of zero, typed by mistake, would make the bound zero
  // and switch off the whole guard.
  if (
    (llm.provider === "anthropic" || llm.provider === "openai") &&
    price.input === 0 &&
    price.output === 0
  )
    throw new SpendConfigError(
      `PAROL_PRICES_FILE gives the configured model an input and an output rate of 0, which would switch off the spend guard for the ${llm.provider} provider. Fix the entry.`,
    );
  if (llm.fallback !== undefined)
    throw new SpendConfigError(
      "CLAUSEWISE_FALLBACK is on, so a request the model declines is rerun on another model whose price " +
        "PAROL_PRICES_FILE does not hold, and the spend limits cannot be held. Unset CLAUSEWISE_FALLBACK.",
    );
  if (llm.provider !== USAGE_PROVIDER && !settings.spendBoundOnly)
    throw new SpendConfigError(
      `Parol records usage only for the ${USAGE_PROVIDER} provider, so the spend limits cannot be enforced ` +
        `while a review runs. Use that provider, or set PAROL_SPEND_BOUND_ONLY=1 to accept that only ` +
        "the bound planned before each review is checked and the daily limit counts nothing for this provider.",
    );
  return {
    limits: {
      perReviewUsd: maxReviewCostUsd,
      perDayUsd: maxDailyCostUsd,
      assumedOutputTokens: settings.assumedOutputTokens,
    },
    provider: llm.provider,
    model: llm.model,
    priceTable,
    price,
  };
}

/** The guard for a checked setup, over the repository whose ledger it writes. */
export function spendGuardFor(
  setup: SpendSetup,
  repo: Pick<Repository, "addSpend" | "spendToday">,
  log: (line: string) => void,
): SpendGuard {
  return createSpendGuard({ ...setup, repo, log });
}
