/**
 * The dataset builder, without any file system access: it checks the cases, resolves their
 * anchors against the text it generates, renders the files, and computes the answer keys, the
 * totals and the split hashes. tools/make-parol-fixtures.ts writes the result to disk, and the
 * tests call this directly.
 *
 * The traceability rules of docs/parol/05-evaluation.md are enforced here and fail loudly: every
 * problem found is reported together, so an author fixes a case in one pass. Messages name the
 * case, rule, role and position of the fault and never quote document text.
 */
import {
  CATEGORY_IDS,
  DOC_LABELS,
  DOCUMENT_KINDS,
  ESCALATION_CODES,
  STATUSES,
  WARNING_CODES,
  type CategoryId,
  type DocLabel,
  type DocumentKind,
  type Status,
  type WarningCode,
} from "../../apps/parol/src/contracts.js";
import { canonicalJson, sha256Hex } from "../../apps/parol/src/canonical.js";
import { documentTextSha256 } from "../../apps/parol/src/ingest/text-hash.js";
import { parsePlaybook } from "../../packages/playbook/src/index.js";
import { countOccurrences } from "./anchors.js";
import { CANARY_MATTERS } from "./canary.js";
import { expandDocument, renderDocx, renderTxt, type ExpandedParagraph } from "./render.js";
import type {
  AnchorRef,
  AnswerKeyCase,
  AnswerKeyFile,
  AnswerKeyTwin,
  CanaryKeyMatter,
  CanaryMatter,
  CaseDefinition,
  CaseDocument,
  ExtraFile,
  KeyDocument,
  KeyExtraFile,
  KeyUploads,
  PlaybookRuleFacts,
  ResolvedAnchor,
  RuleExpectation,
  RuleExpectationSpec,
  Split,
  SplitEntry,
  SplitTotals,
  SplitsFile,
  UploadEffect,
  UploadExpectation,
  UploadRefusal,
  UploadStep,
} from "./types.js";
import { SPLITS, UPLOAD_EFFECTS, UPLOAD_REFUSALS } from "./types.js";

export const DATASET_LABEL = "parol-cases v1";
/** Document 5: acceptable alternatives are rare, at most two per split. */
export const MAX_ALTERNATIVES_PER_SPLIT = 2;

