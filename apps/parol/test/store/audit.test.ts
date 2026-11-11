import { beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../../src/canonical.js";
import {
  AUDIT_ACTIONS,
  AUDIT_BREAK_TEXT,
  AuditDetailError,
  GENESIS_HASH,
  MAX_RECONCILIATION_IDS,
  ValidationError,
  appendAudit,
  auditHead,
  checkAudit,
  checkAuditAnchor,
  latestAuditEvent,
  listAuditEvents,
  openDatabase,
  reconcileMatterEvents,
  transaction,
  validateAuditDetail,
  verifyAuditChain,
  type Database,
} from "../../src/store/index.js";
import { ACTORS, makeWorld } from "./fixtures.js";
import { rewriteChainFrom } from "./audit-tamper.js";

let db: Database;
let n = 0;
const append = (
  detail: Record<string, unknown> = {},
  matterId: string | null = "mat_0000000000000001",
) =>
  appendAudit(db, {
    at: `2026-11-01T09:00:${String(n++ % 60).padStart(2, "0")}.000Z`,
    actorId: "usr_demo_associate",
    matterId,
    action: "review.decide",
    targetType: "finding",
    targetId: `fnd_${n}`,
    detail: detail as never,
  });

const seed = (count: number) => {
  for (let i = 0; i < count; i++) append({ i });
};

/** Lets a test play the attacker: the triggers are what the chain's tamper evidence sits behind. */
const dropAuditTriggers = () => {
  for (const name of [
    "audit_events_no_update",
    "audit_events_no_delete",
    "audit_events_no_replace",
    "audit_events_linked",
  ])
    db.exec(`DROP TRIGGER ${name}`);
};

beforeEach(() => {
  db = openDatabase();
  n = 0;
});

describe("appendAudit", () => {
  it("chains each event to the one before it, starting from the genesis hash", () => {
    const a = append({ step: 1 });
    const b = append({ step: 2 });
    expect(a.seq).toBe(1);
    expect(a.prevHash).toBe(GENESIS_HASH);
    expect(b.seq).toBe(2);
    expect(b.prevHash).toBe(a.hash);
    expect(b.hash).not.toBe(a.hash);
  });

  it("hashes sha256(prev_hash || canonical row), so the chain can be rebuilt independently", () => {
    const a = append({ b: 2, a: 1 });
    const expected = sha256Hex(
      GENESIS_HASH +
        canonicalJson({
          seq: a.seq,
          at: a.at,
          actor_id: a.actorId,
          matter_id: a.matterId,
          action: a.action,
          target_type: a.targetType,
          target_id: a.targetId,
          detail_json: '{"a":1,"b":2}',
        }),
    );
    expect(a.hash).toBe(expected);
  });

  it("carries actor id, matter id, action and target", () => {
    const event = append({ x: 1 });
    expect(event).toMatchObject({
      actorId: "usr_demo_associate",
      matterId: "mat_0000000000000001",
      action: "review.decide",
      targetType: "finding",
    });
    expect(listAuditEvents(db)).toHaveLength(1);
  });

  it("joins the caller's transaction, so a rollback takes the event with it", () => {
    append({ keep: true });
    expect(() =>
      transaction(db, () => {
        append({ lost: true });
        throw new Error("rolled back");
      }),
    ).toThrow();
    expect(listAuditEvents(db)).toHaveLength(1);
    // The next event continues the chain without a gap.
    append({ after: true });
    expect(verifyAuditChain(db)).toEqual({ ok: true, events: 2 });
  });

  it("filters by matter", () => {
    append({ i: 1 }, "mat_0000000000000001");
    append({ i: 2 }, "mat_0000000000000002");
    append({ i: 3 }, null);
    expect(listAuditEvents(db, { matterId: "mat_0000000000000002" })).toHaveLength(1);
    expect(listAuditEvents(db)).toHaveLength(3);
    expect(listAuditEvents(db, { afterSeq: 2 }).map((e) => e.seq)).toEqual([3]);
  });

  it("refuses malformed actions, targets and actors", () => {
    const base = {
      at: "t",
      actorId: null,
      matterId: null,
      action: "a.b",
      targetType: "x",
      targetId: "id",
    };
    expect(() => appendAudit(db, { ...base, action: "Review Decide" })).toThrow(ValidationError);
    expect(() => appendAudit(db, { ...base, action: "single" })).toThrow(ValidationError);
    expect(() => appendAudit(db, { ...base, targetType: "Bad Type" })).toThrow(ValidationError);
    // An id is not prose: a target id with spaces is how text would sneak in.
    expect(() => appendAudit(db, { ...base, targetId: "the indemnity clause" })).toThrow(
      ValidationError,
    );
    expect(() => appendAudit(db, { ...base, targetId: "x".repeat(201) })).toThrow(ValidationError);
    expect(() => appendAudit(db, { ...base, actorId: "someone with spaces" })).toThrow(
      ValidationError,
    );
    expect(() => appendAudit(db, { ...base, matterId: "a b" })).toThrow(ValidationError);
    expect(listAuditEvents(db)).toHaveLength(0);
  });
});

describe("detail limits", () => {
  it("allows a string of exactly 200 characters and refuses 201", () => {
    expect(() => append({ code: "x".repeat(200) })).not.toThrow();
    expect(() => append({ code: "x".repeat(201) })).toThrow(AuditDetailError);
  });

  it("allows two levels of nesting and refuses a third", () => {
    expect(() => append({ counts: { findings: 8 } })).not.toThrow();
    expect(() => append({ ids: ["a", "b"] })).not.toThrow();
    expect(() => append({ a: { b: { c: 1 } } })).toThrow(AuditDetailError);
    expect(() => append({ a: [[1]] })).toThrow(AuditDetailError);
    expect(() => append({ a: [{ b: 1 }] })).toThrow(AuditDetailError);
  });

  it("applies the string limit at every level, and to keys", () => {
    expect(() => append({ nested: { deep: "y".repeat(201) } })).toThrow(AuditDetailError);
    expect(() => append({ list: ["fine", "z".repeat(201)] })).toThrow(AuditDetailError);
    expect(() => append({ ["k".repeat(201)]: 1 })).toThrow(AuditDetailError);
  });

  it("refuses a pasted document broken into many small pieces", () => {
    expect(() => append({ pieces: Array.from({ length: 65 }, () => "words words words") })).toThrow(
      AuditDetailError,
    );
    expect(() =>
      append(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, 1]))),
    ).toThrow(AuditDetailError);
  });

  it("refuses values that are not plain JSON", () => {
    for (const bad of [
      new Date(),
      10n,
      () => 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Map(),
      Symbol("s"),
    ])
      expect(() => append({ bad })).toThrow(AuditDetailError);
    expect(() => append({ list: [undefined] })).toThrow(AuditDetailError);
    class Holder {
      secret = "x";
    }
    expect(() => append({ holder: new Holder() })).toThrow(AuditDetailError);
    expect(() => validateAuditDetail("not an object")).toThrow(AuditDetailError);
    expect(() => validateAuditDetail([1])).toThrow(AuditDetailError);
  });

  it("accepts null, booleans, numbers and skips undefined members", () => {
    const event = append({ a: null, b: true, c: 3.5, d: undefined, e: "ok" });
    expect(event.detail).toEqual({ a: null, b: true, c: 3.5, e: "ok" });
  });

  it("never puts the rejected value in the error, because the value is what must not travel", () => {
    const secret = "CLAUSE-TEXT-THAT-MUST-NOT-LEAK ".repeat(10);
    let message = "";
    try {
      append({ quote: secret });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain("CLAUSE-TEXT");
    try {
      append({ ["SECRET-KEY-".repeat(30)]: 1 });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain("SECRET-KEY");
    expect(listAuditEvents(db)).toHaveLength(0);
  });
});

