/**
 * The case format of the Parol evaluation dataset (docs/parol/05-evaluation.md, "Case format and
 * traceability"). A case is written in code as a `CaseDefinition`; the builder turns it into DOCX
 * and TXT files plus an `AnswerKeyCase` in fixtures/parol/answer-keys.json. Every document and
 * party is synthetic and written for this project.
 *
 * Types, and the list of splits. Nothing in this file reads a file or touches a model.
 */
import type {
  CategoryId,
  DocLabel,
  DocumentKind,
  EscalationCode,
  Status,
  WarningCode,
} from "../../apps/parol/src/contracts.js";

export type Split = "dev" | "heldout";
export const SPLITS: readonly Split[] = ["dev", "heldout"];

/** The playbook's own severities. Declared here so fixtures need no workspace package. */
export type Severity = "high" | "medium" | "low";

// ---------------------------------------------------------------------------------------------
// Source documents
// ---------------------------------------------------------------------------------------------

/**
 * One paragraph of a synthetic document, before it becomes a Word paragraph or a text line.
 * Numbers are typed into the text, as many real contracts do, so a DOCX and a TXT version of the
 * same document segment alike.
 */
export type SourceParagraph =
  /** The document title. Word heading style "Title". */
  | { kind: "title"; text: string; injected?: boolean }
  /** A section heading such as "6. Term and Termination". Word heading style "Heading 1". */
  | { kind: "heading"; text: string; injected?: boolean }
  /** A paragraph outside any numbered clause: a preamble, a recital, a drafting note. */
  | { kind: "text"; text: string; injected?: boolean }
  /** A numbered clause. `number` is "6.1" or "2"; the builder types it before the text. */
  | { kind: "clause"; number: string; text: string; injected?: boolean }
  /** A lettered or numbered sub-item such as "(a)". It belongs to the paragraph before it. */
  | { kind: "item"; marker: string; text: string; injected?: boolean }
  /** A two-party signature block: a table in Word, six short paragraphs in all. */
  | { kind: "signature"; parties: readonly [string, string]; injected?: boolean };

export interface CaseDocument {
  label: DocLabel;
  /** `parol-d05-nda.docx`. Must start with the case prefix, so files never collide. */
  file: string;
  kind: DocumentKind;
  /** What people call the document, such as "Amendment No. 1". */
  title: string;
  /** Entered at intake, never parsed out of the text. ISO date, or null. */
  statedDate: string | null;
  /**
   * False for an earlier version that a later one replaces. Defaults to true. Anchors resolve
   * against the operative document of a label, and a label has exactly one.
   */
  operative?: boolean;
  /** Defaults to 1. */
  versionNo?: number;
  paragraphs: SourceParagraph[];
}

// ---------------------------------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------------------------------

/** A passage in a document, named so that the builder can find it and fail if it cannot. */
export interface AnchorRef {
  /** The label of the operative document that holds the passage. */
  doc: DocLabel;
  /**
   * The clause number as typed, such as "6.1". Null for a paragraph outside any numbered clause:
   * the title, a heading, a preamble, a recital or the signature block.
   */
  clause: string | null;
  /** Words copied exactly from the document. They must occur exactly once in the named clause. */
  anchor: string;
}

/** An anchor with the paragraph index the builder found it at, for people reading the key. */
export interface ResolvedAnchor extends AnchorRef {
  paragraph: number;
}

export type EscalationMode = "required" | "allowed" | "not_expected";

export interface EscalationExpectation {
  mode: EscalationMode;
  /**
   * required: the finding must carry an escalation with one of these codes.
   * allowed: these codes are tolerated and nothing is scored against them.
   * not_expected: empty, and any escalation counts as unnecessary.
   */
  codes: EscalationCode[];
}

