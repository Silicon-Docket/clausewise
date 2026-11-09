export { azureBlobStore } from "./blob.js";
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
