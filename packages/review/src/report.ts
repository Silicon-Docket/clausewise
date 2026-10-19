import type { Severity } from "@clausewise/playbook";
import type { ReviewReport, RuleResult, RuleStatus } from "./types.js";

/**
 * The report as Markdown for people to read. Rule titles come from the playbook, but the
 * explanations, suggested clauses and error texts come from a model, and the quoted words come
 * from the contract. None of that may be able to start a heading, a list or a table row, so every
 * piece of it goes through one of the helpers below before it reaches the page.
 */

const SEVERITIES: Severity[] = ["high", "medium", "low"];
const SEVERITY_LABELS: Record<Severity, string> = { high: "High", medium: "Medium", low: "Low" };

const STATUS_ROWS: [RuleStatus, string][] = [
  ["deviation", "Deviations"],
  ["missing", "Missing clauses"],
  ["compliant", "Compliant"],
  ["not_applicable", "Not applicable"],
  ["error", "Could not be checked"],
];

// Every control character except the tab and the line breaks, which the helpers handle.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
// Line separators that a Markdown renderer does not treat as line ends but a reader does.
const EXTRA_BREAKS = /[\u0085\u2028\u2029]/g;
// Characters that begin emphasis, code, links, HTML, tables, headings or strikethrough anywhere
// in a line.
const INLINE_MARKUP = /[\\`*_[\]<>|#~]/g;
// Characters that make a line a list item, a setext heading underline or a thematic break when
// they come first. The other starts, such as # and >, are escaped wherever they are.
const LINE_START = /^(?:([-+=])|(\d{1,9})([.)]))/;
const EN_OR_EM_DASH = /[ \t]*[\u2013\u2014][ \t]*/g;

const clean = (text: string): string => text.replace(CONTROL, " ").replace(EXTRA_BREAKS, "\n");
const flatten = (text: string): string => clean(text).replace(/\s+/g, " ").trim();

const escapeInline = (value: string): string => value.replace(INLINE_MARKUP, "\\$&");

// Only a line's first characters can start a list or an underline, so this is for text that
// begins a line and would damage a clause number such as 3.1 anywhere else.
const escapeLineStart = (line: string): string =>
  line.replace(LINE_START, (_, mark?: string, digits?: string, stop?: string) =>
    mark === undefined ? `${digits}\\${stop}` : `\\${mark}`,
  );

/** Model or contract text on one line, with nothing in it that Markdown would act on. */
const text = (value: string): string => escapeInline(flatten(value));

/** The same, for a paragraph of its own, which nothing precedes on its line. */
const paragraph = (value: string): string => escapeLineStart(text(value));

/** Several lines of such text as a block quote, so a list or heading inside cannot escape it. */
function block(value: string): string {
  const lines = clean(value)
    .split(/\r\n|\r|\n/)
    .map((line) => escapeLineStart(escapeInline(line.trim())));
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

/** Words quoted from the contract or proposed for it, exactly as they are. */
function code(value: string): string {
  const flat = flatten(value);
  if (flat === "") return "(empty)";
  const longest = (flat.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(longest + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
}

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);
const capitalise = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);
const withoutFinalStop = (value: string): string => value.trim().replace(/[.\s]+$/, "");

function clauseLabel(result: RuleResult): string | undefined {
  // Ids are the fallback for clauses that carry no number in the contract.
  const refs = result.clauseNumbers.length > 0 ? result.clauseNumbers : result.clauseIds;
  if (refs.length === 0) return undefined;
  return `${plural(refs.length, "clause", "clauses")} ${refs.map(text).join(", ")}`;
}

function attentionItem(result: RuleResult, position: number): string {
  const flagged = result.status === "missing" ? "missing" : "deviation";
  const clauses = clauseLabel(result);
  const lines = [
    `### ${position}. ${text(result.title)}`,
    "",
    `**${SEVERITY_LABELS[result.severity]}** severity, ${flagged}${
      clauses === undefined ? "" : `. ${capitalise(clauses)}`
    }.`,
  ];
  if (result.explanation !== "") lines.push("", paragraph(result.explanation));

  const { edit } = result;
  if (edit.kind === "applied") {
    const after = edit.replacement === "" ? "(deleted)" : code(edit.replacement);
    lines.push("", `Changed: ${code(edit.original)} => ${after}`);
  } else if (edit.kind === "comment-only") {
    lines.push("", `No tracked change was made: ${text(withoutFinalStop(edit.reason))}.`);
    if (edit.proposed.replacement.trim() !== "") {
      lines.push("", `Suggested wording: ${code(edit.proposed.replacement)}`);
    }
  } else if (result.status === "deviation") {
    lines.push("", "No edit was proposed.");
  }
  if (result.suggestedClause !== null) {
    lines.push("", "Suggested clause:", "", block(result.suggestedClause));
  }
  return lines.join("\n");
}

