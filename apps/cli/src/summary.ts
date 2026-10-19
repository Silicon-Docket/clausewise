import { SEVERITIES } from "@clausewise/playbook";
import type { ReviewReport, RuleResult, RuleStatus } from "@clausewise/review";
import { aligned, plain, plural } from "./text.js";

export interface WrittenFiles {
  redlined: string;
  report: string;
  summary: string;
}

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

/**
 * What the terminal shows once the files are written: the counts, then every item a lawyer has to
 * look at, most severe first. Nothing from the contract is repeated except clause numbers.
 */
export function formatSummary(report: ReviewReport, written: WrittenFiles): string {
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
  if (flagged.length === 0) {
    lines.push("No deviations or missing clauses.");
  } else {
    lines.push("Deviations and missing clauses:", ...flagged.map(openItem));
  }

  const failed = report.results.filter((result) => result.status === "error");
  if (failed.length > 0) {
    lines.push("", "These rules could not be checked, so the review does not cover them:");
    for (const result of failed) {
      lines.push(`  ${plain(result.title)}: ${plain(result.error ?? "The rule was not checked.")}`);
    }
  }

  lines.push(
    "",
    "Written:",
    ...aligned([
      ["Redlined contract:", written.redlined],
      ["Report (JSON):", written.report],
      ["Summary (Markdown):", written.summary],
    ]),
    "",
  );
  return lines.join("\n");
}