describe("the append-only triggers", () => {
  it("refuse an update and a delete", () => {
    seed(2);
    expect(() => db.exec("UPDATE audit_events SET action = 'x.y' WHERE seq = 1")).toThrow(
      /append-only/,
    );
    expect(() => db.exec("DELETE FROM audit_events WHERE seq = 1")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM audit_events")).toThrow(/append-only/);
  });

  it("refuse INSERT OR REPLACE and an upsert onto an existing sequence number", () => {
    const first = append({ i: 1 });
    // The link is valid on purpose, so it is the replace guard that has to refuse, not the chain guard.
    const row = [
      first.seq,
      "t",
      null,
      null,
      "a.b",
      "x",
      "y",
      "{}",
      first.hash,
      "f".repeat(64),
    ] as const;
    const insert =
      "(seq, at, actor_id, matter_id, action, target_type, target_id, detail_json, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?)";
    expect(() => db.prepare(`INSERT OR REPLACE INTO audit_events ${insert}`).run(...row)).toThrow(
      /append-only/,
    );
    expect(() =>
      db
        .prepare(
          `INSERT INTO audit_events ${insert} ON CONFLICT(seq) DO UPDATE SET action = excluded.action`,
        )
        .run(...row),
    ).toThrow(/append-only/);
    expect(listAuditEvents(db)[0]?.action).toBe("review.decide");
  });

  it("refuse a row that does not extend the chain", () => {
    const first = append({ i: 1 });
    const insert = (prev: string) =>
      db
        .prepare(
          "INSERT INTO audit_events (at, actor_id, matter_id, action, target_type, target_id, detail_json, prev_hash, hash) VALUES ('t', NULL, NULL, 'a.b', 'x', 'y', '{}', ?, ?)",
        )
        .run(prev, "f".repeat(64));
    expect(() => insert(GENESIS_HASH)).toThrow(/does not extend the chain/);
    expect(() => insert("a".repeat(64))).toThrow(/does not extend the chain/);
    expect(() => insert(first.hash)).not.toThrow();
    // The database cannot compute SHA-256, so the forged hash is caught by verification instead.
    expect(verifyAuditChain(db)).toMatchObject({
      ok: false,
      firstBrokenSeq: 2,
      reason: "hash_mismatch",
    });
  });
});

describe("verifyAuditChain", () => {
  it("passes for an empty log and for an intact one", () => {
    expect(verifyAuditChain(db)).toEqual({ ok: true, events: 0 });
    seed(6);
    expect(verifyAuditChain(db)).toEqual({ ok: true, events: 6 });
  });

  it("detects an edited row and names it", () => {
    seed(6);
    dropAuditTriggers();
    db.exec(`UPDATE audit_events SET detail_json = '{"i":99}' WHERE seq = 3`);
    expect(verifyAuditChain(db)).toEqual({
      ok: false,
      firstBrokenSeq: 3,
      reason: "hash_mismatch",
      events: 2,
    });
  });

  it("detects an edit to any column, not only the detail", () => {
    for (const [column, value] of [
      ["actor_id", "'someone_else'"],
      ["matter_id", "'mat_ffffffffffffffff'"],
      ["action", "'review.forged'"],
      ["target_id", "'other'"],
      ["at", "'2000-01-01T00:00:00.000Z'"],
    ] as const) {
      db = openDatabase();
      n = 0;
      seed(4);
      dropAuditTriggers();
      db.exec(`UPDATE audit_events SET ${column} = ${value} WHERE seq = 2`);
      expect(verifyAuditChain(db)).toMatchObject({ ok: false, firstBrokenSeq: 2 });
    }
  });

  it("detects a deleted row and names the missing number", () => {
    seed(6);
    dropAuditTriggers();
    db.exec("DELETE FROM audit_events WHERE seq = 3");
    expect(verifyAuditChain(db)).toEqual({
      ok: false,
      firstBrokenSeq: 3,
      reason: "sequence_gap",
      events: 2,
    });
  });

  it("detects an edit that recomputes its own hash, one event later", () => {
    seed(5);
    dropAuditTriggers();
    const row = db.prepare("SELECT * FROM audit_events WHERE seq = 3").get() as Record<
      string,
      string | number | null
    >;
    const forged = '{"i":42}';
    const hash = sha256Hex(
      String(row.prev_hash) +
        canonicalJson({
          seq: row.seq,
          at: row.at,
          actor_id: row.actor_id,
          matter_id: row.matter_id,
          action: row.action,
          target_type: row.target_type,
          target_id: row.target_id,
          detail_json: forged,
        }),
    );
    db.prepare("UPDATE audit_events SET detail_json = ?, hash = ? WHERE seq = 3").run(forged, hash);
    expect(verifyAuditChain(db)).toMatchObject({
      ok: false,
      firstBrokenSeq: 4,
      reason: "prev_hash_mismatch",
    });
  });

  it("detects events cut from the end, which a bare chain cannot", () => {
    seed(5);
    dropAuditTriggers();
    db.exec("DELETE FROM audit_events WHERE seq > 3");
    expect(verifyAuditChain(db)).toEqual({
      ok: false,
      firstBrokenSeq: 4,
      reason: "truncated",
      events: 3,
    });
    db.exec("DELETE FROM audit_events");
    expect(verifyAuditChain(db)).toMatchObject({
      ok: false,
      firstBrokenSeq: 1,
      reason: "truncated",
    });
  });

  it("does not reuse the number of a removed last event when the log grows again", () => {
    seed(3);
    dropAuditTriggers();
    db.exec("DELETE FROM audit_events WHERE seq = 3");
    append({ after: true });
    const seqs = listAuditEvents(db).map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 4]);
    expect(verifyAuditChain(db)).toMatchObject({
      ok: false,
      firstBrokenSeq: 3,
      reason: "sequence_gap",
    });
  });

  it("detects a stored detail that breaks the limits", () => {
    seed(3);
    dropAuditTriggers();
    const row = db.prepare("SELECT * FROM audit_events WHERE seq = 2").get() as Record<
      string,
      string | number | null
    >;
    const long = JSON.stringify({ text: "q".repeat(500) });
    const hash = sha256Hex(
      String(row.prev_hash) +
        canonicalJson({
          seq: 2,
          at: row.at,
          actor_id: row.actor_id,
          matter_id: row.matter_id,
          action: row.action,
          target_type: row.target_type,
          target_id: row.target_id,
          detail_json: long,
        }),
    );
    db.prepare("UPDATE audit_events SET detail_json = ?, hash = ? WHERE seq = 2").run(long, hash);
    expect(verifyAuditChain(db)).toMatchObject({
      ok: false,
      firstBrokenSeq: 2,
      reason: "bad_detail",
    });
  });
});

