import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const USAGE_HINT = 'Run "clausewise --help" for usage.';

export const USAGE = `Clausewise: review a Word contract against a playbook and get the suggested edits
back as tracked changes and comments.

Usage:
  clausewise review <contract.docx> --playbook <file.yaml> [options]
  clausewise playbook check <file.yaml>
  clausewise --help
  clausewise --version

Review options:
  --playbook <file>     The YAML playbook to review against. Required.
  --out <file>          The redlined contract. Default: <contract>.redlined.docx next to the input.
  --report <file>       The full report as JSON. Default: <contract>.report.json next to the input.
  --summary <file>      The report as Markdown. Default: <contract>.summary.md next to the input.
  --author <name>       The author shown on tracked changes and comments. Default: Clausewise.
  --fail-on <severity>  Exit with code 2 when a deviation or a missing clause is found at this
                        severity or above: high, medium or low.
  --force               Replace output files that already exist. The input file is never replaced.
  --quiet               Do not print progress.
  -h, --help            Show this help.

The playbook check command validates a playbook and lists its rules, without calling any model.

Exit codes:
  0    The review finished (or, for playbook check, the playbook is valid).
  1    Something went wrong. No output files are written when a review fails.
  2    --fail-on was set and an open item at or above that severity was found.
  130  Interrupted with Ctrl-C. No output files are written.

Where your contract goes:
  The contract text is sent to the model provider you configure below, and nowhere else. There
  is no telemetry and no hosted service. Before every review, Clausewise prints where the text is
  being sent. To keep it on your machine, point CLAUSEWISE_PROVIDER=openai-compatible at a local
  server such as Ollama.

Environment variables:
  CLAUSEWISE_PROVIDER             anthropic (default), openai or openai-compatible.
  CLAUSEWISE_MODEL                The model name. Required unless the provider is anthropic.
  ANTHROPIC_API_KEY               Your Anthropic API key. Required for the anthropic provider.
  OPENAI_API_KEY                  Your OpenAI API key. Required for the openai provider.
  CLAUSEWISE_API_KEY              The key for an openai-compatible server. Optional.
  CLAUSEWISE_BASE_URL             The API root. Required for openai-compatible, optional otherwise.
  CLAUSEWISE_MAX_OUTPUT_TOKENS    Most tokens in one model response. Default 16000.
  CLAUSEWISE_EFFORT               Anthropic only: low, medium, high, xhigh or max.
  CLAUSEWISE_CONCURRENCY          How many rule checks run at once. Default 4.
  CLAUSEWISE_MAX_CONTEXT_TOKENS   Largest prompt, in estimated tokens. Longer contracts are reviewed
                                  in overlapping windows. Default: the whole contract every time.
  CLAUSEWISE_MAX_RETRIES          Retries after a network error or an unusable reply. Default 2.
  CLAUSEWISE_FALLBACK             Anthropic only: "default" lets the API rerun a declined request
                                  on its fallback model. Off unless set.

Findings are suggestions for a lawyer to review. They are not legal advice.
`;

const PackageJson = z.object({ version: z.string().min(1) });

export async function readVersion(): Promise<string> {
  const path = fileURLToPath(new URL("../package.json", import.meta.url));
  return PackageJson.parse(JSON.parse(await readFile(path, "utf8"))).version;
}
