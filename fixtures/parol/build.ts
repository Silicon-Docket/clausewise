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
  ESCALATION_CODES,
  STATUSES,
  WARNING_CODES,
  type CategoryId,
  type Status,
} from "../../apps/parol/src/contracts.js";
import { canonicalJson, sha256Hex } from "../../apps/parol/src/canonical.js";
import { parsePlaybook } from "../../packages/playbook/src/index.js";
import { countOccurrences } from "./anchors.js";
import { expandDocument, renderDocx, renderTxt, type ExpandedParagraph } from "./render.js";
import type {
  AnchorRef,
  AnswerKeyCase,
  AnswerKeyFile,
  AnswerKeyTwin,
  CaseDefinition,
  CaseDocument,
  KeyDocument,
  PlaybookRuleFacts,
  ResolvedAnchor,
  RuleExpectation,
  RuleExpectationSpec,
  Split,
  SplitEntry,
  SplitTotals,
  SplitsFile,
} from "./types.js";
import { SPLITS } from "./types.js";

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

export interface Analysis {
  cases: AnalyzedCase[];
  problems: string[];
}

/**
 * Checks every case against the playbook and resolves every anchor. Does not render anything, so
 * a test of a traceability rule is fast. `problems` is empty when the cases are sound.
 */
export function analyzeCases(
  definitions: readonly CaseDefinition[],
  facts: PlaybookFacts,
): Analysis {
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
    cases.push({ definition, documents, twinDocuments, expect });
  }

  for (const split of SPLITS) {
    if (alternatives[split] > MAX_ALTERNATIVES_PER_SPLIT) {
      problems.add(
        split,
        `${alternatives[split]} slots have an acceptable alternative, and the limit is ${MAX_ALTERNATIVES_PER_SPLIT}`,
      );
    }
  }
  return { cases, problems: problems.list };
}

// ---------------------------------------------------------------------------------------------
// Files, keys, totals and hashes
// ---------------------------------------------------------------------------------------------

export interface BuiltFile {
  name: string;
  bytes: Uint8Array;
}

async function renderFile(doc: AnalyzedDocument, omitInjected: boolean): Promise<Uint8Array> {
  return doc.definition.file.endsWith(".docx")
    ? renderDocx(doc.definition, { omitInjected })
    : renderTxt(doc.paragraphs);
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
  keys: { cases: readonly AnswerKeyCase[]; twins: readonly AnswerKeyTwin[] },
  files: readonly BuiltFile[],
): string {
  const ordered = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sha256Hex(
    canonicalJson({
      format: 1,
      keys: {
        cases: [...keys.cases].sort((a, b) => (a.case < b.case ? -1 : 1)),
        twins: [...keys.twins].sort((a, b) => (a.case < b.case ? -1 : 1)),
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

export async function buildDataset(input: {
  cases: readonly CaseDefinition[];
  playbookYaml: string;
  playbookSlug: string;
}): Promise<BuiltDataset> {
  const facts = readPlaybookFacts(input.playbookYaml, input.playbookSlug);
  const analysis = analyzeCases(input.cases, facts);
  if (analysis.problems.length > 0) throw new TraceabilityError(analysis.problems);

  const files: BuiltFile[] = [];
  const filesBySplit: Record<Split, BuiltFile[]> = { dev: [], heldout: [] };
  const keyCases: AnswerKeyCase[] = [];
  const keyTwins: AnswerKeyTwin[] = [];

  for (const analyzed of analysis.cases) {
    const { definition } = analyzed;
    const documents: KeyDocument[] = [];
    for (const doc of analyzed.documents) {
      const bytes = await renderFile(doc, false);
      const file = { name: doc.definition.file, bytes };
      files.push(file);
      filesBySplit[definition.split].push(file);
      documents.push(keyDocument(doc, doc.definition.file, bytes));
    }
    keyCases.push({
      case: definition.case,
      split: definition.split,
      phenomenon: definition.phenomenon,
      intake: { ...definition.intake },
      documents,
      expect: analyzed.expect,
      warnings: [...definition.warnings],
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
      });
    }
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
  };

  const totals: Partial<Record<Split, SplitTotals>> = {};
  const splits: SplitsFile = { format: 1, dataset: DATASET_LABEL, splits: {} };
  for (const split of SPLITS) {
    const cases = answerKeys.cases.filter((key) => key.split === split);
    if (cases.length === 0) continue;
    const twins = answerKeys.twins.filter((key) => key.split === split);
    const splitTotals = totalsOf(cases, twins, (ruleKey) => facts.rules[ruleKey]?.severity ?? "");
    totals[split] = splitTotals;
    const entry: SplitEntry = {
      ...splitTotals,
      sha256: splitHash({ cases, twins }, filesBySplit[split]),
      files: filesBySplit[split].length,
    };
    splits.splits[split] = entry;
  }
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { answerKeys, splits, files, totals };
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
