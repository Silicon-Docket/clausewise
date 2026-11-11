import { afterAll, describe, expect, it } from "vitest";
import { MATTER_ACTIONS } from "../../src/auth/actions.js";
import type { AuthorizedMatter } from "../../src/auth/types.js";
import type { MatterRole } from "../../src/contracts.js";
import { REASON_CODES } from "../../src/contracts.js";
import { DEMO_USER_IDS } from "../../src/store/index.js";
import { cleanup, decisionFor, makeWorld, newMatter, reviewed, uploadCase } from "./support.js";

afterAll(cleanup);

/**
 * The feedback service and the review service together (package W2.6a). Slice A: the review
 * service carries the reason code and the minor-edit mark of a decision from the request to the
 * store and back into the finding's history, and nothing about who may decide changes.
 *
 * Slice B: the report of a missed issue. Any member may make one against a run of their matter that
 * has findings, naming a rule of that run's playbook or none, and it changes nothing about the
 * review: not a finding, not a decision, not the gate of the export. The rules to choose from, and
 * everything the caller may read of the matter's feedback, are read here too. The later slices add
 * the tests of a note and the rating below.
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

// ---------------------------------------------------------------------------------------------
// Slice B: a missed issue
// ---------------------------------------------------------------------------------------------

/** The matter of `open()` with a viewer on it (the engineer's demo identity, given that role). */
async function openWithViewer() {
  const r = await open();
  r.w.repo.addMember(r.matterId, DEMO_USER_IDS.legalEngineer, "viewer", {
    actorId: r.w.associate.userId,
  });
  return { ...r, viewerAm: r.w.grant(r.w.engineer, r.matterId) };
}

const NOTE = "The amendment deletes Section 6.1, and the review did not say so.";
/** A report that names no rule, with no place: the least a report is. */
const report = { ruleKey: null, location: null, note: NOTE } as const;

