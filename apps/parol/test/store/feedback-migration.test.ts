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
  addMatter,
  makeClock,
  makeWorld,
  reviewable,
  saveAll,
  seedPrompts,
  startRun,
  succeed,
  type World,
} from "./fixtures.js";

/**
 * Migration 006, the part of the reason code and the minor-edit mark (package W2.6a, slice A).
 * A decision records why it was an edit or a reject, and whether an edit was minor, in two columns
 * of its own row; the database refuses a new decision that breaks the rules, whoever writes it, and
 * decisions made before the migration keep the two columns empty.
 *
 * Slice B adds the second part of the same migration: the rule and the location of a missed issue,
 * the shape of each kind of feedback, one rating for each person and matter, and a table that is
 * written once. Its tests are the second half of this file.
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

// ---------------------------------------------------------------------------------------------
// Part 2 (slice B): the shape of each kind of feedback
// ---------------------------------------------------------------------------------------------

const SHAPE_MESSAGE = /feedback does not have the shape of its kind/;
const IMMUTABLE_MESSAGE = /feedback is never edited/;
const REPLACED_MESSAGE = /feedback is never replaced/;

/** A matter reviewed, its run, its first finding, and a second run of another matter. */
function feedbackWorld() {
  const r = reviewable(w);
  const other = reviewable(w, { name: "Another matter" });
  return {
    matterId: r.m.id,
    runId: r.run.id,
    findingId: r.findings[0]!.id,
    otherMatterId: other.m.id,
    otherRunId: other.run.id,
    otherFindingId: other.findings[0]!.id,
  };
}

let serial = 0;
/**
 * Writes a feedback row by hand, as code that bypasses the repository would, and returns a function
 * so that a test can say what it expects of it. `over` changes the columns of the row.
 */