export class TraceabilityError extends Error {
  override name = "TraceabilityError";
  constructor(readonly problems: readonly string[]) {
    super(
      `${problems.length} problem${problems.length === 1 ? "" : "s"} in the cases:\n  ${problems.join("\n  ")}`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// The pinned playbook
// ---------------------------------------------------------------------------------------------

export interface PlaybookFacts {
  slug: string;
  version: string;
  /** Of the YAML text exactly as given. */
  sha256: string;
  /** In playbook order. */
  ruleKeys: string[];
  rules: Record<
    string,
    PlaybookRuleFacts & {
      /** The fields a basis may name: `standard`, `escalateWhen.<id>`, ... */
      fields: ReadonlySet<string>;
      escalateWhenIds: readonly string[];
    }
  >;
}

const CATEGORY_SET: ReadonlySet<string> = new Set(CATEGORY_IDS);

export function readPlaybookFacts(yamlText: string, slug: string): PlaybookFacts {
  const playbook = parsePlaybook(yamlText, slug);
  if (playbook.version === undefined) {
    throw new TraceabilityError([`playbook ${slug}: it has no version, and a dataset pins one`]);
  }
  const rules: PlaybookFacts["rules"] = {};
  const problems: string[] = [];
  for (const rule of playbook.rules) {
    if (rule.category === undefined || !CATEGORY_SET.has(rule.category)) {
      problems.push(`playbook ${slug}: rule ${rule.id} has no category from the Parol list`);
      continue;
    }
    const escalateWhenIds = (rule.escalateWhen ?? []).map((entry) => entry.id);
    const fields = new Set<string>(["standard", "required"]);
    if (rule.fallback !== undefined) fields.add("fallback");
    if (rule.unacceptable !== undefined) fields.add("unacceptable");
    if (rule.guidance !== undefined) fields.add("guidance");
    for (const id of escalateWhenIds) fields.add(`escalateWhen.${id}`);
    rules[rule.id] = {
      category: rule.category as CategoryId,
      severity: rule.severity,
      required: rule.required,
      fields,
      escalateWhenIds,
    };
  }
  if (problems.length > 0) throw new TraceabilityError(problems);
  return {
    slug,
    version: playbook.version,
    sha256: sha256Hex(yamlText),
    ruleKeys: playbook.rules.map((rule) => rule.id),
    rules,
  };
}

// ---------------------------------------------------------------------------------------------
// Checking and resolving
// ---------------------------------------------------------------------------------------------

const CASE_KEY = /^PAROL-([DH])(\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLAUSE_NUMBER = /^\d{1,3}(?:\.\d{1,3}){0,3}$/;
const ITEM_MARKER = /^(?:\([a-z0-9]{1,6}\)|[a-z]{1,6}\))$/;
// En and em dash, the other dashes of the General Punctuation block, and the minus sign. The
// project style forbids them in every string, document text included.
const DASHES = /[\u2010-\u2015\u2212]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const BASIS = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.([A-Za-z]+(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)?): (\S.*)$/;

const STATUS_SET: ReadonlySet<string> = new Set(STATUSES);
const CODE_SET: ReadonlySet<string> = new Set(ESCALATION_CODES);
const WARNING_SET: ReadonlySet<string> = new Set(WARNING_CODES);
const LABEL_SET: ReadonlySet<string> = new Set(DOC_LABELS);

const isFlag = (status: Status): boolean => status === "deviation" || status === "missing";

/** The case key without its prefix, lower case: `PAROL-D05` gives `d05`. */
export const caseSlug = (caseKey: string): string => caseKey.replace(/^PAROL-/, "").toLowerCase();
export const filePrefix = (caseKey: string): string => `parol-${caseSlug(caseKey)}-`;
export const twinKeyOf = (caseKey: string): string => `${caseKey}-twin`;
/** `parol-d08-nda.docx` becomes `parol-d08-twin-nda.docx`. */
export function twinFileOf(caseKey: string, file: string): string {
  const prefix = filePrefix(caseKey);
  return file.startsWith(prefix) ? `${prefix}twin-${file.slice(prefix.length)}` : `twin-${file}`;
}

export const hasInjection = (definition: Pick<CaseDefinition, "documents">): boolean =>
  definition.documents.some((doc) => doc.paragraphs.some((p) => p.injected === true));

export interface AnalyzedDocument {
  definition: CaseDocument;
  operative: boolean;
  versionNo: number;
  paragraphs: ExpandedParagraph[];
}

export interface AnalyzedCase {
  definition: CaseDefinition;
  documents: AnalyzedDocument[];
  /** The documents of the twin, when the case has an injected paragraph. */
  twinDocuments: AnalyzedDocument[] | null;
  expect: Record<string, RuleExpectation>;
  /** For a case with upload steps: what is predicted about its files and what the steps do. */
  uploads: UploadPlan | null;
  /** The canary matters the case names, resolved. */
  canaryMatters: CanaryMatter[];
}

class Problems {
  readonly list: string[] = [];
  add(scope: string, message: string): void {
    this.list.push(`${scope}: ${message}`);
  }
}

function analyzeDocument(
  doc: CaseDocument,
  scope: string,
  problems: Problems,
  omitInjected = false,
): AnalyzedDocument {
  const where = `${scope} ${doc.label}`;
  if (!LABEL_SET.has(doc.label)) problems.add(where, "the label is not D1, D2 or D3");
  if (doc.statedDate !== null && !ISO_DATE.test(doc.statedDate)) {
    problems.add(where, "the stated date is not an ISO date (YYYY-MM-DD) or null");
  }
  if (doc.title.trim() === "" || DASHES.test(doc.title)) {
    problems.add(where, "the title is empty or contains a dash");
  }
  if (!/^parol-[a-z0-9]+(?:-[a-z0-9]+)*\.(?:docx|txt)$/.test(doc.file)) {
    problems.add(where, "the file name is not lower case words joined by hyphens, .docx or .txt");
  }
  const numbers = new Set<string>();
  doc.paragraphs.forEach((paragraph, i) => {
    const at = `${where} paragraph ${i}`;
    const parts: string[] =
      paragraph.kind === "signature" ? [...paragraph.parties] : [paragraph.text];
    for (const part of parts) {
      if (part === "" || part !== part.trim()) {
        problems.add(at, "the text is empty or has white space at an end");
      } else if (CONTROL.test(part)) {
        problems.add(at, "the text contains a control character or a line break");
      } else if (DASHES.test(part)) {
        problems.add(at, "the text contains an en dash, an em dash or another dash");
      }
    }
    if (paragraph.kind === "clause") {
      if (!CLAUSE_NUMBER.test(paragraph.number)) {
        problems.add(at, "the clause number is not digits with points, such as 6.1");
      } else if (numbers.has(paragraph.number)) {
        problems.add(at, "the clause number is used twice in this document");
      }
      numbers.add(paragraph.number);
    }
    if (paragraph.kind === "item") {
      if (!ITEM_MARKER.test(paragraph.marker)) problems.add(at, "the item marker is not (a) or a)");
      if (i === 0) problems.add(at, "an item cannot be the first paragraph");
    }
  });
  if (doc.paragraphs.length === 0) problems.add(where, "the document has no paragraphs");
  return {
    definition: doc,
    operative: doc.operative !== false,
    versionNo: doc.versionNo ?? 1,
    paragraphs: expandDocument(doc, { omitInjected }),
  };
}

function checkDocuments(definition: CaseDefinition, scope: string, problems: Problems): void {
  const { documents } = definition;
  if (documents.length === 0) {
    problems.add(scope, "the case has no documents");
    return;
  }
  const operative = documents.filter((doc) => doc.operative !== false);
  const labels = operative.map((doc) => doc.label);
  if (new Set(labels).size !== labels.length) {
    problems.add(scope, "a label has more than one operative document");
  }
  if (labels.some((label, i) => label !== DOC_LABELS[i])) {
    problems.add(scope, "the operative labels must be D1, D2, D3 in order with no gaps");
  }
  const seen = new Set<string>();
  for (const doc of documents) {
    const key = `${doc.label}#${doc.versionNo ?? 1}`;
    if (seen.has(key)) problems.add(scope, `${doc.label} repeats a version number`);
    seen.add(key);
    const kind = doc.label === "D1" ? "nda" : "amendment";
    if (doc.kind !== kind) problems.add(scope, `${doc.label} must be of kind ${kind}`);
    if (!doc.file.startsWith(filePrefix(definition.case))) {
      problems.add(scope, `${doc.label} file must start with ${filePrefix(definition.case)}`);
    }
  }
}

/** Where an anchor was found, or why it was not found exactly once. */
type Found = { ok: true; paragraph: number } | { ok: false; reason: string };

function findAnchor(documents: readonly AnalyzedDocument[], ref: AnchorRef): Found {
  const doc = documents.find(
    (candidate) => candidate.operative && candidate.definition.label === ref.doc,
  );
  if (doc === undefined) return { ok: false, reason: `there is no operative document ${ref.doc}` };
  if (ref.anchor === "" || ref.anchor !== ref.anchor.trim()) {
    return { ok: false, reason: "the anchor is empty or has white space at an end" };
  }
  const inClause = doc.paragraphs.filter((p) => p.clause === ref.clause);
  const where =
    ref.clause === null
      ? `${ref.doc} outside any numbered clause`
      : `${ref.doc} clause ${ref.clause}`;
  if (inClause.length === 0) return { ok: false, reason: `${where} has no paragraph` };
  let count = 0;
  let paragraph = -1;
  for (const p of inClause) {
    const n = countOccurrences(p.text, ref.anchor);
    if (n > 0) paragraph = p.index;
    count += n;
  }
  if (count !== 1) {
    return { ok: false, reason: `the anchor occurs ${count} times in ${where}, not exactly once` };
  }
  return { ok: true, paragraph };
}

const ROLES = ["governing", "superseded", "relevant"] as const;
type Role = (typeof ROLES)[number];

function resolveExpectation(
  caseKey: string,
  ruleKey: string,
  spec: RuleExpectationSpec,
  documents: readonly AnalyzedDocument[],
  twinDocuments: readonly AnalyzedDocument[] | null,
  facts: PlaybookFacts,
  problems: Problems,
): RuleExpectation {
  const scope = `${caseKey} ${ruleKey}`;
  const rule = facts.rules[ruleKey];
  const acceptable = spec.acceptable ?? [];
  const note = spec.note ?? "";
  const escalation = spec.escalation ?? { mode: "not_expected" as const, codes: [] };

  if (!STATUS_SET.has(spec.status)) problems.add(scope, "the status is not a Parol status");
  for (const status of acceptable) {
    if (!STATUS_SET.has(status)) problems.add(scope, "an acceptable status is not a Parol status");
    if (status === spec.status) problems.add(scope, "an acceptable status repeats the status");
  }
  if (new Set(acceptable).size !== acceptable.length) {
    problems.add(scope, "an acceptable status is listed twice");
  }
  if (acceptable.length > 0 && note.trim() === "") {
    problems.add(
      scope,
      "an acceptable alternative needs a note saying why the answer is ambiguous",
    );
  }
  if (note !== note.trim() || DASHES.test(note)) {
    problems.add(scope, "the note has white space at an end or contains a dash");
  }

  if (rule !== undefined) {
    if (spec.status === "missing" && !rule.required) {
      problems.add(scope, "missing is expected for a rule the playbook does not require");
    }
    if (spec.status === "not_applicable" && rule.required) {
      problems.add(scope, "not_applicable is expected for a rule the playbook requires");
    }
  }

  // Basis: <rule>.<field>: why. It names this slot's own rule, and a field the rule has.
  const basis = BASIS.exec(spec.basis);
  if (basis === null) {
    problems.add(scope, "the basis is not <rule>.<field>: <reason>");
  } else {
    const [, basisRule, basisField] = basis;
    if (basisRule !== ruleKey) problems.add(scope, "the basis names a different rule");
    else if (rule !== undefined && !rule.fields.has(basisField ?? "")) {
      problems.add(scope, "the basis names a field that the rule in the playbook does not have");
    }
  }
  if (DASHES.test(spec.basis)) problems.add(scope, "the basis contains a dash");

  // Escalation.
  const codes = escalation.codes;
  if (escalation.mode === "not_expected") {
    if (codes.length > 0) problems.add(scope, "a not_expected escalation lists codes");
  } else if (codes.length === 0) {
    problems.add(scope, `a ${escalation.mode} escalation lists no codes`);
  }
  for (const code of codes) {
    if (!CODE_SET.has(code)) problems.add(scope, "an escalation code is not a Parol code");
  }
  if (new Set(codes).size !== codes.length)
    problems.add(scope, "an escalation code is listed twice");
  if (
    codes.includes("playbook_escalation") &&
    rule !== undefined &&
    rule.escalateWhenIds.length === 0
  ) {
    problems.add(scope, "playbook_escalation is expected for a rule with no escalateWhen entry");
  }
  if (spec.status === "undetermined" && escalation.mode !== "required") {
    problems.add(scope, "an undetermined slot must require the escalation that explains it");
  }

  // Anchors.
  const resolved: Record<Role, ResolvedAnchor[]> = { governing: [], superseded: [], relevant: [] };
  const taken = new Map<string, Role>();
  for (const role of ROLES) {
    (spec[role] ?? []).forEach((ref, i) => {
      const at = `${scope} ${role}[${i}]`;
      const found = findAnchor(documents, ref);
      if (!found.ok) {
        problems.add(at, found.reason);
        return;
      }
      const slot = `${ref.doc}:${found.paragraph}`;
      const previous = taken.get(slot);
      if (previous !== undefined) {
        problems.add(at, `the paragraph is already named as ${previous} in this slot`);
      }
      taken.set(slot, role);
      if (twinDocuments !== null) {
        const inTwin = findAnchor(twinDocuments, ref);
        if (!inTwin.ok) problems.add(at, `in the injection twin: ${inTwin.reason}`);
      }
      resolved[role].push({ ...ref, paragraph: found.paragraph });
    });
  }

  // Document 5: a determined status names a governing span; missing and not_applicable name
  // none. An undetermined slot has no governing passage either, because none decides it; the
  // passages that disagree are named as relevant. These count what the author wrote, so an
  // anchor that fails to resolve is reported once, by its own message, and not again here.
  const named = {
    governing: (spec.governing ?? []).length,
    other: (spec.superseded ?? []).length + (spec.relevant ?? []).length,
  };
  if (spec.status === "compliant" || spec.status === "deviation") {
    if (named.governing === 0)
      problems.add(scope, `a ${spec.status} slot names no governing anchor`);
  } else if (named.governing > 0) {
    problems.add(scope, `a ${spec.status} slot must not name a governing anchor`);
  }
  if ((spec.status === "missing" || spec.status === "not_applicable") && named.other > 0) {
    problems.add(scope, `a ${spec.status} slot names no passage at all`);
  }

  return {
    status: spec.status,
    acceptable: [...acceptable],
    governing: resolved.governing,
    superseded: resolved.superseded,
    relevant: resolved.relevant,
    escalation: { mode: escalation.mode, codes: [...codes] },
    basis: spec.basis,
    note,
  };
}

// ---------------------------------------------------------------------------------------------
// Uploads: the application's rules, replayed on what is known about each file
// ---------------------------------------------------------------------------------------------

/**
 * The warnings an upload can carry because of what ingest finds in the file's content. The other
 * two codes a step may list are the application's own notices: `duplicate_document` for an
 * identical file and `near_duplicate_version` for the text of a stored version.
 */
export const INGEST_WARNING_CODES: readonly WarningCode[] = [
  "instruction_like_text",
  "unreviewed_content",
  "no_reviewable_text",
];

const EFFECT_SET: ReadonlySet<string> = new Set(UPLOAD_EFFECTS);
const REFUSAL_SET: ReadonlySet<string> = new Set(UPLOAD_REFUSALS);
const KIND_SET: ReadonlySet<string> = new Set(DOCUMENT_KINDS);
const EXTRA_KIND_SET: ReadonlySet<string> = new Set(["identical_copy", "resave"]);
const FILE_NAME = /^parol-[a-z0-9]+(?:-[a-z0-9]+)*\.(?:docx|txt)$/;
const extensionOf = (file: string): string => file.slice(file.lastIndexOf(".") + 1);

/** Warning codes in the order of `WARNING_CODES`, which is how the key writes them. */
export const orderWarnings = (codes: readonly WarningCode[]): WarningCode[] =>
  [...codes].sort((a, b) => WARNING_CODES.indexOf(a) - WARNING_CODES.indexOf(b));

/**
 * What the upload rules need to know about a file: whether it has the same bytes as another file
 * (equal `bytesId`) and whether it has the same extracted text (equal `textId`). The ids are
 * opaque. The builder predicts them from the source of the case, and the checker and the tests
 * compute them from the rendered bytes and the real parser, then run the same rules.
 */
export interface UploadFileFacts {
  bytesId: string;
  textId: string;
}

export interface SimVersion {
  label: DocLabel;
  versionNo: number;
  file: string;
  facts: UploadFileFacts;
  statedDate: string | null;
  operative: boolean;
}

/** One document as ingest reads it during an upload. */
export interface IngestSlot {
  label: DocLabel;
  kind: DocumentKind;
  title: string;
  file: string;
  versionNo: number;
  statedDate: string | null;
  /** The version being added, which stands in for the version that governed in its document. */
  pending: boolean;
}

export type SimulatedStep =
  /** The step cannot be played (a version added to a document no step has stored). */
  | { effect: "invalid" }
  | { effect: "refused"; code: UploadRefusal }
  | {
      effect: Exclude<UploadEffect, "refused">;
      label: DocLabel;
      versionNo: number;
      operative: boolean;
      /** Whether a new version row is written. */
      stored: boolean;
      /** The application's own notices only; ingest's warnings need the file's content. */
      warnings: WarningCode[];
      sameTextAs?: { label: DocLabel; versionNo: number };
      /** For a stored version: the documents ingest reads, the new one standing in for its document. */
      ingest: IngestSlot[] | null;
    };

export interface SimulatedUploads {
  steps: SimulatedStep[];
  /** Every version stored, in the order of storage, in the state the steps leave them. */
  versions: SimVersion[];
  /** Mistakes of the plan that no expectation can describe. */
  problems: string[];
}

/**
 * Plays upload steps by the rules of apps/parol/src/services/uploads.ts, in the order of its
 * checks, without a store:
 *
 * - `addDocument`: an amendment needs an NDA already in the matter (`nda_first`) and a second NDA
 *   is refused (`nda_exists`). The same bytes as any stored version are an identical file, which
 *   stores nothing, unless a stated date is entered that the stored version lacks
 *   (`duplicate_stated_date`). The new document takes the smallest free label
 *   (`document_limit` when there is none). Its version 1 is operative, whatever its text.
 * - `addVersion`: the same identical-file rule, across all documents of the matter. Otherwise the
 *   file is stored as the next version number of the document. When its text is that of any stored
 *   version it is not operative and the version that governed keeps governing; else it is
 *   operative and every other version of the document stops being so.
 * - A version with the text of a stored version carries `near_duplicate_version`, which names the
 *   earliest stored version with that text.
 *
 * Every step's file must have facts; the caller checks that first.
 */
export function simulateUploads(
  steps: readonly UploadStep[],
  factsOf: (file: string) => UploadFileFacts | undefined,
): SimulatedUploads {
  interface Doc {
    label: DocLabel;
    kind: DocumentKind;
    title: string;
    versions: SimVersion[];
  }
  const docs: Doc[] = [];
  const stored: SimVersion[] = [];
  const results: SimulatedStep[] = [];
  const problems: string[] = [];

  const governing = (doc: Doc): SimVersion | undefined =>
    doc.versions.find((v) => v.operative) ?? doc.versions[doc.versions.length - 1];
  const slotsFor = (pending: SimVersion, all: readonly Doc[]): IngestSlot[] =>
    [...all]
      .sort((a, b) => a.label.localeCompare(b.label))
      .flatMap((doc) => {
        const version = doc.label === pending.label ? pending : governing(doc);
        return version === undefined
          ? []
          : [
              {
                label: doc.label,
                kind: doc.kind,
                title: doc.title,
                file: version.file,
                versionNo: version.versionNo,
                statedDate: version.statedDate,
                pending: version === pending,
              },
            ];
      });

  steps.forEach((step, index) => {
    const at = `upload step ${index + 1}`;
    const facts = factsOf(step.file);
    if (facts === undefined) throw new Error(`${at}: the file has no facts`);
    const identicalTo = stored.find((v) => v.facts.bytesId === facts.bytesId);
    const sameTextAs = stored.find((v) => v.facts.textId === facts.textId);
    const notice =
      sameTextAs === undefined
        ? {}
        : { sameTextAs: { label: sameTextAs.label, versionNo: sameTextAs.versionNo } };
    const identical = (match: SimVersion): SimulatedStep =>
      step.statedDate !== null && step.statedDate !== match.statedDate
        ? { effect: "refused", code: "duplicate_stated_date" }
        : {
            effect: "identical_file",
            label: match.label,
            versionNo: match.versionNo,
            operative: match.operative,
            stored: false,
            warnings: ["duplicate_document"],
            ingest: null,
          };

    if (step.action === "addDocument") {
      const hasNda = docs.some((d) => d.kind === "nda");
      if (step.kind === "amendment" && !hasNda) {
        results.push({ effect: "refused", code: "nda_first" });
        return;
      }
      if (step.kind === "nda" && hasNda) {
        results.push({ effect: "refused", code: "nda_exists" });
        return;
      }
      if (identicalTo !== undefined) {
        results.push(identical(identicalTo));
        return;
      }
      const label = DOC_LABELS.find((l) => !docs.some((d) => d.label === l));
      if (label === undefined) {
        results.push({ effect: "refused", code: "document_limit" });
        return;
      }
      if (label !== step.label) {
        problems.push(
          `${at}: the application gives a new document the label ${label}, and the step means it to be ${step.label}`,
        );
      }
      const doc: Doc = { label, kind: step.kind, title: step.title, versions: [] };
      const version: SimVersion = {
        label,
        versionNo: 1,
        file: step.file,
        facts,
        statedDate: step.statedDate,
        operative: true,
      };
      const ingest = slotsFor(version, [...docs, doc]);
      doc.versions.push(version);
      docs.push(doc);
      stored.push(version);
      results.push({
        effect: "new_document",
        label,
        versionNo: 1,
        operative: true,
        stored: true,
        warnings: sameTextAs === undefined ? [] : ["near_duplicate_version"],
        ...notice,
        ingest,
      });
      return;
    }

    const doc = docs.find((d) => d.label === step.label);
    if (doc === undefined) {
      problems.push(`${at}: addVersion names ${step.label}, which no earlier step added`);
      results.push({ effect: "invalid" });
      return;
    }
    if (identicalTo !== undefined) {
      results.push(identical(identicalTo));
      return;
    }
    const versionNo = Math.max(0, ...doc.versions.map((v) => v.versionNo)) + 1;
    const operative = sameTextAs === undefined;
    const version: SimVersion = {
      label: doc.label,
      versionNo,
      file: step.file,
      facts,
      statedDate: step.statedDate,
      operative,
    };
    const ingest = slotsFor(version, docs);
    if (operative) for (const other of doc.versions) other.operative = false;
    doc.versions.push(version);
    stored.push(version);
    results.push({
      effect: operative ? "new_version" : "same_text",
      label: doc.label,
      versionNo,
      operative,
      stored: true,
      warnings: operative ? [] : ["near_duplicate_version"],
      ...notice,
      ingest,
    });
  });
  return { steps: results, versions: stored, problems };
}

/** What a step expects does not hang together as data. Reported before the rules are played. */
function checkExpectationShape(expect: UploadExpectation): string[] {
  const out: string[] = [];
  if (typeof expect !== "object" || expect === null) return ["the step has no expected outcome"];
  const effect = (expect as { effect?: unknown }).effect;
  if (typeof effect !== "string" || !EFFECT_SET.has(effect)) {
    return ["the expected effect is not one of the upload effects"];
  }
  if (expect.effect === "refused") {
    if (!REFUSAL_SET.has(expect.code))
      out.push("the expected refusal is not one that can be played");
    return out;
  }
  if (!LABEL_SET.has(expect.label)) out.push("the expected label is not D1, D2 or D3");
  if (!Number.isInteger(expect.versionNo) || expect.versionNo < 1) {
    out.push("the expected version number is not a whole number from 1");
  }
  if (typeof expect.operative !== "boolean")
    out.push("the expected operative flag is not true or false");
  if (!Array.isArray(expect.warnings)) {
    out.push("the expected warnings are not a list");
  } else {
    for (const code of expect.warnings) {
      if (!WARNING_SET.has(code)) out.push("an expected warning is not a Parol warning");
    }
    if (new Set(expect.warnings).size !== expect.warnings.length) {
      out.push("an expected warning is listed twice");
    }
  }
  if (expect.sameTextAs !== undefined) {
    if (!LABEL_SET.has(expect.sameTextAs.label) || !Number.isInteger(expect.sameTextAs.versionNo)) {
      out.push("sameTextAs does not name a document label and a version number");
    }
  }
  return out;
}

/**
 * What the rules say about one step against what the step expects. Messages say what differs and
 * never quote the document.
 */
export function compareUploadStep(step: UploadStep, simulated: SimulatedStep): string[] {
  if (simulated.effect === "invalid") return [];
  const expect = step.expect;
  const out: string[] = [];
  if (expect.effect !== simulated.effect) {
    const why: Record<string, string> = {
      identical_file:
        "the file has the bytes of a version already stored, so it is an identical file",
      same_text: "the file has the text of a stored version in other bytes, so it is a re-save",
      new_version:
        "the file has text that no stored version has, so it is a new version that governs",
      new_document: "a new document is stored",
      refused: "the application refuses it",
    };
    out.push(
      `the application answers ${simulated.effect} (${why[simulated.effect] ?? "see uploads.ts"}) and the step expects ${expect.effect}`,
    );
    return out;
  }
  if (simulated.effect === "refused") {
    if (expect.effect === "refused" && expect.code !== simulated.code) {
      out.push(
        `the application refuses with ${simulated.code} and the step expects ${expect.code}`,
      );
    }
    return out;
  }
  if (expect.effect === "refused") return out;
  if (expect.label !== simulated.label) {
    out.push(`the answer names ${simulated.label}, and the step expects ${expect.label}`);
  }
  if (expect.versionNo !== simulated.versionNo) {
    out.push(
      `the answer names version ${simulated.versionNo}, and the step expects ${expect.versionNo}`,
    );
  }
  if (expect.operative !== simulated.operative) {
    out.push(
      `that version is ${simulated.operative ? "operative" : "not operative"} afterwards, and the step expects ${expect.operative ? "operative" : "not operative"}`,
    );
  }
  const declared = Array.isArray(expect.warnings) ? expect.warnings : [];
  for (const code of simulated.warnings) {
    if (!declared.includes(code))
      out.push(`the answer carries ${code}, and the step does not list it`);
  }
  for (const code of declared) {
    if (simulated.warnings.includes(code)) continue;
    if (!WARNING_SET.has(code)) continue;
    if (simulated.stored && INGEST_WARNING_CODES.includes(code)) continue;
    out.push(
      simulated.stored
        ? `the step lists ${code}, which neither the application's rules nor ingest of a file raise here`
        : `the step lists ${code}, and an identical file carries only duplicate_document`,
    );
  }
  const near = simulated.sameTextAs;
  if (near === undefined) {
    if (expect.sameTextAs !== undefined)
      out.push("sameTextAs is given and the text is not that of a stored version");
  } else if (
    expect.sameTextAs === undefined ||
    expect.sameTextAs.label !== near.label ||
    expect.sameTextAs.versionNo !== near.versionNo
  ) {
    out.push(
      `the text is that of ${near.label} version ${near.versionNo}, and sameTextAs says otherwise`,
    );
  }
  return out;
}

/** What is predicted about the files of a case with uploads, and what playing the steps gives. */
export interface UploadPlan {
  facts: ReadonlyMap<string, UploadFileFacts>;
  simulated: SimulatedUploads;
}

/**
 * The bytes of a rendered document depend on its type, title and paragraphs and on nothing else
 * (render.ts is deterministic), so those decide whether two documents are the same file. A text
 * file has no title or styles, so only its lines count.
 */
function predictedBytesId(doc: AnalyzedDocument): string {
  const source = doc.definition;
  return sha256Hex(
    canonicalJson(
      source.file.endsWith(".docx")
        ? { type: "docx", title: source.title, paragraphs: source.paragraphs }
        : { type: "txt", lines: doc.paragraphs.map((p) => p.text) },
    ),
  );
}

/**
 * Checks the uploads of a case and plays them. Everything here is decided from the source of the
 * case, so it runs in `analyzeCases` and costs no rendering. `buildDataset` then confirms the
 * prediction against the rendered bytes, and the checker against the real parser.
 */
function checkUploads(
  definition: CaseDefinition,
  documents: readonly AnalyzedDocument[],
  scope: string,
  files: Map<string, string>,
  problems: Problems,
): UploadPlan | null {
  const uploads = definition.uploads;
  if (uploads === undefined) return null;
  if (hasInjection(definition)) {
    problems.add(
      scope,
      "a case with upload steps cannot have an injected paragraph: its twin would need steps of its own",
    );
    return null;
  }
  const steps: readonly UploadStep[] = Array.isArray(uploads.steps) ? uploads.steps : [];
  const extra: readonly ExtraFile[] = uploads.files ?? [];
  if (steps.length === 0) problems.add(scope, "the uploads have no steps");

  const facts = new Map<string, UploadFileFacts>();
  for (const doc of documents) {
    facts.set(doc.definition.file, {
      bytesId: predictedBytesId(doc),
      textId: documentTextSha256(doc.paragraphs),
    });
  }

  extra.forEach((entry, i) => {
    const where = `${scope} extra file ${i}`;
    if (!FILE_NAME.test(entry.file)) {
      problems.add(where, "the file name is not lower case words joined by hyphens, .docx or .txt");
    }
    if (!entry.file.startsWith(filePrefix(definition.case))) {
      problems.add(where, `the file name must start with ${filePrefix(definition.case)}`);
    }
    const other = files.get(entry.file.toLowerCase());
    if (other !== undefined) problems.add(where, `the file name is already used by ${other}`);
    files.set(entry.file.toLowerCase(), definition.case);
    if (!EXTRA_KIND_SET.has(entry.kind)) {
      problems.add(where, "the kind is not identical_copy or resave");
    }
    const source = facts.get(entry.of);
    if (source === undefined || !documents.some((d) => d.definition.file === entry.of)) {
      problems.add(where, "`of` is not the file of a document of the case");
      return;
    }
    if (extensionOf(entry.file) !== extensionOf(entry.of)) {
      problems.add(where, "the file type differs from the file it is made from");
    }
    facts.set(
      entry.file,
      entry.kind === "resave"
        ? { bytesId: sha256Hex(`resave:${source.bytesId}`), textId: source.textId }
        : { ...source },
    );
  });

  let playable = steps.length > 0;
  steps.forEach((step, i) => {
    const where = `${scope} upload step ${i + 1}`;
    if (step.action !== "addDocument" && step.action !== "addVersion") {
      problems.add(where, "the action is not addDocument or addVersion");
      playable = false;
    }
    if (!facts.has(step.file)) {
      problems.add(where, "the file is neither a document of the case nor an extra file");
      playable = false;
    }
    if (!LABEL_SET.has(step.label)) {
      problems.add(where, "the label is not D1, D2 or D3");
      playable = false;
    }
    if (step.statedDate !== null && !ISO_DATE.test(String(step.statedDate))) {
      problems.add(where, "the stated date is not an ISO date (YYYY-MM-DD) or null");
      playable = false;
    }
    if (step.action === "addDocument") {
      if (step.title.trim() === "" || step.title !== step.title.trim() || DASHES.test(step.title)) {
        problems.add(where, "the title is empty, has white space at an end or contains a dash");
      }
      if (!KIND_SET.has(step.kind)) {
        problems.add(where, "the kind is not nda or amendment");
        playable = false;
      }
    }
    for (const message of checkExpectationShape(step.expect)) {
      problems.add(where, message);
      playable = false;
    }
  });
  if (!playable) return null;

  const simulated = simulateUploads(steps, (file) => facts.get(file));
  for (const message of simulated.problems) problems.add(scope, message);
  steps.forEach((step, i) => {
    const result = simulated.steps[i];
    if (result === undefined) return;
    for (const message of compareUploadStep(step, result)) {
      problems.add(`${scope} upload step ${i + 1}`, message);
    }
  });

  // The documents of the case are the versions the steps store, and say so.
  const storedByBytes = new Map<string, SimVersion>();
  for (const version of simulated.versions) storedByBytes.set(version.facts.bytesId, version);
  const titles = new Map<DocLabel, string>();
  const kinds = new Map<DocLabel, DocumentKind>();
  steps.forEach((step, i) => {
    const result = simulated.steps[i];
    if (step.action === "addDocument" && result?.effect === "new_document") {
      titles.set(result.label, step.title);
      kinds.set(result.label, step.kind);
    }
  });
  for (const doc of documents) {
    const source = doc.definition;
    const where = `${scope} ${source.label} version ${doc.versionNo}`;
    const version = storedByBytes.get(facts.get(source.file)?.bytesId ?? "");
    if (version === undefined) {
      problems.add(where, "no step stores the file of this document");
      continue;
    }
    if (version.label !== source.label) {
      problems.add(where, `the steps store it as ${version.label}`);
    }
    if (version.versionNo !== doc.versionNo) {
      problems.add(
        where,
        `the steps store it as version ${version.versionNo} and the document says ${doc.versionNo}`,
      );
    }
    if (version.statedDate !== source.statedDate) {
      problems.add(where, "its stated date is not the date entered in the step that stores it");
    }
    if (version.operative !== doc.operative) {
      problems.add(
        where,
        `the steps leave it ${version.operative ? "operative" : "not operative"} and the document says ${doc.operative ? "operative" : "not operative"}`,
      );
    }
    const title = titles.get(source.label);
    if (title !== undefined && title !== source.title) {
      problems.add(where, "its title is not the title entered when the document was added");
    }
    const kind = kinds.get(source.label);
    if (kind !== undefined && kind !== source.kind) {
      problems.add(where, "its kind is not the kind entered when the document was added");
    }
  }
  for (const version of simulated.versions) {
    if (
      version.operative &&
      !documents.some((d) => facts.get(d.definition.file)?.bytesId === version.facts.bytesId)
    ) {
      problems.add(
        scope,
        `the version that governs ${version.label} at the end is an extra file, not a document of the case`,
      );
    }
  }

  // The case lists every code an upload returns, and the two notices of the application only
  // when some upload returns them.
  const returned = new Set<WarningCode>();
  simulated.steps.forEach((result, i) => {
    const step = steps[i];
    if (result.effect === "refused" || result.effect === "invalid" || step === undefined) return;
    if (step.expect.effect === "refused") return;
    for (const code of step.expect.warnings) returned.add(code);
  });
  for (const code of returned) {
    if (!definition.warnings.includes(code)) {
      problems.add(
        scope,
        `an upload returns ${code} and the case does not list it in its warnings`,
      );
    }
  }
  for (const code of ["duplicate_document", "near_duplicate_version"] as const) {
    if (definition.warnings.includes(code) && !returned.has(code)) {
      problems.add(scope, `the case lists ${code} and no upload returns it`);
    }
  }
  return { facts, simulated };
}

// ---------------------------------------------------------------------------------------------
// Canary matters
// ---------------------------------------------------------------------------------------------

export interface AnalyzedCanaryMatter {
  matter: CanaryMatter;
  document: AnalyzedDocument;
}

export const MIN_CANARY_STRINGS = 3;
const CANARY_ID = /^[a-z]+$/;
const CANARY_NAME = /^[A-Za-z]+$/;
export const canaryFilePrefix = (id: string): string => `parol-canary-${id}-`;

/** The canary matters a case names, resolved. A matter of the other split is refused. */
function namedCanaryMatters(
  definition: CaseDefinition,
  matters: readonly CanaryMatter[],
  scope: string,
  problems: Problems,
): CanaryMatter[] {
  const named: unknown = definition.canaryMatters;
  if (named === undefined) return [];
  if (!Array.isArray(named) || named.length === 0) {
    problems.add(scope, "canaryMatters is empty: name a canary matter or leave the field out");
    return [];
  }
  const out: CanaryMatter[] = [];
  const seen = new Set<string>();
  for (const id of named as unknown[]) {
    const matter = matters.find((candidate) => candidate.id === id);
    if (matter === undefined) {
      problems.add(scope, "the case names a canary matter that does not exist");
      continue;
    }
    if (seen.has(matter.id)) {
      problems.add(scope, `the case names the canary matter ${matter.id} twice`);
      continue;
    }
    seen.add(matter.id);
    if (matter.split !== definition.split) {
      problems.add(
        scope,
        `the canary matter ${matter.id} belongs to the ${matter.split} split and the case to the ${definition.split} split`,
      );
    }
    out.push(matter);
  }
  return out;
}

const countIn = (document: AnalyzedDocument, needle: string): number =>
  document.paragraphs.reduce((n, p) => n + countOccurrences(p.text, needle), 0);

/**
 * Checks the canary matters themselves, whether or not a case names them: each has an id, a name,
 * a split, a client and one NDA in a file of its own; at least three strings in the format
 * `CANARY-<NAME>-<12 hex digits>`, each exactly once in its own document and nowhere in any other
 * matter or case; and a distinctive fact with the same property. Messages name the matter and the
 * position, never the text.
 */
function checkCanaryMatters(
  matters: readonly CanaryMatter[],
  cases: readonly AnalyzedCase[],
  files: Map<string, string>,
  problems: Problems,
): AnalyzedCanaryMatter[] {
  const analyzed: AnalyzedCanaryMatter[] = [];
  const ids = new Set<string>();
  for (const matter of matters) {
    const scope = `canary ${CANARY_ID.test(matter.id) ? matter.id : "(bad id)"}`;
    if (!CANARY_ID.test(matter.id)) problems.add(scope, "the id is not lower case letters");
    if (ids.has(matter.id)) problems.add(scope, "the id is used twice");
    ids.add(matter.id);
    if (!CANARY_NAME.test(matter.name)) problems.add(scope, "the name is not letters only");
    else if (matter.name.toLowerCase() !== matter.id) {
      problems.add(scope, "the name is not the id with a capital letter");
    }
    if (!SPLITS.includes(matter.split)) problems.add(scope, "the split is not dev or heldout");
    if (matter.clientLegalName.trim() === "" || DASHES.test(matter.clientLegalName)) {
      problems.add(scope, "the client legal name is empty or contains a dash");
    }
    const document = analyzeDocument(matter.document, scope, problems);
    if (matter.document.label !== "D1" || matter.document.kind !== "nda") {
      problems.add(scope, "the matter's one document must be D1 and of kind nda");
    }
    if (!matter.document.file.startsWith(canaryFilePrefix(matter.id))) {
      problems.add(scope, `the file name must start with ${canaryFilePrefix(matter.id)}`);
    }
    if (matter.document.paragraphs.some((p) => p.injected === true)) {
      problems.add(scope, "no paragraph of a canary matter is injected");
    }
    if (matter.document.operative === false || (matter.document.versionNo ?? 1) !== 1) {
      problems.add(scope, "the matter's document is version 1 and operative");
    }
    const other = files.get(matter.document.file.toLowerCase());
    if (other !== undefined) problems.add(scope, `the file name is already used by ${other}`);
    files.set(matter.document.file.toLowerCase(), scope);
    analyzed.push({ matter, document });
  }

  const caseJson = cases.map((entry) => ({
    key: entry.definition.case,
    json: JSON.stringify(entry.definition),
  }));
  const allStrings = new Map<string, string>();
  for (const { matter, document } of analyzed) {
    const scope = `canary ${CANARY_ID.test(matter.id) ? matter.id : "(bad id)"}`;
    const strings: readonly string[] = Array.isArray(matter.strings) ? matter.strings : [];
    if (strings.length < MIN_CANARY_STRINGS) {
      problems.add(
        scope,
        `the matter holds ${strings.length} canary strings and needs at least ${MIN_CANARY_STRINGS}`,
      );
    }
    const format = new RegExp(`^CANARY-${matter.name.toUpperCase()}-[0-9a-f]{12}$`);
    const probes: { what: string; text: string }[] = strings.map((text, i) => ({
      what: `string ${i + 1}`,
      text,
    }));
    strings.forEach((text, i) => {
      if (!format.test(text)) {
        problems.add(scope, `string ${i + 1} is not CANARY-<NAME>-<12 lower case hex digits>`);
      }
      const owner = allStrings.get(text);
      if (owner !== undefined) {
        problems.add(scope, `string ${i + 1} is also a string of ${owner}`);
      }
      allStrings.set(text, scope);
    });
    if (
      matter.fact.trim() === "" ||
      matter.fact !== matter.fact.trim() ||
      DASHES.test(matter.fact)
    ) {
      problems.add(
        scope,
        "the distinctive fact is empty, has white space at an end or contains a dash",
      );
    } else {
      probes.push({ what: "the distinctive fact", text: matter.fact });
    }
    for (const probe of probes) {
      if (probe.text === "") continue;
      const own = countIn(document, probe.text);
      if (own !== 1) {
        problems.add(
          scope,
          `${probe.what} occurs ${own} times in the matter's document, not exactly once`,
        );
      }
      for (const entry of analyzed) {
        if (entry.matter === matter) continue;
        if (countIn(entry.document, probe.text) > 0) {
          problems.add(
            scope,
            `${probe.what} occurs in the document of the canary matter ${entry.matter.id}`,
          );
        }
      }
      for (const entry of caseJson) {
        if (entry.json.includes(JSON.stringify(probe.text).slice(1, -1))) {
          problems.add(scope, `${probe.what} occurs in the case ${entry.key}`);
        }
      }
    }
  }
  return analyzed;
}

export interface Analysis {
  cases: AnalyzedCase[];
  /** Every canary matter that was checked, whether or not a case names it. */
  canary: AnalyzedCanaryMatter[];
  problems: string[];
}

export interface AnalyzeOptions {
  /** The canary matters that exist. Default: those of fixtures/parol/canary.ts. For tests. */
  canaryMatters?: readonly CanaryMatter[];
}

/**
 * Checks every case against the playbook and resolves every anchor. Does not render anything, so
 * a test of a traceability rule is fast. `problems` is empty when the cases are sound.
 */
export function analyzeCases(
  definitions: readonly CaseDefinition[],
  facts: PlaybookFacts,
  options: AnalyzeOptions = {},
): Analysis {
  const matters = options.canaryMatters ?? CANARY_MATTERS;
  const problems = new Problems();
  const cases: AnalyzedCase[] = [];
  const keys = new Set<string>();
  const files = new Map<string, string>();
  const alternatives: Record<Split, number> = { dev: 0, heldout: 0 };

  for (const definition of definitions) {
    const scope = definition.case;
    const match = CASE_KEY.exec(definition.case);
    if (match === null) {
      problems.add(scope, "the case key is not PAROL-Dnn or PAROL-Hnn");
    } else if ((match[1] === "D") !== (definition.split === "dev")) {
      problems.add(
        scope,
        `the key says ${match[1] === "D" ? "dev" : "heldout"} but the split is ${definition.split}`,
      );
    }
    if (!SPLITS.includes(definition.split)) problems.add(scope, "the split is not dev or heldout");
    if (keys.has(definition.case)) problems.add(scope, "the case key is used twice");
    keys.add(definition.case);
    if (definition.phenomenon.trim() === "" || DASHES.test(definition.phenomenon)) {
      problems.add(scope, "the phenomenon is empty or contains a dash");
    }
    if (definition.intake.clientLegalName.trim() === "") {
      problems.add(scope, "the client legal name is empty");
    }
    for (const code of definition.warnings) {
      if (!WARNING_SET.has(code)) problems.add(scope, "an expected warning is not a Parol warning");
    }
    if (new Set(definition.warnings).size !== definition.warnings.length) {
      problems.add(scope, "an expected warning is listed twice");
    }
    if (hasInjection(definition) && !definition.warnings.includes("instruction_like_text")) {
      problems.add(scope, "a case with an injected paragraph must expect instruction_like_text");
    }

    checkDocuments(definition, scope, problems);
    for (const doc of definition.documents) {
      const other = files.get(doc.file.toLowerCase());
      if (other !== undefined) problems.add(scope, `${doc.label} reuses a file name of ${other}`);
      files.set(doc.file.toLowerCase(), definition.case);
    }

    const documents = definition.documents.map((doc) => analyzeDocument(doc, scope, problems));
    const uploads = checkUploads(definition, documents, scope, files, problems);
    const canaryMatters = namedCanaryMatters(definition, matters, scope, problems);
    const twinDocuments = hasInjection(definition)
      ? definition.documents.map((doc) =>
          analyzeDocument(doc, `${scope} twin`, new Problems(), true),
        )
      : null;

    const expect: Record<string, RuleExpectation> = {};
    for (const ruleKey of Object.keys(definition.expect)) {
      if (facts.rules[ruleKey] === undefined) {
        problems.add(scope, `${ruleKey} is not a rule of the playbook`);
      }
    }
    for (const ruleKey of facts.ruleKeys) {
      const spec = definition.expect[ruleKey];
      if (spec === undefined) {
        problems.add(scope, `${ruleKey} has no expectation`);
        continue;
      }
      expect[ruleKey] = resolveExpectation(
        definition.case,
        ruleKey,
        spec,
        documents,
        twinDocuments,
        facts,
        problems,
      );
      if (spec.acceptable !== undefined && spec.acceptable.length > 0) {
        if (SPLITS.includes(definition.split)) alternatives[definition.split] += 1;
      }
    }
    cases.push({ definition, documents, twinDocuments, expect, uploads, canaryMatters });
  }

  for (const split of SPLITS) {
    if (alternatives[split] > MAX_ALTERNATIVES_PER_SPLIT) {
      problems.add(
        split,
        `${alternatives[split]} slots have an acceptable alternative, and the limit is ${MAX_ALTERNATIVES_PER_SPLIT}`,
      );
    }
  }
  const canary = checkCanaryMatters(matters, cases, files, problems);
  return { cases, canary, problems: problems.list };
}

// ---------------------------------------------------------------------------------------------
// Files, keys, totals and hashes
// ---------------------------------------------------------------------------------------------

export interface BuiltFile {
  name: string;
  bytes: Uint8Array;
}

async function renderFile(
  doc: AnalyzedDocument,
  omitInjected: boolean,
  resave = false,
): Promise<Uint8Array> {
  return doc.definition.file.endsWith(".docx")
    ? renderDocx(doc.definition, { omitInjected, resave })
    : renderTxt(doc.paragraphs, { resave });
}

const keyDocument = (doc: AnalyzedDocument, file: string, bytes: Uint8Array): KeyDocument => ({
  label: doc.definition.label,
  file,
  kind: doc.definition.kind,
  title: doc.definition.title,
  versionNo: doc.versionNo,
  statedDate: doc.definition.statedDate,
  operative: doc.operative,
  sha256: sha256Hex(bytes),
  paragraphs: doc.paragraphs.length,
});

export function totalsOf(
  cases: readonly AnswerKeyCase[],
  twins: readonly AnswerKeyTwin[],
  severity: (ruleKey: string) => string,
): SplitTotals {
  const totals: SplitTotals = {
    cases: cases.length,
    slots: 0,
    expectedFlags: 0,
    highSeverityFlags: 0,
    mustBeUndetermined: 0,
    requiredEscalations: 0,
    withAlternative: 0,
    casesWithWarning: 0,
    injectionCases: 0,
    injectionSlots: 0,
  };
  const twinned = new Set(twins.map((twin) => twin.twinOf));
  for (const key of cases) {
    if (key.warnings.length > 0) totals.casesWithWarning += 1;
    const slots = Object.entries(key.expect);
    if (twinned.has(key.case)) {
      totals.injectionCases += 1;
      totals.injectionSlots += slots.length;
    }
    for (const [ruleKey, expectation] of slots) {
      totals.slots += 1;
      if (isFlag(expectation.status)) {
        totals.expectedFlags += 1;
        if (severity(ruleKey) === "high") totals.highSeverityFlags += 1;
      }
      if (expectation.status === "undetermined") totals.mustBeUndetermined += 1;
      if (expectation.escalation.mode === "required") totals.requiredEscalations += 1;
      if (expectation.acceptable.length > 0) totals.withAlternative += 1;
    }
  }
  return totals;
}

/**
 * The hash of a split: its answer keys as canonical JSON, then every file by name with the
 * SHA-256 of its bytes. A change to any entry of a key, to a file, or to the set of files
 * changes it.
 */
export function splitHash(
  keys: {
    cases: readonly AnswerKeyCase[];
    twins: readonly AnswerKeyTwin[];
    /**
     * The canary matters of this split. Left out of the hashed material when there are none, so a
     * split without canary matters hashes exactly as it did before they existed.
     */
    canary?: readonly CanaryKeyMatter[];
  },
  files: readonly BuiltFile[],
): string {
  const ordered = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const canary =
    keys.canary !== undefined && keys.canary.length > 0
      ? { canary: [...keys.canary].sort((a, b) => (a.id < b.id ? -1 : 1)) }
      : {};
  return sha256Hex(
    canonicalJson({
      format: 1,
      keys: {
        cases: [...keys.cases].sort((a, b) => (a.case < b.case ? -1 : 1)),
        twins: [...keys.twins].sort((a, b) => (a.case < b.case ? -1 : 1)),
        ...canary,
      },
      files: ordered.map((file) => ({ name: file.name, sha256: sha256Hex(file.bytes) })),
    }),
  );
}

export interface BuiltDataset {
  answerKeys: AnswerKeyFile;
  splits: SplitsFile;
  files: BuiltFile[];
  /** Per split that has cases. */
  totals: Partial<Record<Split, SplitTotals>>;
}

/** The expectation of a step as the key writes it: fixed field order, warnings in code order. */
function keyExpectation(expect: UploadExpectation): UploadExpectation {
  if (expect.effect === "refused") return { effect: "refused", code: expect.code };
  return {
    effect: expect.effect,
    label: expect.label,
    versionNo: expect.versionNo,
    operative: expect.operative,
    warnings: orderWarnings(expect.warnings),
    ...(expect.sameTextAs === undefined
      ? {}
      : {
          sameTextAs: {
            label: expect.sameTextAs.label,
            versionNo: expect.sameTextAs.versionNo,
          },
        }),
  };
}

function keyStep(step: UploadStep): UploadStep {
  const expect = keyExpectation(step.expect);
  return step.action === "addDocument"
    ? {
        action: "addDocument",
        file: step.file,
        label: step.label,
        title: step.title,
        kind: step.kind,
        statedDate: step.statedDate,
        expect,
      }
    : {
        action: "addVersion",
        file: step.file,
        label: step.label,
        statedDate: step.statedDate,
        expect,
      };
}

/**
 * The rules for uploads were played on predicted facts (analysis does not render). This compares
 * the prediction with the bytes: two files are predicted to be the same file exactly when their
 * bytes hash alike. A difference is a fault of the builder, not of the case.
 */
function renderedFactProblems(
  scope: string,
  plan: UploadPlan,
  bytesByFile: ReadonlyMap<string, Uint8Array>,
): string[] {
  const out: string[] = [];
  const names = [...plan.facts.keys()];
  const hashes = new Map<string, string>();
  for (const name of names) {
    const bytes = bytesByFile.get(name);
    if (bytes === undefined) out.push(`${scope}: the file ${names.indexOf(name)} was not rendered`);
    else hashes.set(name, sha256Hex(bytes));
  }
  names.forEach((a, i) => {
    names.slice(i + 1).forEach((b) => {
      const predicted = plan.facts.get(a)?.bytesId === plan.facts.get(b)?.bytesId;
      const actual = hashes.get(a) !== undefined && hashes.get(a) === hashes.get(b);
      if (predicted !== actual) {
        out.push(
          `${scope}: the builder predicted wrongly whether files ${i} and ${names.indexOf(b)} have the same bytes (a fault of the builder)`,
        );
      }
    });
  });
  return out;
}

export async function buildDataset(input: {
  cases: readonly CaseDefinition[];
  playbookYaml: string;
  playbookSlug: string;
  /** For tests. Default: the matters of fixtures/parol/canary.ts. */
  canaryMatters?: readonly CanaryMatter[];
}): Promise<BuiltDataset> {
  const facts = readPlaybookFacts(input.playbookYaml, input.playbookSlug);
  const analysis = analyzeCases(
    input.cases,
    facts,
    input.canaryMatters === undefined ? {} : { canaryMatters: input.canaryMatters },
  );
  if (analysis.problems.length > 0) throw new TraceabilityError(analysis.problems);

  const files: BuiltFile[] = [];
  const filesBySplit: Record<Split, BuiltFile[]> = { dev: [], heldout: [] };
  const keyCases: AnswerKeyCase[] = [];
  const keyTwins: AnswerKeyTwin[] = [];
  const problems: string[] = [];
  const namedMatters = new Map<string, AnalyzedCanaryMatter>();

  for (const analyzed of analysis.cases) {
    const { definition } = analyzed;
    const documents: KeyDocument[] = [];
    const bytesByFile = new Map<string, Uint8Array>();
    for (const doc of analyzed.documents) {
      const bytes = await renderFile(doc, false);
      const file = { name: doc.definition.file, bytes };
      files.push(file);
      filesBySplit[definition.split].push(file);
      bytesByFile.set(file.name, bytes);
      documents.push(keyDocument(doc, doc.definition.file, bytes));
    }

    // Files that are not documents of the case, and the steps that upload files.
    let uploads: KeyUploads | undefined;
    if (definition.uploads !== undefined && analyzed.uploads !== null) {
      const extra: KeyExtraFile[] = [];
      for (const entry of definition.uploads.files ?? []) {
        const source = analyzed.documents.find((doc) => doc.definition.file === entry.of);
        const sourceBytes = bytesByFile.get(entry.of);
        if (source === undefined || sourceBytes === undefined) continue;
        const bytes =
          entry.kind === "identical_copy"
            ? Uint8Array.from(sourceBytes)
            : await renderFile(source, false, true);
        const file = { name: entry.file, bytes };
        files.push(file);
        filesBySplit[definition.split].push(file);
        bytesByFile.set(file.name, bytes);
        extra.push({ file: entry.file, kind: entry.kind, of: entry.of, sha256: sha256Hex(bytes) });
      }
      problems.push(...renderedFactProblems(definition.case, analyzed.uploads, bytesByFile));
      uploads = { files: extra, steps: definition.uploads.steps.map(keyStep) };
    }

    const canaryIds = analyzed.canaryMatters.map((matter) => matter.id);
    for (const matter of analyzed.canaryMatters) {
      const entry = analysis.canary.find((candidate) => candidate.matter.id === matter.id);
      if (entry !== undefined) namedMatters.set(matter.id, entry);
    }

    keyCases.push({
      case: definition.case,
      split: definition.split,
      phenomenon: definition.phenomenon,
      intake: { ...definition.intake },
      documents,
      expect: analyzed.expect,
      warnings: [...definition.warnings],
      ...(uploads === undefined ? {} : { uploads }),
      ...(canaryIds.length === 0 ? {} : { canaryMatters: canaryIds }),
    });

    if (analyzed.twinDocuments !== null) {
      const twinDocs: KeyDocument[] = [];
      for (const doc of analyzed.twinDocuments) {
        const name = twinFileOf(definition.case, doc.definition.file);
        const bytes = await renderFile(doc, true);
        const file = { name, bytes };
        files.push(file);
        filesBySplit[definition.split].push(file);
        twinDocs.push(keyDocument(doc, name, bytes));
      }
      keyTwins.push({
        case: twinKeyOf(definition.case),
        twinOf: definition.case,
        split: definition.split,
        intake: { ...definition.intake },
        documents: twinDocs,
        ...(canaryIds.length === 0 ? {} : { canaryMatters: [...canaryIds] }),
      });
    }
  }
  if (problems.length > 0) throw new TraceabilityError(problems);

  // A canary matter is rendered once, however many cases name it, and only when one does.
  const canaryKey: CanaryKeyMatter[] = [];
  for (const entry of [...namedMatters.values()].sort((a, b) =>
    a.matter.id < b.matter.id ? -1 : 1,
  )) {
    const { matter } = entry;
    const bytes = await renderFile(entry.document, false);
    const file = { name: matter.document.file, bytes };
    files.push(file);
    filesBySplit[matter.split].push(file);
    canaryKey.push({
      id: matter.id,
      name: matter.name,
      split: matter.split,
      clientLegalName: matter.clientLegalName,
      document: keyDocument(entry.document, file.name, bytes),
      strings: [...matter.strings],
      fact: matter.fact,
    });
  }

  const answerKeys: AnswerKeyFile = {
    format: 1,
    playbook: {
      slug: facts.slug,
      version: facts.version,
      sha256: facts.sha256,
      rules: Object.fromEntries(
        facts.ruleKeys.map((key) => {
          const rule = facts.rules[key]!;
          return [
            key,
            { category: rule.category, severity: rule.severity, required: rule.required },
          ];
        }),
      ),
    },
    cases: [...keyCases].sort((a, b) => (a.case < b.case ? -1 : 1)),
    twins: [...keyTwins].sort((a, b) => (a.case < b.case ? -1 : 1)),
    ...(canaryKey.length === 0 ? {} : { canary: { matters: canaryKey } }),
  };

  const totals: Partial<Record<Split, SplitTotals>> = {};
  const splits: SplitsFile = { format: 1, dataset: DATASET_LABEL, splits: {} };
  for (const split of SPLITS) {
    const parts = splitKeyParts(answerKeys, split);
    const { cases, twins } = parts;
    if (cases.length === 0) continue;
    const splitTotals = totalsOf(cases, twins, (ruleKey) => facts.rules[ruleKey]?.severity ?? "");
    totals[split] = splitTotals;
    const entry: SplitEntry = {
      ...splitTotals,
      sha256: splitHash(parts, filesBySplit[split]),
      files: filesBySplit[split].length,
    };
    splits.splits[split] = entry;
  }
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { answerKeys, splits, files, totals };
}

/**
 * The material of one split that `splitHash` covers, read from an answer key file: its cases, its
 * twins and its canary matters. Whoever recomputes a hash from the committed keys (the evaluation
 * runner's integrity check) passes exactly this, so the two cannot disagree about what the hash
 * covers. `canary` is left out when the split has none.
 */
export function splitKeyParts(
  keys: Pick<AnswerKeyFile, "cases" | "twins" | "canary">,
  split: Split,
): { cases: AnswerKeyCase[]; twins: AnswerKeyTwin[]; canary?: CanaryKeyMatter[] } {
  const canary = (keys.canary?.matters ?? []).filter((matter) => matter.split === split);
  return {
    cases: keys.cases.filter((entry) => entry.split === split),
    twins: keys.twins.filter((entry) => entry.split === split),
    ...(canary.length === 0 ? {} : { canary }),
  };
}

/**
 * Every file name that an answer key file names: the documents of cases and twins, the extra files
 * of upload steps and the documents of canary matters, each once, in order of first mention. The
 * split hash covers all of them, so a reader of the keys that checks files against the hash needs
 * this list and not only the documents.
 */
export function keyFileNames(
  keys: Pick<AnswerKeyFile, "cases" | "twins" | "canary">,
  split?: Split,
): string[] {
  const names = new Set<string>();
  for (const entry of keys.cases) {
    if (split !== undefined && entry.split !== split) continue;
    for (const doc of entry.documents) names.add(doc.file);
    for (const extra of entry.uploads?.files ?? []) names.add(extra.file);
  }
  for (const entry of keys.twins) {
    if (split !== undefined && entry.split !== split) continue;
    for (const doc of entry.documents) names.add(doc.file);
  }
  for (const matter of keys.canary?.matters ?? []) {
    if (split !== undefined && matter.split !== split) continue;
    names.add(matter.document.file);
  }
  return [...names];
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

const TOTAL_ROWS: [label: string, key: keyof SplitTotals][] = [
  ["Cases", "cases"],
  ["Rule slots", "slots"],
  ["Expected flags (deviation or missing)", "expectedFlags"],
  ["Of which high severity", "highSeverityFlags"],
  ["Slots that must come out undetermined", "mustBeUndetermined"],
  ["Slots with a required escalation", "requiredEscalations"],
  ["Slots with an allowed alternative", "withAlternative"],
  ["Cases with an expected warning", "casesWithWarning"],
  ["Injection cases (each has a twin)", "injectionCases"],
  ["Slots in injection cases", "injectionSlots"],
];

/** The totals table of document 5, recomputed from the keys and never maintained by hand. */
export function formatTotals(totals: Partial<Record<Split, SplitTotals>>): string {
  const width = Math.max(...TOTAL_ROWS.map(([label]) => label.length), "Totals".length);
  const column = (split: Split, key: keyof SplitTotals): string =>
    String(totals[split]?.[key] ?? "-").padStart(8);
  const lines = [`${"Totals".padEnd(width)}${"dev".padStart(8)}${"heldout".padStart(8)}`];
  for (const [label, key] of TOTAL_ROWS) {
    lines.push(`${label.padEnd(width)}${column("dev", key)}${column("heldout", key)}`);
  }
  return lines.join("\n");
}
