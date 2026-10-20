import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { afterEach } from "vitest";
import { root } from "./support.js";

// Starting tsx takes a second or two, and a loaded machine takes longer.
export const TIMEOUT = 90_000;

// No key of any kind: the child must not inherit one from the machine running the tests.
export const BASE_ENV: Record<string, string> = {
  PATH: process.env["PATH"] ?? "",
  HOME: process.env["HOME"] ?? tmpdir(),
  NO_UPDATE_NOTIFIER: "1",
};

export interface Outcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

const started: ChildProcess[] = [];
const listening: Server[] = [];

/** Call once in a test file: stops what the file started, and only that. */
export function cleanUpChildren(): void {
  afterEach(() => {
    for (const child of started.splice(0)) child.kill("SIGKILL");
    for (const server of listening.splice(0)) {
      server.closeAllConnections();
      server.close();
    }
  });
}

export function start(
  command: string,
  args: string[],
  env: Record<string, string>,
  options: { cwd?: string } = {},
) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  started.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const done = new Promise<Outcome>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done, stderr: () => stderr };
}

/** The real command, started through tsx the way `pnpm clausewise` does. */
export const cli = (args: string[], env: Record<string, string> = BASE_ENV) =>
  start("pnpm", ["tsx", "apps/cli/src/bin.ts", ...args], env).done;

/** What a model that follows the OpenAI chat protocol answers: the same finding for every rule. */
export type Verdict = "compliant" | "deviation";

export async function fakeModelServer(
  verdict: Verdict,
): Promise<{ port: number; requests: () => number }> {
  let requests = 0;
  const answer = JSON.stringify({
    status: verdict,
    clauseIds: ["c1"],
    explanation: verdict === "compliant" ? "Meets the standard." : "Falls short of the standard.",
    comment: verdict === "compliant" ? "" : "Please change this.",
    edit: null,
    suggestedClause: null,
  });
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests += 1;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 1,
          model: "test-model",
          choices: [
            { index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
  });
  listening.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, requests: () => requests };
}

/** The environment that points the real command at a server on this machine. */
export const modelEnv = (port: number): Record<string, string> => ({
  ...BASE_ENV,
  CLAUSEWISE_PROVIDER: "openai-compatible",
  CLAUSEWISE_MODEL: "test-model",
  CLAUSEWISE_BASE_URL: `http://127.0.0.1:${port}/v1`,
  CLAUSEWISE_MAX_RETRIES: "0",
});
