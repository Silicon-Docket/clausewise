import type { FindingView, IssueRow } from "../../src/services/views.js";
import { findingPage, paneOnly, runPage } from "./render.js";
import { buildFindingView, buildIssueRows } from "./support.js";
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

export const VARIANTS_USAGE: Variant[] = [
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