/** What a case author writes for one rule. Everything but `status` and `basis` has a default. */
export interface RuleExpectationSpec {
  status: Status;
  /** Other statuses that also count as correct. Rare, and each needs a `note`. */
  acceptable?: Status[];
  /** The passages that decide the status. A compliant slot names the passage that shows it. */
  governing?: AnchorRef[];
  /** Passages an amendment or a later document replaced, and which must not be relied on. */
  superseded?: AnchorRef[];
  /** Other passages a correct reading would look at, such as a definition or a survival clause. */
  relevant?: AnchorRef[];
  escalation?: EscalationExpectation;
  /** `<rule>.<field>: why`, where field is `standard`, `fallback`, `unacceptable`, ... */
  basis: string;
  note?: string;
}

export interface RuleExpectation {
  status: Status;
  acceptable: Status[];
  governing: ResolvedAnchor[];
  superseded: ResolvedAnchor[];
  relevant: ResolvedAnchor[];
  escalation: EscalationExpectation;
  basis: string;
  note: string;
}

// ---------------------------------------------------------------------------------------------
// Uploads: what a person does with the files of a case, and what the application does about it
// ---------------------------------------------------------------------------------------------

/**
 * A file of a case that is not one of its documents. The builder writes it next to the documents,
 * names it in the answer key and counts it in the hash of the split.
 *
 * - `identical_copy`: the bytes of `of` under another name. Uploading it after `of` is a
 *   duplicate and stores nothing.
 * - `resave`: the text of `of` in other bytes, the way a program saving the file again changes
 *   it. Uploading it after `of` is a near duplicate: it is stored and does not govern. The bytes
 *   differ in a fixed way, so the same case always gives the same file (a Word file gets another
 *   revision number and editor in its properties, a text file gets Windows line endings).
 */
export type ExtraFileKind = "identical_copy" | "resave";

export interface ExtraFile {
  /** A new name, starting with the case prefix. Same extension as `of`. */
  file: string;
  kind: ExtraFileKind;
  /** The `file` of a document of the case. */
  of: string;
}

/**
 * What the application does with an uploaded file, in the words of apps/parol/src/services/
 * uploads.ts:
 *
 * - `new_document`: `addDocument` stored a new document. Its first version is operative.
 * - `new_version`: `addVersion` stored a file with other text as the next version. It is operative
 *   at once and the version that governed stops governing.
 * - `same_text`: `addVersion` was given other bytes with the text of a stored version. It is
 *   stored as the next version, it is not operative, the version that governed keeps governing,
 *   and the answer carries `near_duplicate_version`.
 * - `identical_file`: the bytes are those of a stored version. Nothing is stored and nothing
 *   changes. The answer names the stored version and carries `duplicate_document`.
 * - `refused`: the application refuses the upload with a code and changes nothing.
 */
export const UPLOAD_EFFECTS = [
  "new_document",
  "new_version",
  "same_text",
  "identical_file",
  "refused",
] as const;
export type UploadEffect = (typeof UPLOAD_EFFECTS)[number];

/** The refusals a step may expect: the `code` of the error the application raises. */
export const UPLOAD_REFUSALS = [
  "nda_first",
  "nda_exists",
  "duplicate_stated_date",
  "document_limit",
] as const;
export type UploadRefusal = (typeof UPLOAD_REFUSALS)[number];

/** What the answer to an upload names, and the state of that version once the step is done. */
export interface UploadAnswer {
  effect: Exclude<UploadEffect, "refused">;
  /**
   * The document and version the answer names: the one just stored, or for an identical file the
   * stored version it matches (which may belong to another document than the one uploaded to).
   */
  label: DocLabel;
  versionNo: number;
  /** Whether that version is operative once the step is done. */
  operative: boolean;
  /**
   * The codes of the warnings the answer carries (`UploadResult.warnings`), in any order. They are
   * `duplicate_document` for an identical file, `near_duplicate_version` when the text is that of
   * a stored version, and the warnings ingest raises for the file (`instruction_like_text` and so
   * on).
   */
  warnings: WarningCode[];
  /** Required with `near_duplicate_version`: the stored version whose text this is. */
  sameTextAs?: { label: DocLabel; versionNo: number };
}

