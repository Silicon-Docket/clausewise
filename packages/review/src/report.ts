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

const isBlank = (code: number): boolean => code === 0x20 || code === 0x09;

/**
 * Replaces each en or em dash, with the spaces and tabs around it, by " - " when there were any
 * and by "-" when there were none. One pass: every character is looked at a constant number of
 * times, whereas the equivalent regular expression rescans a long run of blanks from every start.
 */
function plainDashes(value: string): string {
  const parts: string[] = [];
  let copied = 0;
  let i = 0;
  while (i < value.length) {
    const code = value.charCodeAt(i);
    if (code !== 0x2013 && code !== 0x2014) {
      i += 1;
      continue;
    }
    let from = i;
    while (from > copied && isBlank(value.charCodeAt(from - 1))) from -= 1;
    let to = i + 1;
    while (to < value.length && isBlank(value.charCodeAt(to))) to += 1;
    parts.push(value.slice(copied, from), from < i || to > i + 1 ? " - " : "-");
    copied = to;
    i = to;
  }
  parts.push(value.slice(copied));
  return parts.join("");
}

const clean = (text: string): string => text.replace(CONTROL, " ").replace(EXTRA_BREAKS, "\n");
// The dashes are replaced before the escaping, so a line that begins with one is seen by the
// line-start escape as the hyphen it has become, instead of turning into a list marker after it.
const flatten = (text: string): string => plainDashes(clean(text).replace(/\s+/g, " ")).trim();

const escapeInline = (value: string): string => value.replace(INLINE_MARKUP, "\\$&");

// A renderer that follows GitHub's Markdown turns a bare address into a link, and a report is
// passed around as a file, so a link planted in a contract or a model's answer would be one click
// from the reader. Whatever looks like an address is set in a code span, where no renderer links.
// Punctuation around an address stays outside it, as a renderer would leave it outside the link.
const WWW_NAME = /(?<![A-Za-z0-9])www\./i;
const SCHEME_CHARS = /[A-Za-z0-9+.-]/;
const LOCAL_PART_CHARS = /[A-Za-z0-9._%+-]/;
const CLOSING_PUNCTUATION = new Set([
  ")",
  "]",
  "}",
  ">",
  '"',
  "'",
  "*",
  "_",
  "~",
  ".",
  ",",
  ";",
  ":",
  "!",
  "?",
  "\u201d",
  "\u2019",
]);

/** Where the first address in a word begins, or -1. Each scan is over the word once. */
function addressStart(word: string): number {
  const starts: number[] = [];
  const scheme = word.indexOf("://");
  if (scheme !== -1) {
    let from = scheme;
    while (from > 0 && SCHEME_CHARS.test(word.charAt(from - 1))) from -= 1;
    starts.push(from);
  }
  const www = WWW_NAME.exec(word);
  if (www !== null) starts.push(www.index);
  // The domain of an address has a dot that is not the last character. Every "@" is tried, since a
  // renderer reads "@jane@example.com" as the address after the first one, and the first
  // "@" that fits begins the earliest address.
  const lastDot = word.lastIndexOf(".", word.length - 2);
  for (let at = word.indexOf("@"); at !== -1 && lastDot > at + 1; at = word.indexOf("@", at + 1)) {
    if (at === 0 || !LOCAL_PART_CHARS.test(word.charAt(at - 1))) continue;
    let from = at;
    while (from > 0 && LOCAL_PART_CHARS.test(word.charAt(from - 1))) from -= 1;
    starts.push(from);
    break;
  }
  return starts.length === 0 ? -1 : Math.min(...starts);
}

