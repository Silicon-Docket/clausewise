/**
 * Errors the store throws. Their messages carry ids, codes and counts and never text from a
 * document, a quote, a review reason or a client name, because callers log them.
 *
 * The HTTP layer maps them: NotFoundError to 404, ValidationError to 400, ConflictError and its
 * subclasses to 409.
 */
const ID_LIKE = /^[A-Za-z0-9_.:/-]{1,128}$/;

/**
 * Ids go into error messages so a person can find the row; anything that is not shaped like an id
 * does not, because a value that is not an id may be text that came out of a document or a model.
 */
export function safeId(value: unknown): string {
  return typeof value === "string" && ID_LIKE.test(value) ? value : "(malformed id)";
}

export class StoreError extends Error {
  override name = "StoreError";
  /** A short stable code, so callers branch on it instead of on the message. */
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The row does not exist, or belongs to another matter. The two cases are deliberately the same
 * error with the same message, so a caller probing ids learns nothing about other matters.
 */
export class NotFoundError extends StoreError {
  override name = "NotFoundError";
  readonly entity: string;
  constructor(entity: string, id: string) {
    super("not_found", `${entity} ${safeId(id)} not found`);
    this.entity = entity;
  }
}

/** The input is malformed. Never quotes the input; names the field and the rule. */
export class ValidationError extends StoreError {
  override name = "ValidationError";
  constructor(code: string, message: string) {
    super(code, message);
  }
}

/** The request is well formed but the current state of the matter does not allow it. */
export class ConflictError extends StoreError {
  override name = "ConflictError";
}

/** A matter already has a run in flight. Carries its id so the UI can link to it. */
export class ActiveRunError extends ConflictError {
  override name = "ActiveRunError";
  readonly activeRunId: string;
  constructor(activeRunId: string) {
    super("active_run", `matter already has an active run ${activeRunId}`);
    this.activeRunId = activeRunId;
  }
}

/** The run belongs to inputs that have since changed, or it has been superseded. Stop work on it. */
export class StaleRunError extends ConflictError {
  override name = "StaleRunError";
  constructor(runId: string | null, why: "superseded" | "inputs_changed") {
    super("stale_run", `run ${runId ?? "(not started)"} is stale (${why})`);
  }
}

/** The finding is stale, or its run is not the matter's current run. Reload and decide again. */
export class StaleFindingError extends ConflictError {
  override name = "StaleFindingError";
  constructor(findingId: string) {
    super("stale_finding", `finding ${findingId} is stale`);
  }
}

/** The reviewer decided on content that is no longer the finding's content. */
export class ContentMismatchError extends ConflictError {
  override name = "ContentMismatchError";
  constructor(findingId: string) {
    super("content_mismatch", `finding ${findingId} content hash does not match`);
  }
}

/** The matter has no complete set of inputs to run on. */
export class InputsIncompleteError extends ConflictError {
  override name = "InputsIncompleteError";
  constructor(matterId: string) {
    super(
      "inputs_incomplete",
      `matter ${matterId} needs a playbook version and an operative version of every document, one of them an NDA`,
    );
  }
}

export class InvalidTransitionError extends ConflictError {
  override name = "InvalidTransitionError";
  constructor(entity: "matter" | "run" | "workflow" | "playbook", from: string, to: string) {
    super("invalid_transition", `${entity} cannot move from ${from} to ${to}`);
  }
}

export interface ExportBlocker {
  /** Null for a blocker about the run or about a rule that has no finding. */
  findingId: string | null;
  /** Null for a blocker about the run as a whole. */
  ruleKey: string | null;
  reason: ExportBlockerReason;
}

export const EXPORT_BLOCKER_REASONS = [
  "no_review",
  "stale_review",
  "content_changed",
  "finding_stale",
  "run_not_current",
  "missing_finding",
] as const;
export type ExportBlockerReason = (typeof EXPORT_BLOCKER_REASONS)[number];

/** Thrown when a memo is recorded while the readiness check still has blockers. */
export class ExportBlockedError extends ConflictError {
  override name = "ExportBlockedError";
  readonly blockers: ExportBlocker[];
  constructor(blockers: ExportBlocker[]) {
    super("export_blocked", `export is blocked by ${blockers.length} item(s)`);
    this.blockers = blockers;
  }
}

/** An applied migration file no longer matches the checksum recorded when it was applied. */
export class MigrationError extends StoreError {
  override name = "MigrationError";
}

/** A detail object for the audit log broke the rules that keep document text out of it. */
export class AuditDetailError extends ValidationError {
  override name = "AuditDetailError";
  constructor(message: string) {
    super("audit_detail", message);
  }
}

/** A path escaped the file store root, or the id it was built from is malformed. */
export class FileStoreError extends StoreError {
  override name = "FileStoreError";
}
