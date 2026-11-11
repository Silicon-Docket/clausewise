import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashOf, sha256Hex } from "../../src/canonical.js";
import { REASON_CODES } from "../../src/contracts.js";
import { createRepository, openDatabase } from "../../src/store/index.js";
import {
  ACTORS,
  PLAYBOOK_YAML,
  RULES,
  WORKFLOW_MANIFEST,
  makeClock,
  makeWorld,
  reviewable,
  seedPrompts,
  type World,
} from "./fixtures.js";

/**
 * Migration 006, the part of the reason code and the minor-edit mark (package W2.6a, slice A).
 * A decision records why it was an edit or a reject, and whether an edit was minor, in two columns
 * of its own row; the database refuses a new decision that breaks the rules, whoever writes it, and
 * decisions made before the migration keep the two columns empty. The later slices add the tests of
 * their parts below.
 */

const REVIEW_MESSAGE = /an edit or reject carries a reason code, and an edit a minor-edit mark/;

let w: World;
beforeEach(() => {
  w = makeWorld();
});

/** Three findings of one matter, undecided. */
function findings() {
  const r = reviewable(w);
  return { matterId: r.m.id, list: r.findings };
}

/**
 * Writes a decision row by hand, as code that bypasses the repository would. `over` changes the
 * columns of the row; the finding is the first of the matter unless `over` names another. A row that
 * goes in is made stale straight away so that the next one can go in beside it.
 */
