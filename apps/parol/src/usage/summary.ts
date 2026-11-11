import { isStandInProvider } from "../stand-in.js";
import type { RunUsageAggregate } from "../store/types.js";

/**
 * What a run's model calls used, in words a page, the JSON and the memo all take from this one
 * file, so that they cannot disagree (the reason `stand-in.ts` exists too).
 *
 * Every figure is given with its denominator: the calls that were recorded, the calls among them
 * that reported usage, and the calls among those that have a price. A figure that was not reported
 * is never a zero and never a dash: it is a sentence that says it was not reported. A dollar sign
 * appears only when a price was applied.
 */

/** The provider whose adapter reports usage. Others report nothing (docs/parol/06, 'Run provenance'). */
export const USAGE_PROVIDER = "anthropic";

export interface UsageCost {
  /**
   * `not_applicable`: no model was called, or none reported usage, so there is nothing to price.
   * `not_priced`: tokens were recorded and no call has a cost. `partly_priced`: some calls with
   * tokens have a cost and some have not. `priced`: every call with tokens has a cost.
   */
  state: "not_applicable" | "not_priced" | "partly_priced" | "priced";
  /** The sum over the priced calls only; null unless `priced` or `partly_priced`. */
  usd: number | null;
  /** The calls with a cost. The denominator is `callsWithUsage`. */
  callsPriced: number;
  /** The one price table every priced call names, else null. */
  priceTableSha256: string | null;
  mixedPriceTables: boolean;
}

export interface UsageSummary {
  /**
   * `stand_in`: a program stood in for a model, so none was called. `not_reported`: calls were
   * recorded, or none yet, and none carries tokens. `reported`: at least one call carries tokens.
   */
  state: "stand_in" | "not_reported" | "reported";
  /** The model call rows of the run: the denominator of every other count. */
  calls: number;
  callsWithUsage: number;
  /** Null when no call reported usage. */
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cost: UsageCost;
  /** True when the provider is one whose adapter reports usage. */
  reportsUsage: boolean;
  /** The sentences a page shows, in order. Fixed text and numbers, built by `usageLines`. */
  lines: string[];
}

/** `1234567` as `1,234,567`, whatever the locale of the machine. */
export const groups = (value: number): string =>
  String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** `$0.0123`: four decimals, as the evaluation prints a cost. */
export const formatUsd = (usd: number): string => `$${usd.toFixed(4)}`;

const callsText = (n: number): string =>
  `${groups(n)} recorded model ${n === 1 ? "call" : "calls"}`;

type Basis = Omit<UsageSummary, "lines">;

/** The sentences of the "Usage" section of the run page, from the numbers of `basis`. */
export function usageLines(basis: Basis): string[] {
  if (basis.state === "stand_in") return ["No model was called, so there is no usage to record."];
  if (basis.state === "not_reported") {
    if (basis.calls === 0) return ["No model call has been recorded for this review yet."];
    return [
      `The provider did not report usage for the ${groups(basis.calls)} model ${basis.calls === 1 ? "call" : "calls"} of this review.`,
      ...(basis.reportsUsage
        ? []
        : [
            `Parol records usage only for the ${USAGE_PROVIDER} provider, so the cost of this review is not known.`,
          ]),
    ];
  }
  const missing = basis.calls - basis.callsWithUsage;
  const lines = [
    `Input ${groups(basis.inputTokens ?? 0)}, output ${groups(basis.outputTokens ?? 0)}, cache read ${groups(basis.cacheReadTokens ?? 0)} and cache write ${groups(basis.cacheWriteTokens ?? 0)} tokens, from ${groups(basis.callsWithUsage)} of ${callsText(basis.calls)}.${missing > 0 ? ` ${groups(missing)} reported no usage.` : ""}`,
  ];
  const { cost } = basis;
  const estimate =
    "This is a computed estimate, not an invoice, and Parol does not check the prices against a price list.";
  if (cost.state === "priced" && cost.usd !== null) {
    const table = cost.mixedPriceTables
      ? "more than one price table"
      : cost.priceTableSha256 === null
        ? "a price table"
        : `the price table ${cost.priceTableSha256.slice(0, 12)}`;
    lines.push(
      `Estimated cost about ${formatUsd(cost.usd)} for the ${groups(basis.callsWithUsage)} ${basis.callsWithUsage === 1 ? "call" : "calls"} that reported usage, from ${table}. ${estimate}`,
    );
  } else if (cost.state === "partly_priced" && cost.usd !== null) {
    lines.push(
      `Estimated cost at least ${formatUsd(cost.usd)}: ${groups(cost.callsPriced)} of ${groups(basis.callsWithUsage)} calls with usage have a price. ${estimate}`,
    );
  } else {
    lines.push("Cost: not priced. No price is configured for this model.");
  }
  return lines;
}

/**
 * The text after the label "Usage:" in the memo's provenance appendix, or null for a stand-in (the
 * memo says so in its own words). It carries no dollar figure: the memo is the document that leaves
 * the system, a price table is the operator's configuration and not a fact about the legal work,
 * and an estimate would change the memo whenever the operator changed a file.
 */
export function memoUsageText(usage: Basis): string | null {
  if (usage.state === "stand_in") return null;
  if (usage.state === "not_reported") return `not reported (${callsText(usage.calls)}).`;
  return `input ${groups(usage.inputTokens ?? 0)}, output ${groups(usage.outputTokens ?? 0)}, cache read ${groups(usage.cacheReadTokens ?? 0)}, cache write ${groups(usage.cacheWriteTokens ?? 0)} tokens, from ${groups(usage.callsWithUsage)} of ${callsText(usage.calls)}.`;
}

/** The summary of one run, from the aggregate of its call rows and the provider that was asked. */
export function summarizeUsage(aggregate: RunUsageAggregate, provider: string): UsageSummary {
  const standIn = isStandInProvider(provider);
  const reportsUsage = provider === USAGE_PROVIDER;
  const reported = !standIn && aggregate.callsWithUsage > 0;
  const state: UsageSummary["state"] = standIn
    ? "stand_in"
    : reported
      ? "reported"
      : "not_reported";
  const priced = reported && aggregate.callsPriced > 0 && aggregate.costUsd !== null;
  const cost: UsageCost = {
    state: !reported
      ? "not_applicable"
      : !priced
        ? "not_priced"
        : aggregate.callsPriced === aggregate.callsWithUsage
          ? "priced"
          : "partly_priced",
    usd: priced ? aggregate.costUsd : null,
    callsPriced: reported ? aggregate.callsPriced : 0,
    priceTableSha256: priced ? aggregate.priceTableSha256 : null,
    mixedPriceTables: priced && aggregate.priceTables > 1,
  };
  const basis: Basis = {
    state,
    calls: aggregate.calls,
    callsWithUsage: reported ? aggregate.callsWithUsage : 0,
    inputTokens: reported ? aggregate.inputTokens : null,
    outputTokens: reported ? aggregate.outputTokens : null,
    cacheReadTokens: reported ? aggregate.cacheReadTokens : null,
    cacheWriteTokens: reported ? aggregate.cacheWriteTokens : null,
    cost,
    reportsUsage,
  };
  return { ...basis, lines: usageLines(basis) };
}
