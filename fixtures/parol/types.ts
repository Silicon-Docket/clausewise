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
  /** The warnings ingest should raise for the documents. */
  warnings: WarningCode[];
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

export interface AnswerKeyCase {
  case: string;
  split: Split;
  phenomenon: string;
  intake: { clientLegalName: string };
  documents: KeyDocument[];
  expect: Record<string, RuleExpectation>;
  warnings: WarningCode[];
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
}

export interface PlaybookRuleFacts {
  category: CategoryId;
  severity: Severity;
  required: boolean;
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
}
