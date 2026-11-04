import { chmodSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { sha256Hex } from "../canonical.js";
import { MigrationError } from "./errors.js";

export type Database = DatabaseSync;

/** `apps/parol/migrations`, found from this file so it works from `src` and from tests alike. */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

export interface OpenOptions {
  /** Where the numbered `.sql` files are. Tests point this at a copy to tamper with it. */
  migrationsDir?: string;
  busyTimeoutMs?: number;
}

/**
 * Opens (and creates) the database, applies pending migrations and returns the connection.
 *
 * - `foreign_keys` is on, because the cascade deletes and the matter checks rely on it.
 * - `recursive_triggers` is on, because SQLite runs delete triggers for the rows an INSERT OR
 *   REPLACE removes only when it is. The insert guards in 002 do not depend on it; this is the
 *   second line.
 * - `secure_delete` is on, so a deleted matter's text is overwritten in the database file and not
 *   just unlinked from its pages. It is not secure erasure of the disk (docs/parol/06 says so).
 * - WAL for files, so a reader does not block the runner's writes.
 */
export function openDatabase(location: string = ":memory:", options: OpenOptions = {}): Database {
  const inMemory = location === ":memory:" || location === "";
  if (!inMemory) mkdirSync(dirname(location), { recursive: true, mode: 0o700 });

  // The busy timeout is a constructor option and not a PRAGMA because a PRAGMA cannot take a bound
  // parameter, and no statement in the store is built from a value.
  const db = new DatabaseSync(location, { timeout: boundedTimeout(options.busyTimeoutMs ?? 5000) });
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA recursive_triggers = ON");
    db.exec("PRAGMA secure_delete = ON");
    if (!inMemory) db.exec("PRAGMA journal_mode = WAL");
    runMigrations(db, options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
    if (!inMemory) restrictFileModes(location);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

function boundedTimeout(ms: number): number {
  if (!Number.isInteger(ms) || ms < 0 || ms > 600_000)
    throw new RangeError("busyTimeoutMs out of range");
  return ms;
}

function restrictFileModes(location: string): void {
  // The database, its write-ahead log and its shared-memory file all hold matter text.
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      chmodSync(location + suffix, 0o600);
    } catch {
      // The log files exist only while the database is open in WAL mode, and some platforms
      // ignore modes. The directory mode is the control that matters.
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------------------------

export interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  /** SHA-256 of the file with CRLF turned into LF, so a Windows checkout does not trip the guard. */
  sha256: string;
}

const MIGRATION_NAME = /^(\d{3,})_([a-z0-9_]+)\.sql$/;

export function loadMigrationFiles(dir: string = DEFAULT_MIGRATIONS_DIR): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const out: MigrationFile[] = [];
  for (const file of files) {
    const match = MIGRATION_NAME.exec(file);
    if (!match)
      throw new MigrationError("bad_migration_name", `migration file ${file} is misnamed`);
    const sql = readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n");
    out.push({
      version: Number(match[1]),
      name: match[2] as string,
      sql,
      sha256: sha256Hex(sql),
    });
  }
  out.forEach((migration, index) => {
    if (migration.version !== index + 1)
      throw new MigrationError(
        "migration_gap",
        `migrations must be numbered 1, 2, 3 without gaps; found ${migration.version} at position ${index + 1}`,
      );
  });
  return out;
}

export interface MigrationResult {
  /** Versions applied by this call. Empty when the database was already current. */
  applied: number[];
  current: number;
}

/**
 * Applies the migrations that have not been applied, each in its own transaction, in order.
 *
 * Before applying anything it checks every migration already recorded against its file. A file that
 * changed since it was applied means the database and the code no longer agree on the schema, and
 * the only safe answer is to stop. A new fix is a new numbered file.
 */
export function runMigrations(db: Database, dir: string = DEFAULT_MIGRATIONS_DIR): MigrationResult {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version     INTEGER PRIMARY KEY,
       name        TEXT NOT NULL,
       sha256      TEXT NOT NULL,
       applied_at  TEXT NOT NULL
     )`,
  );

  const files = loadMigrationFiles(dir);
  const byVersion = new Map(files.map((file) => [file.version, file]));
  const recorded = db
    .prepare("SELECT version, name, sha256 FROM schema_migrations ORDER BY version")
    .all() as unknown as { version: number; name: string; sha256: string }[];

  for (const row of recorded) {
    const file = byVersion.get(row.version);
    if (!file)
      throw new MigrationError(
        "migration_unknown",
        `the database has migration ${row.version} applied but no file for it was found; it was written by a newer build`,
      );
    if (file.sha256 !== row.sha256)
      throw new MigrationError(
        "migration_changed",
        `migration ${row.version} (${row.name}) changed after it was applied; add a new migration instead of editing it`,
      );
  }

  const done = new Set(recorded.map((row) => row.version));
  const applied: number[] = [];
  for (const file of files) {
    if (done.has(file.version)) continue;
    transaction(db, () => {
      db.exec(file.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, sha256, applied_at) VALUES (?, ?, ?, ?)",
      ).run(file.version, file.name, file.sha256, new Date().toISOString());
    });
    applied.push(file.version);
  }
  const last = files[files.length - 1];
  return { applied, current: last ? last.version : 0 };
}

// ---------------------------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------------------------

// One fixed savepoint name is enough: SQLite keeps same-named savepoints as a stack, so ROLLBACK TO
// and RELEASE always address the innermost one. That keeps every statement in this module a literal,
// so no SQL is assembled from data.
const SAVEPOINT = "SAVEPOINT parol_sp";
const RELEASE = "RELEASE SAVEPOINT parol_sp";
const ROLLBACK_TO = "ROLLBACK TO SAVEPOINT parol_sp";

const depths = new WeakMap<Database, number>();

/**
 * Runs `fn` in a transaction and returns its result. The outermost call is `BEGIN IMMEDIATE`, so
 * the write lock is taken up front and two writers cannot deadlock on a lock upgrade. A nested call
 * (a repository method calling another) is a savepoint, so an inner failure that the outer code
 * catches rolls back only the inner work, and one that is not caught rolls back everything.
 * Any throw rolls back and is rethrown unchanged.
 *
 * `fn` must be synchronous: a transaction cannot span an `await`, and a promise result is refused
 * (and rolled back) rather than committed before it settles.
 */
export function transaction<T>(db: Database, fn: () => T): T {
  const depth = depths.get(db) ?? 0;
  // A transaction opened by someone else (a raw BEGIN) is joined with a savepoint, not committed.
  const outermost = depth === 0 && !db.isTransaction;

  db.exec(outermost ? "BEGIN IMMEDIATE" : SAVEPOINT);
  depths.set(db, depth + 1);
  let result: T;
  try {
    result = fn();
    if (isPromiseLike(result))
      throw new TypeError("a store transaction cannot be asynchronous; do the awaiting outside it");
  } catch (error) {
    depths.set(db, depth);
    // A failed rollback must not hide the error that caused it.
    try {
      if (outermost) db.exec("ROLLBACK");
      else {
        db.exec(ROLLBACK_TO);
        db.exec(RELEASE);
      }
    } catch {
      // The original error is the useful one.
    }
    throw error;
  }
  depths.set(db, depth);
  db.exec(outermost ? "COMMIT" : RELEASE);
  return result;
}

function isPromiseLike(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** True while a transaction opened through `transaction` (or a raw BEGIN) is open. */
export const inTransaction = (db: Database): boolean => db.isTransaction;
