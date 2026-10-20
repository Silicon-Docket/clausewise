import { isIP } from "node:net";

/** The settings do not describe a server that can start. The message names the variable and the fix. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface ServerConfig {
  host: string;
  port: number;
  /** Unset means the embedded database in the data directory. */
  databaseUrl: string | undefined;
  dataDir: string;
  playbooksDir: string;
  /** The built web app. A folder that does not exist just means the API runs without a front end. */
  webDir: string;
  /** At least 16 characters when set. */
  accessToken: string | undefined;
  /** Extra `Host` values for a reverse proxy, lower case. */
  allowedHosts: string[];
  maxUploadBytes: number;
  reviewConcurrency: number;
  maxQueued: number;
  /** Not a setting of the environment: a document with this many reviews takes no more. */
  maxReviewsPerDocument: number;
  /** Not a setting of the environment: the least time between two progress writes of a review. */
  progressIntervalMs: number;
}

export const DEFAULTS = {
  host: "127.0.0.1",
  port: 8787,
  dataDir: "./data",
  playbooksDir: "./playbooks",
  webDir: "./apps/web/dist",
  maxUploadMb: 25,
  reviewConcurrency: 1,
  maxQueued: 20,
  maxReviewsPerDocument: 200,
  progressIntervalMs: 500,
} as const;

const MIN_TOKEN_CHARS = 16;
const MAX_UPLOAD_MB = 1024;
const MAX_REVIEW_CONCURRENCY = 16;
const MIB = 1024 * 1024;

type Env = Record<string, string | undefined>;

// Whitespace is trimmed because a value pasted from a file or a Docker secret often ends in a
// newline. Messages name the variable but never echo a value: a mistyped variable can hold a secret.
function read(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function readWhole(
  env: Env,
  name: string,
  fallback: number,
  range: { min: number; max: number },
): number {
  const raw = read(env, name);
  if (raw === undefined) return fallback;
  const value = /^\d{1,9}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(value >= range.min && value <= range.max)) {
    throw new ConfigError(
      `${name} must be a whole number from ${range.min} to ${range.max}. Fix the value, or unset it to use ${fallback}.`,
    );
  }
  return value;
}

/** Reads the environment into a checked configuration. Throws ConfigError for the first problem. */
export function readConfig(env: Env): ServerConfig {
  const accessToken = read(env, "CLAUSEWISE_ACCESS_TOKEN");
  if (accessToken !== undefined && accessToken.length < MIN_TOKEN_CHARS) {
    throw new ConfigError(
      `CLAUSEWISE_ACCESS_TOKEN must be at least ${MIN_TOKEN_CHARS} characters. Use a long random value, for example the output of: openssl rand -hex 24`,
    );
  }

  const databaseUrl = read(env, "DATABASE_URL");
  if (databaseUrl !== undefined && !/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
    throw new ConfigError(
      "DATABASE_URL must be a PostgreSQL address that starts with postgres:// or postgresql://. Fix the value, or unset it to use the embedded database.",
    );
  }

  const allowedHosts = (read(env, "CLAUSEWISE_ALLOWED_HOSTS") ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== "");

  return {
    host: read(env, "HOST") ?? DEFAULTS.host,
    port: readWhole(env, "PORT", DEFAULTS.port, { min: 0, max: 65535 }),
    databaseUrl,
    dataDir: read(env, "CLAUSEWISE_DATA_DIR") ?? DEFAULTS.dataDir,
    playbooksDir: read(env, "CLAUSEWISE_PLAYBOOKS_DIR") ?? DEFAULTS.playbooksDir,
    webDir: read(env, "CLAUSEWISE_WEB_DIR") ?? DEFAULTS.webDir,
    accessToken,
    allowedHosts,
    maxUploadBytes:
      readWhole(env, "CLAUSEWISE_MAX_UPLOAD_MB", DEFAULTS.maxUploadMb, {
        min: 1,
        max: MAX_UPLOAD_MB,
      }) * MIB,
    reviewConcurrency: readWhole(env, "CLAUSEWISE_REVIEW_CONCURRENCY", DEFAULTS.reviewConcurrency, {
      min: 1,
      max: MAX_REVIEW_CONCURRENCY,
    }),
    maxQueued: readWhole(env, "CLAUSEWISE_MAX_QUEUED", DEFAULTS.maxQueued, {
      min: 0,
      max: 10_000,
    }),
    maxReviewsPerDocument: DEFAULTS.maxReviewsPerDocument,
    progressIntervalMs: DEFAULTS.progressIntervalMs,
  };
}

/** True for the addresses that only this machine can reach. */
export function isLoopbackHost(host: string): boolean {
  const name = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (name.toLowerCase() === "localhost") return true;
  if (isIP(name) === 4) return name.startsWith("127.");
  return isIP(name) === 6 && (name === "::1" || /^(?:0{1,4}:){7}0{0,3}1$/.test(name));
}
