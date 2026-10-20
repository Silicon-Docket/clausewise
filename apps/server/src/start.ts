import { Server } from "node:http";
import { join } from "node:path";
import type { ObjectGenerator } from "@clausewise/llm";
import { createAdaptorServer } from "@hono/node-server";
import pkg from "../package.json" with { type: "json" };
import { createApp } from "./app.js";
import { isLoopbackHost, type ServerConfig } from "./config.js";
import { openDatabase, type DatabaseTarget } from "./db/client.js";
import { applyMigrations } from "./db/migrate.js";
import { randomIds, systemClock, type Clock, type IdSource, type ModelSetup } from "./deps.js";
import { createJobRunner } from "./jobs.js";
import { createLogger, type Logger } from "./log.js";
import { modelFromEnv } from "./model.js";
import { createPlaybookStore } from "./playbooks.js";
import { createFileStorage, type DocumentStorage } from "./storage.js";

// What a script that starts the server needs to build its options: the checked settings, from an
// environment-like object, without touching the real environment.
export { readConfig, ConfigError, type ServerConfig } from "./config.js";

export interface StartOptions {
  config: ServerConfig;
  /**
   * A model to use instead of the one the environment describes. The test suite and the end to
   * end script pass a scripted one here; the server itself has no switch that fakes a model.
   */
  generator?: ObjectGenerator;
  /** Where the model settings are read from when no generator is given. Default: process.env. */
  env?: Record<string, string | undefined>;
  log?: Logger;
  clock?: Clock;
  ids?: IdSource;
  /** Replaces the database the configuration names, such as an in-memory one for a test. */
  database?: DatabaseTarget;
  /** Replaces the folder of stored documents, which is `<dataDir>/documents`. */
  storage?: DocumentStorage;
  /** Replaces the folder of migration files found next to the server. */
  migrationsFolder?: string;
}

export interface RunningServer {
  /** The address in a URL that reaches the server, with the port that was bound. */
  url: string;
  port: number;
  /** Aborts running reviews (they end as cancelled), closes the listener, then the database. */
  close(): Promise<void>;
}

// A connection that is still open this long after close() began is cut. Idle ones go at once.
const CLOSE_GRACE_MS = 2000;

function describeModel(log: Logger, model: ModelSetup): void {
  if ("generator" in model) {
    log.info("Model", {
      provider: model.generator.provider,
      model: model.generator.model,
      disclosure: `Reviews are sent to: ${model.generator.disclosure}`,
    });
  } else {
    log.warn(`The model is not configured, so reviews cannot run. ${model.problem}`);
  }
}

/**
 * The address a person opens to reach a server bound to `host`. An address that means "every
 * interface" is no place to browse to, so it is shown as localhost, and an IPv6 address is put
 * in brackets.
 */
export function serverUrl(host: string, port: number): string {
  if (host === "0.0.0.0" || host === "::") return `http://localhost:${port}`;
  const shown = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${shown}:${port}`;
}

/** Opens the database, migrates it, recovers reviews, starts the runner, and listens. */
export async function startServer(options: StartOptions): Promise<RunningServer> {
  const { config } = options;
  const log = options.log ?? createLogger();
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? randomIds;

  const target: DatabaseTarget =
    options.database ??
    (config.databaseUrl === undefined
      ? { kind: "pglite", dataDir: config.dataDir }
      : { kind: "postgres", url: config.databaseUrl });
  const database = await openDatabase(target, (error) =>
    log.error("the database connection failed", error),
  );

  let runnerStop: () => Promise<void> = async () => {};
  try {
    await applyMigrations(database, options.migrationsFolder);
    const storage = options.storage ?? (await createFileStorage(join(config.dataDir, "documents")));
    const model: ModelSetup =
      options.generator === undefined
        ? modelFromEnv(options.env ?? process.env)
        : { generator: options.generator, limits: {} };

    const playbooks = createPlaybookStore({
      db: database.db,
      dir: config.playbooksDir,
      clock,
      ids,
      log,
    });
    const runner = createJobRunner({ db: database.db, storage, model, config, clock, log });
    runnerStop = () => runner.stop();
    const app = createApp({
      db: database.db,
      storage,
      model,
      config,
      clock,
      ids,
      log,
      playbooks,
      runner,
      version: pkg.version,
    });

    // Before the first request is answered: a review that was running when the last process
    // stopped is finished business, and a new one could be mistaken for it.
    await runner.start();

    const server = createAdaptorServer({ fetch: app.fetch });
    // Without TLS or HTTP/2 options the adapter makes a plain HTTP/1.1 server.
    if (!(server instanceof Server)) throw new Error("The HTTP server could not be created.");
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : config.port;
    const url = serverUrl(config.host, port);

    describeModel(log, model);
    if (!isLoopbackHost(config.host) && config.accessToken === undefined) {
      log.warn(
        `Listening on ${config.host} without an access token: anyone who can reach this address can read and delete every contract in it. Set CLAUSEWISE_ACCESS_TOKEN, or listen on 127.0.0.1 and put something that signs people in in front.`,
      );
    }
    // Last, so that whoever waits for this line has seen the others.
    log.info("Clausewise is running", { url, database: database.kind, version: pkg.version });

    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closing ??= (async () => {
        await runner.stop();
        await new Promise<void>((resolve) => {
          const cut = setTimeout(() => server.closeAllConnections(), CLOSE_GRACE_MS);
          server.close(() => {
            clearTimeout(cut);
            resolve();
          });
          server.closeIdleConnections();
        });
        await database.close();
      })();
      return closing;
    };
    return { url, port, close };
  } catch (error) {
    await runnerStop().catch(() => {});
    await database.close().catch(() => {});
    throw error;
  }
}
