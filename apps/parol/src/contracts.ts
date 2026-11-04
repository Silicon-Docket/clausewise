/**
 * The shapes every Parol module agrees on. They follow docs/parol/03-data-model-and-contracts.md,
 * and a module that needs a different shape changes it here, in one place, and says why.
 *
 * Nothing in this file touches a database, a model or the file system.
 */
import type { DocxInspection, DocxParagraph } from "@clausewise/docx";
import type { Severity } from "@clausewise/playbook";
import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------

export const CATEGORY_IDS = [
  "parties",
  "ci-definition",
  "exclusions",
  "permitted-disclosures",
  "duration",
  "return-destruction",
  "governing-law",
] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];

/** `undetermined` is Parol's own: the workflow declines to state a status and says why. */
export const STATUSES = [
  "compliant",
  "deviation",
  "missing",
  "not_applicable",
  "undetermined",
] as const;
export type Status = (typeof STATUSES)[number];

export const EVIDENCE_ROLES = [
  "governing",
  "supporting",
  "superseded",
  "conflicting",
  "definition",
] as const;
export type EvidenceRole = (typeof EVIDENCE_ROLES)[number];

/**
 * The only way Parol expresses doubt. There are no confidence scores. The reviewer is told which
 * check failed and what to look at.
 */
export const ESCALATION_CODES = [
  "quote_not_verified",
  "support_not_confirmed",
  "superseded_evidence",
  "conflicting_sources",
  "missing_not_confirmed",
  "defined_term_unresolved",
  "parties_mismatch",
  "playbook_escalation",
  "model_abstained",
  "output_invalid",
  "context_over_budget",
] as const;
export type EscalationCode = (typeof ESCALATION_CODES)[number];

/** An escalation with one of these codes means the finding's status must be `undetermined`. */
export const FORCES_UNDETERMINED: ReadonlySet<EscalationCode> = new Set<EscalationCode>([
  "conflicting_sources",
  "model_abstained",
  "output_invalid",
  "context_over_budget",
]);