export interface UploadRefusalAnswer {
  effect: "refused";
  code: UploadRefusal;
}

export type UploadExpectation = UploadAnswer | UploadRefusalAnswer;

interface UploadStepBase {
  /** The `file` of a document of the case, or of an extra file. */
  file: string;
  /** The date entered with the upload, or null. Stored with the version. */
  statedDate: string | null;
  expect: UploadExpectation;
}

/**
 * The person adds a document (`MatterService.addDocument`). The application gives it the smallest
 * free label, and `label` is the one the person means it to have: when the file is stored, the two
 * must agree. Title and kind are entered by the person.
 */
export interface AddDocumentStep extends UploadStepBase {
  action: "addDocument";
  label: DocLabel;
  title: string;
  kind: DocumentKind;
}

/**
 * The person adds a version to a document that is already in the matter
 * (`MatterService.addVersion`). The application takes neither a title nor a kind for it.
 */
export interface AddVersionStep extends UploadStepBase {
  action: "addVersion";
  label: DocLabel;
}

export type UploadStep = AddDocumentStep | AddVersionStep;

/** The uploads of a case, in the order a person makes them. */
export interface CaseUploads {
  /** Files that are not documents of the case. */
  files?: ExtraFile[];
  steps: UploadStep[];
}

// ---------------------------------------------------------------------------------------------
// Canary matters (docs/parol/05-evaluation.md, "Canary matters")
// ---------------------------------------------------------------------------------------------

export const CANARY_MATTER_IDS = ["bramblewick", "saltmarsh"] as const;
export type CanaryMatterId = (typeof CANARY_MATTER_IDS)[number];

/**
 * A synthetic matter that sits in the same store as the case while it runs, so that a leak from
 * one matter into another can be seen. It holds one NDA with strings that cannot occur by chance
 * (`CANARY-<NAME>-<12 hex>`) and one distinctive fact that is not secret. The data is in
 * fixtures/parol/canary.ts.
 */
export interface CanaryMatter {
  id: CanaryMatterId;
  /** The matter's name as people say it, such as "Bramblewick". */
  name: string;
  /** A canary matter belongs to one split and only cases of that split may name it. */
  split: Split;
  clientLegalName: string;
  /** The one NDA of the matter. Label D1, kind nda, file `parol-canary-<id>-...`. */
  document: CaseDocument;
  /** At least three, each in the format above and each occurring once in the document. */
  strings: readonly string[];
  /** Words of the document that state a distinctive fact, once. Not secret. */
  fact: string;
}

// ---------------------------------------------------------------------------------------------

export interface CaseDefinition {
  /** `PAROL-D05`. */
  case: string;
  split: Split;
  /** One line on what the case tests, as in the "Phenomenon" column of document 5. */
  phenomenon: string;
  intake: { clientLegalName: string };
  documents: CaseDocument[];
  /** One entry per rule of the pinned playbook, no more and no fewer. */
  expect: Record<string, RuleExpectationSpec>;
  /**
   * The warnings the case should show. Without `uploads` these are the warnings ingest raises for
   * the documents. With `uploads` they are every code any upload returns together with the codes
   * ingest raises for the documents that govern at the end.
   */
  warnings: WarningCode[];
  /**
   * What the person uploads, in order, and what the application does with each file. Absent for a
   * case whose documents are simply uploaded once each in label order. With it, the steps decide
   * which versions exist, and `documents` must agree with them (label, version number, stated date
   * and whether the version is operative at the end).
   */
  uploads?: CaseUploads;
  /**
   * The canary matters that sit in the same store while the case runs. A matter of the other
   * split is refused.
   */
  canaryMatters?: CanaryMatterId[];
}

// ---------------------------------------------------------------------------------------------
// The built answer key (fixtures/parol/answer-keys.json)
// ---------------------------------------------------------------------------------------------

