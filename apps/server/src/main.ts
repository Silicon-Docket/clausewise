import { readConfig } from "./config.js";
import { startServer } from "./start.js";

// The only place that reads the process environment and the only one that exits the process.
async function main(): Promise<void> {
  const config = readConfig(process.env);
  const server = await startServer({ config, env: process.env });

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`${JSON.stringify({ level: "info", msg: `Stopping on ${signal}` })}\n`);
    server.close().then(
      () => process.exit(0),
      (error: unknown) => {
        const reason = error instanceof Error ? error.message : "unknown error";
        process.stderr.write(`Clausewise did not stop cleanly: ${reason}\n`);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : "unknown error";
  process.stderr.write(`Clausewise could not start: ${reason}\n`);
  process.exit(1);
});
