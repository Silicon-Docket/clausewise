import { fileURLToPath } from "node:url";
import { SettingsError } from "@clausewise/azure";
import { LlmConfigError } from "@clausewise/llm";
import { startAzureWorker } from "./worker.js";

let worker;
try {
  worker = startAzureWorker({
    env: process.env,
    playbooksDir: fileURLToPath(new URL("../../../playbooks/", import.meta.url)),
    onOutcome: (reviewId, outcome) => process.stderr.write(`review ${reviewId}: ${outcome}\n`),
    // Only the kind of error is printed: a message could carry an address or a fragment of text.
    onError: (reviewId, error) =>
      process.stderr.write(
        `review ${reviewId || "(none)"}: ${error instanceof Error ? error.name : "unknown"}\n`,
      ),
    onInvalidJob: () => process.stderr.write("removed a queue message that was not a review job\n"),
  });
} catch (error) {
  if (error instanceof SettingsError || error instanceof LlmConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

process.stderr.write(`Sending the contract text to: ${worker.disclosure}\n`);
process.stderr.write("Clausewise worker is taking review jobs.\n");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void worker.stop().then(() => process.exit(0));
  });
}