export interface KeyDocument {
  label: DocLabel;
  file: string;
  kind: DocumentKind;
  title: string;
  versionNo: number;
  statedDate: string | null;
  operative: boolean;
  /** Of the file bytes as written to fixtures/parol/files. */
  sha256: string;
  /** Paragraphs the file holds, counted as the Word parser counts them. */
  paragraphs: number;
}

/** An extra file as the key records it. */
export interface KeyExtraFile extends ExtraFile {
  /** Of the file bytes as written to fixtures/parol/files. */
  sha256: string;
}

/**
 * The uploads of a case as the key records them: the extra files with their hashes, and the steps
 * as written. To replay them, create the matter with the case's intake, then for each step read
 * the file named in `documents` or `files` from fixtures/parol/files and call `addDocument`
 * (title, kind, file name, bytes, stated date) or `addVersion` on the document that has the step's
 * label. Compare the answer with `expect` and, at the end, the operative version of each label
 * with the `documents` entries that are operative.
 */
export interface KeyUploads {
  files: KeyExtraFile[];
  steps: UploadStep[];
}

export interface AnswerKeyCase {
  case: string;
  split: Split;
  phenomenon: string;
  intake: { clientLegalName: string };
  documents: KeyDocument[];
  expect: Record<string, RuleExpectation>;
  warnings: WarningCode[];
  /** Only for a case with upload steps. */
  uploads?: KeyUploads;
  /** Only for a case that names canary matters. */
  canaryMatters?: CanaryMatterId[];
}

/**
 * The same documents with the injected paragraph removed. Both are run, and a slot whose status
 * differs between the case and its twin is an injection effect. A twin has no expectations of
 * its own: the original's key applies to both.
 */
export interface AnswerKeyTwin {
  case: string;
  twinOf: string;
  split: Split;
  intake: { clientLegalName: string };
  documents: KeyDocument[];
  /** The same canary matters as the original, when it names any. */
  canaryMatters?: CanaryMatterId[];
}

export interface PlaybookRuleFacts {
  category: CategoryId;
  severity: Severity;
  required: boolean;
}

/**
 * A canary matter as the key records it: what the evaluation scans for, and the file that holds
 * the matter's NDA. Present only for the matters that a case names.
 */
export interface CanaryKeyMatter {
  id: CanaryMatterId;
  name: string;
  split: Split;
  clientLegalName: string;
  /** The matter's one NDA, with the hash of its file. */
  document: KeyDocument;
  /** The strings that must never leave the matter. Upper case name, 12 lower case hex digits. */
  strings: string[];
  /** Words of the document that state a distinctive fact that is not secret. */
  fact: string;
}

export interface AnswerKeyFile {
  format: 1;
  playbook: {
    slug: string;
    version: string;
    /** Of the YAML text exactly as stored. */
    sha256: string;
    rules: Record<string, PlaybookRuleFacts>;
  };
  cases: AnswerKeyCase[];
  twins: AnswerKeyTwin[];
  /** Only when a case names a canary matter, so a dataset without any is byte for byte as before. */
  canary?: { matters: CanaryKeyMatter[] };
}

export interface SplitTotals {
  cases: number;
  slots: number;
  /** Slots expected `deviation` or `missing`. */
  expectedFlags: number;
  /** Of which the rule's severity is high. */
  highSeverityFlags: number;
  /** Slots whose expected status is `undetermined`. */
  mustBeUndetermined: number;
  /** Slots with a required escalation. */
  requiredEscalations: number;
  /** Slots with an accepted alternative status. */
  withAlternative: number;
  /** Cases with at least one expected warning. */
  casesWithWarning: number;
  /** Cases that have an injection twin, and the slots in them. */
  injectionCases: number;
  injectionSlots: number;
}

export interface SplitEntry extends SplitTotals {
  sha256: string;
  /** Files in the split, twins included. */
  files: number;
}

export interface SplitsFile {
  format: 1;
  dataset: string;
  /** Only splits that have cases. A split with no cases has no hash to commit. */
  splits: Partial<Record<Split, SplitEntry>>;
  /**
   * The support calibration set (fixtures/parol/calibration.json): its hash and its counts. A
   * separate optional entry, outside every split, so it never changes the hash of a split.
   */
  calibration?: CalibrationEntry;
}

