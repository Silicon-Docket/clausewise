import { renderClauses, type Clause } from "@clausewise/review";
import type { PlaybookRuleRecord, RunManifest, SourceSpan } from "../contracts.js";
import { spanIdOf } from "../contracts.js";

/**
 * What the stages put into a prompt, written once so that the extract, analyze, support and
 * retrieve code all show the model, and cost, the same text.
 *
 * Document text only ever goes through `renderClauses`, which fences it and defuses lines that
 * imitate a header or a closing tag. Everything else here comes from intake or from the playbook
 * and is put outside the contract block.
 */

const INTAKE_LIMIT = 200;

// Line breaks and spaces become one space; invisible format and control characters (a zero-width
// space, say) are dropped, and white space is collapsed again where that joins it.
function collapse(text: string): string {
  return text
    .replace(/[\s\u0085\p{Z}]+/gu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

// A cut between the two halves of a surrogate pair would leave half a character.
function cap(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = Math.max(0, limit - 3);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}...`;
}

/** Text from the model or a document held to one line of bounded length, otherwise unchanged. */
export const flatten = (text: string, limit: number): string => cap(collapse(text), limit);

/**
 * One line of intake text (a client name, a document title, a stated date). Intake data is typed
 * by a person, so it is held to one line and a bounded length: a line break in it could otherwise
 * start a line of its own in a prompt, outside the contract block where nothing defuses it. Angle
 * brackets are replaced, so a title that holds "</contract>" cannot look like the end of the
 * block it sits beside.
 */
export function oneLine(text: string, limit: number = INTAKE_LIMIT): string {
  return cap(collapse(text).replace(/</g, "\u2039").replace(/>/g, "\u203a"), limit);
}

/**
 * A span as the clause renderer takes it. The header the model sees is `[c12] 6.1 (section: D1 |
 * 6. Term)`: the section starts with the document's label, so a clause of an amendment is never
 * mistaken for one of the NDA that happens to carry the same number.
 */
export function clauseOfSpan(span: SourceSpan): Clause {
  const heading = span.heading === null ? "" : flatten(span.heading, 400);
  return {
    id: span.modelLabel,
    number: span.clauseNumber ?? undefined,
    heading: heading === "" ? span.docLabel : `${span.docLabel} | ${heading}`,
    paragraphs: [{ id: span.id, text: span.text }],
    text: span.text,
  };
}

/** The clauses as the model reads them, without the fence. Used to estimate what a bundle costs. */
export const renderSpans = (spans: SourceSpan[]): string => renderClauses(spans.map(clauseOfSpan));

/** The fenced contract block. It is the first thing in a prompt, so a provider can cache it. */
export const renderContractBlock = (spans: SourceSpan[]): string =>
  `<contract>\n${renderSpans(spans)}\n</contract>`;

const KIND_NAME: Record<RunManifest["documents"][number]["kind"], string> = {
  nda: "the NDA",
  amendment: "an amendment",
};

/** The documents of the run, from intake data. Stated dates are entered by a person, never read from a document. */
export function describeDocuments(manifest: RunManifest): string {
  return manifest.documents
    .map((document) => {
      const date =
        document.statedDate === null || oneLine(document.statedDate) === ""
          ? "stated date not given"
          : `stated date ${oneLine(document.statedDate, 60)}`;
      return `${document.label} (${KIND_NAME[document.kind]}): ${oneLine(document.title)}, ${date}`;
    })
    .join("\n");
}

export const describeClient = (manifest: RunManifest): string =>
  oneLine(manifest.clientLegalName) || "not given";

/**
 * What the playbook says about one rule. Fields the rule does not have are left out, as the
 * review package does, so the model is not told "Fallback: none" and left to wonder what that
 * means. An absence rule has no Required line: it passes when its clause is not there.
 */
export function renderRule(rule: PlaybookRuleRecord): string {
  const field = (label: string, value: string | null): string[] =>
    value === null || value.trim() === "" ? [] : [`${label}: ${value.trim()}`];
  return [
    `Rule ID: ${rule.key}`,
    `Title: ${rule.title.trim()}`,
    `Kind: ${rule.kind}`,
    `Severity: ${rule.severity}`,
    ...(rule.kind === "absence" ? [] : [`Required: ${rule.required ? "yes" : "no"}`]),
    ...field("Standard", rule.standard),
    ...field("Fallback", rule.fallback),
    ...field("Unacceptable", rule.unacceptable),
    ...field("Guidance", rule.guidance),
    ...field("Approved fallback language", rule.fallbackLanguage),
    ...(rule.escalateWhen.length === 0
      ? []
      : [
          "Escalate when (answer with the ids of the conditions that apply):",
          ...rule.escalateWhen.map(({ id, text }) => `- ${id}: ${text.trim()}`),
        ]),
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// The fingerprint
// ---------------------------------------------------------------------------------------------

const SAMPLE_SPANS: SourceSpan[] = [
  {
    id: spanIdOf("dv_sample_1", 0),
    label: "D1-p0",
    modelLabel: "c1",
    documentVersionId: "dv_sample_1",
    docLabel: "D1",
    paragraphIndex: 0,
    clauseId: "c1",
    clauseNumber: "6.1",
    heading: "6. Term",
    text: "Sample paragraph of the NDA.",
    textSha256: "0".repeat(64),
  },
  {
    id: spanIdOf("dv_sample_2", 0),
    label: "D2-p0",
    modelLabel: "c2",
    documentVersionId: "dv_sample_2",
    docLabel: "D2",
    paragraphIndex: 0,
    clauseId: "c1",
    clauseNumber: null,
    heading: null,
    text: "Sample paragraph of an amendment.",
    textSha256: "0".repeat(64),
  },
];

const sampleDocument = (
  documentVersionId: string,
  label: RunManifest["documents"][number]["label"],
  kind: RunManifest["documents"][number]["kind"],
  title: string,
  statedDate: string | null,
): RunManifest["documents"][number] => ({
  documentVersionId,
  label,
  kind,
  title,
  versionNo: 1,
  statedDate,
  textSha256: "0".repeat(64),
});

const SAMPLE_MANIFEST: RunManifest = {
  matterId: "sample",
  clientLegalName: "Sample Client, Inc.",
  documents: [
    sampleDocument("dv_sample_1", "D1", "nda", "Sample NDA", "2026-01-01"),
    sampleDocument("dv_sample_2", "D2", "amendment", "Sample Amendment", "2026-02-02"),
    sampleDocument("dv_sample_3", "D3", "amendment", "Another Amendment", null),
  ],
  playbook: { versionId: "sample", slug: "sample", version: "1", sha256: "0" },
  workflow: { versionId: "sample", label: "sample", sha256: "0" },
  model: { provider: "sample", model: "sample" },
};

const SAMPLE_RULES: PlaybookRuleRecord[] = [
  {
    key: "sample-1",
    category: "duration",
    title: "Sample title",
    severity: "high",
    required: true,
    kind: "presence",
    standard: "Sample standard.",
    fallback: "Sample fallback.",
    unacceptable: "Sample unacceptable.",
    guidance: "Sample guidance.",
    fallbackLanguage: "Sample approved language.",
    escalateWhen: [{ id: "sample-condition", text: "Sample condition." }],
  },
  {
    key: "sample-2",
    category: "governing-law",
    title: "Sample absence rule",
    severity: "low",
    required: false,
    kind: "absence",
    standard: "Sample standard.",
    fallback: null,
    unacceptable: null,
    guidance: null,
    fallbackLanguage: null,
    escalateWhen: [],
  },
];

/**
 * What the helpers above write, for fixed sample input: a clause block, the document list, the
 * client line and two rules. It is hashed into every prompt, so a change to a field label, to
 * the shape of the document list or to the header of a clause changes the hash of the prompts
 * that were sent with the old wording. The helpers are shared by the stages, which is why the
 * wording they add is not in any one prompt's own text.
 */
export function renderingFingerprint(): string {
  return [
    renderContractBlock(SAMPLE_SPANS),
    describeDocuments(SAMPLE_MANIFEST),
    describeClient(SAMPLE_MANIFEST),
    ...SAMPLE_RULES.map(renderRule),
  ].join("\n---\n");
}
