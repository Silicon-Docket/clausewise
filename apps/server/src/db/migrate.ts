import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseError, type Database } from "./client.js";

// The folder that `drizzle-kit generate` writes. Where it sits depends on how the server runs:
// two levels up from this file when run from source, next to the bundle in the container image.
const CANDIDATES = ["../../drizzle", "./drizzle", "../drizzle"];

export function findMigrationsFolder(
  base: string = import.meta.url,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  for (const candidate of CANDIDATES) {
    const folder = fileURLToPath(new URL(candidate, base));
    if (exists(`${folder}/meta/_journal.json`)) return folder;
  }
  return undefined;
}

// Drizzle wraps the database's own error and puts the failed SQL in its message, so the cause is
// the part worth showing. Only its first line is kept.
function reasonOf(error: unknown): string {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const source = cause instanceof Error ? cause : error;
  const message = source instanceof Error ? source.message : "";
  return message.split("\n")[0]?.slice(0, 200) || "unknown error";
}

/**
 * Brings the database up to date with the SQL files committed under `apps/server/drizzle`. A
 * failure stops the start: a server on a half-migrated database would fail on the first request,
 * in a way that is harder to read.
 */
export async function applyMigrations(database: Database, folder?: string): Promise<void> {
  const where = folder ?? findMigrationsFolder();
  if (where === undefined) {
    throw new DatabaseError(
      "The database migration files were not found. They are in the drizzle folder next to the server; the installation is incomplete.",
    );
  }
  try {
    await database.migrate(where);
  } catch (error) {
    throw new DatabaseError(
      `The database could not be set up, so the server did not start (${reasonOf(error)}). Check that the database user may create tables, and that it is not in use by another Clausewise version.`,
    );
  }
}
