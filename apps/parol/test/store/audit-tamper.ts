import { canonicalJson, sha256Hex } from "../../src/canonical.js";
import type { Database } from "../../src/store/index.js";

/**
 * What a test does to the audit log to play the person who tampers with it. The log is protected by
 * triggers that refuse an update, a delete and a row that does not extend the chain; a test that
 * wants a broken log drops them first, as an attacker with write access to the file would. Nothing
 * here is used by the application.
 */

const TRIGGERS = [
  "audit_events_no_update",
  "audit_events_no_delete",
  "audit_events_no_replace",
  "audit_events_linked",
] as const;

/** Drops the four triggers, so that the log can be edited by raw SQL. */
export function dropAuditTriggers(db: Database): void {
  for (const name of TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
}

interface Row {
  seq: number;
  at: string;
  actor_id: string | null;
  matter_id: string | null;
  action: string;
  target_type: string;
  target_id: string;
  detail_json: string;
  prev_hash: string;
  hash: string;
}

/**
 * Rewrites the log from event `seq` on so that it still verifies: `edit` changes the first row, and
 * every hash from there is recomputed with the same rule the application uses (SHA-256 of the
 * previous hash and the canonical row). This is the attack the chain cannot see by itself, because
 * the hash is not keyed; only a head kept elsewhere can. Drops the triggers first.
 */
export function rewriteChainFrom(db: Database, seq: number, edit: (row: Row) => void): void {
  dropAuditTriggers(db);
  const rows = db
    .prepare("SELECT * FROM audit_events WHERE seq >= ? ORDER BY seq")
    .all(seq) as unknown as Row[];
  const before = db
    .prepare("SELECT hash FROM audit_events WHERE seq = ?")
    .get(seq - 1) as unknown as { hash: string } | undefined;
  let prev = before?.hash ?? "0".repeat(64);
  rows.forEach((row, index) => {
    if (index === 0) edit(row);
    row.prev_hash = prev;
    row.hash = sha256Hex(
      prev +
        canonicalJson({
          seq: row.seq,
          at: row.at,
          actor_id: row.actor_id,
          matter_id: row.matter_id,
          action: row.action,
          target_type: row.target_type,
          target_id: row.target_id,
          detail_json: row.detail_json,
        }),
    );
    db.prepare(
      `UPDATE audit_events SET at = ?, actor_id = ?, matter_id = ?, action = ?, target_type = ?,
         target_id = ?, detail_json = ?, prev_hash = ?, hash = ? WHERE seq = ?`,
    ).run(
      row.at,
      row.actor_id,
      row.matter_id,
      row.action,
      row.target_type,
      row.target_id,
      row.detail_json,
      row.prev_hash,
      row.hash,
      row.seq,
    );
    prev = row.hash;
  });
}
