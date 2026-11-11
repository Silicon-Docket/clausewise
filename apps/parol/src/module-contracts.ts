/**
 * The function-level contracts between Parol modules. Each module implements the type named here
 * and exports it under the name given in its stub. A signature changes only when its owner and
 * every caller change together, so modules built in parallel keep fitting.
 */
import type { DocxInspection, DocxParagraph } from "@clausewise/docx";
import type { ObjectGenerator } from "@clausewise/llm";
import type { ZodType } from "zod";
import type {
  CallRecord,
  ContextBundle,
  DraftFinding,
  EscalationCode,
  ExtractOutput,
  IngestDocumentInput,
  IngestOutput,
  PlaybookRuleRecord,
  PromptDefinition,
  RetrievalPolicy,
  RunManifest,
  SourceSpan,
  SupportAnswer,
  VerifiedFinding,
  WarningCode,
  WorkflowManifest,
} from "./contracts.js";
import type { Severity } from "@clausewise/playbook";
import type { UsageSummary } from "./usage/summary.js";

// ---------------------------------------------------------------------------------------------
// Ingest (src/ingest)
// ---------------------------------------------------------------------------------------------

export interface ParsedDocument {
  /** Paragraphs in the shape `segment` reads, for a Word file and for a plain text file alike. */
  paragraphs: DocxParagraph[];
  /** What a Word file holds that is not reviewed. Null for a TXT file. */
  inspection: DocxInspection | null;
}

/** Thrown for a file that cannot be accepted. The message never quotes the document. */
export class UploadError extends Error {
  override name = "UploadError";
}

/** `parseDocument` in src/ingest/parse.ts. Rejects with `UploadError`. */
export type ParseDocument = (input: {
  bytes: Uint8Array;
  mediaType: "docx" | "txt";
}) => Promise<ParsedDocument>;

/** `buildIngest` in src/ingest/ingest.ts. Pure and deterministic. */
export type BuildIngest = (input: { documents: IngestDocumentInput[] }) => IngestOutput;

// ---------------------------------------------------------------------------------------------
// Prompts and workflow versions (src/prompts)
// ---------------------------------------------------------------------------------------------

export interface RegisteredPrompt {
  definition: PromptDefinition;
  /** The zod schema the model's answer is parsed with. */
  schema: ZodType;
  /** Over id, stage, system, user template and the JSON form of the schema. */
  sha256: string;
}

/** `getPrompt` in src/prompts/registry.ts. Throws for an unknown id. */
export type GetPrompt = (id: string) => RegisteredPrompt;

/**
 * `renderPrompt` in src/prompts/registry.ts. Replaces each `{{name}}` with `vars[name]`. Throws
 * when the template names a variable that is not given, or when a variable is given that the
 * template does not name, so a drifted template fails loudly.
 */
export type RenderPrompt = (definition: PromptDefinition, vars: Record<string, string>) => string;

export interface RegisteredWorkflow {
  manifest: WorkflowManifest;
  sha256: string;
}

// ---------------------------------------------------------------------------------------------
// Playbooks (src/playbooks)
// ---------------------------------------------------------------------------------------------

export interface LoadedPlaybook {
  slug: string;
  name: string;
  version: string;
  description: string | null;
  perspective: string;
  rules: PlaybookRuleRecord[];
  yaml: string;
  /** Over the YAML text exactly as given. */
  sha256: string;
}

/**
 * `loadPlaybook` in src/playbooks/load.ts. Parses with `@clausewise/playbook`, then requires a
 * `version` and, on every rule, a `category` that is one of the seven Parol categories. Throws
 * `PlaybookError` listing every problem.
 */
export type LoadPlaybook = (input: {
  yaml: string;
  slug: string;
  source?: string;
}) => LoadedPlaybook;

// ---------------------------------------------------------------------------------------------
// Stages (src/stages)
// ---------------------------------------------------------------------------------------------

export interface StageCommon {
  generator: ObjectGenerator;
  signal?: AbortSignal;
}

export interface ExtractArgs extends StageCommon {
  ingest: IngestOutput;
  /** Documents, their kinds and stated dates, and the client's name. Intake data, not document text. */
  manifest: RunManifest;
  prompt: RegisteredPrompt;
}
export interface ExtractResult {
  output: ExtractOutput;
  calls: CallRecord[];
}
/** `runExtract` in src/stages/extract.ts. Never throws for a model failure: it degrades. */
export type RunExtract = (args: ExtractArgs) => Promise<ExtractResult>;

export interface RetrieveArgs {
  ingest: IngestOutput;
  extract: ExtractOutput;
  rules: PlaybookRuleRecord[];
  policy: RetrievalPolicy;
  budgetTokens: number;
}
/** `buildBundles` in src/stages/retrieve.ts. Pure. One bundle per rule, in rule order. */
export type BuildBundles = (args: RetrieveArgs) => ContextBundle[];

export interface AnalyzeArgs extends StageCommon {
  bundle: ContextBundle;
  ingest: IngestOutput;
  /** Documents, their kinds and stated dates, and the client's name. Intake data, not document text. */
  manifest: RunManifest;
  prompt: RegisteredPrompt;
  /** Extra attempts after a semantic error. Zero means the first answer is final. */
  repairAttempts: number;
}
export type AnalyzeResult =
  | { ok: true; draft: DraftFinding; calls: CallRecord[] }
  | { ok: false; detail: string; calls: CallRecord[] };
/** `runAnalyze` in src/stages/analyze.ts. Never throws for a model failure. */
export type RunAnalyze = (args: AnalyzeArgs) => Promise<AnalyzeResult>;

