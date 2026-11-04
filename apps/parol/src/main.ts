import { randomBytes } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getRequestListener, type ServerType } from "@hono/node-server";
import {
  createObjectGenerator,
  loadLlmConfig,
  type GenerateObjectRequest,
  type ObjectGenerator,
} from "@clausewise/llm";
import { createScriptedGenerator } from "@clausewise/llm/testing";
import type { Hono } from "hono";
import { CATEGORY_IDS } from "./contracts.js";
import { createApp } from "./server/app.js";
import { renderErrorPage } from "./server/pages/error.js";
import type { AppConfig, AppDeps } from "./server/deps.js";
import { rejectedRequestHandler } from "./server/middleware/rejected.js";
import { FileStore, createRepository, openDatabase, type Repository } from "./store/index.js";

/**
 * Starting the server. `parseEnv` turns the environment into settings and refuses the unsafe
 * combinations; `start` builds everything and listens; `main` is `start` plus a clean stop on
 * SIGINT and SIGTERM. `pnpm parol` runs this file.
 *
 * Nothing here reads a request, so messages may name what is wrong with the settings, but they
 * still never print a value: a mistyped variable can hold a secret.
 */

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

export interface ParolSettings {
  /** The demo identity (docs/parol/06). Binds to loopback only. */
  demoIdentity: boolean;
  dataDir: string;
  port: number;
  host: string;
  cookieSecret: string;
  /** True when the secret was made for this start because none was given. */
  cookieSecretGenerated: boolean;
  /** Use the built-in stand-in model, which calls nothing. */
  scripted: boolean;
  /** The deployment is https, so cookies are marked Secure. */
  secureCookies: boolean;
  /** Single-person demo: one user may prepare and review, and the memo says so. */
  relaxedSegregation: boolean;
  maxUploadBytes: number;
  /** Things the operator should know before the server starts. */
  warnings: string[];
}

/** The environment is wrong. The message names the variable and the fix, never a value. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

export const DEFAULT_PORT = 8787;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_DATA_DIR = "./data/parol";
/** The size of the largest file the parsers accept. */
export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MIN_COOKIE_SECRET_LENGTH = 32;
const MAX_UPLOAD_CEILING = 100 * 1024 * 1024;

/** Addresses that only this machine can reach. The demo identity may bind to nothing else. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "localhost"]);

type Env = Record<string, string | undefined>;

const read = (env: Env, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
};

function readFlag(env: Env, name: string): boolean {
  const value = read(env, name)?.toLowerCase();
  if (value === undefined || value === "0" || value === "false" || value === "no") return false;
  if (value === "1" || value === "true" || value === "yes") return true;
  throw new ConfigError(`${name} must be 1 or 0. Fix the value, or unset it.`);
}

function readInteger(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = read(env, name);
  if (raw === undefined) return fallback;
  const value = /^\d{1,12}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new ConfigError(
      `${name} must be a whole number from ${min} to ${max}. Fix the value, or unset it.`,
    );
  return value;
}

const randomSecret = (): string => randomBytes(32).toString("base64url");

/**
 * Reads the environment. Pure apart from the random secret, which can be supplied. Throws
 * `ConfigError` for a value that is not usable, and for the one combination that must never run:
 * the demo identity (anyone can be anyone) on an address other machines can reach.
 */
