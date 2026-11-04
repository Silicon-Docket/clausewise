import { canonicalJson, sha256Hex } from "../canonical.js";
import { transaction, type Database } from "./db.js";
import { AuditDetailError, ValidationError } from "./errors.js";

/**
 * The audit log (docs/parol/06). Each event stores the hash of the one before it, so editing or
 * removing an event in the middle breaks every hash after it, and `verifyAuditChain` says where.
 *
 * What the log can say is limited in code, not by convention: a detail may hold ids, hashes, counts
 * and short codes, and nothing longer than 200 characters, so a quote or a clause cannot end up in
 * it by accident.
 */

export const GENESIS_HASH = "0".repeat(64);
export const MAX_DETAIL_STRING_LENGTH = 200;
export const MAX_DETAIL_DEPTH = 2;
/** Entries per object or array. A list of 8 rule keys fits; a pasted document does not. */
export const MAX_DETAIL_ENTRIES = 64;

export type AuditDetailValue =
  | string
  | number
  | boolean
  | null
  | AuditDetailValue[]
  | { [key: string]: AuditDetailValue | undefined };
export type AuditDetail = { [key: string]: AuditDetailValue | undefined };

/** The actions the store writes. Other modules may add dotted lower-case actions of their own. */
export const AUDIT_ACTIONS = [
  "matter.create",
  "matter.update",
  "matter.status",
  "matter.delete",
  "member.add",
  "document.add",
  "document.remove",
  "version.add",
  "version.operative",
  "version.stated_date",
  "inputs.changed",
  "run.create",
  "run.status",
  "finding.save",
  "review.decide",
  "memo.export",
  "playbook.import",
  "playbook.approve",
  "prompt.register",
  "workflow.register",
  "workflow.promote",
  "feedback.add",
  "eval.record",
] as const;

export interface AuditInput {
  at: string;
  actorId: string | null;
  matterId: string | null;
  /** Dotted lower case, such as `review.decide`. */
  action: string;
  /** What the event is about, such as `finding`. */
  targetType: string;
  targetId: string;
  detail?: AuditDetail;
}

export interface AuditEvent {
  seq: number;
  at: string;
  actorId: string | null;
  matterId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  detail: AuditDetail;
  prevHash: string;
  hash: string;
}

const ACTION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const TARGET_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
// Ids, span ids (`ver_x:p3`) and storage paths. No spaces and no punctuation that prose needs.
const ID = /^[A-Za-z0-9_.:/\-]{1,200}$/;

export function validateAuditDetail(detail: unknown): asserts detail is AuditDetail {
  if (!isPlainObject(detail)) throw new AuditDetailError("audit detail must be a plain object");
  walk(detail, 0);
}