describe("auditHead and latestAuditEvent", () => {
  it("is the last event, and null for an empty log", () => {
    expect(auditHead(db)).toBeNull();
    const first = append({ i: 1 });
    expect(auditHead(db)).toEqual({ seq: first.seq, hash: first.hash });
    const second = append({ i: 2 });
    expect(auditHead(db)).toEqual({ seq: second.seq, hash: second.hash });
  });

  it("finds the newest event with an action, or null", () => {
    expect(latestAuditEvent(db, "retention.run")).toBeNull();
    const run = (n: number) =>
      appendAudit(db, {
        at: "2026-11-01T09:00:00.000Z",
        actorId: null,
        matterId: null,
        action: "retention.run",
        targetType: "retention",
        targetId: "retention",
        detail: { n },
      });
    append({ other: true });
    run(1);
    const newest = run(2);
    append({ other: true });
    expect(latestAuditEvent(db, "retention.run")).toEqual(newest);
    expect(latestAuditEvent(db, "retention.run")?.detail).toEqual({ n: 2 });
    expect(latestAuditEvent(db, "matter.delete")).toBeNull();
  });

  it("lists the two retention actions among those the store writes", () => {
    expect(AUDIT_ACTIONS).toEqual(expect.arrayContaining(["matter.retention", "retention.run"]));
  });
});