function insertReview(matterId: string, findingId: string, over: Record<string, SQLInputValue>) {
  const row: Record<string, SQLInputValue> = {
    id: `rev_${sha256Hex(JSON.stringify(over) + findingId).slice(0, 16)}`,
    finding_id: findingId,
    matter_id: matterId,
    reviewer_id: ACTORS.reviewer,
    decision: "accept",
    edited_json: null,
    reason: null,
    reason_code: null,
    minor_edit: null,
    finding_content_sha256: sha256Hex("the content the reviewer saw"),
    supersedes_review_id: null,
    validity: "current",
    created_at: "2026-11-02T10:00:00.000Z",
    ...over,
  };
  const columns = Object.keys(row);
  return () => {
    w.db
      .prepare(
        `INSERT INTO reviews (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      )
      .run(...columns.map((c) => row[c] as SQLInputValue));
    w.db.prepare("UPDATE reviews SET validity = 'stale' WHERE id = ?").run(row["id"] as string);
  };
}

describe("a new decision, at the database", () => {
  it("records a reason code exactly when it is an edit or a reject, whoever writes the row", () => {
    const { matterId, list } = findings();
    const f = list[0]!.id;
    // An edit or a reject with no code is refused, whatever else the row holds.
    for (const decision of ["edit", "reject"])
      expect(
        insertReview(matterId, f, {
          decision,
          reason: "r",
          edited_json: decision === "edit" ? '{"discrepancy":"x"}' : null,
          minor_edit: decision === "edit" ? 0 : null,
        }),
        decision,
      ).toThrow(REVIEW_MESSAGE);
    // An accept or an escalate with one is refused too.
    for (const decision of ["accept", "escalate"])
      expect(
        insertReview(matterId, f, { decision, reason: "r", reason_code: "other" }),
        decision,
      ).toThrow(REVIEW_MESSAGE);
    // With the right shape each goes in, one code at a time.
    for (const code of REASON_CODES)
      expect(
        insertReview(matterId, f, {
          decision: "reject",
          reason: "r",
          reason_code: code,
        }),
        code,
      ).not.toThrow();
    expect(
      insertReview(matterId, f, {
        decision: "edit",
        reason: "r",
        reason_code: "other",
        edited_json: '{"discrepancy":"x"}',
        minor_edit: 0,
      }),
    ).not.toThrow();
    expect(insertReview(matterId, f, { decision: "accept" })).not.toThrow();
    expect(insertReview(matterId, f, { decision: "escalate", reason: "r" })).not.toThrow();
  });

  it("refuses a reason code outside the six, and a mark that is not 0 or 1", () => {
    const { matterId, list } = findings();
    const f = list[0]!.id;
    for (const code of ["", "Other", "wrong status", "wrong_evidence ", "none", "unknown"])
      expect(
        insertReview(matterId, f, { decision: "reject", reason: "r", reason_code: code }),
        JSON.stringify(code),
      ).toThrow(/CHECK constraint failed/);
    for (const mark of [2, -1, "yes"])
      expect(
        insertReview(matterId, f, {
          decision: "edit",
          reason: "r",
          reason_code: "other",
          edited_json: '{"discrepancy":"x"}',
          minor_edit: mark,
        }),
        String(mark),
      ).toThrow(/CHECK constraint failed/);
  });

  it("requires a minor-edit mark on an edit and none on the others", () => {
    const { matterId, list } = findings();
    const f = list[0]!.id;
    const edit = {
      decision: "edit",
      reason: "r",
      reason_code: "other",
      edited_json: '{"discrepancy":"x"}',
    };
    expect(insertReview(matterId, f, { ...edit })).toThrow(REVIEW_MESSAGE);
    expect(insertReview(matterId, f, { ...edit, minor_edit: 0 })).not.toThrow();
    expect(insertReview(matterId, f, { ...edit, minor_edit: 1 })).not.toThrow();
    for (const decision of ["accept", "reject", "escalate"])
      expect(
        insertReview(matterId, f, {
          decision,
          reason: "r",
          reason_code: decision === "reject" ? "other" : null,
          minor_edit: 0,
        }),
        decision,
      ).toThrow(REVIEW_MESSAGE);
  });

  it("refuses a minor edit that changes the status, however the row is written", () => {
    const { matterId, list } = findings();
    const f = list[0]!.id;
    const edit = { decision: "edit", reason: "r", reason_code: "wrong_status" };
    const message = /that changes the status is not a minor edit/;
    expect(
      insertReview(matterId, f, { ...edit, edited_json: '{"status":"compliant"}', minor_edit: 1 }),
    ).toThrow(message);
    expect(
      insertReview(matterId, f, {
        ...edit,
        edited_json: '{"discrepancy":"x","status":"missing"}',
        minor_edit: 1,
      }),
    ).toThrow(message);
    // A status edit that is not marked minor is an ordinary edit; a minor edit of anything else is fine.
    expect(
      insertReview(matterId, f, { ...edit, edited_json: '{"status":"compliant"}', minor_edit: 0 }),
    ).not.toThrow();
    for (const edits of [
      '{"discrepancy":"x"}',
      '{"fallbackLanguage":"y"}',
      '{"evidenceRoles":[{"evidenceId":"e","role":"supporting"}]}',
    ])
      expect(
        insertReview(matterId, f, { ...edit, edited_json: edits, minor_edit: 1 }),
        edits,
      ).not.toThrow();
  });

  it("never changes reason_code or minor_edit after the fact, and still lets a decision go stale", () => {
    const { matterId, list } = findings();
    const f = list[0]!.id;
    const id = "rev_kept_for_updates";
    w.db
      .prepare(
        `INSERT INTO reviews (id, finding_id, matter_id, reviewer_id, decision, edited_json, reason,
           reason_code, minor_edit, finding_content_sha256, validity, created_at)
         VALUES (?, ?, ?, ?, 'edit', '{"discrepancy":"x"}', 'r', 'unclear', 0, ?, 'current', ?)`,
      )
      .run(id, f, matterId, ACTORS.reviewer, sha256Hex("seen"), "2026-11-02T10:00:00.000Z");
    const update = (column: string, value: SQLInputValue) => () =>
      w.db.prepare(`UPDATE reviews SET ${column} = ? WHERE id = ?`).run(value, id);
    for (const [column, value] of [
      ["reason_code", "other"],
      ["reason_code", null],
      ["minor_edit", 1],
      ["minor_edit", null],
    ] as [string, SQLInputValue][])
      expect(update(column, value), `${column} ${String(value)}`).toThrow(
        /immutable except for validity/,
      );
    // A decision still goes from current to stale, which is all an update may do.
    expect(update("validity", "stale")).not.toThrow();
    expect(
      w.db.prepare("SELECT reason_code, minor_edit, validity FROM reviews WHERE id = ?").get(id),
    ).toEqual({
      reason_code: "unclear",
      minor_edit: 0,
      validity: "stale",
    });
  });

  it("replaces the content trigger under its own name, once, beside the two new ones", () => {
    const names = (
      w.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'reviews'")
        .all() as { name: string }[]
    ).map((t) => t.name);
    expect(names.filter((n) => n === "reviews_content_immutable")).toHaveLength(1);
    expect(names).toContain("reviews_feedback_shape");
    expect(names).toContain("reviews_minor_edit_not_status");
    // The ones of 002 are still there.
    for (const kept of [
      "reviews_no_replace",
      "reviews_same_matter",
      "reviews_start_current",
      "reviews_validity_forward",
    ])
      expect(names, kept).toContain(kept);
  });

  it("has the two columns, empty on a decision that says nothing of them", () => {
    const columns = (w.db.prepare("PRAGMA table_info(reviews)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(columns).toEqual(expect.arrayContaining(["reason_code", "minor_edit"]));
  });
});

describe("migration 006, the part of the reason code", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "parol-reason-code-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("upgrades a database made at version 5 with an old accept, edit and reject, and keeps them", () => {
    const old = join(dir, "migrations-to-5");
    mkdirSync(old);
    for (const name of [
      "001_init.sql",
      "002_integrity.sql",
      "003_ingest_warnings.sql",
      "004_usage_settled.sql",
      "005_retention.sql",
    ])
      copyFileSync(
        fileURLToPath(new URL(`../../migrations/${name}`, import.meta.url)),
        join(old, name),
      );
    const location = join(dir, "old.sqlite");

    // A database as the code before this migration left it: a reviewed matter with three decisions
    // written the way that code wrote them, with no reason code and no mark.
    const atFive = openDatabase(location, { migrationsDir: old });
    const clock = makeClock();
    const repo = createRepository(atFive, { now: clock.now });
    repo.seedDemoUsers();
    const playbook = repo.approvePlaybookVersion(
      repo.importPlaybookDraft(
        {
          slug: "test-playbook",
          version: "1.0.0",
          yaml: PLAYBOOK_YAML,
          sha256: sha256Hex(PLAYBOOK_YAML),
          rules: RULES,
        },
        { actorId: ACTORS.legalEngineer },
      ).id,
      { actorId: ACTORS.admin },
    );
    seedPrompts(repo);
    const workflow = repo.upsertWorkflowVersion({
      manifest: WORKFLOW_MANIFEST,
      sha256: hashOf(WORKFLOW_MANIFEST),
    });
    const world = { db: atFive, repo, clock, playbook, workflow } as unknown as World;
    const r = reviewable(world);
    const columnsBefore = (
      atFive.prepare("PRAGMA table_info(reviews)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(columnsBefore).not.toContain("reason_code");
    const [accepted, edited, rejected] = r.findings as [
      (typeof r.findings)[0],
      (typeof r.findings)[0],
      (typeof r.findings)[0],
    ];
    const insert = atFive.prepare(
      `INSERT INTO reviews (id, finding_id, matter_id, reviewer_id, decision, edited_json, reason,
         finding_content_sha256, validity, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'current', ?)`,
    );
    const at = "2026-11-02T10:00:00.000Z";
    insert.run(
      "rev_old_accept",
      accepted.id,
      r.m.id,
      ACTORS.reviewer,
      "accept",
      null,
      null,
      accepted.contentSha256,
      at,
    );
    insert.run(
      "rev_old_edit",
      edited.id,
      r.m.id,
      ACTORS.reviewer,
      "edit",
      '{"discrepancy":"Edited."}',
      "Edited long ago.",
      edited.contentSha256,
      at,
    );
    insert.run(
      "rev_old_reject",
      rejected.id,
      r.m.id,
      ACTORS.reviewer,
      "reject",
      null,
      "Rejected long ago.",
      rejected.contentSha256,
      at,
    );
    atFive.close();

    // Opened by the current code: the columns and the triggers are applied, the rows are untouched.
    const upgraded = openDatabase(location);
    const columns = (
      upgraded.prepare("PRAGMA table_info(reviews)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(["reason_code", "minor_edit"]));
    expect(
      upgraded
        .prepare(
          "SELECT id, decision, reason, reason_code, minor_edit, validity FROM reviews ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: "rev_old_accept",
        decision: "accept",
        reason: null,
        reason_code: null,
        minor_edit: null,
        validity: "current",
      },
      {
        id: "rev_old_edit",
        decision: "edit",
        reason: "Edited long ago.",
        reason_code: null,
        minor_edit: null,
        validity: "current",
      },
      {
        id: "rev_old_reject",
        decision: "reject",
        reason: "Rejected long ago.",
        reason_code: null,
        minor_edit: null,
        validity: "current",
      },
    ]);

    // Read by the current code, an old decision has no code and no mark, said as null and not as a guess.
    const after = createRepository(upgraded, { now: clock.now });
    const old_ = after.getFinding(r.m.id, edited.id)?.currentReview;
    expect(old_).toMatchObject({
      id: "rev_old_edit",
      decision: "edit",
      reasonCode: null,
      minorEdit: null,
    });
    expect(after.getFinding(r.m.id, rejected.id)?.currentReview).toMatchObject({
      reasonCode: null,
      minorEdit: null,
    });

    // The replaced trigger still lets an old decision go stale and holds the rest of it.
    expect(() =>
      upgraded.prepare("UPDATE reviews SET reason = 'edited' WHERE id = 'rev_old_edit'").run(),
    ).toThrow(/immutable except for validity/);
    expect(() =>
      upgraded.prepare("UPDATE reviews SET reason_code = 'other' WHERE id = 'rev_old_edit'").run(),
    ).toThrow(/immutable except for validity/);

    // A new decision on the same finding replaces the old one, and now needs its code.
    expect(() =>
      after.recordReview(r.m.id, rejected.id, {
        reviewerId: ACTORS.reviewer,
        decision: "reject",
        reason: "On reflection.",
        findingContentSha256: rejected.contentSha256,
      }),
    ).toThrow(/needs a reason code/);
    const again = after.recordReview(r.m.id, rejected.id, {
      reviewerId: ACTORS.reviewer,
      decision: "reject",
      reasonCode: "wrong_evidence",
      reason: "On reflection.",
      findingContentSha256: rejected.contentSha256,
    });
    expect(again).toMatchObject({
      reasonCode: "wrong_evidence",
      minorEdit: null,
      supersedesReviewId: "rev_old_reject",
    });
    expect(
      upgraded
        .prepare("SELECT id, validity FROM reviews WHERE finding_id = ? ORDER BY rowid")
        .all(rejected.id),
    ).toEqual([
      { id: "rev_old_reject", validity: "stale" },
      { id: again.id, validity: "current" },
    ]);
    // And the database itself refuses the old shape on a new row.
    expect(() =>
      upgraded
        .prepare(
          `INSERT INTO reviews (id, finding_id, matter_id, reviewer_id, decision, reason, finding_content_sha256, validity, created_at)
           VALUES ('rev_new_bad', ?, ?, ?, 'reject', 'r', ?, 'current', ?)`,
        )
        .run(accepted.id, r.m.id, ACTORS.reviewer, accepted.contentSha256, at),
    ).toThrow(REVIEW_MESSAGE);
    upgraded.close();
  });
});