// The messages name the problem and the nesting level and never the offending value or key,
// because the value is the thing that must not travel.
function walk(value: unknown, containerDepth: number): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > MAX_DETAIL_STRING_LENGTH)
      throw new AuditDetailError(
        `audit detail string longer than ${MAX_DETAIL_STRING_LENGTH} characters at nesting level ${containerDepth}`,
      );
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AuditDetailError("audit detail number is not finite");
    return;
  }
  const depth = containerDepth + 1;
  if (Array.isArray(value)) {
    if (depth > MAX_DETAIL_DEPTH)
      throw new AuditDetailError(`audit detail nested deeper than ${MAX_DETAIL_DEPTH} levels`);
    if (value.length > MAX_DETAIL_ENTRIES)
      throw new AuditDetailError(`audit detail list longer than ${MAX_DETAIL_ENTRIES} entries`);
    for (const item of value) {
      if (item === undefined) throw new AuditDetailError("audit detail list holds undefined");
      walk(item, depth);
    }
    return;
  }
  if (isPlainObject(value)) {
    if (depth > MAX_DETAIL_DEPTH)
      throw new AuditDetailError(`audit detail nested deeper than ${MAX_DETAIL_DEPTH} levels`);
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length > MAX_DETAIL_ENTRIES)
      throw new AuditDetailError(`audit detail object has more than ${MAX_DETAIL_ENTRIES} entries`);
    for (const [key, item] of entries) {
      if (key.length > MAX_DETAIL_STRING_LENGTH)
        throw new AuditDetailError(
          `audit detail key longer than ${MAX_DETAIL_STRING_LENGTH} characters at nesting level ${depth}`,
        );
      walk(item, depth);
    }
    return;
  }
  throw new AuditDetailError(`audit detail holds a value of type ${typeof value} that is not JSON`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

interface RawAuditRow {
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

function hashRow(row: Omit<RawAuditRow, "hash">): string {
  return sha256Hex(
    row.prev_hash +
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
}

const toEvent = (row: RawAuditRow): AuditEvent => ({
  seq: row.seq,
  at: row.at,
  actorId: row.actor_id,
  matterId: row.matter_id,
  action: row.action,
  targetType: row.target_type,
  targetId: row.target_id,
  detail: JSON.parse(row.detail_json) as AuditDetail,
  prevHash: row.prev_hash,
  hash: row.hash,
});

/**
 * Appends one event. It joins the caller's transaction when there is one, which is how a
 * repository method's change and its audit event commit or roll back together.
 */
export function appendAudit(db: Database, input: AuditInput): AuditEvent {
  if (!ACTION.test(input.action)) throw new ValidationError("audit_action", "bad audit action");
  if (!TARGET_TYPE.test(input.targetType))
    throw new ValidationError("audit_target_type", "bad audit target type");
  if (!ID.test(input.targetId)) throw new ValidationError("audit_target_id", "bad audit target id");
  if (input.actorId !== null && !ID.test(input.actorId))
    throw new ValidationError("audit_actor_id", "bad audit actor id");
  if (input.matterId !== null && !ID.test(input.matterId))
    throw new ValidationError("audit_matter_id", "bad audit matter id");
  const detail = input.detail ?? {};
  validateAuditDetail(detail);

  return transaction(db, () => {
    const last = db
      .prepare("SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1")
      .get() as unknown as { seq: number; hash: string } | undefined;
    // AUTOINCREMENT remembers the highest number it ever handed out, even after a row is gone.
    // Starting from that, a removed last event leaves a visible gap instead of being reused.
    const issued = db
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'audit_events'")
      .get() as unknown as { seq: number } | undefined;
    const seq = Math.max(last?.seq ?? 0, issued?.seq ?? 0) + 1;

    const row: Omit<RawAuditRow, "hash"> = {
      seq,
      at: input.at,
      actor_id: input.actorId,
      matter_id: input.matterId,
      action: input.action,
      target_type: input.targetType,
      target_id: input.targetId,
      detail_json: canonicalJson(detail),
      prev_hash: last?.hash ?? GENESIS_HASH,
    };
    const hash = hashRow(row);
    db.prepare(
      `INSERT INTO audit_events
         (seq, at, actor_id, matter_id, action, target_type, target_id, detail_json, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.seq,
      row.at,
      row.actor_id,
      row.matter_id,
      row.action,
      row.target_type,
      row.target_id,
      row.detail_json,
      row.prev_hash,
      hash,
    );
    return toEvent({ ...row, hash });
  });
}

export type AuditBreak =
  "sequence_gap" | "prev_hash_mismatch" | "hash_mismatch" | "bad_detail" | "truncated";

export type AuditChainResult =
  | { ok: true; events: number }
  | { ok: false; firstBrokenSeq: number; reason: AuditBreak; events: number };

/**
 * Walks the chain from the start and returns the first sequence number that does not hold. For an
 * event that is missing from the middle that is the missing number; for an event that was edited it
 * is the edited one; for events cut from the end it is the first number after the last survivor.
 *
 * A chain cannot prove it has not lost its newest events unless a head is kept somewhere else.
 * `sqlite_sequence` is that head here: it records the highest number ever issued. Someone who can
 * also edit that table can hide a truncation, which is the limit of a log kept in the same file
 * (docs/parol/06 lists central log shipping as deferred).
 */
export function verifyAuditChain(db: Database): AuditChainResult {
  let prevHash = GENESIS_HASH;
  let expectedSeq = 1;
  let events = 0;

  const rows = db
    .prepare(
      `SELECT seq, at, actor_id, matter_id, action, target_type, target_id, detail_json, prev_hash, hash
       FROM audit_events ORDER BY seq`,
    )
    .iterate() as Iterable<unknown>;

  for (const item of rows) {
    const row = item as RawAuditRow;
    const broken = (reason: AuditBreak, seq: number): AuditChainResult => ({
      ok: false,
      firstBrokenSeq: seq,
      reason,
      events,
    });
    if (row.seq !== expectedSeq) return broken("sequence_gap", expectedSeq);
    if (row.prev_hash !== prevHash) return broken("prev_hash_mismatch", row.seq);
    if (hashRow(row) !== row.hash) return broken("hash_mismatch", row.seq);
    try {
      validateAuditDetail(JSON.parse(row.detail_json));
    } catch {
      return broken("bad_detail", row.seq);
    }
    prevHash = row.hash;
    expectedSeq = row.seq + 1;
    events += 1;
  }

  const issued = db
    .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'audit_events'")
    .get() as unknown as { seq: number } | undefined;
  if (issued && issued.seq >= expectedSeq)
    return { ok: false, firstBrokenSeq: expectedSeq, reason: "truncated", events };
  return { ok: true, events };
}

export interface AuditFilter {
  matterId?: string;
  action?: string;
  afterSeq?: number;
  limit?: number;
}

export function listAuditEvents(db: Database, filter: AuditFilter = {}): AuditEvent[] {
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 1000), 1), 10_000);
  const rows = db
    .prepare(
      `SELECT seq, at, actor_id, matter_id, action, target_type, target_id, detail_json, prev_hash, hash
       FROM audit_events
       WHERE (?1 IS NULL OR matter_id = ?1)
         AND (?2 IS NULL OR action = ?2)
         AND seq > ?3
       ORDER BY seq
       LIMIT ?4`,
    )
    .all(filter.matterId ?? null, filter.action ?? null, filter.afterSeq ?? 0, limit);
  return (rows as unknown as RawAuditRow[]).map(toEvent);
}

export interface MatterAuditFilter {
  action?: string;
  afterSeq?: number;
  limit?: number;
}

export interface AuditPage {
  events: AuditEvent[];
  /**
   * The sequence number to pass as `afterSeq` for the next page, or null when this page reached
   * the end. A caller that ignores it can no longer mistake a cut-off listing for a complete one.
   */
  nextAfterSeq: number | null;
}

/**
 * One matter's events, oldest first. The matter id is required and checked, because the same
 * query with a null id would be the listing of every matter, and a route that forgot to pass the id
 * must get an error and not somebody else's events.
 */
export function listMatterAuditEvents(
  db: Database,
  matterId: string,
  filter: MatterAuditFilter = {},
): AuditPage {
  if (typeof matterId !== "string" || matterId.length === 0)
    throw new ValidationError("matter_required", "listing a matter's audit events needs a matter");
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 1000), 1), 10_000);
  // One more than asked for, to learn whether the page reached the end.
  const rows = db
    .prepare(
      `SELECT seq, at, actor_id, matter_id, action, target_type, target_id, detail_json, prev_hash, hash
       FROM audit_events
       WHERE matter_id = ?1
         AND (?2 IS NULL OR action = ?2)
         AND seq > ?3
       ORDER BY seq
       LIMIT ?4`,
    )
    .all(
      matterId,
      filter.action ?? null,
      filter.afterSeq ?? 0,
      limit + 1,
    ) as unknown as RawAuditRow[];
  const events = rows.slice(0, limit).map(toEvent);
  const last = events[events.length - 1];
  return {
    events,
    nextAfterSeq: rows.length > limit && last !== undefined ? last.seq : null,
  };
}