/** `value` on one line as a code span, whatever backticks it holds. */
function codeSpan(flat: string): string {
  const longest = (flat.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(longest + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
}

function safeWord(word: string): string {
  const from = addressStart(word);
  if (from === -1) return escapeInline(word);
  let to = word.length;
  while (to > from + 1 && CLOSING_PUNCTUATION.has(word.charAt(to - 1))) to -= 1;
  return (
    escapeInline(word.slice(0, from)) +
    codeSpan(word.slice(from, to)) +
    escapeInline(word.slice(to))
  );
}

/** Text with nothing in it that Markdown would act on, links included. Spacing is kept. */
const markdownSafe = (value: string): string =>
  value
    .split(/(\s+)/)
    .map((part, i) => (i % 2 === 1 ? part : safeWord(part)))
    .join("");

// Only a line's first characters can start a list or an underline, so this is for text that
// begins a line and would damage a clause number such as 3.1 anywhere else.
const escapeLineStart = (line: string): string =>
  line.replace(LINE_START, (_, mark?: string, digits?: string, stop?: string) =>
    mark === undefined ? `${digits}\\${stop}` : `\\${mark}`,
  );

/** Model or contract text on one line, with nothing in it that Markdown would act on. */
const text = (value: string): string => markdownSafe(flatten(value));

/** The same, for a paragraph of its own, which nothing precedes on its line. */
const paragraph = (value: string): string => escapeLineStart(text(value));

/** Several lines of such text as a block quote, so a list or heading inside cannot escape it. */
function block(value: string): string {
  const quoted: string[] = [];
  let gap = false;
  for (const raw of clean(value).split(/\r\n|\r|\n/)) {
    const line = plainDashes(raw.trim()).trim();
    if (line === "") {
      gap = quoted.length > 0;
      continue;
    }
    // Any run of blank lines is one blank line, and none comes first or last.
    if (gap) quoted.push(">");
    gap = false;
    quoted.push(`> ${escapeLineStart(markdownSafe(line))}`);
  }
  return quoted.length === 0 ? ">" : quoted.join("\n");
}

/** Words quoted from the contract or proposed for it, exactly as they are. */
function code(value: string): string {
  const flat = flatten(value);
  return flat === "" ? "(empty)" : codeSpan(flat);
}

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);
const capitalise = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

// A pattern such as /[.\s]+$/ is quadratic on a long run of dots or spaces that is not at the end,
// and a model can write one, so the end is found with a plain walk back.
function withoutFinalStop(value: string): string {
  const trimmed = value.trim();
  let end = trimmed.length;
  while (end > 0 && /[.\s]/.test(trimmed.charAt(end - 1))) end -= 1;
  return trimmed.slice(0, end);
}

type NotShown = NonNullable<ReviewReport["notShown"]>;

// Tracked insertions are left out here: the model did read their text, as if accepted.
const UNSEEN: [keyof NotShown, string, string][] = [
  ["trackedDeletions", "tracked deletion", "tracked deletions"],
  ["comments", "comment", "comments"],
  ["footnotes", "footnote", "footnotes"],
  ["endnotes", "endnote", "endnotes"],
  ["headerFooterParts", "header or footer", "headers or footers"],
  ["hiddenRuns", "run of hidden text", "runs of hidden text"],
  ["images", "image", "images"],
];

function count(notShown: NotShown, key: keyof NotShown): number {
  const value: unknown = notShown[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : 0;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** One sentence on what the file holds that the model did not see, or undefined if nothing. */
function notShownSentence(notShown: NotShown | undefined): string | undefined {
  if (notShown === undefined) return undefined;
  const unseen = UNSEEN.flatMap(([key, one, many]) => {
    const n = count(notShown, key);
    return n === 0 ? [] : [`${n} ${plural(n, one, many)}`];
  });
  const accepted = count(notShown, "trackedInsertions");
  const readAs =
    accepted === 0
      ? undefined
      : `${accepted} tracked ${plural(accepted, "insertion", "insertions")} as accepted text`;
  if (unseen.length === 0 && readAs === undefined) return undefined;
  if (readAs === undefined) return `The model was not shown ${joinList(unseen)}.`;
  if (unseen.length === 0) return `The model read ${readAs}.`;
  return `The model was not shown ${joinList(unseen)}, and it read ${readAs}.`;
}

/**
 * Names clauses as a lawyer would: by the number the contract gives them, and where it gives none
 * by their opening words. The ids the review works with mean nothing to a reader, so they never
 * appear. `escape` is applied to each number and excerpt, and not to the words around them.
 */
export function clausePhrase(
  clauses: { numbers: readonly string[]; excerpts: readonly string[] },
  escape: (value: string) => string = (value) => value,
): string | undefined {
  const { numbers, excerpts } = clauses;
  const parts: string[] = [];
  if (numbers.length > 0) {
    parts.push(`${plural(numbers.length, "clause", "clauses")} ${numbers.map(escape).join(", ")}`);
  }
  if (excerpts.length > 0) {
    const quoted = excerpts.map((excerpt) => `"${escape(excerpt)}"`).join(", ");
    parts.push(`the ${plural(excerpts.length, "clause", "clauses")} beginning ${quoted}`);
  }
  return parts.length === 0 ? undefined : parts.join(" and ");
}

function clauseLabel(result: RuleResult): string | undefined {
  const named = clausePhrase(
    { numbers: result.clauseNumbers, excerpts: result.clauseExcerpts ?? [] },
    text,
  );
  if (named !== undefined) return named;
  // A result that was not built by the pipeline can name clauses it has no words for.
  const unnamed = result.clauseIds.length;
  if (unnamed === 0) return undefined;
  return unnamed === 1 ? "a clause without a number" : `${unnamed} clauses without a number`;
}

const BLANK_TITLE = /^[\p{Z}\p{Cc}\p{Cf}]*$/u;

/** The rule's title, or its id when the title has nothing a reader could see. */
function titleOf(result: RuleResult): string {
  if (!BLANK_TITLE.test(flatten(result.title))) return text(result.title);
  return BLANK_TITLE.test(flatten(result.ruleId)) ? "(untitled rule)" : text(result.ruleId);
}

function attentionItem(result: RuleResult, position: number): string {
  const flagged = result.status === "missing" ? "missing" : "deviation";
  const clauses = clauseLabel(result);
  const lines = [
    `### ${position}. ${titleOf(result)}`,
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
  return `- **${titleOf(result)}**${where}${why}`;
}

function errorItem(result: RuleResult): string {
  return `- **${titleOf(result)}** (${code(result.ruleId)}): ${text(result.error ?? "The rule was not checked.")}`;
}

function section(title: string, items: string[], empty: string): string[] {
  return [`## ${title}`, "", ...(items.length === 0 ? [empty] : items), ""];
}

// A rule that could not be checked says nothing about the contract, so an empty list of findings
// is not a clean bill of health when some rules errored.
function nothingToReport(report: ReviewReport, errored: number): string {
  if (report.counts.error === 0 && errored === 0) return "Nothing needs attention.";
  const checked = report.results.length - errored;
  if (checked <= 0)
    return "No rule could be checked, so this review says nothing about the contract.";
  return (
    `No deviations or missing clauses among the ${checked} ${plural(checked, "rule", "rules")} ` +
    `that ${plural(checked, "was", "were")} checked. The rules that could not be checked are listed ` +
    'under "Could not be checked".'
  );
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

  const unseen = notShownSentence(report.notShown);
  if (unseen !== undefined) lines.push(unseen, "");

  // A bullet is a list item of its own, so a note that starts like a list or a heading is
  // escaped as a paragraph is, and a note that is only whitespace is not a note.
  const notes = (report.warnings ?? [])
    .map(paragraph)
    .filter((note) => note !== "")
    .map((note) => `- ${note}`);
  if (notes.length > 0) lines.push(...section("Notes", notes, ""));

  // Results are already in playbook order and the sort is stable, so ties keep that order.
  const attention = report.results
    .filter((result) => result.status === "deviation" || result.status === "missing")
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  const listed = (status: RuleStatus): RuleResult[] =>
    report.results.filter((result) => result.status === status);
  lines.push(
    ...section(
      "Needs attention",
      attention.flatMap((result, i) => [attentionItem(result, i + 1), ""]).slice(0, -1),
      nothingToReport(report, listed("error").length),
    ),
  );
  lines.push(...section("Compliant", listed("compliant").map(listItem), "None."));
  lines.push(...section("Not applicable", listed("not_applicable").map(listItem), "None."));
  lines.push(...section("Could not be checked", listed("error").map(errorItem), "None."));

  return `${lines.join("\n").trimEnd()}\n`;
}
