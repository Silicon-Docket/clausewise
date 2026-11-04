/**
 * The Parol data layer: a SQLite database on `node:sqlite`, a migration runner, a hash-chained audit
 * log, a file store and a repository with typed methods for every table.
 *
 * Everything the other modules need is exported from here.
 */
export {
  DEFAULT_MIGRATIONS_DIR,
  inTransaction,
  loadMigrationFiles,
  openDatabase,
  runMigrations,
  transaction,
  type Database,
  type MigrationFile,
  type MigrationResult,
  type OpenOptions,
} from "./db.js";

export {
  AUDIT_ACTIONS,
  GENESIS_HASH,
  MAX_DETAIL_DEPTH,
  MAX_DETAIL_ENTRIES,
  MAX_DETAIL_STRING_LENGTH,
  appendAudit,
  listAuditEvents,
  validateAuditDetail,
  verifyAuditChain,
  type AuditBreak,
  type AuditChainResult,
  type AuditDetail,
  type AuditDetailValue,
  type AuditEvent,
  type AuditFilter,
  type AuditInput,
} from "./audit.js";

export { FileStore, MATTER_ID_PATTERN } from "./files.js";

export { createRepository, type Repository } from "./repo.js";
export type { RepositoryOptions } from "./context.js";
export {
  DEFAULT_RETAIN_DAYS,
  DEMO_USER_IDS,
  INPUT_CHANGE_REASONS,
  inputsDigestOf,
  type InputsParts,
} from "./repo-matters.js";
export type { PlaybookImport } from "./repo-playbooks.js";

export { canRunTransition, canTransition, isActiveRunStatus, ACTIVE_RUN_STATUSES } from "./states.js";

export {
  ActiveRunError,
  AuditDetailError,
  ConflictError,
  ContentMismatchError,
  EXPORT_BLOCKER_REASONS,
  ExportBlockedError,
  FileStoreError,
  InputsIncompleteError,
  InvalidTransitionError,
  MigrationError,
  NotFoundError,
  StaleFindingError,
  StaleRunError,
  StoreError,
  ValidationError,
  type ExportBlocker,
  type ExportBlockerReason,
} from "./errors.js";

export type * from "./types.js";