export function parseEnv(env: Env, newSecret: () => string = randomSecret): ParolSettings {
  const warnings: string[] = [];
  const demoIdentity = readFlag(env, "PAROL_DEMO_IDENTITY");
  const host = (read(env, "PAROL_HOST") ?? DEFAULT_HOST).toLowerCase();
  if (demoIdentity && !LOOPBACK_HOSTS.has(host))
    throw new ConfigError(
      "PAROL_DEMO_IDENTITY has no passwords, so the server must listen on this machine only. " +
        "Set PAROL_HOST to 127.0.0.1, ::1 or localhost, or turn the demo identity off.",
    );
  if (!demoIdentity)
    warnings.push(
      "PAROL_DEMO_IDENTITY is not set, so there is no way to sign in. Set it to 1 for the demonstration.",
    );

  const port = readInteger(env, "PAROL_PORT", DEFAULT_PORT, 0, 65535);
  const maxUploadBytes = readInteger(
    env,
    "PAROL_MAX_UPLOAD_BYTES",
    DEFAULT_MAX_UPLOAD_BYTES,
    1024,
    MAX_UPLOAD_CEILING,
  );

  const given = read(env, "PAROL_COOKIE_SECRET");
  if (given !== undefined && given.length < MIN_COOKIE_SECRET_LENGTH)
    throw new ConfigError(
      `PAROL_COOKIE_SECRET must be at least ${MIN_COOKIE_SECRET_LENGTH} characters. ` +
        "Use a long random value, or unset it to make one for each start.",
    );
  const cookieSecret = given ?? newSecret();
  if (given === undefined)
    warnings.push(
      "PAROL_COOKIE_SECRET is not set. A random secret is used for this run, so everyone is signed out whenever the server restarts.",
    );

  return {
    demoIdentity,
    dataDir: resolve(read(env, "PAROL_DATA_DIR") ?? DEFAULT_DATA_DIR),
    port,
    host,
    cookieSecret,
    cookieSecretGenerated: given === undefined,
    scripted: readFlag(env, "PAROL_SCRIPTED"),
    secureCookies: readFlag(env, "PAROL_SECURE_COOKIES"),
    relaxedSegregation: readFlag(env, "PAROL_RELAXED_SEGREGATION"),
    maxUploadBytes,
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// The stand-in model
// ---------------------------------------------------------------------------------------------

/**
 * A model that calls nothing and reviews nothing. It lets the whole application run, with every
 * rule coming out `undetermined` and escalated, when there is no key. It is a way to see the
 * screens, not a review, and its disclosure says so.
 */
export function scriptedStandIn(): ObjectGenerator {
  const answer = (request: GenerateObjectRequest<unknown>): unknown => {
    switch (request.schemaName) {
      case "locate_passages":
        return {
          categories: CATEGORY_IDS.map((category) => ({
            category,
            passages: [],
            notFoundReason: "The built-in stand-in model does not read documents.",
          })),
        };
      case "analyze_rule":
        return {
          status: "undetermined",
          evidence: [],
          discrepancy: "",
          explanation: "The built-in stand-in model does not review documents.",
          fallbackLanguage: null,
          escalateWhenMatched: [],
          conflict: null,
          abstainReason: "The built-in stand-in model does not review documents.",
        };
      case "check_support":
        return {
          verdict: "insufficient",
          missingPremise: "The built-in stand-in model checks nothing.",
        };
      default:
        throw new Error("the built-in stand-in model does not know this request");
    }
  };
  return createScriptedGenerator(answer, {
    provider: "scripted",
    model: "parol-stand-in",
    disclosure: "a built-in stand-in model (PAROL_SCRIPTED): nothing is sent anywhere",
  });
}

// ---------------------------------------------------------------------------------------------
// Start and stop
// ---------------------------------------------------------------------------------------------

/** A module the server needs is not there, or the start-up cannot go on. The message is for the operator. */
export class StartupError extends Error {
  override name = "StartupError";
}

/**
 * Loads one of the modules the server is built from. When that very module is missing the error
 * says so; a failure inside it, or a missing dependency of its own, is passed on as it is.
 */
export async function requireModule<T>(load: () => Promise<T>, what: string): Promise<T> {
  try {
    return await load();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      // The quoted name is what could not be found; the file that asked for it comes after.
      const target = /Cannot find (?:module|package) '([^']+)'/.exec(
        String((error as Error).message),
      )?.[1];
      if (target !== undefined && target.replace(/\.(?:js|ts)$/, "").endsWith(what))
        throw new StartupError(`Parol cannot start: the module ${what} is missing.`);
    }
    throw error;
  }
}

export interface StartOptions {
  /** Replaces the model, for tests that run the server for real. */
  generator?: ObjectGenerator;
  /** Where the access log and the service lines go. Default: standard output. */
  log?: (line: string) => void;
  /** Where start-up notices go. Default: standard error. */
  notice?: (line: string) => void;
}

export interface RunningServer {
  app: Hono;
  server: ServerType;
  settings: ParolSettings;
  repo: Repository;
  /** The port actually bound, which differs from the setting when that was 0. */
  port: number;
  /**
   * Stops accepting requests, lets those in flight finish, waits for the runs still working, and
   * closes the database. Safe to call more than once.
   */
  close(): Promise<void>;
}

const stdout = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const stderr = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

