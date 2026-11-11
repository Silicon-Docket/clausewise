import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/canonical.js";
import {
  DEFAULT_MIGRATIONS_DIR,
  MigrationError,
  StoreError,
  createRepository,
  loadMigrationFiles,
  openDatabase,
  openDatabaseReadOnly,
  runMigrations,
  transaction,
} from "../../src/store/index.js";
import { DatabaseSync } from "node:sqlite";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "parol-db-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const pragma = (db: DatabaseSync, name: string): unknown => {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>;
  return Object.values(row)[0];
};

/** The number a scratch migration takes, after the ones the build ships. */
const NEXT = String(loadMigrationFiles(DEFAULT_MIGRATIONS_DIR).length + 1).padStart(3, "0");

/** A scratch copy of the real migrations, to edit without touching the originals. */
function copyMigrations(): string {
  const target = join(dir, "migrations");
  mkdirSync(target);
  for (const file of loadMigrationFiles(DEFAULT_MIGRATIONS_DIR))
    copyFileSync(
      join(DEFAULT_MIGRATIONS_DIR, `${String(file.version).padStart(3, "0")}_${file.name}.sql`),
      join(target, `${String(file.version).padStart(3, "0")}_${file.name}.sql`),
    );
  return target;
}

describe("openDatabase", () => {
  it("turns on foreign keys, recursive triggers and secure delete", () => {
    const db = openDatabase();
    expect(pragma(db, "foreign_keys")).toBe(1);
    expect(pragma(db, "recursive_triggers")).toBe(1);
    expect(pragma(db, "secure_delete")).toBe(1);
    db.close();
  });

  it("enforces foreign keys", () => {
    const db = openDatabase();
    expect(() =>
      db
        .prepare(
          "INSERT INTO matter_members (matter_id, user_id, role, granted_by, granted_at) VALUES ('nope','nope','viewer','nope','t')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it("sets a busy timeout", () => {
    const db = openDatabase(":memory:", { busyTimeoutMs: 1234 });
    expect(pragma(db, "busy_timeout")).toBe(1234);
    db.close();
    expect(() => openDatabase(":memory:", { busyTimeoutMs: -1 })).toThrow(RangeError);
  });

  it("uses WAL for a file, creates its folder privately, and keeps the files private", () => {
    const file = join(dir, "nested", "parol.db");
    const db = openDatabase(file);
    expect(pragma(db, "journal_mode")).toBe("wal");
    expect(statSync(join(dir, "nested")).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    db.close();
  });

  it("does not use WAL in memory", () => {
    const db = openDatabase();
    expect(pragma(db, "journal_mode")).toBe("memory");
    db.close();
  });

  it("closes the connection and rethrows when a migration fails", () => {
    const bad = join(dir, "bad");
    mkdirSync(bad);
    writeFileSync(join(bad, "001_broken.sql"), "CREATE TABLE ok (x); THIS IS NOT SQL;");
    expect(() => openDatabase(join(dir, "x.db"), { migrationsDir: bad })).toThrow();
  });
});

describe("migrations", () => {
  it("applies every numbered file on an empty database and records version and checksum", () => {
    const db = openDatabase();
    const rows = db
      .prepare("SELECT version, name, sha256 FROM schema_migrations ORDER BY version")
      .all() as {
      version: number;
      name: string;
      sha256: string;
    }[];
    const files = loadMigrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(rows.map((r) => [r.version, r.name, r.sha256])).toEqual(
      files.map((f) => [f.version, f.name, f.sha256]),
    );
    for (const f of files)
      expect(f.sha256).toBe(
        sha256Hex(
          readFileSync(
            join(DEFAULT_MIGRATIONS_DIR, `${String(f.version).padStart(3, "0")}_${f.name}.sql`),
            "utf8",
          ).replace(/\r\n/g, "\n"),
        ),
      );
    db.close();
  });

  it("is idempotent: a second run applies nothing, and reopening a file changes nothing", () => {
    const db = openDatabase();
    const again = runMigrations(db);
    expect(again.applied).toEqual([]);
    expect(again.current).toBe(loadMigrationFiles().length);
    db.close();

    const file = join(dir, "a.db");
    openDatabase(file).close();
    const reopened = openDatabase(file);
    const count = reopened.prepare("SELECT count(*) AS n FROM schema_migrations").get() as {
      n: number;
    };
    expect(count.n).toBe(loadMigrationFiles().length);
    reopened.close();
  });

  it("refuses to run when an applied migration file has changed", () => {
    const migrations = copyMigrations();
    const file = join(dir, "b.db");
    openDatabase(file, { migrationsDir: migrations }).close();

    const first = join(migrations, "001_init.sql");
    writeFileSync(first, readFileSync(first, "utf8") + "\n-- an edit made after it was applied\n");
    let caught: unknown;
    try {
      openDatabase(file, { migrationsDir: migrations });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MigrationError);
    expect((caught as MigrationError).code).toBe("migration_changed");
    expect((caught as Error).message).toContain("migration 1");
  });

  it("guards the later migrations too", () => {
    const migrations = copyMigrations();
    const file = join(dir, "c.db");
    openDatabase(file, { migrationsDir: migrations }).close();
    const second = join(migrations, "002_integrity.sql");
    writeFileSync(
      second,
      readFileSync(second, "utf8").replace("one run in flight", "a run in flight"),
    );
    expect(() => openDatabase(file, { migrationsDir: migrations })).toThrow(/migration 2/);
  });

  it("applies a new migration once and only once", () => {
    const migrations = copyMigrations();
    writeFileSync(join(migrations, `${NEXT}_extra.sql`), "CREATE TABLE extra_table (x TEXT);");
    const file = join(dir, "d.db");
    const db = openDatabase(file, { migrationsDir: migrations });
    expect(
      db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(Number(NEXT)),
    ).toBeDefined();
    expect(runMigrations(db, migrations).applied).toEqual([]);
    db.close();
    openDatabase(file, { migrationsDir: migrations }).close();
  });

  it("rolls a failing migration back completely and does not record it", () => {
    const migrations = copyMigrations();
    const file = join(dir, "e.db");
    openDatabase(file, { migrationsDir: migrations }).close();
    writeFileSync(
      join(migrations, `${NEXT}_bad.sql`),
      "CREATE TABLE half_done (x TEXT);\nINSERT INTO no_such_table VALUES (1);",
    );
    expect(() => openDatabase(file, { migrationsDir: migrations })).toThrow();

    writeFileSync(join(migrations, `${NEXT}_bad.sql`), "CREATE TABLE fixed (x TEXT);");
    const db = openDatabase(file, { migrationsDir: migrations });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[];
    expect(tables.map((t) => t.name)).not.toContain("half_done");
    expect(tables.map((t) => t.name)).toContain("fixed");
    db.close();
  });

  it("refuses a database written by a newer build", () => {
    const migrations = copyMigrations();
    const file = join(dir, "f.db");
    writeFileSync(join(migrations, `${NEXT}_extra.sql`), "CREATE TABLE extra_table (x TEXT);");
    openDatabase(file, { migrationsDir: migrations }).close();
    rmSync(join(migrations, `${NEXT}_extra.sql`));
    expect(() => openDatabase(file, { migrationsDir: migrations })).toThrowError(
      new RegExp(`migration ${Number(NEXT)}.*newer build`),
    );
  });

  it("rejects gaps and misnamed files", () => {
    const gap = join(dir, "gap");
    mkdirSync(gap);
    copyFileSync(join(DEFAULT_MIGRATIONS_DIR, "001_init.sql"), join(gap, "001_init.sql"));
    writeFileSync(join(gap, "003_skipped.sql"), "SELECT 1;");
    expect(() => loadMigrationFiles(gap)).toThrow(/without gaps/);

    const misnamed = join(dir, "misnamed");
    mkdirSync(misnamed);
    writeFileSync(join(misnamed, "init.sql"), "SELECT 1;");
    expect(() => loadMigrationFiles(misnamed)).toThrow(/misnamed/);
  });

  it("is not thrown by a Windows checkout: CRLF line endings hash the same", () => {
    const migrations = copyMigrations();
    const file = join(dir, "g.db");
    openDatabase(file, { migrationsDir: migrations }).close();
    for (const name of ["001_init.sql", "002_integrity.sql"]) {
      const path = join(migrations, name);
      writeFileSync(path, readFileSync(path, "utf8").replace(/\n/g, "\r\n"));
    }
    openDatabase(file, { migrationsDir: migrations }).close();
  });

  it("creates the columns and indexes that 002 promises", () => {
    const db = openDatabase();
    const columns = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    expect(columns("runs")).toContain("inputs_sha256");
    expect(columns("matters")).toContain("current_inputs_sha256");
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((i) => i.name);
    expect(indexes).toContain("runs_one_active_per_matter");
    expect(indexes).toContain("document_versions_one_operative");
    db.close();
  });
});

describe("transaction", () => {
  const setup = () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (x INTEGER)");
    const count = () => (db.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n;
    return { db, count };
  };

  it("commits and returns the result", () => {
    const { db, count } = setup();
    expect(transaction(db, () => (db.exec("INSERT INTO t VALUES (1)"), "done"))).toBe("done");
    expect(count()).toBe(1);
    expect(db.isTransaction).toBe(false);
  });

  it("rolls back on a throw and rethrows the same error", () => {
    const { db, count } = setup();
    const boom = new Error("boom");
    let caught: unknown;
    try {
      transaction(db, () => {
        db.exec("INSERT INTO t VALUES (1)");
        throw boom;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(boom);
    expect(count()).toBe(0);
    expect(db.isTransaction).toBe(false);
  });

  it("nests with savepoints: a caught inner failure rolls back only the inner work", () => {
    const { db, count } = setup();
    transaction(db, () => {
      db.exec("INSERT INTO t VALUES (1)");
      try {
        transaction(db, () => {
          db.exec("INSERT INTO t VALUES (2)");
          throw new Error("inner");
        });
      } catch {
        // the outer code decides to carry on
      }
      db.exec("INSERT INTO t VALUES (3)");
    });
    expect(
      (db.prepare("SELECT x FROM t ORDER BY x").all() as { x: number }[]).map((r) => r.x),
    ).toEqual([1, 3]);
    expect(count()).toBe(2);
  });

  it("rolls back everything when an inner failure is not caught", () => {
    const { db, count } = setup();
    expect(() =>
      transaction(db, () => {
        db.exec("INSERT INTO t VALUES (1)");
        transaction(db, () => {
          db.exec("INSERT INTO t VALUES (2)");
          transaction(db, () => {
            db.exec("INSERT INTO t VALUES (3)");
            throw new Error("deep");
          });
        });
      }),
    ).toThrow("deep");
    expect(count()).toBe(0);
    expect(db.isTransaction).toBe(false);
  });

  it("stays usable after a failure (the nesting depth is restored)", () => {
    const { db, count } = setup();
    expect(() =>
      transaction(db, () => {
        throw new Error("x");
      }),
    ).toThrow();
    expect(() =>
      transaction(db, () =>
        transaction(db, () => {
          throw new Error("y");
        }),
      ),
    ).toThrow();
    transaction(db, () => db.exec("INSERT INTO t VALUES (9)"));
    expect(count()).toBe(1);
    expect(db.isTransaction).toBe(false);
  });

  it("joins a transaction someone else opened and leaves committing to them", () => {
    const { db, count } = setup();
    db.exec("BEGIN");
    transaction(db, () => db.exec("INSERT INTO t VALUES (1)"));
    expect(db.isTransaction).toBe(true);
    db.exec("ROLLBACK");
    expect(count()).toBe(0);
  });

  it("refuses an asynchronous function and rolls it back", () => {
    const { db, count } = setup();
    expect(() =>
      transaction(db, () => {
        db.exec("INSERT INTO t VALUES (1)");
        return Promise.resolve(1) as unknown as number;
      }),
    ).toThrow(/asynchronous/);
    expect(count()).toBe(0);
    expect(db.isTransaction).toBe(false);
  });
});

describe("openDatabaseReadOnly", () => {
  it("reads a database as it is, and refuses every write", () => {
    const file = join(dir, "ro.db");
    const rw = openDatabase(file);
    createRepository(rw).seedDemoUsers();
    rw.close();

    const db = openDatabaseReadOnly(file);
    expect(createRepository(db).listUsers().length).toBeGreaterThan(0);
    expect(pragma(db, "query_only")).toBe(1);
    expect(() => db.exec("DELETE FROM users")).toThrow(/readonly|read-only|read only/i);
    expect(() => db.exec("CREATE TABLE zz (x TEXT)")).toThrow();
    // The repository, which writes through the same connection, is refused as well.
    expect(() => createRepository(db).seedDemoUsers()).toThrow(/readonly/);
    expect(() =>
      createRepository(db).createMatter({
        name: "n",
        clientLegalName: "c",
        createdBy: "usr_demo_associate",
      }),
    ).toThrow();
    db.close();
    expect(createRepository(openDatabase(file)).listMatterIds()).toEqual([]);
  });

  it("applies no migration to a database that is one migration behind, and reads it as it is", () => {
    const migrations = copyMigrations();
    const files = loadMigrationFiles(migrations);
    const last = files[files.length - 1]!;
    rmSync(join(migrations, `${String(last.version).padStart(3, "0")}_${last.name}.sql`));
    const file = join(dir, "behind.db");
    openDatabase(file, { migrationsDir: migrations }).close();

    const db = openDatabaseReadOnly(file);
    const versions = (
      db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]
    ).map((row) => row.version);
    expect(versions).toEqual(files.slice(0, -1).map((f) => f.version));
    // The audit log is there to be read, though the newest migration is not applied.
    expect(db.prepare("SELECT count(*) AS n FROM audit_events").get()).toEqual({ n: 0 });
    db.close();
    const after = openDatabase(file, { migrationsDir: migrations });
    expect(
      (after.prepare("SELECT version FROM schema_migrations").all() as { version: number }[])
        .length,
    ).toBe(files.length - 1);
    after.close();
  });

  it("refuses a missing file without creating it, and a file that is not Parol's", () => {
    const missing = join(dir, "missing.db");
    expect(() => openDatabaseReadOnly(missing)).toThrow(StoreError);
    try {
      openDatabaseReadOnly(missing);
    } catch (error) {
      expect((error as StoreError).code).toBe("no_database");
    }
    expect(() => statSync(missing)).toThrow();
    for (const bad of ["", ":memory:"]) {
      try {
        openDatabaseReadOnly(bad);
        throw new Error("opened");
      } catch (error) {
        expect((error as StoreError).code).toBe("no_database");
      }
    }

    // An SQLite file with other tables.
    const other = join(dir, "other.db");
    const foreign = new DatabaseSync(other);
    foreign.exec("CREATE TABLE unrelated (x TEXT)");
    foreign.close();
    try {
      openDatabaseReadOnly(other);
      throw new Error("opened");
    } catch (error) {
      expect(error).toBeInstanceOf(StoreError);
      expect((error as StoreError).code).toBe("not_a_parol_database");
      expect((error as Error).message).not.toContain("unrelated");
    }

    // A file that is not SQLite at all, and one that is empty.
    const text = join(dir, "text.db");
    writeFileSync(text, "SECRET-CONTENT this is plain text");
    for (const file of [text]) {
      try {
        openDatabaseReadOnly(file);
        throw new Error("opened");
      } catch (error) {
        expect((error as StoreError).code).toBe("not_a_parol_database");
        expect((error as Error).message).not.toContain("SECRET-CONTENT");
      }
    }
    const empty = join(dir, "empty.db");
    writeFileSync(empty, "");
    expect(() => openDatabaseReadOnly(empty)).toThrow(StoreError);
  });

  it("gives the files the owner-only mode that openDatabase gives them", () => {
    const file = join(dir, "mode.db");
    openDatabase(file).close();
    chmodSync(file, 0o644);
    openDatabaseReadOnly(file).close();
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
