import { appendFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ObjectGenerator } from "../packages/llm/src/index.js";
import { createLogger } from "../apps/server/src/log.js";
import { readConfig, startServer, type RunningServer } from "../apps/server/src/start.js";
import { createFixtureOracle, createRejectedKeyGenerator } from "./oracle.js";
import { PLAYBOOKS_DIR, WEB_DIR } from "./paths.js";

/**
 * Which model a test server has.
 *
 * - `oracle`: the scripted oracle of the evaluation harness, built from fixtures/expected.json.
 * - `rejected-key`: a provider that answers every call with HTTP 401.
 * - `unconfigured`: no model at all, as when no API key is set.
 */
export type E2eModel = "oracle" | "rejected-key" | "unconfigured";

export interface E2eServerOptions {
  /** A short name, used for the folder and the log file of this server. */
  name: string;
  /** A folder that exists, for this run. The data folder and the log file are made inside it. */
  runDir: string;
  model: E2eModel;
  /** Makes the server demand `Authorization: Bearer <token>` on its API. At least 16 characters. */
  accessToken?: string;
  /** Where the built web app is. Default: apps/web/dist. */
  webDir?: string;
}

export interface E2eServer {
  name: string;
  /** The address a browser opens, with the port the server was given. */
  url: string;
  dataDir: string;
  /** Every line the server logged, one JSON object per line. */
  logFile: string;
  accessToken: string | undefined;
  /** Stops the server, closes its database and releases the lock on its data folder. */
  close(): Promise<void>;
}

async function generatorFor(model: E2eModel): Promise<ObjectGenerator | undefined> {
  switch (model) {
    case "oracle":
      return createFixtureOracle();
    case "rejected-key":
      return createRejectedKeyGenerator();
    case "unconfigured":
      return undefined;
  }
}

/**
 * Starts a real Clausewise server: the production `startServer`, on a free port of the loopback
 * interface, with an embedded database and a fresh data folder, the repository's own playbooks and
 * the built web app. The only part that is not the real one is the model, which the caller chooses
 * from a short list. Nothing in the environment of the running process reaches the server: the
 * settings are written out here, so that a key in the shell of whoever runs the tests is never
 * used and never needed.
 */
export async function startE2eServer(options: E2eServerOptions): Promise<E2eServer> {
  const { name, runDir, model, accessToken } = options;
  const dataDir = join(runDir, name, "data");
  const logFile = join(runDir, name, "server.log");
  await mkdir(dataDir, { recursive: true });

  const env: Record<string, string> = {
    HOST: "127.0.0.1",
    // Port 0: the system picks a free one, so several runs can share a machine.
    PORT: "0",
    CLAUSEWISE_DATA_DIR: dataDir,
    CLAUSEWISE_PLAYBOOKS_DIR: PLAYBOOKS_DIR,
    CLAUSEWISE_WEB_DIR: options.webDir ?? WEB_DIR,
    ...(accessToken === undefined ? {} : { CLAUSEWISE_ACCESS_TOKEN: accessToken }),
  };
  const generator = await generatorFor(model);

  const running: RunningServer = await startServer({
    config: readConfig(env),
    log: createLogger((line) => appendFileSync(logFile, `${line}\n`, { mode: 0o600 })),
    // An unconfigured server reads its model settings from this empty environment, not from the
    // shell, so it is unconfigured whatever keys the shell holds.
    env: {},
    ...(generator === undefined ? {} : { generator }),
  });

  return {
    name,
    url: running.url,
    dataDir,
    logFile,
    accessToken,
    close: () => running.close(),
  };
}
