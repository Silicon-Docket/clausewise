/**
 * What the services hand to routes and pages. Plain data with no behaviour, no secrets and no
 * database types, so a page can be rendered and tested from these alone. Text that came from a
 * document or a model (quotes, explanations, discrepancies) is data: pages escape it and never
 * treat it as markup.
 */
import type { Severity } from "@clausewise/playbook";
import type {
  CategoryId,
  CheckResult,
  DocLabel,
  DocumentKind,
  Escalation,
  EvidenceRole,
  FallbackBasis,
  MatterRole,
  MatterStatus,
  QuoteCheck,
  ReviewDecision,
  RunStatus,
  Status,
  SupportCheck,
  WarningCode,
} from "../contracts.js";

export interface PlaybookOption {
  versionId: string;
  slug: string;
  name: string;
  version: string;
  approvedAt: string;
  ruleCount: number;
}

/** A workflow version a review can be started with. */
export interface WorkflowOption {
  /** The label a run is started with, such as `v2`. */
  label: string;
  status: "candidate" | "pilot" | "retired";
  /** True for the one a review uses when none is chosen. */
  isDefault: boolean;
}

export interface MemberView {
  userId: string;
  displayName: string;
  role: MatterRole;
}

export interface UploadWarningView {
  code: WarningCode;
  documentLabel: DocLabel | null;
  /** `D1-p22`, or null for a whole-document warning. */
  spanLabel: string | null;
  /** Ids, counts and pattern names. Never document text. */
  detail: string;
}

export interface DocumentVersionView {
  versionId: string;
  versionNo: number;
  mediaType: "docx" | "txt";
  byteSize: number;
  fileSha256: string;
  statedDate: string | null;
  operative: boolean;
  uploadedAt: string;
  uploadedByName: string;
}

export interface DocumentView {
  documentId: string;
  label: DocLabel;
  kind: DocumentKind;
  title: string;
  versions: DocumentVersionView[];
}

export interface RunProgress {
  stage: "ingest" | "extract" | "retrieve" | "analyze" | "verify";
  done: number;
  total: number;
}

export interface RunSummary {
  id: string;
  status: RunStatus;
  workflowLabel: string;
  playbook: { slug: string; version: string };
  model: { provider: string; requested: string; reported: string | null };
  startedAt: string;
  finishedAt: string | null;
  startedByName: string;
  /** A fixed code such as `interrupted` or `provider_auth`. Never a provider message. */
  errorKind: string | null;
  /** True while the run's inputs are the matter's current inputs. */
  current: boolean;
  /**
   * True for a failed run that a resume would accept: its inputs are unchanged and the provider
   * and model now configured are the ones it started on. A run on other inputs is not `current`; a
   * run on another model is current and not resumable, and the way on is a new review. Optional so
   * that a summary built before it existed still fits; absent, a page falls back to `current`.
   */
  resumable?: boolean;
  progress: RunProgress | null;
  findingCount: number;
}

export interface MatterSummary {
  id: string;
  name: string;
  clientLegalName: string;
  status: MatterStatus;
  /** The signed-in user's role on this matter. */
  role: MatterRole;
  createdAt: string;
  retainUntil: string;
  playbook: { slug: string; version: string } | null;
  synthetic: boolean;
}

export interface StartReadiness {
  ready: boolean;
  /** Fixed phrases a person can act on, such as "Choose which version of the NDA is operative". */
  reasons: string[];
}

export interface MemoSummary {
  memoId: string;
  runId: string;
  fileName: string;
  fileSha256: string;
  status: "current" | "superseded";
  exportedAt: string;
  exportedByName: string;
}

export interface MatterView {
  matter: MatterSummary;
  members: MemberView[];
  documents: DocumentView[];
  warnings: UploadWarningView[];
  playbooks: PlaybookOption[];
  start: StartReadiness;
  activeRun: RunSummary | null;
  /** The run whose inputs are the matter's current inputs, if there is one. */
  currentRun: RunSummary | null;
  runs: RunSummary[];
  /** Why results are stale, as a fixed phrase, or null when they are not. */
  staleReason: string | null;
  /** One plain sentence saying where document text is sent. From the generator's disclosure. */
  destination: string;
  memos: MemoSummary[];
  /** True when one person may both prepare and review, so the memo says so. */
  segregationRelaxed: boolean;
  /**
   * The workflow versions a review can be started with, the default first. Optional so that a view
   * built before it existed still fits; the start form offers a choice only when there are two or
   * more.
   */
  workflows?: WorkflowOption[];
}

export interface ReviewSummary {
  decision: ReviewDecision;
  reviewerName: string;
  at: string;
  validity: "current" | "stale";
}

/** One row of the issue table. */
export interface IssueRow {
  findingId: string;
  ruleKey: string;
  ruleTitle: string;
  category: CategoryId;
  severity: Severity;
  status: Status;
  validity: "current" | "stale";
  verificationState: "verified" | "escalated_by_system";
  escalations: Escalation[];
  evidenceCount: number;
  /** The current decision, or null. */
  review: ReviewSummary | null;
}

export interface EvidenceView {
  evidenceId: string;
  spanId: string;
  /** `Amendment No. 1 (v1), Section 2, paragraph 3`. */
  location: string;
  quote: string;
  role: EvidenceRole;
  quoteCheck: QuoteCheck;
  supportCheck: SupportCheck;
  /** Offsets of the quote inside `spanText`, set only for a verified quote. */
  offsets: { start: number; end: number } | null;
  /** The whole paragraph, exactly as stored, so the inspector can show the quote in place. */
  spanText: string;
}

export interface ReviewHistoryItem {
  decision: ReviewDecision;
  reviewerName: string;
  at: string;
  reason: string | null;
  validity: "current" | "stale";
  /** Changed fields only, as the reviewer entered them. */
  edits: {
    status?: Status;
    discrepancy?: string;
    fallbackLanguage?: string;
    evidenceRoles?: { evidenceId: string; role: EvidenceRole }[];
  } | null;
}

export interface FindingView {
  issue: IssueRow;
  rule: {
    standard: string;
    fallback: string | null;
    unacceptable: string | null;
    /** The playbook's approved wording, for the reviewer to compare with the suggestion. */
    fallbackLanguage: string | null;
    playbook: { slug: string; version: string };
  };
  discrepancy: string;
  explanation: string;
  fallbackLanguage: string | null;
  fallbackBasis: FallbackBasis;
  conflict: string | null;
  abstainReason: string | null;
  evidence: EvidenceView[];
  checks: CheckResult[];
  reviews: ReviewHistoryItem[];
  /** What a decision must quote back to be accepted. */
  contentSha256: string;
  /** Whether the signed-in user may decide it now (role, validity), and if not, a fixed reason. */
  canDecide: { allowed: boolean; reason: string | null };
}

export interface DecisionRequest {
  decision: ReviewDecision;
  /** The `contentSha256` of the finding the reviewer saw. A mismatch is a conflict (HTTP 409). */
  findingContentSha256: string;
  edits: {
    status?: Status;
    discrepancy?: string;
    fallbackLanguage?: string;
    evidenceRoles?: { evidenceId: string; role: EvidenceRole }[];
  } | null;
  /** Required for edit, reject and escalate. */
  reason: string | null;
}

/** A user a matter can be shared with, for the reviewer picker. */
export interface UserOption {
  userId: string;
  displayName: string;
  globalRole: string;
}
