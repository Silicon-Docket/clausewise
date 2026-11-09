import { fileURLToPath } from "node:url";
import { createObjectGenerator, loadLlmConfig } from "@clausewise/llm";
import { checkEntraConfig, type EntraConfig } from "./entra.js";
import { startLocal } from "./local.js";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// Every mode but local serves people on other machines and keeps their contracts, and the Azure
// storage that needs is not built yet (docs/azure-in-tenant.md, phase 1). Until it is, the server
// refuses to pretend.
const mode = process.env.CLAUSEWISE_WEB_MODE ?? "local";
if (mode !== "local") {
  fail(
    `CLAUSEWISE_WEB_MODE=${mode} is not available yet: Entra ID sign-in is built, but the Azure ` +
      "storage it would keep contracts in is not, so only local mode runs.",
  );
}

// Both ids or neither: one alone is a mistake, not a choice.
function readEntra(): EntraConfig | undefined {
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

const entra = readEntra();

const rawPort = process.env.PORT;
const port = rawPort === undefined ? 8787 : Number(rawPort);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write("PORT must be a whole number from 0 to 65535.\n");
  process.exit(1);
}

const config = loadLlmConfig(process.env);
const generator = createObjectGenerator(config);
const server = await startLocal({
  playbooksDir: fileURLToPath(new URL("../../../playbooks/", import.meta.url)),
  generator,
  limits: {
    concurrency: config.concurrency,
    ...(config.maxContextTokens === undefined ? {} : { maxContextTokens: config.maxContextTokens }),
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
  // Only the kind of error is printed: a message could quote a request.
  onError: (error) =>
    process.stderr.write(`error: ${error instanceof Error ? error.name : "unknown"}\n`),
});

process.stderr.write(`Sending the contract text to: ${generator.disclosure}\n`);
process.stderr.write(`Clausewise is running on this machine only, at ${server.url}\n`);
process.stderr.write(
  entra === undefined
    ? "Sign-in: none beyond being on this machine.\n"
    : `Sign-in: Entra ID access tokens for app ${entra.clientId} in tenant ${entra.tenantId}.\n`,
);
process.stderr.write("Everything is kept in memory and is gone when this process stops.\n");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
