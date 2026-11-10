/**
 * Small constructors for writing cases, so that a case reads as the document and its answer and
 * not as plumbing. Nothing here has behaviour that a case could depend on without seeing it: each
 * helper returns plain data in the shapes of types.ts.
 */
import type {
  DocLabel,
  DocumentKind,
  EscalationCode,
  WarningCode,
} from "../../apps/parol/src/contracts.js";
import type {
  AddDocumentStep,
  AddVersionStep,
  AnchorRef,
  EscalationExpectation,
  ExtraFile,
  RuleExpectationSpec,
  SourceParagraph,
  UploadAnswer,
  UploadRefusal,
  UploadRefusalAnswer,
} from "./types.js";

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------

export const title = (text: string): SourceParagraph => ({ kind: "title", text });
export const heading = (text: string): SourceParagraph => ({ kind: "heading", text });
export const text = (value: string): SourceParagraph => ({ kind: "text", text: value });
export const clause = (number: string, value: string): SourceParagraph => ({
  kind: "clause",
  number,
  text: value,
});
export const item = (marker: string, value: string): SourceParagraph => ({
  kind: "item",
  marker,
  text: value,
});
export const signature = (first: string, second: string): SourceParagraph => ({
  kind: "signature",
  parties: [first, second],
});

/**
 * Marks a paragraph as the injected instruction. The builder removes it to make the twin, so no
 * anchor may point into it.
 */
export const injected = (paragraph: SourceParagraph): SourceParagraph => ({
  ...paragraph,
  injected: true,
});

/** A section: its heading without a number, then its clauses without numbers. */
export type SectionSpec = readonly [title: string, clauses: readonly (string | null)[]];

/**
 * Numbers sections from 1 and the clauses in each from 1, so that a variant that leaves a clause
 * or a whole section out renumbers itself and the surrounding text stays consistent. A `null`
 * clause is skipped, and a section with no clause left is skipped with its heading.
 */
export function numbered(sections: readonly SectionSpec[]): SourceParagraph[] {
  const out: SourceParagraph[] = [];
  let section = 0;
  for (const [name, clauses] of sections) {
    const kept = clauses.filter((value): value is string => value !== null);
    if (kept.length === 0) continue;
    section += 1;
    out.push(heading(`${section}. ${name}`));
    kept.forEach((value, i) => out.push(clause(`${section}.${i + 1}`, value)));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------------------------------

export const at = (doc: DocLabel, clauseNumber: string | null, anchor: string): AnchorRef => ({
  doc,
  clause: clauseNumber,
  anchor,
});

export const NOT_EXPECTED: EscalationExpectation = { mode: "not_expected", codes: [] };
export const required = (...codes: EscalationCode[]): EscalationExpectation => ({
  mode: "required",
  codes,
});
export const allowed = (...codes: EscalationCode[]): EscalationExpectation => ({
  mode: "allowed",
  codes,
});

type WithoutStatus = Omit<RuleExpectationSpec, "status">;

export const compliant = (spec: WithoutStatus): RuleExpectationSpec => ({
  status: "compliant",
  ...spec,
});
export const deviation = (spec: WithoutStatus): RuleExpectationSpec => ({
  status: "deviation",
  ...spec,
});
export const missing = (spec: WithoutStatus): RuleExpectationSpec => ({
  status: "missing",
  ...spec,
});
export const notApplicable = (spec: WithoutStatus): RuleExpectationSpec => ({
  status: "not_applicable",
  ...spec,
});
export const undetermined = (spec: WithoutStatus): RuleExpectationSpec => ({
  status: "undetermined",
  ...spec,
});

// ---------------------------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------------------------

/** `file` is the bytes of the document file `of` under another name. */
export const identicalCopyOf = (of: string, file: string): ExtraFile => ({
  file,
  kind: "identical_copy",
  of,
});
/** `file` has the text of the document file `of` in other bytes, as a program saving it again would. */
export const resaveOf = (of: string, file: string): ExtraFile => ({ file, kind: "resave", of });

/** The person adds a document: the label they mean it to have, and what they enter about it. */
export const addDocument = (
  file: string,
  entered: { label: DocLabel; title: string; kind: DocumentKind; statedDate: string | null },
  expect: UploadAnswer | UploadRefusalAnswer,
): AddDocumentStep => ({ action: "addDocument", file, ...entered, expect });

/** The person adds a version to the document that has `label`. */
export const addVersion = (
  file: string,
  label: DocLabel,
  statedDate: string | null,
  expect: UploadAnswer | UploadRefusalAnswer,
): AddVersionStep => ({ action: "addVersion", file, label, statedDate, expect });

interface AnswerOptions {
  /** Warnings ingest raises for the file, such as `instruction_like_text`. */
  warnings?: WarningCode[];
}
type Version = { label: DocLabel; versionNo: number };

/** A new document: version 1, operative. With `sameTextAs` when its text is that of a stored version. */
export const newDocument = (
  label: DocLabel,
  options: AnswerOptions & { sameTextAs?: Version } = {},
): UploadAnswer => ({
  effect: "new_document",
  label,
  versionNo: 1,
  operative: true,
  warnings: [
    ...(options.sameTextAs === undefined ? [] : (["near_duplicate_version"] as const)),
    ...(options.warnings ?? []),
  ],
  ...(options.sameTextAs === undefined ? {} : { sameTextAs: options.sameTextAs }),
});

/** Other text as the next version of a document: operative at once, and the version before it stops governing. */
export const newVersion = (
  label: DocLabel,
  versionNo: number,
  options: AnswerOptions = {},
): UploadAnswer => ({
  effect: "new_version",
  label,
  versionNo,
  operative: true,
  warnings: [...(options.warnings ?? [])],
});

/** Other bytes with the text of the stored version `sameTextAs`: stored as the next version and not operative. */
export const sameText = (
  label: DocLabel,
  versionNo: number,
  sameTextAs: Version,
  options: AnswerOptions = {},
): UploadAnswer => ({
  effect: "same_text",
  label,
  versionNo,
  operative: false,
  warnings: ["near_duplicate_version", ...(options.warnings ?? [])],
  sameTextAs,
});

/**
 * The bytes of a stored version, uploaded again: nothing is stored. The answer names the stored
 * version, and `operative` says whether that version governs once the step is done.
 */
export const identicalFile = (
  label: DocLabel,
  versionNo: number,
  operative: boolean,
): UploadAnswer => ({
  effect: "identical_file",
  label,
  versionNo,
  operative,
  warnings: ["duplicate_document"],
});

/** The application refuses the upload with this code and changes nothing. */
export const refused = (code: UploadRefusal): UploadRefusalAnswer => ({
  effect: "refused",
  code,
});
