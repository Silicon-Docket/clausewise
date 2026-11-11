import { randomBytes } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getRequestListener, type ServerType } from "@hono/node-server";
import {
  loadLlmConfig,
  type GenerateObjectRequest,
  type LlmConfig,
  type ObjectGenerator,
} from "@clausewise/llm";
import { createScriptedGenerator } from "@clausewise/llm/testing";
import type { Hono } from "hono";
import { CATEGORY_IDS } from "./contracts.js";
import { createSimulatedModel } from "./demo/simulated-model.js";
import { createApp } from "./server/app.js";
import { renderErrorPage } from "./server/pages/error.js";
import type { AppConfig, AppDeps } from "./server/deps.js";
import {
  guardRequests,
  rejectedRequestHandler,
  wireErrorHandler,
} from "./server/middleware/rejected.js";
import { acquireInstanceLock } from "./boot/instance-lock.js";
import { createComparisonSource } from "./evaluations/index.js";
import { reportRetentionNotices } from "./retention/notices.js";
import { isStandInProvider } from "./stand-in.js";
import {
  FileStore,
  createRepository,
  openDatabase,
  type Database,
  type Repository,
} from "./store/index.js";
import { SpendConfigError } from "./usage/errors.js";
import type { SpendGuard } from "./usage/guard.js";
import { checkSpend, createLiveGenerator, spendGuardFor, type SpendSetup } from "./usage/live.js";
import { DEFAULT_ASSUMED_OUTPUT_TOKENS } from "./usage/plan.js";

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
  /** Use the simulated reader (src/demo), a scripted stand-in that calls nothing. */
  scripted: boolean;
  /** The deployment is https, so cookies are marked Secure. */
  secureCookies: boolean;
  /** Single-person demo: one user may prepare and review, and the memo says so. */
  relaxedSegregation: boolean;
  maxUploadBytes: number;
  /**
   * A JSON file of prices, USD per million tokens, in the format of `evals/prices.json`. A server
   * that calls a model needs it: it gives each call an estimated cost and the spend limits their
   * arithmetic. Null when the variable is not set.
   */
  pricesFile: string | null;
  /** The most one review may cost, USD (PAROL_MAX_REVIEW_COST_USD). No default. Null when not set. */
  maxReviewCostUsd: number | null;
  /** The most all reviews may cost in one UTC day, USD (PAROL_MAX_DAILY_COST_USD). No default. */
  maxDailyCostUsd: number | null;
  /** Output tokens assumed for each call in the bound planned before a review. */
  assumedOutputTokens: number;
  /**
   * A provider that reports no usage is accepted, so that only the bound planned before each review
   * is checked (PAROL_SPEND_BOUND_ONLY).
   */
  spendBoundOnly: boolean;
  /** The names of the spend variables the environment sets, for the notice a stand-in reader prints. */
  spendVariables: string[];
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

/** The variables that only a server that calls a model uses. */
const SPEND_VARIABLES: readonly string[] = [
  "PAROL_MAX_REVIEW_COST_USD",
  "PAROL_MAX_DAILY_COST_USD",
  "PAROL_PRICES_FILE",
  "PAROL_ASSUMED_OUTPUT_TOKENS",
  "PAROL_SPEND_BOUND_ONLY",
];

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

const MAX_COST_USD = 100_000;

/**
 * An amount in US dollars: a positive decimal such as `2` or `0.50`, at most 100000. `raw` is what
 * `read` found, so an unset variable is `undefined` and gives null.
 */
