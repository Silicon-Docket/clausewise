import type {
  CheckResult,
  DeterminedStatus,
  DocLabel,
  DocumentKind,
  Escalation,
  EvidenceRole,
  FallbackBasis,
  GlobalRole,
  MatterRole,
  MatterStatus,
  PlaybookRuleRecord,
  ReviewDecision,
  RunManifest,
  RunStatus,
  SourceSpan,
  Status,
  VerifiedEvidence,
  VerifiedFinding,
  WorkflowManifest,
} from "../contracts.js";

/** Typed, camelCase rows and records the repository returns. Booleans are booleans, JSON is parsed. */

export interface UserRow {
  id: string;
  displayName: string;
  globalRole: GlobalRole;
  demo: true;
}

export interface MatterRow {
  id: string;
  name: string;
  clientLegalName: string;
  playbookVersionId: string | null;
  status: MatterStatus;
  /** The digest of the inputs a run would use now, or null while they are incomplete. */
  currentInputsSha256: string | null;
  synthetic: boolean;
  createdBy: string;
  createdAt: string;
  retainUntil: string;
  deletedAt: string | null;
}

export interface MatterWithRole extends MatterRow {
  role: MatterRole;
}

export interface MemberRow {
  matterId: string;
  userId: string;
  role: MatterRole;
  grantedBy: string;
  grantedAt: string;
}

export interface DocumentRow {
  id: string;
  matterId: string;
  kind: DocumentKind;
  title: string;
  ordinal: number;
  /** `D1`, `D2` or `D3`: the ordinal as the model and the reader see it. */
  label: DocLabel;
}

export interface DocumentVersionRow {
  id: string;
  documentId: string;
  matterId: string;
  versionNo: number;
  mediaType: "docx" | "txt";
  fileSha256: string;
  textSha256: string;
  byteSize: number;
  statedDate: string | null;
  operative: boolean;
  storagePath: string;
  uploadedBy: string;
  uploadedAt: string;
}

export interface NewVersionInput {
  mediaType: "docx" | "txt";
  fileSha256: string;
  textSha256: string;
  byteSize: number;
  /** `YYYY-MM-DD`, entered at intake. Never parsed from the document. */
  statedDate: string | null;
  /** From `FileStore.save`. Must sit in the matter's own folder. */
  storagePath: string;
  /**
   * Make this version the document's operative one in the same transaction. Without it, nothing is
   * operative until `setOperativeVersion` is called, so choosing which text governs is always a
   * deliberate act.
   */
  operative?: boolean;
  /**
   * Store the version and leave the document's operative version as it is, on `addVersion` only.
   * For a re-saved file whose text is a version the matter already holds: the text that governs
   * does not change, so no finding, decision or memo goes stale (docs/parol/03, Invalidation), and
   * using the new file is a deliberate `setOperativeVersion`. Without it a new version takes the
   * operative flag away from the old one even when it is not operative itself. It cannot be
   * combined with `operative`, which already says which version governs.
   */
  keepOperative?: boolean;
}

export interface OperativeDocument {
  document: DocumentRow;
  version: DocumentVersionRow;
}

/** A source span as stored. `SourceSpan` minus `modelLabel`, which depends on the run, plus where it sits. */
export interface StoredSpan extends Omit<SourceSpan, "modelLabel"> {
  matterId: string;
  documentId: string;
  documentTitle: string;
  documentKind: DocumentKind;
  versionNo: number;
}

