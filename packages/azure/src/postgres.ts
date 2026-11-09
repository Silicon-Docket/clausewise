import type { TokenSource } from "@clausewise/llm";
import type { ReviewRecord, ReviewRecords, ReviewStatus } from "@clausewise/service";
import pg from "pg";

/** The Entra ID resource Azure Database for PostgreSQL accepts tokens for. */
export const POSTGRES_RESOURCE = "https://ossrdbms-aad.database.windows.net";

export interface AzurePostgresOptions {
  host: string;
  database: string;
  /** The Entra role to sign in as: the name of the app's managed identity. */
  user: string;
  /** Tokens for POSTGRES_RESOURCE, from that identity. Used as the password. */
  tokens: TokenSource;
  /** Connections held at most. Default 5. */
  max?: number;
}

/**
 * A pool of connections to Azure Database for PostgreSQL, signed in with the app's managed
 * identity: each new connection uses a fresh token as its password, and TLS with a verified
 * certificate is required. There is no database password anywhere.
 */
export function azurePostgresPool(options: AzurePostgresOptions): pg.Pool {
  return new pg.Pool({
    host: options.host,
    port: 5432,
    database: options.database,
    user: options.user,
    password: () => options.tokens.token(),
    ssl: { rejectUnauthorized: true, servername: options.host },
    max: options.max ?? 5,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
}

type Queryable = Pick<pg.Pool, "query">;

interface ReviewRow {
  id: string;
  owner: string;
  playbook_id: string;
  file_name: string;
  client: string | null;
  author: string;
  status: ReviewStatus;
  created_at: Date;
  updated_at: Date;
  error: string | null;
  open: NonNullable<ReviewRecord["open"]> | null;
  unchecked: number | null;
}

function toRecord(row: ReviewRow): ReviewRecord {
  return {
    id: row.id,
    owner: row.owner,
    playbookId: row.playbook_id,
    fileName: row.file_name,
    client: row.client ?? undefined,
    author: row.author,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.open === null ? {} : { open: row.open }),
    ...(row.unchecked === null ? {} : { unchecked: row.unchecked }),
  };
}

// The fields a transition may change, and their columns. Anything else in a patch is a mistake in
// the caller and is refused rather than silently ignored.
const COLUMNS: Record<string, { column: string; json?: boolean }> = {
  status: { column: "status" },
  updatedAt: { column: "updated_at" },
  error: { column: "error" },
  open: { column: "open", json: true },
  unchecked: { column: "unchecked" },
};

/** Review records in PostgreSQL, with the same guarantees as the in-memory store. */
export function postgresRecords(db: Queryable): ReviewRecords {
  return {
    async create(record) {
      await db.query(
        `INSERT INTO reviews (id, owner, playbook_id, file_name, client, author, status,
           created_at, updated_at, error, open, unchecked)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          record.id,
          record.owner,
          record.playbookId,
          record.fileName,
          record.client ?? null,
          record.author,
          record.status,
          record.createdAt,
          record.updatedAt,
          record.error ?? null,
          record.open === undefined ? null : JSON.stringify(record.open),
          record.unchecked ?? null,
        ],
      );
    },

    async get(id) {
      const result = await db.query<ReviewRow>("SELECT * FROM reviews WHERE id = $1", [id]);
      const [row] = result.rows;
      return row === undefined ? undefined : toRecord(row);
    },

    async transition(id, from, patch) {
      const sets: string[] = [];
      const values: unknown[] = [id, [...from]];
      for (const [field, value] of Object.entries(patch)) {
        const target = COLUMNS[field];
        if (target === undefined) throw new Error(`A review's ${field} cannot be changed.`);
        values.push(
          target.json === true && value !== undefined ? JSON.stringify(value) : (value ?? null),
        );
        sets.push(`${target.column} = $${values.length}`);
      }
      const result = await db.query<ReviewRow>(
        `UPDATE reviews SET ${sets.join(", ")} WHERE id = $1 AND status = ANY($2::text[]) RETURNING *`,
        values,
      );
      const [row] = result.rows;
      return row === undefined ? undefined : toRecord(row);
    },

    async claim(id, now, staleBefore) {
      const result = await db.query<ReviewRow>(
        `UPDATE reviews SET status = 'running', updated_at = $2
         WHERE id = $1 AND (status = 'queued' OR (status = 'running' AND updated_at < $3))
         RETURNING *`,
        [id, now, staleBefore],
      );
      const [row] = result.rows;
      return row === undefined ? undefined : toRecord(row);
    },
  };
}

/** Each migration once, in order. Never edit one that has shipped: add another. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE reviews (
     id text PRIMARY KEY,
     owner text NOT NULL,
     playbook_id text NOT NULL,
     file_name text NOT NULL,
     client text,
     author text NOT NULL,
     status text NOT NULL
       CHECK (status IN ('awaiting_upload', 'queued', 'running', 'done', 'failed')),
     created_at timestamptz NOT NULL,
     updated_at timestamptz NOT NULL,
     error text,
     open jsonb,
     unchecked integer
   );
   CREATE INDEX reviews_by_owner ON reviews (owner, created_at DESC);`,
];

export type TablePrivilege = "SELECT" | "INSERT" | "UPDATE";

export interface AppRole {
  /** The role's name: in Azure, the name of the app's managed identity. */
  name: string;
  privileges: readonly TablePrivilege[];
}

export interface MigrateOptions {
  /** Roles the apps sign in as, and what each may do with the reviews table. */
  appRoles?: readonly AppRole[];
  /**
   * Create each app role as an Entra principal first, with pgaadauth_create_principal, which only
   * an Entra administrator can call and only Azure Database for PostgreSQL provides.
   */
  createEntraPrincipals?: boolean;
}

const PRIVILEGES: ReadonlySet<string> = new Set(["SELECT", "INSERT", "UPDATE"]);

/**
 * Brings the database up to date and grants the app roles what they need, in one transaction
 * under an advisory lock, so two migrate jobs started together cannot both run. Returns the
 * versions it applied.
 */
export async function migrate(pool: pg.Pool, options: MigrateOptions = {}): Promise<number[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('clausewise-migrate'))");
    await client.query(
      `CREATE TABLE IF NOT EXISTS clausewise_migrations (
         version integer PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const done = new Set(
      (
        await client.query<{ version: number }>("SELECT version FROM clausewise_migrations")
      ).rows.map((row) => row.version),
    );
    const applied: number[] = [];
    for (const [index, sql] of MIGRATIONS.entries()) {
      const version = index + 1;
      if (done.has(version)) continue;
      await client.query(sql);
      await client.query("INSERT INTO clausewise_migrations (version) VALUES ($1)", [version]);
      applied.push(version);
    }

    for (const role of options.appRoles ?? []) {
      const privileges = [...new Set(role.privileges)];
      if (privileges.length === 0 || privileges.some((privilege) => !PRIVILEGES.has(privilege))) {
        throw new Error("An app role's privileges must be SELECT, INSERT or UPDATE.");
      }
      if (options.createEntraPrincipals === true) {
        const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role.name]);
        if (exists.rowCount === 0) {
          await client.query("SELECT * FROM pgaadauth_create_principal($1, false, false)", [
            role.name,
          ]);
        }
      }
      const name = pg.escapeIdentifier(role.name);
      await client.query(`GRANT USAGE ON SCHEMA public TO ${name}`);
      await client.query(`GRANT ${privileges.join(", ")} ON TABLE reviews TO ${name}`);
    }
    await client.query("COMMIT");
    return applied;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
