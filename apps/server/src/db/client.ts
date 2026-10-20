import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import pg from "pg";
import * as schema from "./schema.js";

/** The query builder, the same for the embedded database and for Postgres. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface Database {
  db: Db;
  kind: "postgres" | "pglite";
  /** Applies the SQL files in `folder` that have not been applied yet. */
  migrate(folder: string): Promise<void>;
  close(): Promise<void>;
}

/** The database could not be opened or set up. The message is safe to print: it holds no address or password. */
export class DatabaseError extends Error {
  override name = "DatabaseError";
}

export type DatabaseTarget =
  | { kind: "postgres"; url: string }
  /** Files under `<dataDir>/pglite`. */
  | { kind: "pglite"; dataDir: string }
  | { kind: "memory" };

// Postgres reports its own errors in plain words, but a failed connection can carry the host and
// the user, so the connection string and its password are cut out of anything shown.
function scrub(text: string, url: string): string {
  let result = text.split(url).join("<DATABASE_URL>");
  try {
    const { password, username } = new URL(url);
    for (const secret of [password, username]) {
      if (secret !== "") result = result.split(decodeURIComponent(secret)).join("***");
    }
  } catch {
    // An address that does not parse has nothing more to cut out.
  }
  return result;
}

async function openPostgres(url: string, onError: (error: Error) => void): Promise<Database> {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  // An idle connection that the server drops would otherwise crash the process.
  pool.on("error", onError);
  try {
    await pool.query("select 1");
  } catch (error) {
    await pool.end().catch(() => {});
    const reason = error instanceof Error ? scrub(error.message, url) : "unknown error";
    throw new DatabaseError(
      `Cannot connect to the database at DATABASE_URL (${reason}). Check the address, the password and that the database is running.`,
    );
  }
  const db = drizzleNodePg(pool, { schema });
  return {
    db,
    kind: "postgres",
    migrate: (folder) => migrateNodePg(db, { migrationsFolder: folder }),
    close: () => pool.end(),
  };
}

async function openPglite(location: string | undefined): Promise<Database> {
  const client = new PGlite(location);
  await client.waitReady;
  const db = drizzlePglite(client, { schema });
  return {
    db,
    kind: "pglite",
    migrate: (folder) => migratePglite(db, { migrationsFolder: folder }),
    close: () => client.close(),
  };
}

export async function openDatabase(
  target: DatabaseTarget,
  onError: (error: Error) => void = () => {},
): Promise<Database> {
  switch (target.kind) {
    case "postgres":
      return openPostgres(target.url, onError);
    case "memory":
      return openPglite(undefined);
    case "pglite": {
      const folder = join(target.dataDir, "pglite");
      // The embedded database holds every contract's findings, so the folder is private.
      await mkdir(target.dataDir, { recursive: true, mode: 0o700 });
      await chmod(target.dataDir, 0o700);
      return openPglite(folder);
    }
  }
}
