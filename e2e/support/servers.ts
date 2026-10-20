import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectGenerator } from "../../packages/llm/src/index.js";
import { createLogger } from "../../apps/server/src/log.js";
import { readConfig, startServer, type RunningServer } from "../../apps/server/src/start.js";
import { createFixtureOracle } from "../oracle.js";
import { PLAYBOOKS_DIR, WEB_DIR } from "../paths.js";

/**
 * Servers that one test owns, for the scenarios that need something the shared servers of the run
 * do not give: a model scripted for one contract, a port to come back to, a data folder to look at
 * before and after. They are the production `startServer`, like the shared ones; only the model is
 * the caller's.
 */

export interface OwnServerOptions {
  /** A folder that exists. The data folder and the log file are made inside it. */
  dir: string;
  /** The model: the oracle of the fixtures (default), a generator of the caller's, or none. */
  model?: "oracle" | "none" | ObjectGenerator;
  accessToken?: string;
  /** The port to listen on. Default: a free one, chosen by the system. */
  port?: number;
  allowedHosts?: string[];
  maxUploadMb?: number;
  /** Where the web app is. Default: apps/web/dist. */
  webDir?: string;
}

export interface OwnServer {
  /** The address a browser opens. */
  url: string;
  port: number;
  dataDir: string;
  /** Every line this server (and any later one on the same folder) logged, one JSON object each. */
  logFile: string;
  accessToken: string | undefined;
  close(): Promise<void>;
}

export interface LogLine {
  time: string;
  level: string;
  msg: string;
  method?: string;
  route?: string;
  status?: number;
  [key: string]: unknown;
}

/** Starts a server. The log is appended to, so a restart on the same folder keeps one history. */
export async function startOwnServer(options: OwnServerOptions): Promise<OwnServer> {
  const dataDir = join(options.dir, "data");
  const logFile = join(options.dir, "server.log");
  await mkdir(dataDir, { recursive: true });

  const env: Record<string, string> = {
    HOST: "127.0.0.1",
    // Port 0 asks the system for a free one.
    PORT: String(options.port ?? 0),
    CLAUSEWISE_DATA_DIR: dataDir,
    CLAUSEWISE_PLAYBOOKS_DIR: PLAYBOOKS_DIR,
    CLAUSEWISE_WEB_DIR: options.webDir ?? WEB_DIR,
    ...(options.accessToken === undefined ? {} : { CLAUSEWISE_ACCESS_TOKEN: options.accessToken }),
    ...(options.allowedHosts === undefined
      ? {}
      : { CLAUSEWISE_ALLOWED_HOSTS: options.allowedHosts.join(",") }),
    ...(options.maxUploadMb === undefined
      ? {}
      : { CLAUSEWISE_MAX_UPLOAD_MB: String(options.maxUploadMb) }),
  };
  const model = options.model ?? "oracle";
  const generator =
    model === "oracle" ? await createFixtureOracle() : model === "none" ? undefined : model;

  const running: RunningServer = await startServer({
    config: readConfig(env),
    log: createLogger((line) => appendFileSync(logFile, `${line}\n`, { mode: 0o600 })),
    // The settings of the shell never reach the server, so a key in the environment of whoever
    // runs the tests is neither used nor needed.
    env: {},
    ...(generator === undefined ? {} : { generator }),
  });
  return {
    url: running.url,
    port: running.port,
    dataDir,
    logFile,
    accessToken: options.accessToken,
    close: () => running.close(),
  };
}

/**
 * Starts the same server again on the port and the data folder of one that was closed, which is
 * what a restart of the process is. The port was given by the system to the first one, and nothing
 * has had a reason to take it since; if something did, the error says so instead of the test
 * passing against another address.
 */
export async function restartOwnServer(
  previous: OwnServer,
  options: Omit<OwnServerOptions, "dir" | "port" | "accessToken"> & {
    /** A new token, for a server whose owner changed it. Default: the one it had. */
    accessToken?: string;
  },
  dir: string,
): Promise<OwnServer> {
  let lastError: unknown;
  const accessToken = options.accessToken ?? previous.accessToken;
  // A closed listener frees its port at once, but a socket in the middle of closing can hold it for
  // a moment on some systems.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await startOwnServer({
        ...options,
        dir,
        port: previous.port,
        ...(accessToken === undefined ? {} : { accessToken }),
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(
    `The server could not listen on port ${previous.port} again: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/** A folder for one test, under the system's temporary folder. Remove it with `scratch.remove()`. */
export async function makeScratch(
  prefix: string,
): Promise<{ dir: string; remove(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), `clausewise-e2e-${prefix}-`));
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
}

/** The lines a server logged, oldest first. A line that is not JSON is an error. */
export async function readLog(logFile: string): Promise<LogLine[]> {
  const text = await readFile(logFile, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as LogLine);
}

/** The requests in a log, as "METHOD route status". */
export function requestsOf(lines: LogLine[]): string[] {
  return lines
    .filter((line) => line.msg === "request")
    .map((line) => `${line.method ?? "?"} ${line.route ?? "?"} ${line.status ?? "?"}`);
}