export interface SupportCheckInput extends StageCommon {
  rule: PlaybookRuleRecord;
  draft: DraftFinding;
  /** Only the spans the finding cites. The checker sees nothing else. */
  citedSpans: SourceSpan[];
}
export type SupportChecker = (
  input: SupportCheckInput,
) => Promise<{ answer: SupportAnswer; call: CallRecord }>;

export interface VerifyArgs {
  draft: DraftFinding;
  bundle: ContextBundle;
  rule: PlaybookRuleRecord;
  ingest: IngestOutput;
  manifest: RunManifest;
  /**
   * The check sets the workflow version enables, from `WorkflowManifest.checks`. `C1` is the
   * baseline set. `C2` adds the deterministic supersession check (`superseded_evidence`), which
   * is measured as a separate workflow version and so is off unless listed.
   */
  enabledChecks: string[];
  /** Null or absent: no model support check is run and `supportCheck` stays `not_run`. */
  supportChecker?: SupportChecker | null;
  generator?: ObjectGenerator;
  signal?: AbortSignal;
}
export interface VerifyResult {
  finding: VerifiedFinding;
  calls: CallRecord[];
}
/**
 * `verifyFinding` in src/stages/verify.ts. Never throws for bad model output. It settles the
 * draft's status against the rule's flags before any check (`settleStatus`), for every workflow
 * version, and keeps the status the model stated in `VerifiedFinding.modelStatus`.
 */
export type VerifyFinding = (args: VerifyArgs) => Promise<VerifyResult>;

/**
 * `makeUndetermined` in src/stages/verify.ts. A finding for a rule the workflow could not analyse
 * (no valid answer, over budget). Status `undetermined`, no evidence, one escalation.
 */
export type MakeUndetermined = (args: {
  rule: PlaybookRuleRecord;
  code: EscalationCode;
  detail: string;
}) => VerifiedFinding;

// ---------------------------------------------------------------------------------------------
// Memo export (src/export)
// ---------------------------------------------------------------------------------------------

/** Thrown when a memo cannot be built: an undecided finding, or a quote that no longer verifies. */
export class MemoError extends Error {
  override name = "MemoError";
}

export interface MemoFinding {
  finding: VerifiedFinding;
  /** Where each evidence quote is, in the order of `finding.evidence`. */
  locations: string[];
  /**
   * The stored id of each evidence item, in the order of `finding.evidence`. Needed when the
   * decision changes evidence roles (`review.edits.evidenceRoles` names evidence by id) and
   * otherwise optional. The store's `FindingRecord.evidence[i].id`.
   */
  evidenceIds?: string[];
  /** The reviewer's current decision, or null when there is none. A null decision blocks export. */
  review: {
    decision: "accept" | "edit" | "reject" | "escalate";
    reviewerName: string;
    decidedAt: string;
    reason: string | null;
    edits: {
      status?: string;
      discrepancy?: string;
      fallbackLanguage?: string;
      /** The reviewer's change to how a cited passage is labelled. The store's `ReviewEdits`. */
      evidenceRoles?: { evidenceId: string; role: string }[];
    } | null;
  } | null;
}

export interface MemoInput {
  matter: { id: string; name: string; clientLegalName: string };
  playbook: { name: string; slug: string; version: string; sha256: string };
  run: {
    id: string;
    workflowLabel: string;
    workflowSha256: string;
    modelProvider: string;
    modelRequested: string;
    modelReported: string | null;
    manifestSha256: string;
    startedAt: string;
    /**
     * What the run's model calls used. The memo prints counts with their denominators and never a
     * cost (see `memoUsageText`). Absent, or for a stand-in reader, the memo has no usage line.
     */
    usage?: UsageSummary | null;
  };
  documents: {
    label: string;
    title: string;
    versionNo: number;
    statedDate: string | null;
    fileSha256: string;
  }[];
  /** Current text of every span a finding cites, keyed by span id, for re-verifying each quote. */
  spanTexts: Record<string, string>;
  /**
   * What the upload said about the documents the run read: Word content the review did not read,
   * tracked changes it read as accepted, and paragraphs that read like an instruction to software.
   * Optional so that a caller written before the memo carried warnings still compiles; absent
   * means none were recorded.
   */
  documentWarnings?: {
    /** `D1`, `D2` or `D3`. */
    label: string;
    code: WarningCode;
    /** Where the paragraph is, in the words the memo uses for passages. Null for a whole document. */
    location: string | null;
    /** The stored detail: ids, counts and pattern names. The memo reads counts from it, nothing else. */
    detail: string;
  }[];
  /** One per rule, in playbook order. */
  findings: MemoFinding[];
  /** Counts of rules by severity, to show on the summary. */
  ruleSeverities: Record<string, Severity>;
  /**
   * Rule titles by rule key, for the summary table and the section headings. Optional so that a
   * caller written before the memo showed titles still compiles: a rule without a title is shown
   * under the name of its category.
   */
  ruleTitles?: Record<string, string>;
  /**
   * The flags of each rule that decide how a status is settled (`kind` and `required`), by rule
   * key. Optional like `ruleTitles`: without them a settled finding is still marked as settled but
   * the memo does not say why.
   */
  ruleFlags?: Record<string, { kind: "presence" | "absence"; required: boolean }>;
  exportedBy: string;
  /** ISO 8601. The memo says this date, so it is an input and not read from the clock. */
  exportedAt: string;
  /** True when the reviewer and the associate were the same person (single-person demo). */
  segregationRelaxed: boolean;
}

/** `buildMemo` in src/export/memo.ts. Rejects with `MemoError`. */
export type BuildMemo = (input: MemoInput) => Promise<Uint8Array>;