describe("reportMissedIssue", () => {
  it("lets an associate, a reviewer and a viewer each report, as themselves, and nobody else", async () => {
    const { w, am, reviewerAm, viewerAm, runId } = await openWithViewer();
    const by: Record<MatterRole, AuthorizedMatter> = {
      associate: am,
      reviewer: reviewerAm,
      viewer: viewerAm,
    };
    // The roles that may are the roles of the table, so a change of the table shows up here.
    expect(Object.keys(by).sort()).toEqual([...MATTER_ACTIONS["feedback.add"]].sort());
    for (const role of MATTER_ACTIONS["feedback.add"]) {
      const caller = by[role];
      const view = w.services.feedback.reportMissedIssue(caller, runId, {
        ruleKey: "dur-1",
        location: `Section 6.1, reported as ${role}`,
        note: NOTE,
      });
      expect(view).toMatchObject({
        runId,
        ruleKey: "dur-1",
        location: `Section 6.1, reported as ${role}`,
        note: NOTE,
        reporterName: w.repo.getUser(caller.principal.userId)?.displayName,
      });
      expect(view.at).toMatch(/^\d{4}-\d\d-\d\dT/);
    }
    expect(
      w.repo
        .listFeedback(am.matterId, { kind: "missed_issue" })
        .map((f) => f.userId)
        .sort(),
    ).toEqual([am, reviewerAm, viewerAm].map((x) => x.principal.userId).sort());
    // A caller whose role the table does not list is refused by the service itself.
    const nobody = { ...am, role: "nobody" } as unknown as AuthorizedMatter;
    expect(
      errorOf(() => w.services.feedback.reportMissedIssue(nobody, runId, report)),
    ).toMatchObject({ name: "ForbiddenError", action: "feedback.add" });
    expect(w.repo.listFeedback(am.matterId, { kind: "missed_issue" })).toHaveLength(3);
  });

  it("carries the title of the rule in the playbook of the run, and none for a miss that no rule covers", async () => {
    const { w, am, runId } = await open();
    const rule = w.repo
      .listRules(w.repo.getRun(am.matterId, runId)!.playbookVersionId)
      .find((r) => r.key === "dur-1")!;
    const named = w.services.feedback.reportMissedIssue(am, runId, {
      ruleKey: "dur-1",
      location: null,
      note: NOTE,
    });
    expect(named.ruleTitle).toBe(rule.title);
    expect(named.ruleTitle).toBeTruthy();
    const uncovered = w.services.feedback.reportMissedIssue(am, runId, {
      ruleKey: null,
      location: null,
      note: NOTE,
    });
    expect(uncovered).toMatchObject({ ruleKey: null, ruleTitle: null, location: null });
  });

  it("refuses a rule that is not in the playbook of the run, and says so in the store's code", async () => {
    const { w, am, runId } = await open();
    for (const ruleKey of ["not-a-rule", "DUR-1", "dur-1 ", "../dur-1"])
      expect(
        errorOf(() => w.services.feedback.reportMissedIssue(am, runId, { ...report, ruleKey })),
        ruleKey,
      ).toMatchObject({ name: "ValidationError", code: "unknown_rule" });
    expect(w.repo.listFeedback(am.matterId)).toEqual([]);
  });

  it("is a 404 for a run of another matter and for a run that is nowhere, in the same words", async () => {
    const { w, am, runId } = await open();
    const other = await reviewed(w);
    const foreign = errorOf(() => w.services.feedback.reportMissedIssue(am, other.runId, report));
    const nowhere = errorOf(() => w.services.feedback.reportMissedIssue(am, "run_nowhere", report));
    expect(foreign).toMatchObject({ name: "NotFoundError" });
    expect(nowhere).toMatchObject({ name: "NotFoundError" });
    expect((foreign as Error).message).toBe((nowhere as Error).message);
    expect(w.repo.listFeedback(am.matterId)).toEqual([]);
    expect(w.repo.listFeedback(other.matterId)).toEqual([]);
    // And it is still this matter's own run that works.
    expect(w.services.feedback.reportMissedIssue(am, runId, report).runId).toBe(runId);
  });

  it("is a 409 for a review that has no findings, and keeps nothing", async () => {
    const w = makeWorld();
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    // A review that is queued has produced nothing. It is made without being run.
    const manifest = w.repo.buildRunManifest(matterId, {
      workflowVersionId: w.repo.getWorkflowVersionByLabel("v2")!.id,
      modelProvider: "scripted",
      model: "scripted-1",
    });
    const empty = w.repo.createRun(matterId, { manifest, startedBy: w.associate.userId });
    expect(w.repo.listFindings(matterId, empty.id)).toEqual([]);
    expect(
      errorOf(() => w.services.feedback.reportMissedIssue(am, empty.id, report)),
    ).toMatchObject({ name: "ConflictError", code: "run_has_no_findings" });
    expect(w.repo.listFeedback(matterId)).toEqual([]);
    expect(w.repo.listAuditEvents({ matterId, action: "feedback.add" })).toEqual([]);
  });

  it("changes no finding, no decision, no status of the matter and nothing the export waits for", async () => {
    const { w, am, reviewerAm, matterId, runId } = await open();
    const issues = w.services.runs.issues(am, runId);
    const snapshot = () =>
      JSON.stringify({
        matter: w.services.matters.view(am),
        issues: w.services.runs.issues(am, runId),
        findings: issues.map((i) => w.services.runs.finding(reviewerAm, i.findingId)),
        readiness: w.repo.getExportReadiness(matterId, runId),
        memos: w.services.reviews.listMemos(reviewerAm),
      });
    const before = snapshot();
    for (const ruleKey of ["pty-1", "dur-1", null])
      w.services.feedback.reportMissedIssue(reviewerAm, runId, {
        ruleKey,
        location: null,
        note: NOTE,
      });
    expect(snapshot()).toBe(before);
    // The review can still be decided and exported: nothing was waiting on the reports.
    const decided = issues.map((issue) => {
      const view = w.services.runs.finding(reviewerAm, issue.findingId);
      return w.services.reviews.decide(reviewerAm, issue.findingId, decisionFor(view));
    });
    expect(decided).toHaveLength(issues.length);
    expect(w.repo.getExportReadiness(matterId, runId).ready).toBe(true);
  });

  it("writes the audit event of the report with ids and the rule key, and the words nowhere in it", async () => {
    const { w, am, runId } = await open();
    const place = "ZQ-PLACE-SERVICE-1";
    const note = "ZQ-NOTE-SERVICE-1 and what it says";
    const view = w.services.feedback.reportMissedIssue(am, runId, {
      ruleKey: "gov-1",
      location: place,
      note,
    });
    const [event] = w.repo.listAuditEvents({ matterId: am.matterId, action: "feedback.add" });
    expect(event).toMatchObject({
      actorId: am.principal.userId,
      targetId: view.feedbackId,
      detail: { kind: "missed_issue", ruleKey: "gov-1", runId, hasLocation: true, hasText: true },
    });
    expect(JSON.stringify(event)).not.toContain("ZQ-PLACE");
    expect(JSON.stringify(event)).not.toContain("ZQ-NOTE");
    expect(w.logs.join("\n")).not.toContain("ZQ-");
  });
});

