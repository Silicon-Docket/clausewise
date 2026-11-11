import type { RunUsageAggregate } from "../../src/store/types.js";
import type { FindingView, IssueRow, RunSummary } from "../../src/services/views.js";
import { summarizeUsage, type UsageSummary } from "../../src/usage/summary.js";
import { findingPage, paneOnly, runPage } from "./render.js";
import { buildFindingView, buildIssueRows, buildRunSummary } from "./support.js";
import type { Variant } from "./variants.js";

/**
 * The page fixtures of the usage and settled-status pages (work package W2.x), in the same shape
 * as the base list in variants.ts, which spreads this list after its own. It adds an entry for
 * every state of a page that changes what the page shows, and only this file.
 *
 * Settled statuses: the playbook's flags settled the status the workflow stated to another one,
 * and the finding says so. In the demo playbook `ret-1` is the one rule that is not required, so
 * the workflow stating `missing` for it settles to `not_applicable`.
 */

const SETTLED_REASON = "the rule is not required";

/** The issue row of `ret-1` as the presenter gives it when the workflow stated `missing`. */
export function settledRow(over: Partial<IssueRow> = {}): IssueRow {
  const row = buildIssueRows().find((r) => r.ruleKey === "ret-1") as IssueRow;
  return {
    ...row,
    status: "not_applicable",
    modelStatus: "missing",
    settlementReason: SETTLED_REASON,
    ...over,
  };
}

/** The issue table of the run page, with `ret-1` settled. */
export function rowsWithSettled(): IssueRow[] {
  return buildIssueRows().map((row) => (row.ruleKey === "ret-1" ? settledRow() : row));
}

/** A finding of `ret-1` the playbook settled from missing to not_applicable. */
export function buildSettledFinding(over: Partial<FindingView> = {}): FindingView {
  return buildFindingView({
    issue: settledRow({ evidenceCount: 0 }),
    discrepancy: "The documents hold no clause on the return or destruction of information.",
    explanation: "No paragraph of the documents deals with returning or destroying information.",
    fallbackLanguage: null,
    fallbackBasis: "none",
    evidence: [],
    checks: [
      {
        id: "citation_shape",
        kind: "deterministic",
        outcome: "pass",
        detail: "status not_applicable is cited as it requires",
      },
      {
        id: "status_settled",
        kind: "deterministic",
        outcome: "pass",
        detail:
          "the workflow stated missing and the playbook settles it to not_applicable: the rule is not required",
      },
    ],
    ...over,
  });
}

/** The same finding after a flag made the status undetermined: the model's status is still kept. */
export function buildSettledThenOpenFinding(): FindingView {
  return buildSettledFinding({
    issue: settledRow({
      status: "undetermined",
      verificationState: "escalated_by_system",
      escalations: [{ code: "conflicting_sources", detail: "two passages disagree" }],
      evidenceCount: 0,
    }),
  });
}

// ---------------------------------------------------------------------------------------------
// Usage: what the run's model calls used, and which model answered
// ---------------------------------------------------------------------------------------------

const HASH = "0123456789abcdef".repeat(4);

/** What nine recorded calls add up to when all of them reported usage and all have a price. */
export const PRICED: RunUsageAggregate = {
  calls: 9,
  callsWithUsage: 9,
  inputTokens: 123_456,
  outputTokens: 7_890,
  cacheReadTokens: 1_000_000,
  cacheWriteTokens: 12,
  callsPriced: 9,
  costUsd: 0.0123456,
  priceTables: 1,
  priceTableSha256: HASH,
};

/** Calls were recorded and none carries a count. */
export const UNREPORTED: RunUsageAggregate = {
  ...PRICED,
  callsWithUsage: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  callsPriced: 0,
  costUsd: null,
  priceTables: 0,
  priceTableSha256: null,
};

/** The model names a provider and a model, as a review by that provider has them. */
export function modelOf(
  provider: string,
  reported: string | null = "model-a-20260101",
): RunSummary["model"] {
  return { provider, requested: "model-a", reported };
}

/**
 * The usage of a run by `provider`, as the service builds it from the aggregate of its calls.
 * `stoppedBySpend` is a run the spend guard stopped.
 */
