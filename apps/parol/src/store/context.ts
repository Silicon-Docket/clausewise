import type { StatementSync } from "node:sqlite";
import { z } from "zod";
import { appendAudit, type AuditEvent, type AuditInput } from "./audit.js";
import { transaction, type Database } from "./db.js";
import { ConflictError, ValidationError } from "./errors.js";

export type SqlParam = string | number | bigint | null | Uint8Array;

export interface RepositoryOptions {
  /** The clock. Tests pass a fixed one so timestamps and retention dates are exact. */
  now?: () => Date;
}

/**
 * What every repository module shares: the connection, the clock and thin helpers. Every statement
 * is a literal string with bound parameters; the only thing that varies between calls is the
 * parameter list, so no SQL is ever assembled from a value.
 */
export interface Ctx {
  db: Database;
  now(): string;
  tx<T>(fn: () => T): T;
  get<T>(sql: string, ...params: SqlParam[]): T | undefined;
  all<T>(sql: string, ...params: SqlParam[]): T[];
  /**
   * Runs a write and returns the number of rows it changed. A text parameter holding a NUL
   * character is refused: SQLite would cut the stored value at the NUL without an error, and the
   * stored text would then no longer match the hash that was computed over the whole of it.
   */
  run(sql: string, ...params: SqlParam[]): number;
  audit(input: Omit<AuditInput, "at">): AuditEvent;
}

export function createContext(db: Database, options: RepositoryOptions = {}): Ctx {
  const clock = options.now ?? (() => new Date());
  const statements = new Map<string, StatementSync>();
  const stmt = (sql: string): StatementSync => {
    let s = statements.get(sql);
    if (!s) {
      s = db.prepare(sql);
      statements.set(sql, s);
    }
    return s;
  };
  const now = (): string => clock().toISOString();
  return {
    db,
    now,
    tx: (fn) => transaction(db, fn),
    get: <T>(sql: string, ...params: SqlParam[]) =>
      stmt(sql).get(...params) as unknown as T | undefined,
    all: <T>(sql: string, ...params: SqlParam[]) => stmt(sql).all(...params) as unknown as T[],
    run: (sql, ...params) => {
      rejectNul(params);
      return Number(stmt(sql).run(...params).changes);
    },
    audit: (input) => appendAudit(db, { ...input, at: now() }),
  };
}

// ---------------------------------------------------------------------------------------------
// Validation helpers. Messages name the field and the rule and never echo the value.
// ---------------------------------------------------------------------------------------------

function rejectNul(params: readonly SqlParam[]): void {
  for (const param of params)
    if (typeof param === "string" && param.includes("\u0000"))
      throw new ValidationError("nul_character", "text must not contain a NUL character");
}

export const SHA256 = /^[0-9a-f]{64}$/;
/** A short machine code: a stale reason, an error kind, a reason code. */
export const SHORT_CODE = /^[a-z][a-z0-9_]{0,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function assertSha256(field: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value))
    throw new ValidationError("bad_hash", `${field} must be 64 lower-case hex digits`);
}

export function assertShortCode(field: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHORT_CODE.test(value))
    throw new ValidationError("bad_code", `${field} must be a short lower-case code`);
}

/** A one-line label such as a matter name: trimmed, non-empty, no control characters. */
export function cleanLabel(field: string, value: unknown, max = 200): string {
  if (typeof value !== "string") throw new ValidationError("bad_text", `${field} must be a string`);
  const text = value.trim();
  if (text.length === 0) throw new ValidationError("bad_text", `${field} must not be empty`);
  if (text.length > max)
    throw new ValidationError("bad_text", `${field} must be at most ${max} characters`);
  if (CONTROL.test(text))
    throw new ValidationError("bad_text", `${field} must not contain control characters`);
  return text;
}

/** Free text from a person (a reason, a comment). Multi-line is fine; control characters other than line breaks are not. */
export function cleanProse(field: string, value: unknown, max: number): string {
  if (typeof value !== "string") throw new ValidationError("bad_text", `${field} must be a string`);
  if (value.length > max)
    throw new ValidationError("bad_text", `${field} must be at most ${max} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))
    throw new ValidationError("bad_text", `${field} must not contain control characters`);
  return value;
}

export function assertCount(field: string, value: unknown, min = 0): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
    throw new ValidationError("bad_number", `${field} must be an integer of at least ${min}`);
}

/** `YYYY-MM-DD` that is a real calendar date, or null. */
export function cleanStatedDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new ValidationError("bad_date", "stated date must be YYYY-MM-DD or null");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)
    throw new ValidationError("bad_date", "stated date is not a real calendar date");
  return value;
}

/** Reports which fields failed and why, never what they held. */
export function parseWith<S extends z.ZodType>(
  schema: S,
  value: unknown,
  label: string,
): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const where = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}:${issue.code}`)
    .join(", ");
  throw new ValidationError("invalid_input", `${label} is invalid (${where})`);
}

export const bool = (n: unknown): boolean => n === 1 || n === 1n;
export const flag = (b: boolean): number => (b ? 1 : 0);

/** A storage path for matter `matterId` has the form `<matterId>/<name>`: never another folder. */
export function assertStoragePath(matterId: string, value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith(`${matterId}/`) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value.slice(matterId.length + 1))
  )
    throw new ValidationError(
      "bad_storage_path",
      "storage path must sit in the matter's own folder",
    );
}

/**
 * One stored file belongs to one row, across document versions and memos alike. Two rows naming
 * one file would hand a caller deleting the first row's file a path the second row still needs.
 * The database refuses it as well (002_integrity.sql); this gives the caller a clear error first.
 */
export function assertStoragePathFree(ctx: Pick<Ctx, "get">, storagePath: string): void {
  const taken = ctx.get<{ n: number }>(
    `SELECT 1 AS n FROM document_versions WHERE storage_path = ?1
     UNION ALL SELECT 1 AS n FROM memos WHERE storage_path = ?1 LIMIT 1`,
    storagePath,
  );
  if (taken !== undefined)
    throw new ConflictError(
      "storage_path_in_use",
      "the stored file already belongs to another row",
    );
}