function listItem(result: RuleResult): string {
  const clauses = clauseLabel(result);
  const where = clauses === undefined ? "" : ` (${clauses})`;
  const why = result.explanation === "" ? "" : `: ${text(result.explanation)}`;
  return `- **${text(result.title)}**${where}${why}`;
}

function errorItem(result: RuleResult): string {
  return `- **${text(result.title)}** (${code(result.ruleId)}): ${text(result.error ?? "The rule was not checked.")}`;
}

function section(title: string, items: string[], empty: string): string[] {
  return [`## ${title}`, "", ...(items.length === 0 ? [empty] : items), ""];
}

export function renderMarkdown(report: ReviewReport): string {
  const { counts, open, stats, model } = report;
  const title =
    report.document === undefined
      ? `Review against ${text(report.playbook.name)}`
      : `Review of ${text(report.document)} against ${text(report.playbook.name)}`;
  const types = report.playbook.contractTypes.map(text).join(", ");

  const lines: string[] = [
    `# ${title}`,
    "",
    `Playbook: ${text(report.playbook.name)} (contract types: ${types}).`,
    "",
    `Reviewed by ${text(model.model)} (${text(model.provider)}). ` +
      `The contract text was sent to: ${text(withoutFinalStop(model.disclosure))}.`,
    "",
    "Findings are suggestions for a lawyer to review. They are not legal advice.",
    "",
    "## Summary",
    "",
    "| Result | Count |",
    "| --- | ---: |",
    ...STATUS_ROWS.map(([status, label]) => `| ${label} | ${counts[status]} |`),
    "",
    "| Open items | Count |",
    "| --- | ---: |",
    ...SEVERITIES.map(
      (severity) => `| ${SEVERITY_LABELS[severity]} severity | ${open[severity]} |`,
    ),
    "",
    `Checked ${stats.clauses} ${plural(stats.clauses, "clause", "clauses")} ` +
      `(${stats.paragraphs} ${plural(stats.paragraphs, "paragraph", "paragraphs")}) in ` +
      `${stats.windows} ${plural(stats.windows, "window", "windows")}. ` +
      `${stats.editsApplied} tracked ${plural(stats.editsApplied, "change was", "changes were")} applied.`,
    "",
  ];

  // Results are already in playbook order and the sort is stable, so ties keep that order.
  const attention = report.results
    .filter((result) => result.status === "deviation" || result.status === "missing")
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  lines.push(
    ...section(
      "Needs attention",
      attention.flatMap((result, i) => [attentionItem(result, i + 1), ""]).slice(0, -1),
      "Nothing needs attention.",
    ),
  );

  const listed = (status: RuleStatus): RuleResult[] =>
    report.results.filter((result) => result.status === status);
  lines.push(...section("Compliant", listed("compliant").map(listItem), "None."));
  lines.push(...section("Not applicable", listed("not_applicable").map(listItem), "None."));
  lines.push(...section("Could not be checked", listed("error").map(errorItem), "None."));

  // Quoted text and model prose are rendered as they are, apart from these two characters, which
  // the project does not print.
  return (
    lines
      .join("\n")
      .trimEnd()
      .replace(EN_OR_EM_DASH, (run) => (/[ \t]/.test(run) ? " - " : "-")) + "\n"
  );
}