describe("ruleChoices", () => {
  it("lists the rules of the playbook of the run, in the playbook's order, for every role", async () => {
    const { w, am, reviewerAm, viewerAm, runId } = await openWithViewer();
    const playbook = w.repo.getRun(am.matterId, runId)!.playbookVersionId;
    const expected = w.repo
      .listRules(playbook)
      .map((rule) => ({ ruleKey: rule.key, title: rule.title }));
    expect(expected.length).toBeGreaterThan(3);
    for (const caller of [am, reviewerAm, viewerAm])
      expect(w.services.feedback.ruleChoices(caller, runId)).toEqual(expected);
    // The order is the playbook's, not the alphabet's.
    expect(expected.map((r) => r.ruleKey)).not.toEqual(expected.map((r) => r.ruleKey).sort());
  });

  it("is a 404 for a run of another matter and for none, and a refusal for a caller with no role", async () => {
    const { w, am, runId } = await open();
    const other = await reviewed(w);
    expect(errorOf(() => w.services.feedback.ruleChoices(am, other.runId))).toMatchObject({
      name: "NotFoundError",
    });
    expect(errorOf(() => w.services.feedback.ruleChoices(am, "run_nowhere"))).toMatchObject({
      name: "NotFoundError",
    });
    const nobody = { ...am, role: "nobody" } as unknown as AuthorizedMatter;
    expect(errorOf(() => w.services.feedback.ruleChoices(nobody, runId))).toMatchObject({
      name: "ForbiddenError",
    });
  });
});

describe("list", () => {
  it("returns every report and every note of the matter, oldest first, and only the caller's own rating", async () => {
    const { w, am, reviewerAm, viewerAm, matterId, runId, dur } = await openWithViewer();
    w.services.feedback.reportMissedIssue(am, runId, {
      ruleKey: "dur-1",
      location: "Section 6.1",
      note: "ZQ-FIRST",
    });
    w.services.feedback.reportMissedIssue(reviewerAm, runId, {
      ruleKey: null,
      location: null,
      note: "ZQ-SECOND",
    });
    // A note and two ratings are written through the store: their services are the later slices'.
    w.repo.addFeedback(matterId, {
      userId: w.associate.userId,
      kind: "comment",
      runId,
      findingId: dur.findingId,
      text: "ZQ-NOTE",
    });
    w.repo.addFeedback(matterId, {
      userId: w.associate.userId,
      kind: "rating",
      rating: 5,
      text: "ZQ-ASSOCIATE-RATING",
    });
    w.repo.addFeedback(matterId, {
      userId: w.reviewer.userId,
      kind: "rating",
      rating: 2,
      text: "ZQ-REVIEWER-RATING",
    });
    // A comment with no finding is not a note on a finding.
    w.repo.addFeedback(matterId, { userId: w.associate.userId, kind: "comment", text: "ZQ-LOOSE" });

    const seen = w.services.feedback.list(reviewerAm);
    expect(seen.missedIssues.map((m) => [m.note, m.ruleKey, m.ruleTitle !== null])).toEqual([
      ["ZQ-FIRST", "dur-1", true],
      ["ZQ-SECOND", null, false],
    ]);
    expect(seen.missedIssues.map((m) => m.reporterName)).toEqual([
      w.repo.getUser(w.associate.userId)?.displayName,
      w.repo.getUser(w.reviewer.userId)?.displayName,
    ]);
    expect(seen.notes.map((n) => [n.note, n.findingId])).toEqual([["ZQ-NOTE", dur.findingId]]);
    expect(seen.myRating).toMatchObject({ rating: 2, comment: "ZQ-REVIEWER-RATING" });
    // Another person's rating is nowhere in what a caller reads: not its number, not its words.
    expect(JSON.stringify(seen)).not.toContain("ZQ-ASSOCIATE-RATING");
    expect(JSON.stringify(seen)).not.toContain("ZQ-LOOSE");
    expect(w.services.feedback.list(am).myRating).toMatchObject({ rating: 5 });
    expect(JSON.stringify(w.services.feedback.list(am))).not.toContain("ZQ-REVIEWER-RATING");
    // A viewer, who has not rated, reads the reports and the notes and no rating at all.
    const viewer = w.services.feedback.list(viewerAm);
    expect(viewer.myRating).toBeNull();
    expect(viewer.missedIssues).toHaveLength(2);
    expect(JSON.stringify(viewer)).not.toContain("RATING");
  });

  it("reads only the matter's own feedback, and is empty for a matter with none", async () => {
    const { w, am, runId } = await open();
    const other = await reviewed(w);
    w.services.feedback.reportMissedIssue(other.am, other.runId, {
      ...report,
      note: "ZQ-ELSEWHERE",
    });
    expect(w.services.feedback.list(am)).toEqual({ missedIssues: [], notes: [], myRating: null });
    w.services.feedback.reportMissedIssue(am, runId, report);
    expect(w.services.feedback.list(am).missedIssues).toHaveLength(1);
    expect(JSON.stringify(w.services.feedback.list(am))).not.toContain("ZQ-ELSEWHERE");
    const nobody = { ...am, role: "nobody" } as unknown as AuthorizedMatter;
    expect(errorOf(() => w.services.feedback.list(nobody))).toMatchObject({
      name: "ForbiddenError",
    });
  });
});
