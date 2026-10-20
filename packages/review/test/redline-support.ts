import { createScriptedGenerator } from "@clausewise/llm/testing";
import JSZip from "jszip";
import { reviewContract } from "../src/pipeline.js";
import type { ReviewReport, RuleCheck, RuleResult } from "../src/types.js";
import {
  buildDocx,
  clausesOf,
  compliantAnswer,
  idOf,
  loadPlaybook,
  onlyRules,
  ruleIdOf,
} from "./pipeline-support.js";

// A small contract with one finding of every kind a redline can hold, and a review of it that is
// the same every time: three tracked changes, one change the engine refuses (it sits across a
// hyperlink), one missing clause, and one rule that is met.

export const AUTHOR = "Reviewer";
export const DATE = new Date("2025-03-04T05:06:07Z");

export const PREAMBLE =
  "This Agreement is made between Acme Inc and Beta LLC to govern what each of them shares with the other.";
export const TERM =
  "1.1 Recipient shall keep the Confidential Information secret for three years from the date it is disclosed to Recipient.";
export const NOTICE =
  "1.2 Either party may end this Agreement by giving thirty days written notice.";
export const LAW = "1.3 This Agreement is governed by the laws of Singapore.";
export const FEE = "1.4 The fee is five percent of revenue annually, payable monthly in arrears.";
export const RETURN = "1.5 Each party shall return the other party's materials on request.";

/** The rules of the scenario, in the playbook's order, by what became of them. */
export const RULES = {
  /** Deviations with a tracked change. */
  applied: ["term", "permitted-use", "governing-law"],
  /** A deviation whose tracked change the engine refused: only a comment, with the wording. */
  commentOnly: "remedies",
  /** A missing clause: only a comment, with the suggested clause. */
  missing: "compelled-disclosure",
  compliant: "exclusions",
} as const;

export const FLAGGED = [...RULES.applied, RULES.commentOnly, RULES.missing] as const;
export const SUGGESTED_CLAUSE =
  "Recipient may disclose Confidential Information to the extent the law requires, giving notice where it may.";

export interface Scenario {
  docx: Uint8Array;
  report: ReviewReport;
  redlined: Uint8Array;
}

const deviation = (overrides: Partial<RuleCheck>): RuleCheck =>
  compliantAnswer({ status: "deviation", explanation: "Falls short.", ...overrides });

export async function buildDocument(
  overrides: { law?: string; term?: string; keep?: number } = {},
): Promise<Uint8Array> {
  const paragraphs = [
    { text: PREAMBLE },
    { text: overrides.term ?? TERM },
    { text: NOTICE },
    { text: overrides.law ?? LAW },
    {
      xml:
        `<w:r><w:t xml:space="preserve">1.4 The fee is </w:t></w:r>` +
        `<w:hyperlink w:anchor="fees"><w:r><w:t>five percent of revenue</w:t></w:r></w:hyperlink>` +
        `<w:r><w:t xml:space="preserve"> annually, payable monthly in arrears.</w:t></w:r>`,
    },
    { text: RETURN },
  ];
  return buildDocx(paragraphs.slice(0, overrides.keep ?? paragraphs.length));
}

/** The rule ids that a review of the scenario reports on, in the order of the report. */
export const SCENARIO_RULE_IDS = [
  ...RULES.applied,
  RULES.commentOnly,
  RULES.missing,
  RULES.compliant,
];

export async function buildScenario(): Promise<Scenario> {
  const docx = await buildDocument();
  const clauses = await clausesOf(docx);
  const id = (number: string): string => idOf(clauses, number);
  const answers: Record<string, RuleCheck> = {
    term: deviation({
      clauseIds: [id("1.1")],
      comment: "Shorten the term.",
      edit: { clauseId: id("1.1"), quote: "three years", replacement: "two years" },
    }),
    "permitted-use": deviation({
      clauseIds: [id("1.2")],
      comment: "Ask for longer notice.",
      edit: { clauseId: id("1.2"), quote: "thirty days", replacement: "sixty days" },
    }),
    "governing-law": deviation({
      clauseIds: [id("1.3")],
      comment: "Use a forum we know.",
      edit: { clauseId: id("1.3"), quote: "Singapore", replacement: "Delaware" },
    }),
    remedies: deviation({
      clauseIds: [id("1.4")],
      comment: "Lower the fee.",
      edit: {
        clauseId: id("1.4"),
        quote: "five percent of revenue",
        replacement: "three percent of revenue",
      },
    }),
    "compelled-disclosure": compliantAnswer({
      status: "missing",
      clauseIds: [],
      explanation: "Nothing lets Recipient disclose what the law requires.",
      comment: "Add a legal compulsion exception.",
      suggestedClause: SUGGESTED_CLAUSE,
    }),
    exclusions: compliantAnswer({ clauseIds: [id("1.5")] }),
  };
  const playbook = onlyRules(loadPlaybook(), ...SCENARIO_RULE_IDS);
  const { report, redlined } = await reviewContract(
    { docx, playbook },
    createScriptedGenerator((request) => answers[ruleIdOf(request)]),
    { author: AUTHOR, date: DATE },
  );
  return { docx, report, redlined };
}

export function resultOf(report: ReviewReport, ruleId: string): RuleResult {
  const found = report.results.find((result) => result.ruleId === ruleId);
  if (found === undefined) throw new Error(`no result for ${ruleId}`);
  return found;
}

// ---------------------------------------------------------------------------------------------
// Reading the parts of a file
// ---------------------------------------------------------------------------------------------

/** Every part of the package by name, as bytes, so that two files can be compared part by part. */
export async function partsOf(bytes: Uint8Array): Promise<Map<string, Buffer>> {
  const zip = await JSZip.loadAsync(bytes);
  const parts = new Map<string, Buffer>();
  for (const name of Object.keys(zip.files).sort()) {
    const entry = zip.files[name];
    if (entry === undefined || entry.dir) continue;
    parts.set(name, Buffer.from(await entry.async("uint8array")));
  }
  return parts;
}

export async function documentXml(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  return (await zip.file("word/document.xml")?.async("string")) ?? "";
}

/** The XML of each body paragraph, exactly as it is written. */
export async function paragraphXml(bytes: Uint8Array): Promise<string[]> {
  return (await documentXml(bytes)).match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
}

/** True when the two files hold the same parts with the same bytes. */
export async function sameParts(a: Uint8Array, b: Uint8Array): Promise<boolean> {
  const [first, second] = await Promise.all([partsOf(a), partsOf(b)]);
  if ([...first.keys()].join("\n") !== [...second.keys()].join("\n")) return false;
  return [...first].every(([name, data]) => data.equals(second.get(name) ?? Buffer.alloc(0)));
}
