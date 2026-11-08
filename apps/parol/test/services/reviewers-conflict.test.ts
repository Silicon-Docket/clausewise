import { afterAll, describe, expect, it } from "vitest";
import { CANNOT_DECIDE } from "../../src/services/phrases.js";
import { cleanup, decisionFor, makeWorld, reviewed } from "./support.js";
import { addUser } from "../server/support-app.js";

afterAll(cleanup);

/**
 * Two reviewers on one matter. A decision is a reviewing attorney's, and the memo is built from the
 * decision that is current at export: another reviewer must not replace it without a word, in either
 * direction.
 */

async function twoReviewers() {
  const w = makeWorld();
  const run = await reviewed(w);
  addUser(w.repo, "usr_lee");
  w.repo.addMember(run.matterId, "usr_lee", "reviewer", { actorId: w.associate.userId });
  const lee = w.grant(w.principal("usr_lee"), run.matterId);
  const issue = w.services.runs.issues(run.am, run.runId).find((i) => i.ruleKey === "dur-1")!;
  return { w, ...run, lee, issue };
}

const errorOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
};

describe("a finding that one reviewer has decided", () => {
  it("is not replaced by another reviewer, who is told so, and the first decision stands", async () => {
    const { w, reviewerAm, lee, issue, am } = await twoReviewers();
    const seen = w.services.runs.finding(reviewerAm, issue.findingId);
    const dana = w.services.reviews.decide(reviewerAm, issue.findingId, {
      ...decisionFor(seen),
      decision: "accept",
      reason: null,
    });
    expect(dana.issue.review?.decision).toBe("accept");

    // Lee read the same finding, before Dana decided, and rejects it.
    const refused = errorOf(() =>
      w.services.reviews.decide(lee, issue.findingId, {
        decision: "reject",
        findingContentSha256: seen.contentSha256,
        edits: null,
        reason: "Not for this client.",
      }),
    );
    expect(refused).toMatchObject({ name: "ConflictError", code: "decision_conflict" });
    expect(JSON.stringify(refused)).not.toContain("Not for this client");

    const after = w.services.runs.finding(am, issue.findingId);
    expect(after.reviews).toHaveLength(1);
    expect(after.issue.review).toMatchObject({
      decision: "accept",
      reviewerName: dana.issue.review?.reviewerName,
    });
    expect(after.issue.review?.validity).toBe("current");
  });

  it("tells the second reviewer on the finding page that it is decided, and why they cannot", async () => {
    const { w, reviewerAm, lee, issue } = await twoReviewers();
    const seen = w.services.runs.finding(reviewerAm, issue.findingId);
    expect(seen.canDecide.allowed).toBe(true);
    w.services.reviews.decide(reviewerAm, issue.findingId, decisionFor(seen));
    expect(w.services.runs.finding(lee, issue.findingId).canDecide).toEqual({
      allowed: false,
      reason: CANNOT_DECIDE.decidedByAnother,
    });
    // The reviewer who made it can still change it.
    expect(w.services.runs.finding(reviewerAm, issue.findingId).canDecide.allowed).toBe(true);
  });

  it("can be changed by the reviewer who made it, and then that is the decision Lee is refused against", async () => {
    const { w, reviewerAm, lee, issue } = await twoReviewers();
    const seen = w.services.runs.finding(reviewerAm, issue.findingId);
    w.services.reviews.decide(reviewerAm, issue.findingId, decisionFor(seen));
    const second = w.services.reviews.decide(reviewerAm, issue.findingId, {
      decision: "reject",
      findingContentSha256: seen.contentSha256,
      edits: null,
      reason: "On reflection, no.",
    });
    expect(second.reviews.map((r) => r.validity)).toEqual(["stale", "current"]);
    // Lee never saw Dana's later decision, and posting from what he saw before is refused.
    expect(
      errorOf(() =>
        w.services.reviews.decide(lee, issue.findingId, {
          decision: "accept",
          findingContentSha256: seen.contentSha256,
          edits: null,
          reason: null,
        }),
      ),
    ).toMatchObject({ code: "decision_conflict" });
  });

  it("lets the other reviewer decide the findings the first has not", async () => {
    const { w, reviewerAm, lee, issue, am, runId } = await twoReviewers();
    const seen = w.services.runs.finding(reviewerAm, issue.findingId);
    w.services.reviews.decide(reviewerAm, issue.findingId, decisionFor(seen));
    const other = w.services.runs.issues(am, runId).find((i) => i.ruleKey !== "dur-1")!;
    const view = w.services.runs.finding(lee, other.findingId);
    expect(
      w.services.reviews.decide(lee, other.findingId, decisionFor(view)).issue.review,
    ).not.toBeNull();
  });
});