describe("checkAuditAnchor", () => {
  it("holds for an event that is there with the hash it was given, and goes on holding as the log grows", () => {
    seed(4);
    const head = auditHead(db)!;
    expect(checkAuditAnchor(db, head)).toEqual({ ok: true });
    seed(3);
    expect(checkAuditAnchor(db, head)).toEqual({ ok: true });
  });

  it("is missing for an event past the end, and mismatched for another hash", () => {
    seed(4);
    const head = auditHead(db)!;
    expect(checkAuditAnchor(db, { seq: head.seq + 1, hash: head.hash })).toEqual({
      ok: false,
      reason: "anchor_missing",
    });
    expect(checkAuditAnchor(db, { seq: head.seq, hash: "0".repeat(64) })).toEqual({
      ok: false,
      reason: "anchor_mismatch",
    });
    expect(checkAuditAnchor(db, { seq: 0, hash: head.hash })).toEqual({
      ok: false,
      reason: "anchor_missing",
    });
  });

  it("sees a log rewritten with every later hash recomputed, which the chain by itself passes", () => {
    seed(6);
    const head = auditHead(db)!;
    rewriteChainFrom(db, 3, (row) => {
      row.detail_json = '{"rewritten":true}';
    });
    // The documented limit, kept as an assertion so that it is not forgotten: the hash is not keyed.
    expect(verifyAuditChain(db)).toEqual({ ok: true, events: 6 });
    expect(checkAuditAnchor(db, head)).toEqual({ ok: false, reason: "anchor_mismatch" });
    // An anchor taken before the edited event is not moved by it.
    expect(checkAuditAnchor(db, { seq: 2, hash: listAuditEvents(db)[1]!.hash })).toEqual({
      ok: true,
    });
  });

  it("sees events cut from the end even when the highest number issued was edited to match", () => {
    seed(6);
    const head = auditHead(db)!;
    db.exec("DROP TRIGGER audit_events_no_delete");
    db.exec("DELETE FROM audit_events WHERE seq > 3");
    db.exec("UPDATE sqlite_sequence SET seq = 3 WHERE name = 'audit_events'");
    expect(verifyAuditChain(db)).toEqual({ ok: true, events: 3 });
    expect(checkAuditAnchor(db, head)).toEqual({ ok: false, reason: "anchor_missing" });
  });
});

