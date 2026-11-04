/**
 * The service layer's contract. Routes call these and nothing else: they never touch the store
 * directly, so authorization, invalidation, auditing and the export gate live in one place.
 *
 * Every function that touches matter data takes an `AuthorizedMatter`, which only the
 * authorization layer can make, and checks `am.role` again with `roleAllows` before it acts
 * (defence in depth: a route cannot be more permissive than the service behind it). A role that may
 * not act gets `ForbiddenError`. An id that belongs to another matter behaves as if it did not
 * exist (the store's NotFoundError). Errors never repeat caller-supplied text.
 */
import type { AuthorizedMatter, Principal } from "../auth/types.js";
import type { MatterRole } from "../contracts.js";
import type {
  DecisionRequest,
  FindingView,
  IssueRow,
  MatterSummary,
  MatterView,
  MemoSummary,
  PlaybookOption,
  RunSummary,
  UploadWarningView,
  UserOption,
} from "./views.js";

export interface MatterService {
  create(
    principal: Principal,
    input: {
      name: string;
      clientLegalName: string;
      playbookVersionId: string | null;
      /** Added as a member with the reviewer role. */
      reviewerUserId: string | null;
    },
  ): MatterSummary;
  /** Only matters the principal is a member of. */
  list(principal: Principal): MatterSummary[];
  view(am: AuthorizedMatter): MatterView;
  update(
    am: AuthorizedMatter,
    patch: { clientLegalName?: string; playbookVersionId?: string },
  ): MatterView;
  addMember(am: AuthorizedMatter, input: { userId: string; role: MatterRole }): void;
  /** Parses, hashes, stores and registers a document, then rebuilds the matter's spans. */
  addDocument(
    am: AuthorizedMatter,
    input: {
      title: string;
      kind: "nda" | "amendment";
      fileName: string;
      bytes: Uint8Array;
      statedDate: string | null;
    },
  ): Promise<{ documentId: string; versionId: string; warnings: UploadWarningView[] }>;
  addVersion(
    am: AuthorizedMatter,
    documentId: string,
    input: { fileName: string; bytes: Uint8Array; statedDate: string | null },
  ): Promise<{ versionId: string; warnings: UploadWarningView[] }>;
  setOperative(am: AuthorizedMatter, documentId: string, versionId: string): void;
  setStatedDate(am: AuthorizedMatter, versionId: string, statedDate: string | null): void;
  removeDocument(am: AuthorizedMatter, documentId: string): void;
  /** Creator or admin only; the authorization layer decides who may hold the `AuthorizedMatter`. */
  delete(am: AuthorizedMatter): Promise<void>;
  /** Approved playbook versions a matter can pin. Not matter data. */
  playbooks(): PlaybookOption[];
  /** Demo identities, for the reviewer picker. Not matter data. */
  users(): UserOption[];
}

export interface RunService {
  /**
   * Starts a run and returns at once with status `queued`; the stages run in the background.
   * Throws `RunNotReadyError` (HTTP 409) when inputs are incomplete, and the store's
   * `ActiveRunError` when a run is already in flight.
   */
  start(am: AuthorizedMatter, input: { workflowLabel?: string }): RunSummary;
  get(am: AuthorizedMatter, runId: string): RunSummary;
  list(am: AuthorizedMatter): RunSummary[];
  /** Resumes a failed run from its failed stage, skipping units whose input hash is unchanged. */
  resume(am: AuthorizedMatter, runId: string): RunSummary;
  cancel(am: AuthorizedMatter, runId: string): RunSummary;
  /** The issue table of a run (default: the current run). Empty when there is no such run. */
  issues(am: AuthorizedMatter, runId?: string): IssueRow[];
  finding(am: AuthorizedMatter, findingId: string): FindingView;
  /** Resolves when no run for any matter is in flight. For tests and orderly shutdown. */
  idle(): Promise<void>;
}

export interface ReviewService {
  /** Records a decision bound to the finding content the reviewer saw. */
  decide(am: AuthorizedMatter, findingId: string, request: DecisionRequest): FindingView;
  /** Checks the export gate, builds the memo, stores it, and records it. */
  exportMemo(am: AuthorizedMatter): Promise<MemoSummary>;
  listMemos(am: AuthorizedMatter): MemoSummary[];
  memoFile(am: AuthorizedMatter, memoId: string): Promise<{ bytes: Uint8Array; fileName: string }>;
}

export interface Services {
  matters: MatterService;
  runs: RunService;
  reviews: ReviewService;
}