export async function start(
  env: Env = process.env,
  options: StartOptions = {},
): Promise<RunningServer> {
  const log = options.log ?? stdout;
  const notice = options.notice ?? stderr;
  const settings = parseEnv(env);
  for (const warning of settings.warnings) notice(`warning: ${warning}`);

  // The model is chosen first, so a missing key stops the start before anything is opened.
  const generator =
    options.generator ??
    (settings.scripted ? scriptedStandIn() : createObjectGenerator(loadLlmConfig(env)));
  notice(`Document text is sent to: ${generator.disclosure}`);

  const { createServices } = await requireModule(
    () => import("./services/index.js"),
    "services/index",
  );
  const { registerAll, markInterruptedRuns, sweepOrphanFiles } = await requireModule(
    () => import("./boot/register.js"),
    "boot/register",
  );

  mkdirSync(settings.dataDir, { recursive: true, mode: 0o700 });
  const db = openDatabase(join(settings.dataDir, "parol.sqlite"));
  const repo = createRepository(db);
  const files = new FileStore(join(settings.dataDir, "matters"));

  // The demonstration playbook is imported and approved by the demo users, so they exist whether
  // or not signing in as one is switched on.
  registerAll(repo, { seedDemoUsers: true });
  markInterruptedRuns(repo, log);
  sweepOrphanFiles(repo, files, log);

  const now = (): Date => new Date();
  const services = createServices({
    repo,
    files,
    generator,
    config: { relaxedSegregation: settings.relaxedSegregation },
    now,
    log,
  });
  const config: AppConfig = {
    demoIdentity: settings.demoIdentity,
    cookieSecret: settings.cookieSecret,
    secureCookies: settings.secureCookies,
    maxUploadBytes: settings.maxUploadBytes,
    relaxedSegregation: settings.relaxedSegregation,
  };
  const deps: AppDeps = { repo, services, config, now };
  const app = createApp(deps, { log, renderError: renderErrorPage });

  // The page and API routes are a module of their own. Until it exists the server serves the
  // shell only (health check, sign-in, static files), and says so.
  const routes = await optionalRoutes();
  if (routes === null)
    notice("notice: the page and API routes are not installed; serving the shell only");
  else routes(app, deps);

  const server = await listen(app, settings, log);
  const bound = (server.address() as AddressInfo | null)?.port ?? settings.port;
  notice(
    `Parol is listening on http://${settings.host.includes(":") ? `[${settings.host}]` : settings.host}:${bound}`,
  );

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      await new Promise<void>((done) => {
        const idle = (server as { closeIdleConnections?: () => void }).closeIdleConnections;
        // A connection kept open for the next request would hold the stop until its keep-alive
        // timer ran out. Those in use are left alone, and swept as each one finishes.
        const sweep = setInterval(() => idle?.call(server), 50);
        server.close(() => {
          clearInterval(sweep);
          done();
        });
        idle?.call(server);
      });
      await services.runs.idle();
      db.close();
    })());

  return { app, server, settings, repo, port: bound, close };
}

type RouteInstaller = (app: Hono, deps: AppDeps) => void;

async function optionalRoutes(): Promise<RouteInstaller | null> {
  // A variable, so the compiler does not require the module to exist.
  const specifier = "./server/routes/index.js";
  try {
    const module = (await import(specifier)) as { registerRoutes?: RouteInstaller };
    return typeof module.registerRoutes === "function" ? module.registerRoutes : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      const target = /Cannot find (?:module|package) '([^']+)'/.exec(
        String((error as Error).message),
      )?.[1];
      if (
        target !== undefined &&
        target.replace(/\.(?:js|ts)$/, "").endsWith("server/routes/index")
      )
        return null;
    }
    throw error;
  }
}

/**
 * Serves the application with @hono/node-server. `serve` is not used because it takes no error
 * handler, and the adapter's own answer to a request it cannot read (a bad Host header, a
 * backslash in the path) is a bare 400 with none of the headers every other response carries.
 */
function listen(
  app: Hono,
  settings: ParolSettings,
  log: (line: string) => void,
): Promise<ServerType> {
  return new Promise((resolveListening, reject) => {
    const listener = getRequestListener(app.fetch, {
      hostname: settings.host,
      errorHandler: rejectedRequestHandler({ log, https: settings.secureCookies }),
    });
    const server = createServer(listener);
    server.once("error", reject);
    server.listen(settings.port, settings.host, () => resolveListening(server));
  });
}

/** Start, then stop cleanly on SIGINT or SIGTERM. A second signal stops at once. */
export async function main(env: Env = process.env): Promise<void> {
  const running = await start(env);
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) {
      stderr(`${signal} again: stopping now, without waiting for runs`);
      process.exit(1);
    }
    stopping = true;
    stderr(
      `${signal}: no new requests; waiting for runs in progress (send it again to stop at once)`,
    );
    running.close().then(
      () => process.exit(0),
      (error: unknown) => {
        stderr(`could not close cleanly: ${error instanceof Error ? error.name : "error"}`);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return (
      pathToFileURL(realpathSync(entry)).href === pathToFileURL(fileURLToPath(import.meta.url)).href
    );
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((error: unknown) => {
    // Start-up errors are about settings and files, not about a request, so they may be read.
    if (error instanceof ConfigError || error instanceof StartupError)
      stderr(`Parol cannot start: ${error.message}`);
    else if (error instanceof Error) stderr(`Parol cannot start: ${error.name}: ${error.message}`);
    else stderr("Parol cannot start.");
    process.exitCode = 1;
  });
}