describe("reconcileMatterEvents and checkAudit", () => {
  it("counts the matters created, present and deleted, and finds none unaccounted for in a clean log", () => {
    const w = makeWorld();
    const a = w.repo.createMatter({ name: "a", clientLegalName: "c", createdBy: ACTORS.associate });
    const b = w.repo.createMatter({ name: "b", clientLegalName: "c", createdBy: ACTORS.associate });
    w.repo.createMatter({ name: "c", clientLegalName: "c", createdBy: ACTORS.associate });
    w.repo.deleteMatter(a.id, { actorId: ACTORS.admin });
    expect(reconcileMatterEvents(w.db)).toEqual({
      created: 3,
      present: 2,
      deleted: 1,
      goneWithoutDeleteEvent: { count: 0, ids: [] },
      presentWithoutCreateEvent: { count: 0, ids: [] },
      deletedButPresent: { count: 0, ids: [] },
    });
    expect(checkAudit(w.db)).toMatchObject({ ok: true, anchor: null, chain: { ok: true } });
    expect(checkAudit(w.db).head).toEqual(auditHead(w.db));
    expect(b.id).not.toBe(a.id);
  });

  it("names a matter removed by raw SQL without a deletion event, and fails the check", () => {
    const w = makeWorld();
    const a = w.repo.createMatter({ name: "a", clientLegalName: "c", createdBy: ACTORS.associate });
    w.repo.createMatter({ name: "b", clientLegalName: "c", createdBy: ACTORS.associate });
    w.db.prepare("DELETE FROM matters WHERE id = ?").run(a.id);
    const found = reconcileMatterEvents(w.db);
    expect(found.goneWithoutDeleteEvent).toEqual({ count: 1, ids: [a.id] });
    expect(found.deleted).toBe(0);
    const check = checkAudit(w.db);
    expect(check.chain.ok).toBe(true);
    expect(check.ok).toBe(false);
  });

  it("names a matter row that has no creation event, and one that has a deletion event and is still there", () => {
    const w = makeWorld();
    const a = w.repo.createMatter({ name: "a", clientLegalName: "c", createdBy: ACTORS.associate });
    const b = w.repo.createMatter({ name: "b", clientLegalName: "c", createdBy: ACTORS.associate });
    // A row made with SQL, with no event: copied from an existing one.
    const row = w.db.prepare("SELECT * FROM matters WHERE id = ?").get(b.id) as Record<
      string,
      string | number | null
    >;
    const columns = Object.keys(row);
    w.db
      .prepare(
        `INSERT INTO matters (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      )
      .run(
        ...columns.map((c) =>
          c === "id" ? "mat_cccccccccccccccc" : (row[c] as string | number | null),
        ),
      );
    // A deletion event for a matter that was not deleted.
    appendAudit(w.db, {
      at: "2026-11-01T09:00:00.000Z",
      actorId: null,
      matterId: a.id,
      action: "matter.delete",
      targetType: "matter",
      targetId: a.id,
      detail: {},
    });
    const found = reconcileMatterEvents(w.db);
    expect(found.presentWithoutCreateEvent).toEqual({ count: 1, ids: ["mat_cccccccccccccccc"] });
    expect(found.deletedButPresent).toEqual({ count: 1, ids: [a.id] });
    expect(checkAudit(w.db).ok).toBe(false);
  });

  it("gives the exact count and the ids of at most twenty", () => {
    const w = makeWorld();
    for (let i = 0; i < MAX_RECONCILIATION_IDS + 5; i++)
      w.repo.createMatter({ name: `m${i}`, clientLegalName: "c", createdBy: ACTORS.associate });
    w.db.exec("DELETE FROM matters");
    const found = reconcileMatterEvents(w.db).goneWithoutDeleteEvent;
    expect(found.count).toBe(MAX_RECONCILIATION_IDS + 5);
    expect(found.ids).toHaveLength(MAX_RECONCILIATION_IDS);
    expect([...found.ids].sort()).toEqual(found.ids);
  });

  it("fails the check for a chain that breaks, an anchor that does not hold, or both, and passes the anchor it is given", () => {
    const w = makeWorld();
    w.repo.createMatter({ name: "a", clientLegalName: "c", createdBy: ACTORS.associate });
    const head = auditHead(w.db)!;
    expect(checkAudit(w.db, { anchor: head })).toMatchObject({ ok: true, anchor: { ok: true } });
    expect(checkAudit(w.db, { anchor: { seq: head.seq, hash: "1".repeat(64) } })).toMatchObject({
      ok: false,
      chain: { ok: true },
      anchor: { ok: false, reason: "anchor_mismatch" },
    });
    w.db.exec("DROP TRIGGER audit_events_no_update");
    w.db.exec("UPDATE audit_events SET action = 'review.forged' WHERE seq = 1");
    expect(checkAudit(w.db)).toMatchObject({
      ok: false,
      chain: { ok: false, firstBrokenSeq: 1, reason: "hash_mismatch" },
    });
  });
});

describe("AUDIT_BREAK_TEXT", () => {
  it("has plain words for every way a check can break, and none of them names a row", () => {
    expect(Object.keys(AUDIT_BREAK_TEXT).sort()).toEqual(
      [
        "anchor_mismatch",
        "anchor_missing",
        "bad_detail",
        "hash_mismatch",
        "prev_hash_mismatch",
        "sequence_gap",
        "truncated",
      ].sort(),
    );
    for (const words of Object.values(AUDIT_BREAK_TEXT)) {
      expect(words).toMatch(/^[a-z][a-z' ]+$/);
      expect(words).not.toMatch(new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]"));
    }
  });
});
