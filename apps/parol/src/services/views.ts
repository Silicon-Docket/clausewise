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
  DeterminedStatus,
  DocLabel,
  DocumentKind,
  Escalation,
  EvidenceRole,
  FallbackBasis,
  MatterRole,
  MatterStatus,
  QuoteCheck,
  ReasonCode,
  ReviewDecision,
  RunStatus,
  Status,
  SupportCheck,
  WarningCode,
} from "../contracts.js";
import type { UsageSummary } from "../usage/summary.js";

export type { UsageCost, UsageSummary } from "../usage/summary.js";

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
  /**
   * What the run's model calls used, with the sentences a page shows. Optional so that a summary
   * built before it existed still fits; absent, a page shows no usage section.
   */
  usage?: UsageSummary;
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
  /**
   * True when the retention date has passed. Optional so that a summary built before it existed
   * still fits; absent, a page shows no "past" mark. Package W2.7 fills it.
   */
  pastRetention?: boolean;
  /**
   * The training key of a matter made for the training exercise (`T01`), or null for an ordinary
   * matter. Optional so that a summary built before it existed still fits. Package W2.8 reads it.
   */
  training?: string | null;
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
  /** The retention date and what the page needs to explain it. Package W2.7 fills it; absent, the page shows no section. */
  retention?: RetentionView;
  /**
   * How far the person has got through the training exercise. Set only for a matter made for it;
   * absent or null, the page shows no training section. Package W2.8 fills it.
   */
  training?: TrainingProgressView | null;
}

/** Where one step of the training exercise stands. Package W2.8 (progress.ts) fills it. */
export interface TrainingStepProgress {
  n: number;
  title: string;
  /** `seeded`: set up by the script. `trainer`: only the trainer can check it. */
  state: "done" | "not_yet" | "seeded" | "trainer";
  note: string;
}

export interface TrainingProgressView {
  key: string;
  steps: TrainingStepProgress[];
  /** Steps Parol can check from what it stores: 3 to 7. */
  checkable: number;
  checkableDone: number;
}

export interface RetentionView {
  retainUntil: string;
  daysLeft: number; // whole days to the date, rounded up; 0 once it has passed
  pastDate: boolean;
  defaultDays: number; // DEFAULT_RETAIN_DAYS
  maxDays: number; // MAX_RETAIN_DAYS
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
  /**
   * The status the workflow stated, set only when the playbook's flags settled it to another one
   * (`settleStatus`). Undefined for every other finding (and so left out of the JSON), and
   * optional so that a page fixture built before settlement existed still fits.
   */
  modelStatus?: DeterminedStatus | null | undefined;
  /**
   * Why the rule settles the status as it does, as a fixed clause (for example "the rule is not
   * required"). Set together with `modelStatus` and never from a document.
   */
  settlementReason?: string | null | undefined;
  validity: "current" | "stale";
  verificationState: "verified" | "escalated_by_system";
  escalations: Escalation[];
  evidenceCount: number;
  /** The current decision, or null. */
  review: ReviewSummary | null;
  /**
   * How many notes the finding carries, from every member. Left out when there are none, so that
   * the row of a finding nobody has written about is the row it was before notes existed; optional,
   * so that a row built before it existed still fits. Package W2.6a, slice D.
   */
  noteCount?: number | undefined;
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
  /** Why an edit or a reject was made; null for other decisions and for decisions made before it existed. Package W2.6a. */
  reasonCode?: ReasonCode | null;
  /** Whether an edit was marked minor; null for other decisions and for decisions made before it existed. Package W2.6a. */
  minorEdit?: boolean | null;
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
  /** The notes on the finding, oldest first. Package W2.6a, slice D. */
  notes?: NoteView[];
  /** Whether the signed-in user may add a note now, and if not, a fixed reason. Package W2.6a, slice D. */
  canAddNote?: { allowed: boolean; reason: string | null };
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
  /** Required for edit and reject, not allowed for accept and escalate. Package W2.6a. */
  reasonCode?: ReasonCode | null;
  /** Only an edit may carry it. Package W2.6a. */
  minorEdit?: boolean | null;
}

// Feedback capture (package W2.6a). The shapes are the design's, section 3.4.

/** A rule of a run's playbook, for the missed-issue form. */
export interface RuleChoice {
  ruleKey: string;
  title: string;
}

export interface MissedIssueView {
  feedbackId: string;
  runId: string;
  /** Null: reported as not covered by any rule. */
  ruleKey: string | null;
  /** The title in the run's playbook; null for not covered. */
  ruleTitle: string | null;
  location: string | null;
  note: string;
  reporterName: string;
  at: string;
}

export interface NoteView {
  feedbackId: string;
  findingId: string;
  note: string;
  authorName: string;
  at: string;
}

export interface RatingView {
  feedbackId: string;
  rating: 1 | 2 | 3 | 4 | 5;
  comment: string | null;
  at: string;
}

export interface MatterFeedbackView {
  /** Oldest first. */
  missedIssues: MissedIssueView[];
  /** Oldest first. */
  notes: NoteView[];
  /** Other people's ratings are never returned. */
  myRating: RatingView | null;
}

/** A user a matter can be shared with, for the reviewer picker. */
export interface UserOption {
  userId: string;
  displayName: string;
  globalRole: string;
}

// The views of the pages that name no matter. They are declared next to their services; a page may
// import types only through this file (the static test lists what a page may import).
export type { EvaluationListView, ComparisonView } from "./evaluations.js";
export type { AuditPageView } from "./audit.js";
// The pilot measures page, the timer and the reference list (package W2.6b). Declared in the pure
// module; a page cannot import that folder, so it reads the types here.
export type {
  PilotAdminView,
  PilotCellView,
  PilotMeasuresView,
  PilotParticipantView,
  PilotPopulationLine,
  PilotTableRowView,
  PilotTableView,
  ReferenceListInput,
  ReferenceRuleView,
  ReferenceView,
  TimerView,
} from "../pilot/views.js";
export type { PilotMeasures, PilotScope, PilotSeverity } from "../pilot/types.js";
