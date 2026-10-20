import { SEVERITIES, type Severity } from "@clausewise/playbook";
import type { ReviewReport, RuleResult, RuleStatus } from "@clausewise/review";
import { aligned, plain, plural, visible } from "./text.js";

export interface WrittenFiles {
  redlined: string;
  report: string;
  summary: string;
}

export interface SummaryOptions {
  /** The severity the gate was set to. A rule that could not be checked counts as open from it up. */
  failOn?: Severity | undefined;
}

/** True when a rule of this severity is at the threshold or more severe. */
export const atOrAbove = (severity: Severity, threshold: Severity): boolean =>
  SEVERITIES.indexOf(severity) <= SEVERITIES.indexOf(threshold);

const STATUS_ROWS: [RuleStatus, string][] = [
  ["deviation", "Deviations"],
  ["missing", "Missing clauses"],
  ["compliant", "Compliant"],
  ["not_applicable", "Not applicable"],
  ["error", "Could not be checked"],
];

function openItem(result: RuleResult): string {
  const numbers = result.clauseNumbers.map(plain);
  const where =
    numbers.length === 0
      ? ""
      : `, ${plural(numbers.length, "clause", "clauses")} ${numbers.join(", ")}`;
  return `  [${result.severity}] ${plain(result.title)}: ${result.status}${where}`;
}

const NOT_SHOWN: [keyof NonNullable<ReviewReport["notShown"]>, string, string][] = [
  ["trackedInsertions", "tracked insertion", "tracked insertions"],
  ["trackedDeletions", "tracked deletion", "tracked deletions"],
  ["comments", "comment", "comments"],
  ["footnotes", "footnote", "footnotes"],
  ["endnotes", "endnote", "endnotes"],
  ["headerFooterParts", "header or footer part", "header or footer parts"],
  ["hiddenRuns", "run of hidden text", "runs of hidden text"],
  ["images", "picture", "pictures"],
];

function notShownLine(report: ReviewReport): string | undefined {
  const seen = report.notShown;
  if (seen === undefined) return undefined;
  const parts = NOT_SHOWN.flatMap(([key, one, many]) =>
    seen[key] > 0 ? [`${seen[key]} ${plural(seen[key], one, many)}`] : [],
  );
  return parts.length === 0 ? undefined : `Not shown to the model: ${parts.join(", ")}.`;
}

/**
 * What the terminal shows once the files are written: the counts, then every item a lawyer has to
 * look at, most severe first. Nothing from the contract is repeated except clause numbers.
 */
export function formatSummary(
  report: ReviewReport,
  written: WrittenFiles,
  options: SummaryOptions = {},
): string {
  const { counts, open, stats } = report;
  const document = report.document === undefined ? "" : `${plain(report.document)} `;
  const severities = SEVERITIES.map((severity) => `${open[severity]} ${severity}`).join(", ");

  const lines = [
    `Reviewed ${document}against ${plain(report.playbook.name)}.`,
    "",
    "Results:",
    ...aligned(STATUS_ROWS.map(([status, name]) => [`${name}:`, String(counts[status])])),
    "",
    `Open items by severity: ${severities}`,
    `Tracked changes applied: ${stats.editsApplied}`,
    "",
  ];

  // The sort is stable, so items of one severity keep the playbook's order.
  const flagged = report.results
    .filter((result) => result.status === "deviation" || result.status === "missing")
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  const failed = report.results.filter((result) => result.status === "error");
  const checked = report.results.length - failed.length;
  if (flagged.length > 0) {
    lines.push("Deviations and missing clauses:", ...flagged.map(openItem));
  } else if (failed.length === 0) {
    lines.push("No deviations or missing clauses.");
  } else {
    // Silence about the rules that did not run would read as a clean contract.
    lines.push(
      checked === 0
        ? "No rule could be checked."
        : `No deviations or missing clauses among the ${checked} ${plural(checked, "rule that was", "rules that were")} checked.`,
    );
  }

  if (failed.length > 0) {
    const { failOn } = options;
    lines.push("", "These rules could not be checked, so the review does not cover them:");
    for (const result of failed) {
      const open =
        failOn !== undefined && atOrAbove(result.severity, failOn)
          ? `could not be checked, treated as open (--fail-on ${failOn}): `
          : "";
      lines.push(
        `  [${result.severity}] ${plain(result.title)}: ${open}` +
          plain(result.error ?? "The rule was not checked."),
      );
    }
  }

  const warnings = (report.warnings ?? []).map(plain).filter((warning) => warning !== "");
  if (warnings.length > 0)
    lines.push("", "Warnings:", ...warnings.map((warning) => `  ${warning}`));
  const notShown = notShownLine(report);
  if (notShown !== undefined) lines.push("", notShown);

  lines.push(
    "",
    "Written:",
    ...aligned([
      ["Redlined contract:", visible(written.redlined)],
      ["Report (JSON):", visible(written.report)],
      ["Summary (Markdown):", visible(written.summary)],
    ]),
    "",
  );
  return lines.join("\n");
}