function insertFeedback(over: Record<string, SQLInputValue>) {
  serial += 1;
  const row: Record<string, SQLInputValue> = {
    id: `fbk_by_hand_${serial}`,
    matter_id: "unset",
    run_id: null,
    finding_id: null,
    user_id: ACTORS.reviewer,
    kind: "comment",
    reason_code: null,
    rating: null,
    text: "A remark.",
    rule_key: null,
    location: null,
    created_at: "2026-11-02T10:00:00.000Z",
    ...over,
  };
  const columns = Object.keys(row);
  return () =>
    w.db
      .prepare(
        `INSERT INTO feedback (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      )
      .run(...columns.map((c) => row[c] as SQLInputValue));
}

describe("feedback, at the database: the shape of a missed issue", () => {
  it("needs a run, a text, and no finding and no reason code, whoever writes the row", () => {
    const f = feedbackWorld();
    const base = { matter_id: f.matterId, kind: "missed_issue", run_id: f.runId };
    expect(insertFeedback({ ...base, text: "The review missed a clause." })).not.toThrow();
    // No run: a report is about a review.
    expect(insertFeedback({ ...base, run_id: null, text: "x" })).toThrow(SHAPE_MESSAGE);
    // No text, or text that is only spaces.
    expect(insertFeedback({ ...base, text: null })).toThrow(SHAPE_MESSAGE);
    expect(insertFeedback({ ...base, text: "   " })).toThrow(SHAPE_MESSAGE);
    // A finding, or a reason code, belongs to other kinds.
    expect(insertFeedback({ ...base, text: "x", finding_id: f.findingId })).toThrow(SHAPE_MESSAGE);
    expect(insertFeedback({ ...base, text: "x", reason_code: "other" })).toThrow(SHAPE_MESSAGE);
    // A rating belongs to the rating.
    expect(insertFeedback({ ...base, text: "x", rating: 3 })).toThrow(SHAPE_MESSAGE);
  });

  it("names a rule of the playbook of its run, or none, and never the rule of a playbook it was not made with", () => {
    const f = feedbackWorld();
    const base = {
      matter_id: f.matterId,
      kind: "missed_issue",
      run_id: f.runId,
      text: "The review missed a clause.",
    };
    // No rule at all is "not covered by any rule".
    expect(insertFeedback({ ...base, rule_key: null })).not.toThrow();
    for (const key of ["pty-1", "dur-1", "gov-1"])
      expect(insertFeedback({ ...base, rule_key: key }), key).not.toThrow();
    // A key that is no rule of the playbook is refused, and so is a key with other letters.
    for (const key of ["zzz-9", "DUR-1", "dur-1 "])
      expect(insertFeedback({ ...base, rule_key: key }), key).toThrow(SHAPE_MESSAGE);
    // The rule of another playbook is not a rule of this run's: the match is on the run's own.
    const other = w.repo.approvePlaybookVersion(
      w.repo.importPlaybookDraft(
        {
          slug: "other-playbook",
          version: "1.0.0",
          yaml: `${PLAYBOOK_YAML}# other\n`,
          sha256: sha256Hex(`${PLAYBOOK_YAML}# other\n`),
          rules: RULES.map((rule) => ({ ...rule, key: `o${rule.key}` })),
        },
        { actorId: ACTORS.legalEngineer },
      ).id,
      { actorId: ACTORS.admin },
    );
    expect(w.repo.listRules(other.id).map((rule) => rule.key)).toContain("odur-1");
    expect(insertFeedback({ ...base, rule_key: "odur-1" })).toThrow(SHAPE_MESSAGE);
    // A run of another matter is not this matter's run: the older trigger of 002 still holds.
    expect(insertFeedback({ ...base, run_id: f.otherRunId })).toThrow(/its own matter/);
  });

  it("holds the length of the rule and of the location with a CHECK, and the text with the shape", () => {
    const f = feedbackWorld();
    const base = {
      matter_id: f.matterId,
      kind: "missed_issue",
      run_id: f.runId,
      text: "The review missed a clause.",
    };
    expect(insertFeedback({ ...base, location: "x".repeat(200) })).not.toThrow();
    expect(insertFeedback({ ...base, location: "x".repeat(201) })).toThrow(/CHECK constraint/);
    expect(insertFeedback({ ...base, location: "" })).toThrow(/CHECK constraint/);
    // A rule key of the wrong length is refused too. The shape trigger answers first (it runs
    // before the constraints and matches the key against the playbook), so it names the shape.
    expect(insertFeedback({ ...base, rule_key: "" })).toThrow();
    expect(insertFeedback({ ...base, rule_key: "x".repeat(65) })).toThrow();
    // The text is held to its 4,000 characters, and exactly 4,000 goes in.
    expect(insertFeedback({ ...base, text: "t".repeat(4000) })).not.toThrow();
    expect(insertFeedback({ ...base, text: "t".repeat(4001) })).toThrow(SHAPE_MESSAGE);
  });
});