export const WARNING_CODES = [
  "instruction_like_text",
  "duplicate_document",
  "near_duplicate_version",
  "unreviewed_content",
  "no_reviewable_text",
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

export const FALLBACK_BASES = [
  "approved_adapted",
  "approved_verbatim",
  "generated",
  "none",
] as const;
export type FallbackBasis = (typeof FALLBACK_BASES)[number];

export const REVIEW_DECISIONS = ["accept", "edit", "reject", "escalate"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const MATTER_STATUSES = [
  "draft",
  "ready",
  "running",
  "in_review",
  "review_complete",
  "exported",
  "stale",
  "deleted",
] as const;
export type MatterStatus = (typeof MATTER_STATUSES)[number];

export const RUN_STATUSES = [
  "queued",
  "ingesting",
  "extracting",
  "retrieving",
  "analyzing",
  "verifying",
  "succeeded",
  "failed",
  "cancelled",
  "superseded",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const MATTER_ROLES = ["associate", "reviewer", "viewer"] as const;
export type MatterRole = (typeof MATTER_ROLES)[number];

export const GLOBAL_ROLES = ["member", "legal_engineer", "admin"] as const;
export type GlobalRole = (typeof GLOBAL_ROLES)[number];

export const DOCUMENT_KINDS = ["nda", "amendment"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** One NDA and at most two amendments per matter. */
export const DOC_LABELS = ["D1", "D2", "D3"] as const;
export type DocLabel = (typeof DOC_LABELS)[number];

export const SEVERITY_WEIGHT: Record<Severity, number> = { high: 5, medium: 3, low: 1 };

// ---------------------------------------------------------------------------------------------
// Playbook rules, as the stages see them
// ---------------------------------------------------------------------------------------------

export interface PlaybookRuleRecord {
  /** The rule id in the playbook, such as `dur-1`. */
  key: string;
  category: CategoryId;
  title: string;
  severity: Severity;
  required: boolean;
  kind: "presence" | "absence";
  standard: string;
  fallback: string | null;
  unacceptable: string | null;
  guidance: string | null;
  /** Approved wording to offer or adapt. Null when the playbook gives none. */
  fallbackLanguage: string | null;
  escalateWhen: { id: string; text: string }[];
}

// ---------------------------------------------------------------------------------------------
// Source spans
// ---------------------------------------------------------------------------------------------

/** `<documentVersionId>:p<paragraphIndex>`. Stable for as long as the version exists. */
export type SpanId = string;

export const spanIdOf = (documentVersionId: string, paragraphIndex: number): SpanId =>
  `${documentVersionId}:p${paragraphIndex}`;

export interface SourceSpan {
  id: SpanId;
  /** What people read: `D1-p19`. */
  label: string;
  /**
   * What the model reads and cites: `c<N>`, N counting from 1 across all documents of the run in
   * the order D1, D2, D3. The `c` prefix is deliberate: the hardened clause renderer in
   * `@clausewise/review` already neutralises document lines that imitate a `[c12]` header, and it
   * would not neutralise any other label.
   */
  modelLabel: string;
  documentVersionId: string;
  docLabel: DocLabel;
  paragraphIndex: number;
  /** The `c<n>` id `segment` gave the clause within its own document. */
  clauseId: string;
  /** The clause number as written, such as `6.1`. */
  clauseNumber: string | null;
  heading: string | null;
  text: string;
  textSha256: string;
}

export type SpanAnnotation =
  | { kind: "defines_term"; spanId: SpanId; term: string }
  | { kind: "uses_term"; spanId: SpanId; term: string }
  | {
      kind: "cross_reference";
      spanId: SpanId;
      /** The clause number the span refers to, such as `6.1`. */
      target: string;
      verb: "replaces" | "amends" | "deletes" | "refers";
    }
  | { kind: "instruction_like"; spanId: SpanId; pattern: string }
  | { kind: "keyword_hint"; spanId: SpanId; category: CategoryId };

export interface IngestWarning {
  code: WarningCode;
  documentVersionId: string;
  spanId?: SpanId;
  /** Ids, counts and pattern names. Never document text. */
  detail: string;
}

export interface IngestDocumentInput {
  documentVersionId: string;
  label: DocLabel;
  kind: DocumentKind;
  /** What people call the document, such as "Amendment No. 1". */
  title: string;
  versionNo: number;
  /** Entered at intake. Never parsed out of the document text. */
  statedDate: string | null;
  paragraphs: DocxParagraph[];
  /** What the Word file holds that is not reviewed. Null for a TXT file. */
  inspection: DocxInspection | null;
}

export interface IngestOutput {
  spans: SourceSpan[];
  annotations: SpanAnnotation[];
  warnings: IngestWarning[];
}

// ---------------------------------------------------------------------------------------------
// Run manifest and workflow versions
// ---------------------------------------------------------------------------------------------

export interface RunManifest {
  matterId: string;
  clientLegalName: string;
  documents: {
    documentVersionId: string;
    label: DocLabel;
    kind: DocumentKind;
    title: string;
    versionNo: number;
    statedDate: string | null;
    textSha256: string;
  }[];
  playbook: { versionId: string; slug: string; version: string; sha256: string };
  workflow: { versionId: string; label: string; sha256: string };
  model: { provider: string; model: string };
}

export type RetrievalPolicy = "R1" | "R2";

/** What a workflow version pins. Its canonical hash is the workflow version's identity. */
export interface WorkflowManifest {
  label: string;
  /** Prompt ids from the prompt registry. `support` is null when no support check is run. */
  prompts: { extract: string; analyze: string; support: string | null };
  retrieval: RetrievalPolicy;
  /** Names of the verify check sets that are enabled, such as `C1`. */
  checks: string[];
  /** Estimated tokens allowed in one rule's context. Over budget: no call, `undetermined`. */
  budgetTokens: number;
  /** Extra attempts after a semantic error in a model answer. */
  repairAttempts: number;
}

// ---------------------------------------------------------------------------------------------
// Stage outputs
// ---------------------------------------------------------------------------------------------

export interface LocatedPassage {
  spanId: SpanId;
  quote: string;
  quoteCheck: "verified" | "not_found";
}

export interface ExtractOutput {
  categories: Record<
    CategoryId,
    {
      located: LocatedPassage[];
      /** The model found no passage for the category. */
      notFound: boolean;
      notFoundReason: string | null;
      /** Keyword-hint spans for the category that the model did not locate. */
      hintSpans: SpanId[];
    }
  >;
  /**
   * True when the model call failed. Located passages are then empty and retrieval falls back to
   * the whole document for every rule, which is slower and still correct.
   */
  degraded: boolean;
}

export type BundleSpanReason =
  "located" | "definition" | "cross_reference" | "hint" | "full_document";

export interface ContextBundle {
  ruleKey: string;
  category: CategoryId;
  rule: PlaybookRuleRecord;
  spans: { spanId: SpanId; why: BundleSpanReason }[];
  /** True when every operative span is included, because "missing" is a whole-document judgment. */
  fullDocument: boolean;
  estimatedTokens: number;
  budgetTokens: number;
  /** True when `estimatedTokens` exceeds `budgetTokens`. Nothing is truncated; the rule is not analysed. */
  overBudget: boolean;
}

export interface DraftEvidence {
  spanId: SpanId;
  quote: string;
  role: EvidenceRole;
}

export interface DraftFinding {
  ruleKey: string;
  status: Status;
  evidence: DraftEvidence[];
  discrepancy: string;
  explanation: string;
  fallbackLanguage: string | null;
  /** Ids from the rule's `escalateWhen` list that the model says apply. */
  escalateWhenMatched: string[];
  conflict: string | null;
  abstainReason: string | null;
}

export type QuoteCheck = "verified" | "not_found" | "ambiguous";
export type SupportCheck = "supported" | "not_supported" | "insufficient" | "not_run";

export interface VerifiedEvidence extends DraftEvidence {
  quoteCheck: QuoteCheck;
  /** Offsets of the quote inside the span text. Set only when the quote was verified. */
  offsets: { start: number; end: number } | null;
  supportCheck: SupportCheck;
}

export interface CheckResult {
  /** `quote_exists`, `span_in_bundle`, `citation_shape`, `numeric_consistency`, ... */
  id: string;
  kind: "deterministic" | "model";
  outcome: "pass" | "fail" | "not_applicable";
  /** Ids and short reasons. Never document text. */
  detail: string;
}

export interface Escalation {
  code: EscalationCode;
  detail: string;
}

export interface VerifiedFinding {
  ruleKey: string;
  category: CategoryId;
  severity: Severity;
  status: Status;
  evidence: VerifiedEvidence[];
  discrepancy: string;
  explanation: string;
  fallbackLanguage: string | null;
  fallbackBasis: FallbackBasis;
  conflict: string | null;
  abstainReason: string | null;
  checks: CheckResult[];
  escalations: Escalation[];
  verificationState: "verified" | "escalated_by_system";
  /** Over status, texts, evidence and escalations. See `findingContentSha256` in canonical.ts. */
  contentSha256: string;
}

/** One model call, as recorded in `model_calls`. No prompt or response text. */
export interface CallRecord {
  stage: "extract" | "analyze" | "support";
  ruleKey: string | null;
  promptVersionId: string;
  requestSha256: string;
  /** 1 for the first answer, 2 for a semantic repair. */
  attempt: number;
  outcome: "ok" | "schema_error" | "semantic_error" | "refusal" | "cut_off" | "transport" | "fatal";
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

// ---------------------------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------------------------

export interface PromptDefinition {
  /** `extract.p1`, `analyze.p1`, `support.p1`. */
  id: string;
  stage: "extract" | "analyze" | "support";
  system: string;
  /** Text with `{{name}}` placeholders. Rendered with `renderPrompt`. */
  userTemplate: string;
  /** Name given to the structured-output schema. */
  schemaName: string;
}

// ---------------------------------------------------------------------------------------------
// Model-facing schemas
//
// Kept plain, as `RuleCheckSchema` in @clausewise/review is: no optional keys (nullable instead),
// no min or max constraints, and every semantic check done in code after parsing.
// ---------------------------------------------------------------------------------------------

export const LocateSchema = z.object({
  categories: z.array(
    z.object({
      category: z.enum(CATEGORY_IDS),
      passages: z.array(
        z.object({
          span: z
            .string()
            .describe("A clause label such as c12, exactly as shown in the header line."),
          quote: z
            .string()
            .describe(
              "Words copied exactly from that clause that show why it belongs to the category.",
            ),
        }),
      ),
      notFoundReason: z
        .string()
        .nullable()
        .describe("Why no passage covers the category, or null when passages are given."),
    }),
  ),
});
export type LocateAnswer = z.infer<typeof LocateSchema>;

export const AnalysisSchema = z.object({
  status: z
    .enum(STATUSES)
    .describe(
      "compliant: the documents meet the playbook standard or a stated fallback, or, for an absence rule, contain nothing the standard forbids. deviation: a clause addresses the topic but falls short of the standard, or, for an absence rule, contains what the standard forbids. missing: a presence rule that the playbook requires and no clause covers. not_applicable: a presence rule that the playbook does not require and no clause covers. undetermined: the passages given do not let the rule be applied, or they conflict in a way the documents do not settle; abstainReason is then required.",
    ),
  evidence: z.array(
    z.object({
      span: z.string().describe("A clause label such as c12, exactly as shown in the header line."),
      quote: z.string().describe("Copied character for character from that clause."),
      role: z.enum(EVIDENCE_ROLES),
    }),
  ),
  discrepancy: z
    .string()
    .describe(
      "How the governing text differs from the standard. An empty string when compliant or not applicable.",
    ),
  explanation: z.string(),
  fallbackLanguage: z
    .string()
    .nullable()
    .describe(
      "Adapt the rule's approved fallback language to the documents' defined terms. Null when compliant or not applicable.",
    ),
  escalateWhenMatched: z.array(z.string()),
  conflict: z.string().nullable().describe("Describe passages that disagree, or null."),
  abstainReason: z.string().nullable().describe("Required when status is undetermined."),
});
export type AnalysisAnswer = z.infer<typeof AnalysisSchema>;

export const SupportSchema = z.object({
  verdict: z.enum(["supported", "not_supported", "insufficient"]),
  missingPremise: z
    .string()
    .nullable()
    .describe("What the passages would need to say for the conclusion to follow."),
});
export type SupportAnswer = z.infer<typeof SupportSchema>;
