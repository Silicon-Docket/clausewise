import { fileURLToPath } from "node:url";
import { SettingsError } from "@clausewise/azure";
import { createObjectGenerator, loadLlmConfig } from "@clausewise/llm";
import { startAzureWeb } from "./azure.js";
import { checkEntraConfig, type EntraConfig } from "./entra.js";
import { startLocal } from "./local.js";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const mode = process.env.CLAUSEWISE_WEB_MODE ?? "local";
if (mode !== "local" && mode !== "azure") {
  fail("CLAUSEWISE_WEB_MODE must be local or azure.");
}

const rawPort = process.env.PORT;
const port = rawPort === undefined ? (mode === "azure" ? 8080 : 8787) : Number(rawPort);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  fail("PORT must be a whole number from 0 to 65535.");
}

const playbooksDir = fileURLToPath(new URL("../../../playbooks/", import.meta.url));
// Only the kind of error is printed: a message could quote a request.
const onError = (error: unknown) =>
  process.stderr.write(`error: ${error instanceof Error ? error.name : "unknown"}\n`);

function stopOn(close: () => Promise<void>): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void close().then(() => process.exit(0));
    });
  }
}

async function runAzure(): Promise<void> {
  let server;
  try {
    server = await startAzureWeb({
      env: process.env,
      playbooksDir,
      port,
      entra: { onReject: (reason) => process.stderr.write(`sign-in refused: ${reason}\n`) },
      onError,
    });
  } catch (error) {
    if (error instanceof SettingsError) fail(error.message);
    throw error;
  }
  process.stderr.write(`Clausewise web is listening on port ${new URL(server.url).port}.\n`);
  process.stderr.write("Sign-in: Entra ID. Contracts and reviews are kept in Azure.\n");
  stopOn(server.close);
}

// Both ids or neither: one alone is a mistake, not a choice.
function readLocalEntra(): EntraConfig | undefined {
  const tenantId = process.env.CLAUSEWISE_ENTRA_TENANT_ID?.trim() || undefined;
  const clientId = process.env.CLAUSEWISE_ENTRA_CLIENT_ID?.trim() || undefined;
  if (tenantId === undefined && clientId === undefined) return undefined;
  if (tenantId === undefined || clientId === undefined) {
    fail("Set both CLAUSEWISE_ENTRA_TENANT_ID and CLAUSEWISE_ENTRA_CLIENT_ID, or neither.");
  }
  try {
    return checkEntraConfig({ tenantId, clientId });
  } catch (error) {
    return fail((error as Error).message);
  }
}

async function runLocal(): Promise<void> {
  const entra = readLocalEntra();
  const config = loadLlmConfig(process.env);
  const generator = createObjectGenerator(config);
  const server = await startLocal({
    playbooksDir,
    generator,
    limits: {
      concurrency: config.concurrency,
      ...(config.maxContextTokens === undefined
        ? {}
        : { maxContextTokens: config.maxContextTokens }),
    },
    port,
    ...(entra === undefined
      ? {}
      : {
          entra: {
            ...entra,
            // The reason is a fixed code; the token itself is never printed.
            options: {
              onReject: (reason) => process.stderr.write(`sign-in refused: ${reason}\n`),
            },
          },
        }),
    onError,
  });

  process.stderr.write(`Sending the contract text to: ${generator.disclosure}\n`);
  // Entra ID accepts a plain-http redirect address only for localhost, so that is the address to
  // open, and the one to register for the page.
  const pageUrl = `http://localhost:${new URL(server.url).port}/`;
  process.stderr.write(`Clausewise is running on this machine only. Open ${pageUrl}\n`);
  process.stderr.write(
    entra === undefined
      ? "Sign-in: none beyond being on this machine.\n"
      : `Sign-in: Entra ID access tokens for app ${entra.clientId} in tenant ${entra.tenantId}.\n`,
  );
  process.stderr.write("Everything is kept in memory and is gone when this process stops.\n");
  stopOn(server.close);
}

await (mode === "azure" ? runAzure() : runLocal());
