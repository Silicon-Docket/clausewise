import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  azureServiceDeps,
  readIdentity,
  readPostgres,
  readStorage,
  SettingsError,
} from "@clausewise/azure";
import { createReviewService } from "@clausewise/service";
import { directoryPlaybooks } from "@clausewise/service/node";
import { checkEntraConfig, entraAuthenticator, type EntraOptions } from "./entra.js";
import { createHandler } from "./handler.js";

type Env = Record<string, string | undefined>;

export interface AzureWebOptions {
  env: Env;
  playbooksDir: string;
  /** Default 8080. 0 picks a free port. */
  port?: number;
  /** Default all interfaces: in Container Apps the environment's ingress sits in front. */
  host?: string;
  /** For tests: the Entra ID signing keys, and how refusals are reported. */
  entra?: EntraOptions;
  /** For tests: the network to Azure Storage and to the token service. */
  fetch?: typeof globalThis.fetch;
  onError?: (error: unknown) => void;
}

/** Reads the sign-in ids, which azure mode requires, from the same variables as local mode. */
function readEntra(env: Env) {
  const tenantId = env.CLAUSEWISE_ENTRA_TENANT_ID?.trim() ?? "";
  const clientId = env.CLAUSEWISE_ENTRA_CLIENT_ID?.trim() ?? "";
  if (tenantId === "" || clientId === "") {
    throw new SettingsError(
      "Missing settings: azure mode needs CLAUSEWISE_ENTRA_TENANT_ID and CLAUSEWISE_ENTRA_CLIENT_ID.",
    );
  }
  try {
    return checkEntraConfig({ tenantId, clientId });
  } catch (error) {
    throw new SettingsError((error as Error).message);
  }
}

/**
 * The web app as it runs in the firm's Azure tenant: Entra ID sign-in on every API request, the
 * page, and the review service over Blob Storage, the queue and PostgreSQL, all signed in as the
 * web app's own managed identity. It runs no reviews itself; the worker does.
 *
 * Every setting is read and checked before anything listens, so a deployment with a missing or
 * malformed setting stops at once and names it.
 */
export async function startAzureWeb(options: AzureWebOptions): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const entra = readEntra(options.env);
  const identity = readIdentity(options.env);
  const storage = readStorage(options.env);
  const postgres = readPostgres(options.env);

  const { pool, ...stores } = azureServiceDeps(identity, storage, postgres, {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const service = createReviewService({
    ...stores,
    playbooks: directoryPlaybooks(options.playbooksDir),
  });
  const handler = createHandler({
    service,
    authenticate: entraAuthenticator(entra, options.entra),
    pages: { signIn: true, tenantId: entra.tenantId, clientId: entra.clientId },
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });

  const server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8080, options.host ?? "0.0.0.0", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    },
  };
}
