import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import JSZip from "jszip";
import { NO_MATTER_DATA, STORE_SCOPES } from "../../../../evals/src/parol/exposure/canary.js";
import type { Database } from "../../src/store/index.js";

/**
 * The helpers of the deletion-trace test (test/services/deletion-leaves-nothing.test.ts): which
 * table is which, and where anything of a deleted matter is still to be found. No vitest import,
 * so a script can use them too.
 *
 * The classification is the exposure suite's own (`STORE_SCOPES` and `NO_MATTER_DATA`, imported
 * from evals/src/parol/exposure/canary.ts, the direction the application's tests already take for
 * the probe tables). A table is classified once for both, and the exposure scan and this test stop
 * for the same new table.
 *
 * Nothing here returns a value from a row or a file. What it reports is `table.column`, a path
 * relative to the data folder, and which kind of thing was found there.
 */

/** Columns whose name says that the table's rows belong to a matter, a run or something under one. */
export const MATTER_KEY_COLUMNS = [
  "matter_id",
  "run_id",
  "finding_id",
  "span_id",
  "document_id",
  "document_version_id",
  "memo_id",
  "review_id",
] as const;

export interface TableClassification {
  /** In `STORE_SCOPES`, `audit_events` apart. */
  scoped: string[];
  /** In `NO_MATTER_DATA`. */
  global: string[];
  /** `audit_events`: it keeps ids on purpose and no text. */
  audit: string[];
  /** In neither list: a failure of the test that reads this. */
  unclassified: string[];
  /**
   * Declared as holding no matter data and yet: has a column that is a key of matter data, or a
   * foreign key to a table that is scoped.
   */
  badGlobal: string[];
}

const tablesOf = (db: Database): string[] =>
  (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as unknown as { name: string }[]
  ).map((row) => row.name);

const columnsOf = (db: Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info("${table}")`).all() as unknown as { name: string }[]).map(
    (column) => column.name,
  );

/**
 * Every table in the database, sorted into the lists above. `scopes` and `noData` default to the
 * exposure suite's; a test passes its own to show that the heuristics can fail.
 */
export function classifyTables(
  db: Database,
  lists: { scopes?: readonly string[]; noData?: readonly string[] } = {},
): TableClassification {
  const scopes = new Set(lists.scopes ?? STORE_SCOPES.map(([table]) => table));
  const noData = new Set(lists.noData ?? NO_MATTER_DATA);
  const result: TableClassification = {
    scoped: [],
    global: [],
    audit: [],
    unclassified: [],
    badGlobal: [],
  };
  for (const table of tablesOf(db)) {
    if (table === "audit_events") result.audit.push(table);
    else if (scopes.has(table)) result.scoped.push(table);
    else if (noData.has(table)) result.global.push(table);
    else result.unclassified.push(table);
  }
  for (const table of result.global) {
    const keyed = columnsOf(db, table).some((column) =>
      (MATTER_KEY_COLUMNS as readonly string[]).includes(column),
    );
    const references = (
      db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as unknown as { table: string }[]
    ).some((fk) => result.scoped.includes(fk.table));
    if (keyed || references) result.badGlobal.push(table);
  }
  return result;
}

export interface TraceQuery {
  db: Database;
  dataDir: string;
  matterId: string;
  /** Every id of every record of the matter, the matter's own included. */
  ids: readonly string[];
  /** Strings that were written only into this matter's text. */
  markers: readonly string[];
}

/**
 * Where something of the matter is still to be found, as strings that name the place and never
 * show what is there.
 *
 *   `table.column`          an id of the matter is in a column (the audit log is exempt: it keeps ids)
 *   `table.column (text)`   a marker is in a column (the audit log is not exempt)
 *   `path`                  a file or folder under the data folder has the matter's id in its path
 *   `path (text)`           a file under the data folder holds a marker, as bytes
 *   `path!part (text)`      a file is a zip package and one of its parts holds a marker
 *
 * The database file and its write-ahead log are read as bytes like any other file, so text that was
 * deleted from the tables but not yet from the file is found here.
 */
export async function findTraces(query: TraceQuery): Promise<string[]> {
  const found = new Set<string>();
  const { db, dataDir, matterId, ids, markers } = query;

  // The rows.
  for (const table of tablesOf(db)) {
    for (const column of columnsOf(db, table)) {
      const where = (needles: readonly string[]): string | null =>
        needles.length === 0
          ? null
          : needles.map(() => `instr(CAST("${column}" AS TEXT), ?) > 0`).join(" OR ");
      const idClause = table === "audit_events" ? null : where(ids);
      if (idClause !== null) {
        const row = db
          .prepare(`SELECT count(*) AS n FROM "${table}" WHERE ${idClause}`)
          .get(...ids) as unknown as { n: number };
        if (row.n > 0) found.add(`${table}.${column}`);
      }
      const markerClause = where(markers);
      if (markerClause !== null) {
        const row = db
          .prepare(`SELECT count(*) AS n FROM "${table}" WHERE ${markerClause}`)
          .get(...markers) as unknown as { n: number };
        if (row.n > 0) found.add(`${table}.${column} (text)`);
      }
    }
  }

  // The folder.
  const needles = markers.map((marker) => Buffer.from(marker, "utf8"));
  const holdsMarker = (bytes: Uint8Array): boolean =>
    needles.some((needle) => Buffer.from(bytes).includes(needle));
  const walk = async (dir: string): Promise<void> => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const rel = relative(dataDir, path).split(sep).join("/");
      if (rel.includes(matterId)) found.add(rel);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!stat.isFile()) continue;
      const bytes = readFileSync(path);
      if (holdsMarker(bytes)) found.add(`${rel} (text)`);
      // A Word package (the memo) deflates its text: look inside each part.
      if (bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
        try {
          const zip = await JSZip.loadAsync(bytes);
          for (const [name, file] of Object.entries(zip.files)) {
            if (file.dir) continue;
            if (holdsMarker(await file.async("nodebuffer"))) found.add(`${rel}!${name} (text)`);
          }
        } catch {
          // Not a package after all: the raw bytes were already searched.
        }
      }
    }
  };
  await walk(dataDir);
  return [...found].sort();
}

/** The number of rows in every table, by name, for a census taken before and after. */
export function censusOf(db: Database): Record<string, number> {
  return Object.fromEntries(
    tablesOf(db).map((table) => [
      table,
      (db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as unknown as { n: number }).n,
    ]),
  );
}

/**
 * The rows of `table` that its scope ties to the matter, counted. `scopes` defaults to the exposure
 * suite's `STORE_SCOPES`.
 */
export function rowsOfMatter(
  db: Database,
  table: string,
  matterId: string,
  scopes: readonly (readonly [table: string, where: string])[] = STORE_SCOPES,
): number {
  const scope = scopes.find(([name]) => name === table);
  if (scope === undefined) throw new Error(`no scope for ${table}`);
  const where = scope[1];
  const params = (where.match(/\?/g) ?? []).map(() => matterId);
  return (
    db.prepare(`SELECT count(*) AS n FROM "${table}" WHERE ${where}`).get(...params) as unknown as {
      n: number;
    }
  ).n;
}

/**
 * The scoped tables (the audit log apart) in which the matter has no row: tables that the fixture
 * never filled, so that their deletion is not being tested.
 */
export function unfilledTables(
  db: Database,
  matterId: string,
  scopes: readonly (readonly [table: string, where: string])[] = STORE_SCOPES,
): string[] {
  return scopes
    .map(([table]) => table)
    .filter((table) => table !== "audit_events" && rowsOfMatter(db, table, matterId, scopes) === 0);
}
