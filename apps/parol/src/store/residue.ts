import type { Database } from "./db.js";

/** What a table name must look like before it is quoted into a statement. */
const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * The tables (other than `audit_events`, which keeps ids on purpose) that have a `matter_id`
 * column and still hold a row of this matter. `deleteMatter` calls it after its last delete, inside
 * its transaction: a table that nobody taught `deleteMatter` about makes the deletion fail and roll
 * back, loudly, instead of quietly keeping a matter's data.
 *
 * Table names come from `sqlite_master`, never from a request, and are checked against
 * /^[a-z_][a-z0-9_]*$/ before they are quoted into the statement (a table cannot be a bound
 * parameter). The matter id is a bound parameter. This is the one place in the store that builds a
 * statement from schema identifiers; the rule "no SQL is assembled from a value" (context.ts) is
 * about values, and no value of a request reaches this one.
 *
 * Tables are listed in name order, so the answer is the same on every run.
 */
export function tablesHoldingMatter(db: Database, matterId: string): string[] {
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'audit_events' ORDER BY name",
      )
      .all() as unknown as { name: string }[]
  ).map((row) => row.name);

  const holding: string[] = [];
  for (const name of tables) {
    // A table with an odd name cannot be quoted safely: refuse to guess, and say it holds the matter.
    if (!TABLE_NAME.test(name)) {
      holding.push(name);
      continue;
    }
    const columns = db.prepare(`PRAGMA table_info("${name}")`).all() as unknown as {
      name: string;
    }[];
    if (!columns.some((column) => column.name === "matter_id")) continue;
    const row = db
      .prepare(`SELECT 1 AS found FROM "${name}" WHERE matter_id = ? LIMIT 1`)
      .get(matterId);
    if (row !== undefined) holding.push(name);
  }
  return holding;
}