function usdFrom(raw: string | undefined, name: string): number | null {
  if (raw === undefined) return null;
  const value = /^\d{1,6}(?:\.\d{1,6})?$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value <= 0 || value > MAX_COST_USD)
    throw new ConfigError(
      `${name} must be a positive amount in US dollars, such as 2 or 0.50, and at most ${MAX_COST_USD}. Fix the value, or unset it.`,
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
  const pricesFile = read(env, "PAROL_PRICES_FILE");
  const maxReviewCostUsd = usdFrom(
    read(env, "PAROL_MAX_REVIEW_COST_USD"),
    "PAROL_MAX_REVIEW_COST_USD",
  );
  const maxDailyCostUsd = usdFrom(
    read(env, "PAROL_MAX_DAILY_COST_USD"),
    "PAROL_MAX_DAILY_COST_USD",
  );
  if (maxReviewCostUsd !== null && maxDailyCostUsd !== null && maxDailyCostUsd < maxReviewCostUsd)
    throw new ConfigError(
      "PAROL_MAX_DAILY_COST_USD must be at least PAROL_MAX_REVIEW_COST_USD. Fix the values.",
    );
  const assumedOutputTokens = readInteger(
    env,
    "PAROL_ASSUMED_OUTPUT_TOKENS",
    DEFAULT_ASSUMED_OUTPUT_TOKENS,
    1,
    200_000,
  );
  const spendBoundOnly = readFlag(env, "PAROL_SPEND_BOUND_ONLY");
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
    pricesFile: pricesFile === undefined ? null : resolve(pricesFile),
    maxReviewCostUsd,
    maxDailyCostUsd,
    assumedOutputTokens,
    spendBoundOnly,
    spendVariables: SPEND_VARIABLES.filter((name) => read(env, name) !== undefined),
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// The stand-in model
// ---------------------------------------------------------------------------------------------

/**
 * A model that calls nothing and reviews nothing, with every rule coming out `undetermined` and
 * escalated. PAROL_SCRIPTED no longer uses it: that setting runs the simulated reader of
 * src/demo, which can read the worked example. This one stays for a caller that wants a model
 * that never states a status.
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
  /**
   * The configuration of an injected `generator` that is not a stand-in. The spend guard reads the
   * provider, the model, `maxOutputTokens`, `maxRetries` and `fallback` from it, so a generator that
   * calls a model cannot be served without it. Ignored for a stand-in.
   */
  llmConfig?: LlmConfig;
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
  /** The spend guard of a server that calls a model; undefined for a stand-in reader. */
  spend: SpendGuard | undefined;
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

  // The model is chosen first, so a missing key, a missing limit or a price file that cannot be
  // used stops the start before anything is opened.
  let generator: ObjectGenerator | undefined =
    options.generator ?? (settings.scripted ? createSimulatedModel() : undefined);
  let llm: LlmConfig | undefined;
  let setup: SpendSetup | undefined;
  if (generator === undefined || !isStandInProvider(generator.provider)) {
    llm = generator === undefined ? loadLlmConfig(env) : options.llmConfig;
    if (llm === undefined)
      throw new ConfigError(
        "a generator that is not a stand-in must be started with its configuration (llmConfig), " +
          "which the spend limits are read against.",
      );
    if (
      generator !== undefined &&
      (generator.provider !== llm.provider || generator.model !== llm.model)
    )
      throw new ConfigError(
        "the generator and the llmConfig it was started with name a different provider or model.",
      );
    try {
      setup = checkSpend(settings, llm);
    } catch (error) {
      if (error instanceof SpendConfigError) throw new ConfigError(error.message);
      throw error;
    }
  } else if (settings.spendVariables.length > 0) {
    // A stand-in reader calls no model, so there is nothing to limit or to price.
    notice(
      `notice: ${settings.spendVariables.join(", ")} ${settings.spendVariables.length === 1 ? "is" : "are"} ignored, because the reader is a stand-in and calls no model`,
    );
  }
  if (generator !== undefined) notice(`Document text is sent to: ${generator.disclosure}`);

  const { createServices } = await requireModule(
    () => import("./services/index.js"),
    "services/index",
  );
  const { registerAll, markInterruptedRuns, sweepOrphanFiles } = await requireModule(
    () => import("./boot/register.js"),
    "boot/register",
  );

  mkdirSync(settings.dataDir, { recursive: true, mode: 0o700 });
  // Before anything in the folder is opened or changed. Starting marks the runs it finds in flight
  // as interrupted, and a second server on this folder would do that to the first one's live runs.
  const lock = acquireInstanceLock(settings.dataDir);
  if (lock === null)
    throw new StartupError(
      "another Parol server is already using this data folder. Stop it first, or give this one a " +
        "folder of its own with PAROL_DATA_DIR.",
    );
  let db: Database | undefined;
  try {
    const opened = openDatabase(join(settings.dataDir, "parol.sqlite"));
    db = opened;
    const repo = createRepository(opened);
    const files = new FileStore(join(settings.dataDir, "matters"));

    // The demonstration playbook is imported and approved by the demo users, so they exist whether
    // or not signing in as one is switched on.
    registerAll(repo, { seedDemoUsers: true });
    markInterruptedRuns(repo, log);
    sweepOrphanFiles(repo, files, log);

    const now = (): Date => new Date();
    reportRetentionNotices({ repo, now, notice });
    // The guard reads and writes the ledger of the database that is now open. A live generator is
    // built only here, with the guard's two hooks in it, so that no request can leave unmetered.
    const spend = setup === undefined ? undefined : spendGuardFor(setup, repo, log);
    if (generator === undefined) {
      generator = createLiveGenerator(
        llm as LlmConfig,
        spend === undefined ? {} : { guard: spend },
      );
      notice(`Document text is sent to: ${generator.disclosure}`);
    }
    const services = createServices({
      repo,
      files,
      generator,
      config: { relaxedSegregation: settings.relaxedSegregation },
      now,
      log,
      evaluations: createComparisonSource(join(settings.dataDir, "evaluations")),
      ...(spend === undefined ? {} : { spend }),
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
        opened.close();
        lock.release();
      })());

    return { app, server, settings, repo, spend, port: bound, close };
  } catch (error) {
    // The server did not start: give the folder back, so that the next try can have it.
    try {
      db?.close();
    } catch {
      // Already closed. The error that matters is the one being thrown.
    }
    lock.release();
    throw error;
  }
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
 * backslash in the path) is a bare 400 with none of the headers every other response carries. The
 * same goes for what Node's parser refuses before the adapter is reached.
 */
function listen(
  app: Hono,
  settings: ParolSettings,
  log: (line: string) => void,
): Promise<ServerType> {
  return new Promise((resolveListening, reject) => {
    const wire = { log, https: settings.secureCookies };
    const listener = getRequestListener(app.fetch, {
      hostname: settings.host,
      errorHandler: rejectedRequestHandler(wire),
    });
    // Node answers a request it cannot parse, or one without a Host, with a bare status line. The
    // handler and the guard give those the headers, the request id and the log line of any other
    // answer (middleware/rejected.ts).
    const server = createServer({ requireHostHeader: false }, guardRequests(wire, listener));
    server.on("clientError", wireErrorHandler(wire));
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
