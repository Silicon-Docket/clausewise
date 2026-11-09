import { createManagedIdentityTokenSource, type ManagedIdentityConfig } from "@clausewise/llm";
import type { BlobStore, JobQueue, ReviewRecords } from "@clausewise/service";
import type pg from "pg";
import { azureBlobStore } from "./blob.js";
import { POSTGRES_RESOURCE, azurePostgresPool, postgresRecords } from "./postgres.js";
import { azureStorageQueue } from "./queue.js";
import { STORAGE_RESOURCE, normalizeEndpoint } from "./rest.js";

type Env = Record<string, string | undefined>;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/;

/** A setting that is missing or unusable. The message names variables, never their values. */
export class SettingsError extends Error {
  override name = "SettingsError";
}

function required(env: Env, names: readonly string[]): Record<string, string> {
  const missing = names.filter((name) => (env[name]?.trim() ?? "") === "");
  if (missing.length > 0) {
    throw new SettingsError(`Missing settings: ${missing.join(", ")}.`);
  }
  return Object.fromEntries(names.map((name) => [name, env[name]!.trim()]));
}

function check(ok: boolean, message: string): void {
  if (!ok) throw new SettingsError(message);
}

/**
 * The app's user-assigned managed identity, which the platform's token service signs in as. The
 * client id is required: every identity in the foundation template is user-assigned, and without
 * it the token service would look for a system-assigned one.
 */
export function readIdentity(env: Env): ManagedIdentityConfig {
  const values = required(env, ["IDENTITY_ENDPOINT", "IDENTITY_HEADER", "AZURE_CLIENT_ID"]);
  const clientId = values.AZURE_CLIENT_ID!;
  check(
    GUID.test(clientId),
    "AZURE_CLIENT_ID must be the client id of a user-assigned identity, a GUID.",
  );
  let identityEndpoint: string;
  try {
    const url = new URL(values.IDENTITY_ENDPOINT!);
    check(
      url.protocol === "http:" || url.protocol === "https:",
      "IDENTITY_ENDPOINT must be an http or https URL.",
    );
    identityEndpoint = url.toString();
  } catch (error) {
    if (error instanceof SettingsError) throw error;
    throw new SettingsError("IDENTITY_ENDPOINT is not a valid URL.");
  }
  return { identityEndpoint, clientId };
}

export interface StorageSettings {
  blobEndpoint: string;
  contractsContainer: string;
  resultsContainer: string;
  queueEndpoint: string;
  queueName: string;
}

/** Blob and queue settings, as the foundation template outputs them. */
export function readStorage(env: Env): StorageSettings {
  const values = required(env, [
    "CLAUSEWISE_BLOB_ENDPOINT",
    "CLAUSEWISE_CONTRACTS_CONTAINER",
    "CLAUSEWISE_RESULTS_CONTAINER",
    "CLAUSEWISE_QUEUE_ENDPOINT",
    "CLAUSEWISE_QUEUE_NAME",
  ]);
  const endpoint = (name: string) => {
    try {
      return normalizeEndpoint(values[name]!, name);
    } catch (error) {
      throw new SettingsError((error as Error).message);
    }
  };
  return {
    blobEndpoint: endpoint("CLAUSEWISE_BLOB_ENDPOINT"),
    contractsContainer: values.CLAUSEWISE_CONTRACTS_CONTAINER!,
    resultsContainer: values.CLAUSEWISE_RESULTS_CONTAINER!,
    queueEndpoint: endpoint("CLAUSEWISE_QUEUE_ENDPOINT"),
    queueName: values.CLAUSEWISE_QUEUE_NAME!,
  };
}

export interface PostgresSettings {
  host: string;
  database: string;
  /** The Entra role to sign in as: the app identity's name. */
  user: string;
}

export function readPostgres(env: Env): PostgresSettings {
  const values = required(env, [
    "CLAUSEWISE_POSTGRES_HOST",
    "CLAUSEWISE_POSTGRES_DATABASE",
    "CLAUSEWISE_POSTGRES_USER",
  ]);
  const host = values.CLAUSEWISE_POSTGRES_HOST!;
  check(HOST.test(host), "CLAUSEWISE_POSTGRES_HOST must be a host name, with no scheme or port.");
  check(
    NAME.test(values.CLAUSEWISE_POSTGRES_DATABASE!),
    "CLAUSEWISE_POSTGRES_DATABASE is not a database name.",
  );
  check(
    NAME.test(values.CLAUSEWISE_POSTGRES_USER!),
    "CLAUSEWISE_POSTGRES_USER is not a role name.",
  );
  return {
    host,
    database: values.CLAUSEWISE_POSTGRES_DATABASE!,
    user: values.CLAUSEWISE_POSTGRES_USER!,
  };
}

export interface AzureServiceDeps {
  records: ReviewRecords;
  contracts: BlobStore;
  results: BlobStore;
  queue: JobQueue;
  /** Close it when the process stops. */
  pool: pg.Pool;
}

/**
 * Everything the review service and the worker need from Azure, each signed in as the given
 * identity. `fetch` stands in for the network to Azure Storage and to the token service.
 */
export function azureServiceDeps(
  identity: ManagedIdentityConfig,
  storage: StorageSettings,
  postgres: PostgresSettings,
  options: { fetch?: typeof globalThis.fetch; onInvalidJob?: () => void } = {},
): AzureServiceDeps {
  const network = options.fetch === undefined ? {} : { fetch: options.fetch };
  const storageTokens = createManagedIdentityTokenSource(identity, {
    resource: STORAGE_RESOURCE,
    ...network,
  });
  const postgresTokens = createManagedIdentityTokenSource(identity, {
    resource: POSTGRES_RESOURCE,
    ...network,
  });
  const pool = azurePostgresPool({ ...postgres, tokens: postgresTokens });
  return {
    pool,
    records: postgresRecords(pool),
    contracts: azureBlobStore({
      endpoint: storage.blobEndpoint,
      container: storage.contractsContainer,
      tokens: storageTokens,
      ...network,
    }),
    results: azureBlobStore({
      endpoint: storage.blobEndpoint,
      container: storage.resultsContainer,
      tokens: storageTokens,
      ...network,
    }),
    queue: azureStorageQueue({
      endpoint: storage.queueEndpoint,
      queue: storage.queueName,
      tokens: storageTokens,
      ...network,
      ...(options.onInvalidJob === undefined ? {} : { onInvalid: options.onInvalidJob }),
    }),
  };
}
