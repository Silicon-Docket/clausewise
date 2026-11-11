import { afterAll, describe, expect, it } from "vitest";
import { REASON_CODES } from "../../src/contracts.js";
import { cleanup, decisionFor, makeWorld, reviewed } from "./support.js";

afterAll(cleanup);

/**
 * The feedback service and the review service together (package W2.6a). Slice A: the review
 * service carries the reason code and the minor-edit mark of a decision from the request to the
 * store and back into the finding's history, and nothing about who may decide changes. The later
 * slices add the tests of a missed issue, a note and the rating below.
 */

const errorOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
};

async function open() {
  const w = makeWorld();
  const run = await reviewed(w);
  const issues = w.services.runs.issues(run.am, run.runId);
  const dur = issues.find((i) => i.ruleKey === "dur-1")!;
  const seen = w.services.runs.finding(run.reviewerAm, dur.findingId);
  return { w, ...run, issues, dur, seen };
}

describe("decide, with the reason code and the minor-edit mark", () => {
  it("passes both through, and the finding's history shows them on the decision", async () => {
    const { w, reviewerAm, dur, seen } = await open();
    const edit = w.services.reviews.decide(reviewerAm, dur.findingId, {
      decision: "edit",
      findingContentSha256: seen.contentSha256,
      edits: { fallbackLanguage: "6.1 The obligations continue for two (2) years." },
      reason: "The parties agreed two years in February.",
      reasonCode: "missed_context",
      minorEdit: true,
    });
    expect(edit.reviews).toHaveLength(1);
    expect(edit.reviews[0]).toMatchObject({
      decision: "edit",
      validity: "current",
      reasonCode: "missed_context",
      minorEdit: true,
    });
    const reject = w.services.reviews.decide(reviewerAm, dur.findingId, {
      decision: "reject",
      findingContentSha256: seen.contentSha256,
      edits: null,
      reason: "On reflection, not a deviation.",
      reasonCode: "wrong_status",
      minorEdit: null,
    });
    expect(reject.reviews.map((r) => [r.decision, r.reasonCode, r.minorEdit, r.validity])).toEqual([
      ["edit", "missed_context", true, "stale"],
      ["reject", "wrong_status", null, "current"],
    ]);
    // The view of the same finding, read again, says the same: it is what is stored.
    expect(
      w.services.runs.finding(reviewerAm, dur.findingId).reviews.map((r) => r.reasonCode),
    ).toEqual(["missed_context", "wrong_status"]);
  });

  it("says nothing of either on an accept or an escalate, and the request may leave them out", async () => {
    const { w, reviewerAm, issues } = await open();
    const decided = issues.map((issue) => {
      const view = w.services.runs.finding(reviewerAm, issue.findingId);
      return w.services.reviews.decide(reviewerAm, issue.findingId, decisionFor(view));
    });
    for (const view of decided)
      for (const item of view.reviews) {
        expect(["accept", "escalate"]).toContain(item.decision);
        expect(item.reasonCode).toBeNull();
        expect(item.minorEdit).toBeNull();
      }
  });

  it("refuses an edit or a reject with no code, and a code on any other decision, and records nothing", async () => {
    const { w, reviewerAm, dur, seen } = await open();
    const decide = (request: object) =>
      errorOf(() =>
        w.services.reviews.decide(reviewerAm, dur.findingId, {
          findingContentSha256: seen.contentSha256,
          edits: null,
          reason: "A reason.",
          ...request,
        } as never),
      );
    expect(await decide({ decision: "reject" })).toMatchObject({ code: "reason_code_required" });
    expect(
      await decide({ decision: "edit", edits: { discrepancy: "x" }, reasonCode: null }),
    ).toMatchObject({ code: "reason_code_required" });
    for (const decision of ["accept", "escalate"])
      expect(await decide({ decision, reasonCode: "other" })).toMatchObject({
        code: "reason_code_not_allowed",
      });
    expect(await decide({ decision: "accept", minorEdit: false })).toMatchObject({
      code: "minor_edit_not_allowed",
    });
    expect(
      await decide({
        decision: "edit",
        edits: { status: seen.issue.status === "missing" ? "compliant" : "missing" },
        reasonCode: "wrong_status",
        minorEdit: true,
      }),
    ).toMatchObject({ code: "minor_edit_status" });
    expect(w.services.runs.finding(reviewerAm, dur.findingId).reviews).toEqual([]);
  });

  it("takes each of the six codes from a request, in the order the list gives them", async () => {
    const { w, reviewerAm, dur, seen } = await open();
    const seenCodes: (string | null | undefined)[] = [];
    for (const code of REASON_CODES) {
      const view = w.services.reviews.decide(reviewerAm, dur.findingId, {
        decision: "reject",
        findingContentSha256: seen.contentSha256,
        edits: null,
        reason: `Rejected as ${code}.`,
        reasonCode: code,
      });
      seenCodes.push(view.reviews.at(-1)?.reasonCode);
    }
    expect(seenCodes).toEqual([...REASON_CODES]);
  });

  it("leaves who may decide as it was: the viewer and the associate are refused, the segregation rule holds", async () => {
    const { w, am, matterId, runId, dur, seen } = await open();
    const request = {
      decision: "reject" as const,
      findingContentSha256: seen.contentSha256,
      edits: null,
      reason: "A reason.",
      reasonCode: "other" as const,
    };
    // The associate is not a reviewer, so a code does not make the decision theirs to take.
    expect(errorOf(() => w.services.reviews.decide(am, dur.findingId, request))).toMatchObject({
      name: "ForbiddenError",
      action: "review.decide",
    });
    // A reviewer who started the review is refused as before.
    w.repo.db
      .prepare("UPDATE matter_members SET role = 'reviewer' WHERE matter_id = ? AND user_id = ?")
      .run(matterId, w.associate.userId);
    const starter = w.grant(w.associate, matterId);
    expect(errorOf(() => w.services.reviews.decide(starter, dur.findingId, request))).toMatchObject(
      {
        name: "ForbiddenError",
        action: "review.segregation",
      },
    );
    expect(w.services.runs.finding(w.grant(w.reviewer, matterId), dur.findingId).reviews).toEqual(
      [],
    );
    expect(runId).toBeTruthy();
  });
});
