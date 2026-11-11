import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_DATA_DIR } from "./main.js";
import { StoreError } from "./store/index.js";

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

/** A class of error whose message was written to be read by the person who runs the command. */
export type WrittenErrorClass = new (...args: never[]) => Error;

/** A name or a code that is safe to print: letters, digits and underscores, and short. */
const SAFE_TOKEN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const tokenOf = (value: unknown): string | null =>
  typeof value === "string" && SAFE_TOKEN.test(value) ? value : null;

const DISK_FULL = "the disk is full. Free some space and run the command again.";
const NOT_ALLOWED =
  "this user may not read or write the data folder. Run the command as the user who runs the server, or fix who may use the folder.";
const BAD_FOLDER =
  "PAROL_DATA_DIR, or something in that folder, is not what the command expects: a file stands where a folder is needed, or a folder where a file is needed. Set PAROL_DATA_DIR to the folder the server uses.";
const READ_ONLY =
  "the data folder is on a disk that cannot be written to. Run the command where the folder can be written to.";
const TOO_MANY_FILES =
  "the system has too many files open. Close other programs and run the command again.";
const MISSING_FILE =
  "a file that Parol needs is missing. Install its dependencies again (pnpm install) and run the command again.";
const NOT_A_PAROL_DATABASE =
  "the file parol.sqlite in the data folder is not a Parol database. Set PAROL_DATA_DIR to the folder the server uses.";
const DAMAGED_DATABASE =
  "the database file in the data folder is damaged, or is not a Parol database. Restore it from a copy, or set PAROL_DATA_DIR to another folder.";
const DATABASE_IN_USE =
  "the database is in use by another program. Stop the server and any other Parol that uses this data folder, then run the command again.";
const MIGRATIONS_DISAGREE =
  "the database and this copy of Parol do not agree on the migrations that build it: the database was made by another version of Parol, or a migration file was changed after it was applied. Run the version of Parol that made the data folder.";

/** Operating system errors, by the code Node gives them. Their messages are not shown: they hold a path. */
const SYSTEM_FAILURES: Readonly<Record<string, string>> = {
  EACCES: NOT_ALLOWED,
  EPERM: NOT_ALLOWED,
  ENOENT: BAD_FOLDER,
  ENOTDIR: BAD_FOLDER,
  EISDIR: BAD_FOLDER,
  EEXIST: BAD_FOLDER,
  ENOSPC: DISK_FULL,
  EDQUOT: DISK_FULL,
  EROFS: READ_ONLY,
  EMFILE: TOO_MANY_FILES,
  ENFILE: TOO_MANY_FILES,
  ERR_MODULE_NOT_FOUND: MISSING_FILE,
  MODULE_NOT_FOUND: MISSING_FILE,
};

/** SQLite's primary result codes, by what the person can do. */
const SQLITE_FAILURES: Readonly<Record<number, string>> = {
  14: "the database file in the data folder cannot be opened. Check that PAROL_DATA_DIR is a folder you can use, and that parol.sqlite in it is a file and not a folder.",
  26: DAMAGED_DATABASE,
  11: DAMAGED_DATABASE,
  5: DATABASE_IN_USE,
  6: DATABASE_IN_USE,
  13: DISK_FULL,
  8: "the database cannot be written to. Make the data folder and parol.sqlite in it writable by the user who runs the command.",
  10: "the disk reported an error while the database was read or written. Check the disk, then run the command again.",
};

/**
 * What a command says when the data folder holds no database. Nothing is created for it: the
 * commands that read a database do not make one.
 */
export const NO_DATABASE =
  "there is no database in the data folder. Set PAROL_DATA_DIR to the folder the server uses.";

/** The store's own faults a command can meet, by their code. */
const STORE_FAILURES: Readonly<Record<string, string>> = {
  no_database: NO_DATABASE,
  not_a_parol_database: NOT_A_PAROL_DATABASE,
  migration_gap: MIGRATIONS_DISAGREE,
  migration_changed: MIGRATIONS_DISAGREE,
  migration_unknown: MIGRATIONS_DISAGREE,
  bad_migration_name: MIGRATIONS_DISAGREE,
};

/**
 * What the terminal says when a command cannot run, as one line that begins `<command> cannot run:`
 * and says what to do.
 *
 * An error of a class in `written` (the command's own usage errors, a setting that is wrong) was
 * written as a sentence for the person who runs the command, naming an option or a variable and
 * never a value, so its message is shown as it is. Anything else is told from its class and a code
 * of a fixed shape: the operating system's codes, SQLite's result codes and the store's codes each
 * have a sentence that says what to change or do. The message of such an error is never shown,
 * because it can hold a path, a setting, a line of a file or a word of a document; for an error that
 * nobody wrote a sentence for, only its class name and code are printed, so that whoever helps can
 * find the fault.
 */
export function describeCommandFailure(
  command: string,
  error: unknown,
  written: readonly WrittenErrorClass[] = [],
): string {
  const said = (text: string): string => `${command} cannot run: ${text}`;
  if (error instanceof Error && written.some((kind) => error instanceof kind))
    return said(error.message);
  const fields =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const code = tokenOf(fields.code);
  const name = error instanceof Error ? (tokenOf(error.name) ?? "Error") : null;
  if (code === "ERR_SQLITE_ERROR" && typeof fields.errcode === "number") {
    const primary = fields.errcode & 0xff;
    const advice =
      SQLITE_FAILURES[primary] ??
      "the database could not be opened or updated. Check the data folder (PAROL_DATA_DIR) and run the command again.";
    return said(`${advice} [SQLite result ${primary}]`);
  }
  if (error instanceof StoreError && code !== null) {
    const advice =
      STORE_FAILURES[code] ??
      "a check of the stored data failed. Run the command again; if it fails again, report the code given here.";
    return said(`${advice} [${name ?? "StoreError"}, code ${code}]`);
  }
  if (code !== null && Object.hasOwn(SYSTEM_FAILURES, code))
    return said(`${SYSTEM_FAILURES[code]} [${code}]`);
  const what = name === null ? "something that is not an error" : `an unexpected ${name}`;
  return said(
    `${what} stopped it. Run the command again; if it happens again, report it with the name${code === null ? "" : ` and the code ${code}`} given here. Its message is not shown, because it could hold a path or a setting.`,
  );
}