export function usageOf(
  aggregate: RunUsageAggregate,
  provider = "anthropic",
  options: { stoppedBySpend?: boolean } = {},
): UsageSummary {
  return summarizeUsage(aggregate, provider, options);
}

/** What the page says of a run the spend guard stopped, about the calls it cut short. */
export const CUT_SHORT =
  "Calls that were cut short when the review stopped are counted in the day's total and are not listed here.";

/** A run that failed because it reached a spend limit, with `kind` the one it reached. */
export function spendStoppedRun(
  kind: "spend_review_limit" | "spend_daily_limit" = "spend_review_limit",
  aggregate: RunUsageAggregate = { ...PRICED, calls: 4, callsWithUsage: 4, callsPriced: 4 },
): RunSummary {
  return buildRunSummary({
    model: modelOf("anthropic"),
    usage: usageOf(aggregate, "anthropic", { stoppedBySpend: true }),
    status: "failed",
    errorKind: kind,
    findingCount: 0,
  });
}

/** A run by a provider that reports usage, with the usage given. */
export function usageRun(
  aggregate: RunUsageAggregate,
  over: Partial<RunSummary> = {},
  provider = "anthropic",
): RunSummary {
  return buildRunSummary({
    model: modelOf(provider),
    usage: usageOf(aggregate, provider),
    ...over,
  });
}

export const VARIANTS_USAGE: Variant[] = [
  ["run, usage reported and priced", () => runPage({ run: usageRun(PRICED) })],
  [
    "run, usage reported and partly priced",
    () => runPage({ run: usageRun({ ...PRICED, callsPriced: 4, costUsd: 0.05 }) }),
  ],
  [
    "run, usage reported and not priced",
    () =>
      runPage({
        run: usageRun({
          ...PRICED,
          callsPriced: 0,
          costUsd: null,
          priceTables: 0,
          priceTableSha256: null,
        }),
      }),
  ],
  [
    "run, usage reported by some calls only",
    () => runPage({ run: usageRun({ ...PRICED, callsWithUsage: 6, callsPriced: 6 }) }),
  ],
  ["run, usage not reported", () => runPage({ run: usageRun(UNREPORTED) })],
  [
    "run, usage not reported by another provider",
    () => runPage({ run: usageRun(UNREPORTED, { model: modelOf("openai", null) }, "openai") }),
  ],
  [
    "run, no call recorded yet",
    () =>
      runPage({
        run: usageRun(
          { ...UNREPORTED, calls: 0 },
          {
            status: "queued",
            progress: null,
            finishedAt: null,
            findingCount: 0,
          },
        ),
        issues: [],
        selected: null,
      }),
  ],
  [
    "run, a stand-in reader",
    () =>
      runPage({
        run: usageRun(PRICED, { model: modelOf("simulated", null) }, "simulated"),
      }),
  ],
  ["run, stopped by the limit for one review", () => runPage({ run: spendStoppedRun() })],
  [
    "run, stopped by the limit for a day",
    () => runPage({ run: spendStoppedRun("spend_daily_limit") }),
  ],
  [
    "run, stopped by a limit before a call was recorded",
    () =>
      runPage({
        run: spendStoppedRun("spend_review_limit", { ...UNREPORTED, calls: 0 }),
        issues: [],
        selected: null,
      }),
  ],
  [
    "run, the provider did not say which model answered",
    () => runPage({ run: usageRun(PRICED, { model: modelOf("anthropic", null) }) }),
  ],

  [
    "run, a settled finding in the table and selected",
    () => runPage({ issues: rowsWithSettled(), selected: buildSettledFinding() }),
  ],
  [
    "run, a settled finding in the table, another selected",
    () => runPage({ issues: rowsWithSettled() }),
  ],
  ["finding page, settled", () => findingPage(buildSettledFinding())],
  ["pane, settled", () => paneOnly(buildSettledFinding()), { fragment: true }],
  [
    "pane, settled and then undetermined",
    () => paneOnly(buildSettledThenOpenFinding()),
    { fragment: true },
  ],
];