describe("feedback, at the database: the other kinds", () => {
  it("keeps the rule and the location to a missed issue, and the rating to a rating", () => {
    const f = feedbackWorld();
    const comment = { matter_id: f.matterId, kind: "comment", text: "A remark." };
    expect(insertFeedback(comment)).not.toThrow();
    // A note on a finding is a comment with a finding and a run, and keeps its old shape.
    expect(insertFeedback({ ...comment, finding_id: f.findingId, run_id: f.runId })).not.toThrow();
    expect(insertFeedback({ ...comment, rule_key: "dur-1" })).toThrow(SHAPE_MESSAGE);
    expect(insertFeedback({ ...comment, location: "Section 6.1" })).toThrow(SHAPE_MESSAGE);
    expect(insertFeedback({ ...comment, rating: 4 })).toThrow(SHAPE_MESSAGE);
    // A rating needs its number, and takes no finding, no reason code, no rule and no location.
    const rating = { matter_id: f.matterId, kind: "rating", text: null, rating: 4 };
    expect(insertFeedback(rating)).not.toThrow();
    expect(insertFeedback({ ...rating, user_id: ACTORS.associate, rating: null })).toThrow(
      SHAPE_MESSAGE,
    );
    expect(
      insertFeedback({ ...rating, user_id: ACTORS.associate, finding_id: f.findingId }),
    ).toThrow(SHAPE_MESSAGE);
    expect(insertFeedback({ ...rating, user_id: ACTORS.associate, reason_code: "other" })).toThrow(
      SHAPE_MESSAGE,
    );
    expect(insertFeedback({ ...rating, user_id: ACTORS.associate, location: "x" })).toThrow(
      SHAPE_MESSAGE,
    );
    expect(insertFeedback({ ...rating, user_id: ACTORS.associate, rule_key: "dur-1" })).toThrow(
      SHAPE_MESSAGE,
    );
    // The reserved kind keeps the shape it had.
    expect(
      insertFeedback({
        matter_id: f.matterId,
        kind: "finding_reason",
        finding_id: f.findingId,
        run_id: f.runId,
        reason_code: "wrong_evidence",
        text: null,
      }),
    ).not.toThrow();
  });

  it("keeps a note on a finding to its own matter: a finding or a run of another matter is refused", () => {
    const f = feedbackWorld();
    const note = { matter_id: f.matterId, kind: "comment", text: "A note." };
    // The shape of a note on a finding (slice D) is the comment's, with its finding and its run.
    expect(insertFeedback({ ...note, finding_id: f.findingId, run_id: f.runId })).not.toThrow();
    // Not another matter's finding, and not another matter's run, by the trigger of 002.
    expect(insertFeedback({ ...note, finding_id: f.otherFindingId, run_id: f.runId })).toThrow(
      /feedback must refer to its own matter/,
    );
    expect(insertFeedback({ ...note, finding_id: f.findingId, run_id: f.otherRunId })).toThrow(
      /feedback must refer to its own matter/,
    );
    // Any number of them: the cap of twenty a person is the store's, not the database's.
    for (let i = 0; i < 25; i += 1)
      expect(
        insertFeedback({ ...note, finding_id: f.findingId, run_id: f.runId, text: `Note ${i}.` }),
      ).not.toThrow();
  });

  it("holds one rating for each person and matter in the index too, if the insert guard is gone", () => {
    const f = feedbackWorld();
    const rating = (over: Record<string, SQLInputValue>) =>
      insertFeedback({ kind: "rating", text: null, rating: 4, matter_id: f.matterId, ...over });
    w.db.exec("DROP TRIGGER feedback_no_replace");
    expect(rating({})).not.toThrow();
    expect(rating({ rating: 5 })).toThrow(/UNIQUE constraint failed/);
    expect(rating({ user_id: ACTORS.associate })).not.toThrow();
  });

  it("allows one rating for each person and matter, and any number of the rest", () => {
    const f = feedbackWorld();
    const rating = (over: Record<string, SQLInputValue>) =>
      insertFeedback({ kind: "rating", text: null, rating: 4, matter_id: f.matterId, ...over });
    expect(rating({})).not.toThrow();
    // The same person on the same matter, whatever the number: refused by the insert guard, which
    // runs before the index does (the index is tried on its own in the next test).
    expect(rating({ rating: 5 })).toThrow(REPLACED_MESSAGE);
    expect(rating({ run_id: f.runId })).toThrow(REPLACED_MESSAGE);
    // Another person on that matter, and that person on another matter, may rate.
    expect(rating({ user_id: ACTORS.associate })).not.toThrow();
    expect(rating({ matter_id: f.otherMatterId })).not.toThrow();
    // The index is for ratings: a person writes as many reports and comments as the application lets them.
    for (let i = 0; i < 3; i += 1) {
      expect(
        insertFeedback({ matter_id: f.matterId, kind: "comment", text: `A remark ${i}.` }),
      ).not.toThrow();
      expect(
        insertFeedback({
          matter_id: f.matterId,
          kind: "missed_issue",
          run_id: f.runId,
          text: `A miss ${i}.`,
        }),
      ).not.toThrow();
    }
  });
});

