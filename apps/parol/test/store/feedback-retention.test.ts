import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTORS, makeWorld, reviewable, type World } from "./fixtures.js";

/**
 * Feedback goes with its matter (package W2.6a). Slice A: the reason code and the minor-edit mark
 * are columns of the decision row, so they are deleted with it and cleared from the file by the
 * compaction that follows; the audit trail keeps the decision events with ids and codes only.
 *
 * Slice B: a missed issue is a row of `feedback` with the rule, the place and the note a person
 * typed. It goes with its matter, the place and the note are cleared from the file by the
 * compaction, and the audit trail keeps the event with ids, the rule key and flags only. The later
 * slices add what a note and a rating leave behind below.
 */

let dir: string;
let w: World;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "parol-feedback-retention-"));
  w = makeWorld({ file: join(dir, "parol.sqlite") });
});
afterEach(() => {
  w.db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A matter with one edit marked minor, one reject and one accept, the words of each carrying `marker`. */
function decided(marker: string) {
  const r = reviewable(w, { name: `Matter ${marker}` });
  const [edited, rejected, accepted] = r.findings as [
    (typeof r.findings)[0],
    (typeof r.findings)[0],
    (typeof r.findings)[0],
  ];
  const decide = (f: typeof edited, over: Record<string, unknown>) =>
    w.repo.recordReview(r.m.id, f.id, {
      reviewerId: ACTORS.reviewer,
      findingContentSha256: f.contentSha256,
      ...over,
    } as never);
  const reviews = [
    decide(edited, {
      decision: "edit",
      reason: `The wording was changed. ${marker}`,
      reasonCode: "bad_fallback",
      minorEdit: true,
      edits: { fallbackLanguage: `Wording ${marker}` },
    }),
    decide(rejected, {
      decision: "reject",
      reason: `It does not hold. ${marker}`,
      reasonCode: "wrong_evidence",
    }),
    decide(accepted, { decision: "accept" }),
  ];
  return { ...r, reviews };
}

const count = (sql: string, ...args: string[]): number =>
  (w.db.prepare(sql).get(...args) as { n: number }).n;

describe("deleting a matter", () => {
  it("removes its reason codes and minor-edit marks with its decisions, and leaves another matter's untouched", () => {
    const doomed = decided("ZQ-DOOMED-0001");
    const kept = decided("ZQ-KEPT-0002");
    const coded = (matterId: string) =>
      count(
        "SELECT count(*) AS n FROM reviews WHERE matter_id = ? AND reason_code IS NOT NULL",
        matterId,
      );
    const marked = (matterId: string) =>
      count(
        "SELECT count(*) AS n FROM reviews WHERE matter_id = ? AND minor_edit IS NOT NULL",
        matterId,
      );
    expect([coded(doomed.m.id), marked(doomed.m.id)]).toEqual([2, 1]);
    expect([coded(kept.m.id), marked(kept.m.id)]).toEqual([2, 1]);

    w.repo.deleteMatter(doomed.m.id, { actorId: ACTORS.associate });

    expect(count("SELECT count(*) AS n FROM reviews WHERE matter_id = ?", doomed.m.id)).toBe(0);
    for (const review of doomed.reviews)
      expect(count("SELECT count(*) AS n FROM reviews WHERE id = ?", review.id)).toBe(0);
    // The other matter keeps what it had, code for code.
    expect([coded(kept.m.id), marked(kept.m.id)]).toEqual([2, 1]);
    expect(w.repo.getFinding(kept.m.id, kept.findings[0]!.id)?.currentReview).toMatchObject({
      decision: "edit",
      reasonCode: "bad_fallback",
      minorEdit: true,
    });
    // The deletion event counts the decisions it removed.
    expect(
      w.repo.listAuditEvents({ matterId: doomed.m.id, action: "matter.delete" })[0]?.detail,
    ).toMatchObject({ reviews: 3 });
  });

  it("leaves no word the reviewer typed in the database file once it is compacted", () => {
    const doomed = decided("ZQ-DOOMED-MARKER-7391");
    const raw = (): string => readFileSync(join(dir, "parol.sqlite")).toString("latin1");
    w.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(raw()).toContain("ZQ-DOOMED-MARKER-7391");

    w.repo.deleteMatter(doomed.m.id, { actorId: ACTORS.associate });
    w.repo.compact();
    w.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    expect(raw()).not.toContain("ZQ-DOOMED-MARKER-7391");
    for (const table of ["reviews", "audit_events"])
      expect(
        count(
          `SELECT count(*) AS n FROM ${table} WHERE instr(CAST(${table === "reviews" ? "reason" : "detail_json"} AS TEXT), ?) > 0`,
          "ZQ-DOOMED-MARKER-7391",
        ),
        table,
      ).toBe(0);
  });
});

describe("the audit trail", () => {
  it("keeps the decision events after the matter is deleted, with ids and codes and no text", () => {
    const doomed = decided("ZQ-TRAIL-MARKER-5522");
    const before = w.repo.listAuditEvents({ matterId: doomed.m.id, action: "review.decide" });
    expect(
      before.map((e) => [e.detail["decision"], e.detail["reasonCode"], e.detail["minorEdit"]]),
    ).toEqual([
      ["edit", "bad_fallback", true],
      ["reject", "wrong_evidence", null],
      ["accept", null, null],
    ]);

    w.repo.deleteMatter(doomed.m.id, { actorId: ACTORS.associate });

    const after = w.repo.listAuditEvents({ matterId: doomed.m.id, action: "review.decide" });
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain("ZQ-TRAIL-MARKER-5522");
    // The chain is whole, and the codes are all it says of why.
    expect(w.repo.verifyAuditChain().ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Slice B: a missed issue
// ---------------------------------------------------------------------------------------------

/** A matter with a report that names a rule, one that is not covered, a note on a finding, and a rating, each carrying `marker`. */
function reported(marker: string) {
  const r = reviewable(w, { name: `Matter ${marker}` });
  const add = (over: Record<string, unknown>) =>
    w.repo.addFeedback(r.m.id, { userId: ACTORS.reviewer, ...over } as never);
  const rows = [
    add({
      kind: "missed_issue",
      runId: r.run.id,
      ruleKey: "dur-1",
      location: `Location ${marker}`,
      text: `A report. ${marker}`,
    }),
    add({
      kind: "missed_issue",
      runId: r.run.id,
      userId: ACTORS.associate,
      text: `Another report. ${marker}`,
    }),
    // A note on a finding names the finding, which the deletion has to remove the note before.
    add({
      kind: "comment",
      runId: r.run.id,
      findingId: r.findings[0]!.id,
      text: `A note. ${marker}`,
    }),
    add({ kind: "rating", rating: 4, text: `A comment. ${marker}` }),
  ];
  return { ...r, rows };
}

describe("deleting a matter, with missed issues", () => {
  it("removes its reports with the rule, the place and the note, and leaves another matter's untouched", () => {
    const doomed = reported("ZQ-DOOMED-0001");
    const kept = reported("ZQ-KEPT-0002");
    const held = (matterId: string) =>
      count("SELECT count(*) AS n FROM feedback WHERE matter_id = ?", matterId);
    expect([held(doomed.m.id), held(kept.m.id)]).toEqual([4, 4]);
    const keptRows = w.repo.listFeedback(kept.m.id);

    w.repo.deleteMatter(doomed.m.id, { actorId: ACTORS.associate });

    expect(held(doomed.m.id)).toBe(0);
    for (const row of doomed.rows)
      expect(count("SELECT count(*) AS n FROM feedback WHERE id = ?", row.id)).toBe(0);
    // The other matter keeps every report, rule for rule and word for word.
    expect(w.repo.listFeedback(kept.m.id)).toEqual(keptRows);
    expect(w.repo.listFeedback(kept.m.id).map((f) => [f.kind, f.ruleKey])).toEqual([
      ["missed_issue", "dur-1"],
      ["missed_issue", null],
      ["comment", null],
      ["rating", null],
    ]);
    // The deletion event counts what it removed.
    expect(
      w.repo.listAuditEvents({ matterId: doomed.m.id, action: "matter.delete" })[0]?.detail,
    ).toMatchObject({ feedback: 4 });
  });

  it("leaves no word of a report in the database file once it is compacted, and the table can be deleted before the findings it names", () => {
    const doomed = reported("ZQ-DOOMED-MARKER-4410");
    const raw = (): string => readFileSync(join(dir, "parol.sqlite")).toString("latin1");
    w.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(raw()).toContain("ZQ-DOOMED-MARKER-4410");
    expect(
      count(
        "SELECT count(*) AS n FROM feedback WHERE instr(location, ?) > 0",
        "ZQ-DOOMED-MARKER-4410",
      ),
    ).toBe(1);

    // The note on a finding is a foreign key to it without a cascade: the deletion of the matter
    // has to remove feedback before findings, and a failure to would be an error here.
    expect(() => w.repo.deleteMatter(doomed.m.id, { actorId: ACTORS.associate })).not.toThrow();
    w.repo.compact();
    w.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    expect(raw()).not.toContain("ZQ-DOOMED-MARKER-4410");
    for (const column of ["text", "location", "rule_key"])
      expect(
        count(
          `SELECT count(*) AS n FROM feedback WHERE instr(CAST(${column} AS TEXT), ?) > 0`,
          "ZQ-DOOMED-MARKER-4410",
        ),
        column,
      ).toBe(0);
  });
});

describe("the audit trail, with missed issues", () => {
  it("keeps the events of the reports after the matter is deleted, with ids and the rule key and no text", () => {
    const doomed = reported("ZQ-TRAIL-MARKER-8801");
    const before = w.repo.listAuditEvents({ matterId: doomed.m.id, action: "feedback.add" });
    expect(before).toHaveLength(4);
    expect(
      before.map((e) => [
        e.detail["kind"],
        e.detail["ruleKey"],
        e.detail["hasText"],
        e.detail["hasLocation"],
      ]),
    ).toEqual([
      ["missed_issue", "dur-1", true, true],
      ["missed_issue", null, true, false],
      ["comment", null, true, false],
      ["rating", null, true, false],
    ]);

    w.repo.deleteMatter(doomed.m.id, { actorId: ACTORS.associate });

    const after = w.repo.listAuditEvents({ matterId: doomed.m.id, action: "feedback.add" });
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain("ZQ-TRAIL-MARKER-8801");
    expect(w.repo.verifyAuditChain().ok).toBe(true);
  });
});
