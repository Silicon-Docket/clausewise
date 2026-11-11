import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_DATA_DIR } from "./main.js";

/**
 * What the operator commands share (`pnpm parol:retain`, `pnpm parol:audit-verify`).
 *
 * They are not application roles and take no request: whoever can run a command against the data
 * folder is trusted with it, as with the seed and the start-up sweep. They read one variable,
 * `PAROL_DATA_DIR`, and no other, so a bad `PAROL_COOKIE_SECRET` or port cannot stop a deletion or
 * a check (the server's `parseEnv` would).
 */

/** The file the database lives in, inside the data folder. */
export const DATABASE_FILE = "parol.sqlite";
/** The folder of the stored files, inside the data folder. */
export const MATTERS_FOLDER = "matters";

/** The command was used wrongly. The message names the option and never repeats its value. */
export class CliUsageError extends Error {
  override name = "CliUsageError";
}

export interface DataFolder {
  dataDir: string;
  databasePath: string;
  mattersDir: string;
}

/** Where the data is: `PAROL_DATA_DIR`, or the server's default, resolved. Nothing is created. */
export function dataFolder(env: Record<string, string | undefined> = process.env): DataFolder {
  const given = env.PAROL_DATA_DIR?.trim();
  const dataDir = resolve(given === undefined || given === "" ? DEFAULT_DATA_DIR : given);
  return {
    dataDir,
    databasePath: join(dataDir, DATABASE_FILE),
    mattersDir: join(dataDir, MATTERS_FOLDER),
  };
}

/**
 * True when the module whose `import.meta.url` is given is the script being run, as opposed to
 * imported by a test or by another command. A link to the script is followed.
 */
export function isEntryPointOf(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return (
      pathToFileURL(realpathSync(entry)).href ===
      pathToFileURL(realpathSync(fileURLToPath(importMetaUrl))).href
    );
  } catch {
    return false;
  }
}

/** One line to standard output. */
export const stdoutLine = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** One line to standard error. */
export const stderrLine = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/**
 * What an error that nobody expected says on the terminal: its class, and its message when the
 * class is one whose messages are written to be read (the store's, which never repeat a request or a
 * document, and the usage errors). Any other class prints its name and its `code`, if it has one.
 * The command prints nothing that came from a row.
 */
export function describeFailure(
  error: unknown,
  readable: readonly (new (...args: never[]) => Error)[],
): string {
  if (error instanceof Error) {
    if (readable.some((kind) => error instanceof kind)) return `${error.name}: ${error.message}`;
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code)
      ? `${error.name} (${code})`
      : error.name;
  }
  return "an error that is not an Error";
}
