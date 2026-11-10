import { MATTER_STATUSES, RUN_STATUSES } from "../contracts.js";

/**
 * Errors the store throws. Their messages name a kind of thing, a rule that was broken or a closed
 * vocabulary value (a status, a decision), and never a string the caller supplied: not text from a
 * document, a quote, a review reason or a client name, and not an id either, because an id arrives
 * in a request and can be anything an attacker types. Callers log these messages, so a message that
 * repeated its input would carry that input into the logs.
 *
 * Where a caller needs an id back (the run that is already active), it is a field of the error, and
 * it is an id the store read from its own rows.
 *
 * The HTTP layer maps them: NotFoundError to 404, ValidationError to 400, ConflictError and its
 * subclasses to 409.
 */

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
 * error with the same message, so a caller probing ids learns nothing about other matters. It does
 * not keep the id it was asked for: the caller has it already, and an error object is serialised
 * whole by loggers.
 */
export type EntityKind =
  | "user"
  | "matter"
  | "document"
  | "document version"
  | "span"
  | "playbook version"
  | "workflow version"
  | "prompt version"
  | "run"
  | "run stage"
  | "finding"
  | "evidence"
  | "memo"
  | "eval dataset"
  | "eval run"
  | "evaluation comparison";

export class NotFoundError extends StoreError {
  override name = "NotFoundError";
  /** A closed set, so a value from a request cannot be passed here by mistake. */
  readonly entity: EntityKind;
  constructor(entity: EntityKind) {
    super("not_found", `${entity} not found`);
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

/**
 * A matter already has a run in flight. Carries its id so the UI can link to it; the id is read
 * from the database, never taken from the request.
 */
export class ActiveRunError extends ConflictError {
  override name = "ActiveRunError";
  readonly activeRunId: string;
  constructor(activeRunId: string) {
    super("active_run", "the matter already has an active run");
    this.activeRunId = activeRunId;
  }
}

/** The run belongs to inputs that have since changed, or it has been superseded. Stop work on it. */
export class StaleRunError extends ConflictError {
  override name = "StaleRunError";
  readonly why: "superseded" | "inputs_changed";
  constructor(why: "superseded" | "inputs_changed") {
    super("stale_run", `the run is stale (${why})`);
    this.why = why;
  }
}

/** The finding is stale, or its run is not the matter's current run. Reload and decide again. */
export class StaleFindingError extends ConflictError {
  override name = "StaleFindingError";
  constructor() {
    super("stale_finding", "the finding is stale");
  }
}

/** The reviewer decided on content that is no longer the finding's content. */
export class ContentMismatchError extends ConflictError {
  override name = "ContentMismatchError";
  constructor() {
    super("content_mismatch", "the finding content hash does not match the one decided on");
  }
}

/** The matter has no complete set of inputs to run on. */
export class InputsIncompleteError extends ConflictError {
  override name = "InputsIncompleteError";
  constructor() {
    super(
      "inputs_incomplete",
      "the matter needs a playbook version and an operative version of every document, one of them an NDA",
    );
  }
}

/** Every state name a transition can mention. Anything else is not echoed. */
const KNOWN_STATES: ReadonlySet<string> = new Set([
  ...MATTER_STATUSES,
  ...RUN_STATUSES,
  "candidate",
  "pilot",
  "retired",
  "draft",
  "approved",
]);
const stateName = (value: unknown): string =>
  typeof value === "string" && KNOWN_STATES.has(value) ? value : "(unknown state)";

export class InvalidTransitionError extends ConflictError {
  override name = "InvalidTransitionError";
  // `to` can come straight from a request, so it is named only when it is a state that exists.
  constructor(entity: "matter" | "run" | "workflow" | "playbook", from: string, to: string) {
    super(
      "invalid_transition",
      `${entity} cannot move from ${stateName(from)} to ${stateName(to)}`,
    );
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
