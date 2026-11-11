import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTORS, makeWorld, reviewable, type World } from "./fixtures.js";

/**
 * Feedback goes with its matter (package W2.6a). Slice A: the reason code and the minor-edit mark
 * are columns of the decision row, so they are deleted with it and cleared from the file by the
 * compaction that follows; the audit trail keeps the decision events with ids and codes only. The
 * later slices add what a missed issue, a note and a rating leave behind below.
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
