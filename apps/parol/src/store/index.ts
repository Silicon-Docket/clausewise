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
  openDatabaseReadOnly,
  runMigrations,
  transaction,
  type Database,
  type MigrationFile,
  type MigrationResult,
  type OpenOptions,
} from "./db.js";

export {
  AUDIT_ACTIONS,
  AUDIT_BREAK_TEXT,
  GENESIS_HASH,
  MAX_DETAIL_DEPTH,
  MAX_DETAIL_ENTRIES,
  MAX_DETAIL_STRING_LENGTH,
  MAX_RECONCILIATION_IDS,
  appendAudit,
  auditHead,
  checkAudit,
  checkAuditAnchor,
  countAuditEvents,
  latestAuditEvent,
  listAuditEvents,
  listMatterAuditEvents,
  reconcileMatterEvents,
  validateAuditDetail,
  verifyAuditChain,
  type AnchorBreak,
  type AnchorResult,
  type AuditBreak,
  type AuditChainResult,
  type AuditCheck,
  type AuditDetail,
  type AuditDetailValue,
  type AuditEvent,
  type AuditFilter,
  type AuditHead,
  type AuditInput,
  type AuditPage,
  type MatterAuditFilter,
  type MatterReconciliation,
} from "./audit.js";
export { tablesHoldingMatter } from "./residue.js";

export { FileStore, MATTER_ID_PATTERN } from "./files.js";
export { toSourceSpans } from "./model-labels.js";

export { createRepository, type Repository } from "./repo.js";
export type { RepositoryOptions } from "./context.js";
export {
  DEFAULT_RETAIN_DAYS,
  DEMO_USER_IDS,
  INPUT_CHANGE_REASONS,
  MAX_RETAIN_DAYS,
  NOT_TRAINING_SQL,
  inputsDigestOf,
  type InputsParts,
} from "./repo-matters.js";
export type { PlaybookImport } from "./repo-playbooks.js";
export type { NewIngestWarning, StoredIngestWarning } from "./repo-warnings.js";

export {
  ACTIVE_RUN_STATUSES,
  canRunTransition,
  canTransition,
  isActiveRunStatus,
  isTerminalRunStatus,
} from "./states.js";

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
  type EntityKind,
  type ExportBlocker,
  type ExportBlockerReason,
} from "./errors.js";

export type * from "./types.js";
