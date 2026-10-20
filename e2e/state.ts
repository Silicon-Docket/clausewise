import { readFileSync } from "node:fs";

/** What a test needs to know about one running server. */
export interface ServerInfo {
  name: string;
  url: string;
  dataDir: string;
  logFile: string;
  accessToken: string | undefined;
}

/** The servers the global setup started, by name. */
export type ServerName = "main" | "token" | "rejected-key" | "unconfigured";

export type RunState = Record<ServerName, ServerInfo>;

/**
 * The global setup runs in the process that runs Playwright, and the tests run in workers. The
 * setup writes this file and tells the workers where it is through the environment, which they
 * inherit because they are started after it.
 */
export const STATE_FILE_VARIABLE = "CLAUSEWISE_E2E_STATE";

let cached: RunState | undefined;

export function readRunState(): RunState {
  if (cached !== undefined) return cached;
  const path = process.env[STATE_FILE_VARIABLE];
  if (path === undefined || path === "") {
    throw new Error(
      `${STATE_FILE_VARIABLE} is not set, so the servers of this run are not known. Run the tests with Playwright and the configuration in e2e/playwright.config.ts (pnpm e2e).`,
    );
  }
  cached = JSON.parse(readFileSync(path, "utf8")) as RunState;
  return cached;
}