export interface PlaybookVersionRow {
  id: string;
  slug: string;
  version: string;
  yaml: string;
  sha256: string;
  status: "draft" | "approved" | "retired";
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface StoredRule extends PlaybookRuleRecord {
  id: string;
  playbookVersionId: string;
  /** Position in the playbook; findings and the memo follow it. */
  ordinal: number;
  ruleSha256: string;
}

export interface PromptVersionRow {
  id: string;
  stage: "extract" | "analyze" | "support";
  template: string;
  schemaJson: string;
  sha256: string;
  createdAt: string;
}

export interface WorkflowVersionRow {
  id: string;
  label: string;
  manifest: WorkflowManifest;
  sha256: string;
  status: "candidate" | "pilot" | "retired";
  promotedBy: string | null;
  promotedAt: string | null;
  promotionRecord: string | null;
}

export interface RunRow {
  id: string;
  matterId: string;
  workflowVersionId: string;
  playbookVersionId: string;
  modelProvider: string;
  modelRequested: string;
  modelReported: string | null;
  manifest: RunManifest;
  inputManifestJson: string;
  inputManifestSha256: string;
  /** The inputs digest this run was started on. Current only while it equals the matter's. */
  inputsSha256: string;
  purpose: "matter" | "eval";
  status: RunStatus;
  errorKind: string | null;
  startedBy: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface RunStageRow {
  runId: string;
  stage: string;
  unit: string;
  attempt: number;
  status: "running" | "succeeded" | "failed";
  inputSha256: string;
  /** The parsed output, or null while running or after a failure. */
  output: unknown;
  outputSha256: string | null;
  errorKind: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ModelCallRow {
  id: string;
  runId: string;
  stage: string;
  ruleKey: string | null;
  promptVersionId: string;
  requestSha256: string;
  attempt: number;
  outcome: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  latencyMs: number;
  costUsdEstimate: number | null;
  priceTableSha256: string | null;
}

export interface StoredEvidence extends VerifiedEvidence {
  id: string;
}

export interface ReviewEdits {
  status?: Status;
  discrepancy?: string;
  fallbackLanguage?: string;
  evidenceRoles?: { evidenceId: string; role: EvidenceRole }[];
}

export interface ReviewRecord {
  id: string;
  findingId: string;
  matterId: string;
  reviewerId: string;
  reviewerName: string;
  decision: ReviewDecision;
  /** Changed fields only. */
  edits: ReviewEdits | null;
  reason: string | null;
  findingContentSha256: string;
  supersedesReviewId: string | null;
  validity: "current" | "stale";
  createdAt: string;
}

/** A finding as the issue table, the inspector and the memo need it. Usable wherever a `VerifiedFinding` is. */
export interface FindingRecord extends Omit<VerifiedFinding, "evidence"> {
  id: string;
  runId: string;
  matterId: string;
  playbookRuleId: string;
  evidence: StoredEvidence[];
  checks: CheckResult[];
  escalations: Escalation[];
  fallbackBasis: FallbackBasis;
  /** The status the workflow stated, when code settled it to another one; null otherwise. */
  modelStatus: DeterminedStatus | null;
  validity: "current" | "stale";
  staleReason: string | null;
  rule: StoredRule;
  /** Every decision on this finding, oldest first. */
  reviews: ReviewRecord[];
  /** The one decision that counts, or null. */
  currentReview: ReviewRecord | null;
}

export interface MemoRow {
  id: string;
  matterId: string;
  runId: string;
  reviewIds: string[];
  fileSha256: string;
  storagePath: string;
  status: "current" | "superseded";
  exportedBy: string;
  exportedAt: string;
}

export interface FeedbackRow {
  id: string;
  matterId: string;
  runId: string | null;
  findingId: string | null;
  userId: string;
  kind: "finding_reason" | "missed_issue" | "rating" | "comment";
  reasonCode: string | null;
  rating: number | null;
  text: string | null;
  createdAt: string;
}

export interface EvalDatasetRow {
  id: string;
  label: string;
  devSha256: string;
  heldoutSha256: string;
  createdAt: string;
}

export interface EvalRunRow {
  id: string;
  datasetId: string;
  split: "dev" | "heldout" | "calibration";
  workflowVersionId: string;
  playbookVersionId: string;
  model: string;
  repeats: number;
  priceTableSha256: string;
  resultsPath: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface EvalSlotResultRow {
  evalRunId: string;
  caseKey: string;
  ruleKey: string;
  repeat: number;
  runId: string;
  expectedStatus: string;
  gotStatus: string;
  scores: Record<string, unknown>;
}

export interface InputChangeResult {
  matterId: string;
  reason: string;
  previousInputsSha256: string | null;
  inputsSha256: string | null;
  status: MatterStatus;
  findingsMarkedStale: number;
  reviewsMarkedStale: number;
  memosSuperseded: number;
  runsSuperseded: number;
}

export interface ExportReadiness {
  ready: boolean;
  blockers: import("./errors.js").ExportBlocker[];
}
