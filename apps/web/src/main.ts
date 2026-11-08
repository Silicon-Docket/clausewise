import { fileURLToPath } from "node:url";
import { createObjectGenerator, loadLlmConfig } from "@clausewise/llm";
import { startLocal } from "./local.js";

// Every mode but local serves people on other machines, and that needs Entra ID sign-in, which is
// the next part of phase 1 (docs/azure-in-tenant.md). Until then the server refuses to pretend.
const mode = process.env.CLAUSEWISE_WEB_MODE ?? "local";
if (mode !== "local") {
  process.stderr.write(
    `CLAUSEWISE_WEB_MODE=${mode} is not available yet: only local mode exists until Entra ID ` +
      "sign-in is built.\n",
  );
  process.exit(1);
}

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
  // Only the kind of error is printed: a message could quote a request.
  onError: (error) =>
    process.stderr.write(`error: ${error instanceof Error ? error.name : "unknown"}\n`),
});

process.stderr.write(`Sending the contract text to: ${generator.disclosure}\n`);
process.stderr.write(`Clausewise is running on this machine only, at ${server.url}\n`);
process.stderr.write("Everything is kept in memory and is gone when this process stops.\n");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
