/**
 * What the simulated reader can see of a request: the text of the prompt, and nothing else. A
 * model behind an API sees the same and no more, so the reader's conclusions can only depend on
 * what the workflow chose to show it. That is the point of using it to demonstrate retrieval.
 *
 * The parts are taken apart with the same layout the stages write (`renderContractBlock`,
 * `describeDocuments`, `renderRule`). Nothing here follows an instruction found in a document:
 * the contract block is only ever searched for fixed phrases, and everything outside it is read
 * only for the labelled lines the stages put there.
 */

/** A clause as the model is shown it: the label of its header line, its document, its text. */
export interface ShownClause {
  /** `c20`, as in the header line. */
  label: string;
  /** `D1`, the first word of the section in the header, or null when the header gives none. */
  doc: string | null;
  /** The paragraph, with every run of white space folded to one space. */
  text: string;
}

export interface DocumentLine {
  label: string;
  kind: "nda" | "amendment" | "other";
  /**
   * The title the line carries (typed at intake, held to one line), or null when it has none. The
   * reader uses it for one thing: the marker that says a matter is the training matter.
   */
  title: string | null;
  /** `YYYY-MM-DD` when the line carries one that parses, else null. */
  statedDate: string | null;
}

export interface PromptView {
  clauses: ShownClause[];
  ruleId: string | null;
  /** The rule's `Required:` line, or null when it has none (an absence rule). */
  required: boolean | null;
  approvedFallback: string | null;
  /** The ids under `Escalate when`. */
  escalationIds: string[];
  /** Whether the stage said the passages are every paragraph of every document. */
  coverage: "whole" | "selection";
  client: string | null;
  /** The document list. Empty when the request has none, as a support check does not. */
  documents: DocumentLine[];
  /** The status a support check is asked about. */
  proposedStatus: string | null;
}

/** Every run of white space as one space, as the reader sees a paragraph. */
export const fold = (text: string): string => text.replace(/\s+/g, " ").trim();

const OPEN = "<contract>\n";
const CLOSE = "\n</contract>";

/** Header: `[c20] 6.1 (section: D1 | 6. Term and Termination)`. Number and section are optional. */
const HEADER = /^\[(c\d+)\](.*)$/;
const SECTION = /\(section: (D\d+)\b[^\n]*\)\s*$/;

function parseClauses(block: string): ShownClause[] {
  const clauses: ShownClause[] = [];
  for (const part of block.split(/\n{2,}/)) {
    const lines = part.split("\n");
    const header = HEADER.exec(lines[0] ?? "");
    if (header === null) continue;
    clauses.push({
      label: header[1]!,
      doc: SECTION.exec(header[2] ?? "")?.[1] ?? null,
      text: fold(lines.slice(1).join(" ")),
    });
  }
  return clauses;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})(?![\d])/;

function parseDate(value: string): string | null {
  const match = DATE.exec(value.trim());
  if (match === null) return null;
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? match[0] : null;
}

/** `D2 (an amendment): Amendment No. 1, stated date 2026-09-15`. A title may hold commas. */
function parseDocuments(outside: string): DocumentLine[] {
  const start = outside.indexOf("Documents:\n");
  if (start === -1) return [];
  const lines: DocumentLine[] = [];
  for (const line of outside.slice(start + "Documents:\n".length).split("\n")) {
    if (line.trim() === "") break;
    const head = /^(D\d+) \((the NDA|an amendment)\): /.exec(line);
    if (head === null) continue;
    const at = line.lastIndexOf(", stated date ");
    const stated = at === -1 ? "" : line.slice(at + ", stated date ".length);
    // The title is what the stage wrote between the kind and the date. It may hold commas and
    // parentheses, and the last ", stated date " is the stage's own.
    const title = line.slice(head[0].length, at === -1 ? undefined : at).trim();
    lines.push({
      label: head[1]!,
      kind: head[2] === "the NDA" ? "nda" : "amendment",
      title: title === "" ? null : title,
      statedDate: parseDate(stated),
    });
  }
  return lines;
}

function escalationIds(outside: string): string[] {
  const start = outside.indexOf("Escalate when");
  if (start === -1) return [];
  const ids: string[] = [];
  // The list is the lines that follow, up to the first blank line.
  for (const line of outside.slice(start).split("\n").slice(1)) {
    if (line.trim() === "") break;
    const id = /^- ([A-Za-z0-9._-]+): /.exec(line)?.[1];
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

export function viewOfPrompt(prompt: string): PromptView {
  const open = prompt.indexOf(OPEN);
  const close = open === -1 ? -1 : prompt.indexOf(CLOSE, open + OPEN.length);
  // A block that never closes has no end the reader can trust, so it is read as no clauses.
  const block = open === -1 || close === -1 ? "" : prompt.slice(open + OPEN.length, close);
  const outside = close === -1 ? prompt : prompt.slice(close + CLOSE.length);

  const required = /^Required: (yes|no)$/m.exec(outside)?.[1];
  const coverage = outside.includes("every paragraph of every document") ? "whole" : "selection";
  return {
    clauses: parseClauses(block),
    ruleId: /^Rule ID: (\S+)$/m.exec(outside)?.[1] ?? null,
    required: required === undefined ? null : required === "yes",
    approvedFallback: /^Approved fallback language: (.+)$/m.exec(outside)?.[1]?.trim() ?? null,
    escalationIds: escalationIds(outside),
    coverage,
    client: /^Our client: (.+)$/m.exec(outside)?.[1]?.trim() ?? null,
    documents: parseDocuments(outside),
    proposedStatus: /^Proposed status: (\S+)$/m.exec(outside)?.[1] ?? null,
  };
}
