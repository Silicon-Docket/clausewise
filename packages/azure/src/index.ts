export { azureBlobStore } from "./blob.js";
export {
  SettingsError,
  azureServiceDeps,
  readIdentity,
  readPostgres,
  readStorage,
  type AzureServiceDeps,
  type PostgresSettings,
  type StorageSettings,
} from "./config.js";
export {
  POSTGRES_RESOURCE,
  azurePostgresPool,
  migrate,
  postgresRecords,
  type AppRole,
  type AzurePostgresOptions,
  type MigrateOptions,
  type TablePrivilege,
} from "./postgres.js";
export { azureStorageQueue, type QueueOptions } from "./queue.js";
export {
  STORAGE_API_VERSION,
  STORAGE_RESOURCE,
  StorageError,
  normalizeEndpoint,
  type StorageClientOptions,
} from "./rest.js";
