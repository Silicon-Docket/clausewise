/**
 * The wire format between the Clausewise server and its web app. Types and constants only, no
 * runtime code, so a browser bundle can import it and the server can check itself against it.
 * docs/m3-design.md explains each route; where prose and this file disagree, this file wins and
 * the prose is fixed.
 *
 * This file does not import from the other packages on purpose: the web app must not pull the
 * server-side packages into its type check. The server asserts at compile time that its own types
 * fit these.
 */

export type Severity = "high" | "medium" | "low";
export type RuleStatus = "compliant" | "deviation" | "missing" | "not_applicable" | "error";
/** The two statuses that need the lawyer's attention. */
export type FindingStatus = "deviation" | "missing";
export type ReviewStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type Decision = "pending" | "accepted" | "rejected";
/** Which findings a downloaded redline holds: only accepted ones, or all that are not rejected. */
export type IncludeMode = "accepted" | "all";
export type ReportFormat = "json" | "md";

export const LIMITS = {
  /** Longest replacement text a lawyer may save for an edit, in characters. */
  maxReplacementChars: 20_000,
  /** Largest playbook YAML, in bytes. */
  maxPlaybookBytes: 256 * 1024,
  /** Longest client description, in characters. */
  maxClientChars: 300,
  /** Longest file name kept for display, in characters. */
  maxFileNameChars: 200,
} as const;

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "payload_too_large"
  | "unsupported_media_type"
  | "invalid_document"
  | "wrong_host"
  | "too_many_requests"
  | "model_not_configured"
  | "internal_error";

export interface ApiError {
  error: { code: ErrorCode; message: string; requestId?: string };
}

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

export interface ModelInfo {
  provider: string;
  model: string;
  /**
   * Where document text is sent, as a destination phrase such as `Anthropic API
   * (api.anthropic.com)`. The screens build their own sentences around it.
   */
  disclosure: string;
}

export interface ConfigResponse {
  version: string;
  authRequired: boolean;
  maxUploadBytes: number;
  model: ({ configured: true } & ModelInfo) | { configured: false; problem: string };
}

// ---------------------------------------------------------------------------------------------
// Playbooks
// ---------------------------------------------------------------------------------------------

export interface PlaybookSummary {
  /** `builtin:<file stem>` for the playbooks that ship with the server, else a short random id. */
  id: string;
  source: "builtin" | "custom";
  name: string;
  contractTypes: string[];
  ruleCount: number;
  updatedAt: string | null;
}

export interface PlaybookDetail extends PlaybookSummary {
  yaml: string;
  editable: boolean;
}

export interface PlaybookListResponse {
  playbooks: PlaybookSummary[];
}

export interface PlaybookWriteRequest {
  yaml: string;
}

export type PlaybookValidateResponse =
  | { ok: true; name: string; ruleCount: number; contractTypes: string[] }
  | { ok: false; problems: string[] };

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------

export interface DocumentSummary {
  id: string;
  fileName: string;
  size: number;
  paragraphs: number;
  createdAt: string;
  reviewCount: number;
}

export interface DocumentListResponse {
  documents: DocumentSummary[];
}

// ---------------------------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------------------------

export interface CreateReviewRequest {
  documentId: string;
  playbookId: string;
  /** Which party the lawyer acts for, in their words. Optional. */
  client?: string;
}

export interface ReviewSummary {
  id: string;
  status: ReviewStatus;
  documentId: string;
  documentName: string;
  playbookName: string;
  client: string | null;
  progress: { done: number; total: number };
  /** Why the review failed, in words for a person. Null unless status is `failed`. */
  error: string | null;
  /** Deviations and missing clauses by severity. Null until the review is done. */
  open: Record<Severity, number> | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ReviewListResponse {
  reviews: ReviewSummary[];
}

export interface FindingClause {
  id: string;
  /** The clause's own number as written, such as `3.1`. */
  number: string | null;
  heading: string | null;
  text: string;
}

export type FindingEdit =
  | { kind: "none" }
  | {
      kind: "applied";
      /** The words the edit removes. */
      original: string;
      /** The model's replacement. The lawyer's own wording is `Finding.editedReplacement`. */
      replacement: string;
      /** The whole paragraph the edit sits in, as the model saw it. */
      paragraphText: string;
      /** Where `original` sits in `paragraphText`. */
      start: number;
      end: number;
    }
  | {
      kind: "comment-only";
      proposed: { quote: string; replacement: string };
      /** Why the proposed edit became a comment. */
      reason: string;
    };

export interface Finding {
  ruleId: string;
  title: string;
  severity: Severity;
  required: boolean;
  status: FindingStatus;
  explanation: string;
  comment: string;
  suggestedClause: string | null;
  clauses: FindingClause[];
  edit: FindingEdit;
  decision: Decision;
  /** The lawyer's own replacement for an applied edit, or null to use the model's. */
  editedReplacement: string | null;
}

/** A rule that is not a finding: compliant, not applicable, or one that could not be checked. */
export interface ResultRow {
  ruleId: string;
  title: string;
  severity: Severity;
  status: Exclude<RuleStatus, FindingStatus>;
  clauseNumbers: string[];
  explanation: string;
  error: string | null;
}

export interface ReviewNotShown {
  trackedInsertions: number;
  trackedDeletions: number;
  comments: number;
  footnotes: number;
  endnotes: number;
  headerFooterParts: number;
  hiddenRuns: number;
  images: number;
}

export interface ReviewDetail extends ReviewSummary {
  model: ModelInfo | null;
  warnings: string[];
  notShown: ReviewNotShown | null;
  stats: { paragraphs: number; clauses: number; windows: number; editsApplied: number } | null;
  counts: Record<RuleStatus, number> | null;
  /** Empty until the review is done. */
  findings: Finding[];
  results: ResultRow[];
}

export interface PatchFindingRequest {
  decision?: Decision;
  /** Allowed only when the finding's edit is `applied`. Null clears it. */
  editedReplacement?: string | null;
}

export interface BulkDecisionRequest {
  decision: Decision;
  ruleIds?: string[];
  severities?: Severity[];
}

export interface BulkDecisionResponse {
  updated: number;
}