describe("feedback, at the database: a table that is written once", () => {
  it("never changes a row, whatever column is named, and says so", () => {
    const f = feedbackWorld();
    const write = insertFeedback({
      id: "fbk_fixed",
      matter_id: f.matterId,
      kind: "missed_issue",
      run_id: f.runId,
      text: "The review missed a clause.",
      rule_key: "dur-1",
      location: "NDA section 6.1",
    });
    write();
    for (const set of [
      "text = 'rewritten'",
      "location = 'elsewhere'",
      "rule_key = NULL",
      "rule_key = 'gov-1'",
      "user_id = 'usr_other'",
      "matter_id = 'mat_other'",
      "run_id = NULL",
      "kind = 'comment'",
      "created_at = '2030-01-01T00:00:00.000Z'",
      "id = 'fbk_renamed'",
    ])
      expect(
        () => w.db.prepare(`UPDATE feedback SET ${set} WHERE id = 'fbk_fixed'`).run(),
        set,
      ).toThrow(IMMUTABLE_MESSAGE);
    // A statement that changes no row is not a change, and the row is what it was.
    expect(
      w.db.prepare("SELECT text, rule_key, location FROM feedback WHERE id = 'fbk_fixed'").get(),
    ).toEqual({
      text: "The review missed a clause.",
      rule_key: "dur-1",
      location: "NDA section 6.1",
    });
  });

  it("never replaces a row: not by id, and not with INSERT OR REPLACE", () => {
    const f = feedbackWorld();
    const row = {
      id: "fbk_once",
      matter_id: f.matterId,
      kind: "comment",
      text: "Said once.",
    };
    insertFeedback(row)();
    expect(insertFeedback({ ...row, text: "Said again." })).toThrow(REPLACED_MESSAGE);
    expect(() =>
      w.db
        .prepare(
          `INSERT OR REPLACE INTO feedback (id, matter_id, user_id, kind, text, created_at)
           VALUES ('fbk_once', ?, ?, 'comment', 'Replaced.', '2026-11-02T10:00:00.000Z')`,
        )
        .run(f.matterId, ACTORS.reviewer),
    ).toThrow(REPLACED_MESSAGE);
    expect(w.db.prepare("SELECT text FROM feedback WHERE id = 'fbk_once'").get()).toEqual({
      text: "Said once.",
    });
  });

  it("never replaces a rating either: a new id that meets the one-rating index is refused, and the rating stays", () => {
    const f = feedbackWorld();
    const rating = (over: Record<string, SQLInputValue>) =>
      insertFeedback({ kind: "rating", text: null, matter_id: f.matterId, ...over });
    rating({ id: "fbk_a", rating: 2 })();
    // REPLACE on a key other than the id deletes the row that holds it, and no trigger of the other
    // kinds would see it: the index is the key, so the insert trigger has to.
    const replace = (id: string, user: string, matter: string) => () =>
      w.db
        .prepare(
          `INSERT OR REPLACE INTO feedback (id, matter_id, user_id, kind, rating, created_at)
           VALUES (?, ?, ?, 'rating', 5, '2026-11-02T10:00:00.000Z')`,
        )
        .run(id, matter, user);
    expect(replace("fbk_b", ACTORS.reviewer, f.matterId)).toThrow(REPLACED_MESSAGE);
    expect(
      w.db.prepare("SELECT id, rating FROM feedback WHERE matter_id = ?").all(f.matterId),
    ).toEqual([{ id: "fbk_a", rating: 2 }]);
    // The guard is for the one rating of a person and a matter and for nothing wider: the same
    // person on another matter, and another person on this one, still rate.
    expect(replace("fbk_c", ACTORS.reviewer, f.otherMatterId)).not.toThrow();
    expect(replace("fbk_d", ACTORS.associate, f.matterId)).not.toThrow();
    // A comment by that person is not a rating, so it is not stopped by the rating they gave.
    expect(
      insertFeedback({ matter_id: f.matterId, kind: "comment", text: "A remark." }),
    ).not.toThrow();
  });

  it("still lets the matter go with all of its feedback, and leaves the feedback of another", () => {
    const f = feedbackWorld();
    for (const matter of [f.matterId, f.otherMatterId])
      insertFeedback({
        matter_id: matter,
        kind: "comment",
        text: `A remark on ${matter}.`,
      })();
    const count = (id: string): number =>
      (
        w.db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE matter_id = ?").get(id) as {
          n: number;
        }
      ).n;
    expect([count(f.matterId), count(f.otherMatterId)]).toEqual([1, 1]);
    w.repo.deleteMatter(f.matterId, { actorId: ACTORS.associate });
    expect([count(f.matterId), count(f.otherMatterId)]).toEqual([0, 1]);
  });

  it("has the columns, the three indexes and the three triggers, beside the ones of 002", () => {
    const columns = (w.db.prepare("PRAGMA table_info(feedback)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(columns).toEqual(expect.arrayContaining(["rule_key", "location"]));
    const indexes = (
      w.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'feedback'")
        .all() as { name: string }[]
    ).map((i) => i.name);
    for (const name of [
      "feedback_by_matter",
      "feedback_one_rating_per_user",
      "feedback_by_run",
      "feedback_by_finding",
    ])
      expect(indexes, name).toContain(name);
    const triggers = (
      w.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'feedback'")
        .all() as { name: string }[]
    ).map((t) => t.name);
    expect(triggers.sort()).toEqual([
      "feedback_immutable",
      "feedback_no_replace",
      "feedback_same_matter",
      "feedback_shape",
    ]);
  });
});

describe("migration 006, the part of the feedback table", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "parol-feedback-shape-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("upgrades a database made at version 5 with every old kind of feedback, and keeps them as they were", () => {
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
    const m = addMatter(world);
    const run = startRun(world, m);
    saveAll(world, m, run);
    succeed(world, m, run);
    const columnsBefore = (
      atFive.prepare("PRAGMA table_info(feedback)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(columnsBefore).not.toContain("rule_key");

    // Feedback as the code before this migration wrote it, including a missed issue with no run
    // and a rating with text, which could not be written the same way now.
    const insert = atFive.prepare(
      `INSERT INTO feedback (id, matter_id, run_id, finding_id, user_id, kind, reason_code, rating, text, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?, '2026-11-02T10:00:00.000Z')`,
    );
    insert.run("fbk_old_missed", m.id, null, ACTORS.reviewer, "missed_issue", null, "No run.");
    insert.run("fbk_old_rating_1", m.id, null, ACTORS.reviewer, "rating", 3, null);
    insert.run("fbk_old_rating_2", m.id, run.id, ACTORS.associate, "rating", 5, "Again.");
    insert.run("fbk_old_comment", m.id, null, ACTORS.associate, "comment", null, "A remark.");
    atFive.close();

    const upgraded = openDatabase(location);
    expect(
      upgraded
        .prepare(
          "SELECT id, kind, run_id, rating, text, rule_key, location FROM feedback ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: "fbk_old_comment",
        kind: "comment",
        run_id: null,
        rating: null,
        text: "A remark.",
        rule_key: null,
        location: null,
      },
      {
        id: "fbk_old_missed",
        kind: "missed_issue",
        run_id: null,
        rating: null,
        text: "No run.",
        rule_key: null,
        location: null,
      },
      {
        id: "fbk_old_rating_1",
        kind: "rating",
        run_id: null,
        rating: 3,
        text: null,
        rule_key: null,
        location: null,
      },
      {
        id: "fbk_old_rating_2",
        kind: "rating",
        run_id: run.id,
        rating: 5,
        text: "Again.",
        rule_key: null,
        location: null,
      },
    ]);
    // The application reads the old rows with the new columns empty.
    const after = createRepository(upgraded, { now: clock.now });
    expect(after.listFeedback(m.id).map((row) => [row.id, row.ruleKey, row.location])).toEqual([
      ["fbk_old_missed", null, null],
      ["fbk_old_rating_1", null, null],
      ["fbk_old_rating_2", null, null],
      ["fbk_old_comment", null, null],
    ]);
    // An old row cannot be changed or replaced now, and a new row has to have its kind's shape.
    expect(() =>
      upgraded.prepare("UPDATE feedback SET text = 'x' WHERE id = 'fbk_old_comment'").run(),
    ).toThrow(IMMUTABLE_MESSAGE);
    expect(() =>
      after.addFeedback(m.id, { userId: ACTORS.reviewer, kind: "missed_issue", text: "No run." }),
    ).toThrow(/reported against a run/);
    expect(() =>
      upgraded
        .prepare(
          `INSERT INTO feedback (id, matter_id, user_id, kind, text, created_at)
           VALUES ('fbk_new_bad', ?, ?, 'missed_issue', 'No run.', '2026-11-03T10:00:00.000Z')`,
        )
        .run(m.id, ACTORS.reviewer),
    ).toThrow(SHAPE_MESSAGE);
    expect(
      after.addFeedback(m.id, {
        userId: ACTORS.reviewer,
        kind: "missed_issue",
        runId: run.id,
        ruleKey: "dur-1",
        location: "NDA section 6.1",
        text: "A new one.",
      }),
    ).toMatchObject({ ruleKey: "dur-1", location: "NDA section 6.1", runId: run.id });
    // One more rating by a person who has rated is refused from now on: by the store, which says so
    // in its own words, and by the database, which holds the same rule for anything that writes to
    // it another way (the index is the second line, and this is the proof that the old rows did
    // not stop it from being made).
    expect(() =>
      after.addFeedback(m.id, { userId: ACTORS.reviewer, kind: "rating", rating: 4 }),
    ).toThrow(/already rated/);
    const second = () =>
      upgraded
        .prepare(
          `INSERT INTO feedback (id, matter_id, user_id, kind, rating, created_at)
           VALUES ('fbk_new_second_rating', ?, ?, 'rating', 4, '2026-11-03T10:00:00.000Z')`,
        )
        .run(m.id, ACTORS.reviewer);
    expect(second).toThrow(/feedback is never replaced/);
    // The insert guard runs first. With it gone, the index is what refuses.
    upgraded.exec("DROP TRIGGER feedback_no_replace");
    expect(second).toThrow(/UNIQUE constraint failed/);
    upgraded.close();
  });

  it("is refused as a whole by a database that holds two ratings by one person for one matter, and leaves it at version 5", () => {
    // Nothing in the application could write that (it had no route to a rating), so this is a
    // database that someone changed by hand. The migration does not delete a row to make room for
    // its index: it stops, the file is left as it was, and the old code can still open it.
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
    const location = join(dir, "twice.sqlite");
    const atFive = openDatabase(location, { migrationsDir: old });
    const repo = createRepository(atFive, { now: makeClock().now });
    repo.seedDemoUsers();
    const matter = repo.createMatter({
      name: "A matter",
      clientLegalName: "A Client, Inc.",
      createdBy: ACTORS.associate,
    });
    const insert = atFive.prepare(
      `INSERT INTO feedback (id, matter_id, user_id, kind, rating, created_at)
       VALUES (?, ?, ?, 'rating', ?, '2026-11-02T10:00:00.000Z')`,
    );
    insert.run("fbk_twice_1", matter.id, ACTORS.reviewer, 3);
    insert.run("fbk_twice_2", matter.id, ACTORS.reviewer, 5);
    atFive.close();

    expect(() => openDatabase(location)).toThrow(/UNIQUE constraint failed/);
    const again = openDatabase(location, { migrationsDir: old });
    const columns = (again.prepare("PRAGMA table_info(feedback)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(columns).not.toContain("rule_key");
    expect(columns).not.toContain("location");
    expect((again.prepare("SELECT COUNT(*) AS n FROM feedback").get() as { n: number }).n).toBe(2);
    expect(
      (again.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v,
    ).toBe(5);
    again.close();
  });
});