// ---------------------------------------------------------------------------------------------
// The support calibration set (docs/parol/05-evaluation.md, "Support calibration set")
// ---------------------------------------------------------------------------------------------

export const CALIBRATION_LABELS = ["supported", "unsupported"] as const;
/** The author's label. An unsupported pair has a valid quote that does not support the claim. */
export type CalibrationLabel = (typeof CALIBRATION_LABELS)[number];

/**
 * The five ways an unsupported pair fails on substance although its quote is valid. Four pairs of
 * each kind, and a supported pair has none.
 *
 * - `superseded`: the finding relies on text that an amendment replaced or deleted.
 * - `overlooked_exception`: the clause cited states an exception, qualifier or condition ("except
 *   as provided in Section 8") that the finding overlooks.
 * - `other_party_obligation`: the clause cited puts a duty, cost or choice on the other party and
 *   the finding reads it as the client's.
 * - `definition_as_duty`: a definition is read as if it imposed a duty or a period.
 * - `wrong_frame`: a number is read in the wrong frame (three years from termination for three
 *   years from disclosure, thirty days' notice for a thirty day return deadline).
 */
export const CALIBRATION_KINDS = [
  "superseded",
  "overlooked_exception",
  "other_party_obligation",
  "definition_as_duty",
  "wrong_frame",
] as const;
export type CalibrationKind = (typeof CALIBRATION_KINDS)[number];

/**
 * The claim a finding makes, as a model would write it. The support check runs only for a
 * determined status, and the checker is shown the status and the discrepancy, not the explanation
 * (apps/parol/src/services/support-checker.ts). A compliant claim has an empty discrepancy, as the
 * analysis schema says.
 */
export interface CalibrationClaim {
  status: "compliant" | "deviation";
  discrepancy: string;
  explanation: string;
}

/** The one passage the finding cites: a document label, a clause number and words copied from it. */
export interface CalibrationEvidence {
  doc: DocLabel;
  /** The clause number as typed, or null for a paragraph outside any numbered clause. */
  clause: string | null;
  /** Occurs exactly once in the clause, in the operative document of that label. */
  quote: string;
}

/** What the author writes for one pair. */
export interface CalibrationPairSpec {
  /** `CAL-01` and up. Carries no information about the label, the kind or the case. */
  id: string;
  /** A development case, such as `PAROL-D05`. */
  case: string;
  /** A rule of the pinned playbook. */
  rule: string;
  label: CalibrationLabel;
  /** Required for an unsupported pair, and absent for a supported one. */
  kind?: CalibrationKind;
  claim: CalibrationClaim;
  evidence: CalibrationEvidence;
  /** Why the label is right. Not shown to a blind reader. */
  note: string;
}

/** A pair as calibration.json records it: the evidence resolved, the clause text pinned. */
export interface CalibrationKeyPair extends Omit<CalibrationPairSpec, "evidence"> {
  evidence: CalibrationEvidence & {
    /** The index of the paragraph the quote was found in, in the operative document. */
    paragraph: number;
  };
  /** SHA-256 of the text of that paragraph, so a case edited under a pair changes the hash. */
  paragraphSha256: string;
}

export interface CalibrationCounts {
  pairs: number;
  supported: number;
  unsupported: number;
  /** The unsupported pairs of each kind. */
  byKind: Record<CalibrationKind, number>;
}

/** fixtures/parol/calibration.json. */
export interface CalibrationFile {
  format: 1;
  dataset: string;
  playbook: { slug: string; version: string; sha256: string };
  counts: CalibrationCounts;
  pairs: CalibrationKeyPair[];
}

/** What splits.json records: the hash of calibration.json (as canonical JSON) and the counts. */
export interface CalibrationEntry extends CalibrationCounts {
  sha256: string;
}
