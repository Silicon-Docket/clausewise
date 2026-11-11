import { afterAll, describe, expect, it } from "vitest";
import { MATTER_ACTIONS } from "../../src/auth/actions.js";
import type { AuthorizedMatter } from "../../src/auth/types.js";
import type { MatterRole } from "../../src/contracts.js";
import { REASON_CODES } from "../../src/contracts.js";
import { DEMO_USER_IDS } from "../../src/store/index.js";
import {
  cleanup,
  decideAll,
  decisionFor,
  makeWorld,
  newMatter,
  reviewed,
  uploadCase,
} from "./support.js";

afterAll(cleanup);

/**
 * The feedback service and the review service together (package W2.6a). Slice A: the review
 * service carries the reason code and the minor-edit mark of a decision from the request to the
 * store and back into the finding's history, and nothing about who may decide changes.
 *
 * Slice B: the report of a missed issue. Any member may make one against a run of their matter that
 * has findings, naming a rule of that run's playbook or none, and it changes nothing about the
 * review: not a finding, not a decision, not the gate of the export. The rules to choose from, and
 * everything the caller may read of the matter's feedback, are read here too.
 *
 * Slice C: the rating of a matter. Any member may rate once the matter has a memo, once, for good,
 * and reads only their own; it changes nothing about the review. The later slice adds the tests of a
 * note below.
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
    // A note is written through the store: its service is the later slice's.
    w.repo.addFeedback(matterId, {
      userId: w.associate.userId,
      kind: "comment",
      runId,
      findingId: dur.findingId,
      text: "ZQ-NOTE",
    });
    // The matter is exported, and two of its members rate it.
    decideAll(w, reviewerAm, w.services.runs.issues(am, runId));
    await w.services.reviews.exportMemo(reviewerAm);
    w.services.feedback.rate(am, { rating: 5, comment: "ZQ-ASSOCIATE-RATING" });
    w.services.feedback.rate(reviewerAm, { rating: 2, comment: "ZQ-REVIEWER-RATING" });
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

// ---------------------------------------------------------------------------------------------
// Slice C: the rating of a matter
// ---------------------------------------------------------------------------------------------

/** The matter of `openWithViewer()`, with every finding decided and the memo exported. */
async function exportedWithViewer() {
  const r = await openWithViewer();
  decideAll(r.w, r.reviewerAm, r.w.services.runs.issues(r.am, r.runId));
  const memo = await r.w.services.reviews.exportMemo(r.reviewerAm);
  return { ...r, memo };
}

const ratingsOf = (w: ReturnType<typeof makeWorld>, matterId: string) =>
  w.repo.listFeedback(matterId, { kind: "rating" });

describe("rate", () => {
  it("lets an associate, a reviewer and a viewer each rate an exported matter, as themselves, and nobody else", async () => {
    const { w, am, reviewerAm, viewerAm, memo } = await exportedWithViewer();
    const by: Record<MatterRole, AuthorizedMatter> = {
      associate: am,
      reviewer: reviewerAm,
      viewer: viewerAm,
    };
    // The roles that may are the roles of the table, so a change of the table shows up here.
    expect(Object.keys(by).sort()).toEqual([...MATTER_ACTIONS["feedback.add"]].sort());
    const marks: Record<MatterRole, 1 | 2 | 3 | 4 | 5> = { associate: 5, reviewer: 2, viewer: 4 };
    for (const role of MATTER_ACTIONS["feedback.add"]) {
      const view = w.services.feedback.rate(by[role], {
        rating: marks[role],
        comment: `A comment by the ${role}.`,
      });
      expect(view).toMatchObject({ rating: marks[role], comment: `A comment by the ${role}.` });
      expect(view.at).toMatch(/^\d{4}-\d\d-\d\dT/);
      expect(view.feedbackId).toMatch(/^fbk_/);
    }
    const stored = ratingsOf(w, am.matterId);
    expect(stored.map((r) => [r.userId, r.rating]).sort()).toEqual(
      [am, reviewerAm, viewerAm].map((x) => [x.principal.userId, marks[x.role]]).sort(),
    );
    // Each is recorded against the review the newest memo was made from, and names no finding.
    for (const row of stored) expect(row).toMatchObject({ runId: memo.runId, findingId: null });
    // A caller whose role the table does not list is refused by the service itself.
    const nobody = { ...am, role: "nobody" } as unknown as AuthorizedMatter;
    expect(
      errorOf(() => w.services.feedback.rate(nobody, { rating: 3, comment: null })),
    ).toMatchObject({ name: "ForbiddenError", action: "feedback.add" });
    expect(ratingsOf(w, am.matterId)).toHaveLength(3);
  });

  it("refuses before the first memo with not_exported, writes nothing, and allows it once the memo is exported", async () => {
    const { w, am, reviewerAm, matterId, runId } = await open();
    const attempt = () => w.services.feedback.rate(am, { rating: 4, comment: "Not yet." });
    expect(errorOf(attempt)).toMatchObject({ name: "ConflictError", code: "not_exported" });
    expect(ratingsOf(w, matterId)).toEqual([]);
    expect(w.repo.listAuditEvents({ matterId, action: "feedback.add" })).toEqual([]);
    // The review decided but not exported is still not exported.
    decideAll(w, reviewerAm, w.services.runs.issues(am, runId));
    expect(errorOf(attempt)).toMatchObject({ code: "not_exported" });
    await w.services.reviews.exportMemo(reviewerAm);
    expect(attempt()).toMatchObject({ rating: 4, comment: "Not yet." });
  });

  it("checks what was sent before the state of the matter: a mark that is no mark is bad_rating whether or not the matter is exported", async () => {
    const before = await open();
    const after = await exportedWithViewer();
    for (const w of [before, after])
      for (const rating of [0, 6, 2.5, -3, Number.NaN])
        expect(
          errorOf(() => w.w.services.feedback.rate(w.am, { rating, comment: null })),
          String(rating),
        ).toMatchObject({ name: "ValidationError", code: "bad_rating" });
    expect(ratingsOf(before.w, before.matterId)).toEqual([]);
    expect(ratingsOf(after.w, after.matterId)).toEqual([]);
  });

  it("is final: a second rating by the same person is already_rated, whatever it says, and the first stays", async () => {
    const { w, am, reviewerAm } = await exportedWithViewer();
    const first = w.services.feedback.rate(am, { rating: 2, comment: "ZQ-FIRST" });
    for (const input of [
      { rating: 2, comment: "ZQ-FIRST" },
      { rating: 5, comment: "ZQ-SECOND" },
      { rating: 5, comment: null },
    ])
      expect(errorOf(() => w.services.feedback.rate(am, input))).toMatchObject({
        name: "ConflictError",
        code: "already_rated",
      });
    expect(w.services.feedback.myRating(am)).toEqual(first);
    expect(ratingsOf(w, am.matterId)).toHaveLength(1);
    // Another person is not held to the first one's rating.
    expect(w.services.feedback.rate(reviewerAm, { rating: 5, comment: null })).toMatchObject({
      rating: 5,
    });
  });

  it("is recorded against the run of the newest memo, and a comment that says nothing is none", async () => {
    const { w, am, reviewerAm, matterId, runId } = await open();
    decideAll(w, reviewerAm, w.services.runs.issues(am, runId));
    const first = await w.services.reviews.exportMemo(reviewerAm);
    // A review started again on unchanged documents, decided and exported: the newest memo is its.
    const second = w.services.runs.start(am, { workflowLabel: "v2" });
    await w.services.runs.idle();
    decideAll(w, reviewerAm, w.services.runs.issues(am, second.id));
    const next = await w.services.reviews.exportMemo(reviewerAm);
    expect(next.runId).toBe(second.id);
    expect(first.runId).toBe(runId);
    const view = w.services.feedback.rate(am, { rating: 3, comment: "  \n " });
    expect(view.comment).toBeNull();
    expect(ratingsOf(w, matterId)).toMatchObject([{ runId: second.id, text: null, rating: 3 }]);
  });

  it("writes an audit event with the mark and whether there were words, and the words nowhere", async () => {
    const { w, am, memo } = await exportedWithViewer();
    const words = "ZQ-RATING-WORDS the review was useful";
    const view = w.services.feedback.rate(am, { rating: 4, comment: words });
    const [event] = w.repo.listAuditEvents({ matterId: am.matterId, action: "feedback.add" });
    expect(event).toMatchObject({
      actorId: am.principal.userId,
      targetType: "feedback",
      targetId: view.feedbackId,
      detail: {
        kind: "rating",
        rating: 4,
        hasText: true,
        hasLocation: false,
        runId: memo.runId,
        findingId: null,
      },
    });
    expect(JSON.stringify(event)).not.toContain("ZQ-");
    expect(w.logs.join("\n")).not.toContain("ZQ-");
  });

  it("changes no finding, no decision, no status of the matter, no memo and nothing the export waits for", async () => {
    const { w, am, reviewerAm, viewerAm, matterId, runId } = await exportedWithViewer();
    const issues = w.services.runs.issues(am, runId);
    const snapshot = () =>
      JSON.stringify({
        matter: w.services.matters.view(am),
        issues: w.services.runs.issues(am, runId),
        findings: issues.map((i) => w.services.runs.finding(reviewerAm, i.findingId)),
        readiness: w.repo.getExportReadiness(matterId, runId),
        memos: w.services.reviews.listMemos(reviewerAm),
        hashes: w.repo.listFindings(matterId, runId).map((f) => f.contentSha256),
      });
    const before = snapshot();
    for (const [caller, rating] of [
      [am, 1],
      [reviewerAm, 3],
      [viewerAm, 5],
    ] as const)
      w.services.feedback.rate(caller, { rating, comment: "ZQ-NOTHING-CHANGES" });
    expect(snapshot()).toBe(before);
    expect(w.services.runs.get(am, runId).current).toBe(true);
  });
});

describe("myRating", () => {
  it("is null until the person has rated, then theirs, and no other person's, for every role", async () => {
    const { w, am, reviewerAm, viewerAm } = await exportedWithViewer();
    for (const caller of [am, reviewerAm, viewerAm])
      expect(w.services.feedback.myRating(caller)).toBeNull();
    const given = w.services.feedback.rate(reviewerAm, { rating: 2, comment: "ZQ-REVIEWER-ONLY" });
    expect(w.services.feedback.myRating(reviewerAm)).toEqual(given);
    // The others have not rated, and the reviewer's rating is nowhere in what they read.
    for (const caller of [am, viewerAm]) {
      expect(w.services.feedback.myRating(caller)).toBeNull();
      expect(JSON.stringify(w.services.feedback.list(caller))).not.toContain("ZQ-REVIEWER-ONLY");
    }
    w.services.feedback.rate(am, { rating: 5, comment: "ZQ-ASSOCIATE-ONLY" });
    expect(w.services.feedback.myRating(am)).toMatchObject({ rating: 5 });
    expect(w.services.feedback.myRating(reviewerAm)).toMatchObject({ rating: 2 });
    expect(w.services.feedback.myRating(viewerAm)).toBeNull();
  });

  it("reads only the matter's own: a rating of another matter is not this matter's", async () => {
    const { w, am } = await exportedWithViewer();
    const other = await reviewed(w);
    decideAll(w, other.reviewerAm, w.services.runs.issues(other.am, other.runId));
    await w.services.reviews.exportMemo(other.reviewerAm);
    // The same person rates the other matter and not this one.
    w.services.feedback.rate(other.am, { rating: 1, comment: "ZQ-ELSEWHERE" });
    expect(w.services.feedback.myRating(am)).toBeNull();
    expect(w.services.feedback.list(am).myRating).toBeNull();
    expect(w.services.feedback.myRating(other.am)).toMatchObject({ rating: 1 });
  });

  it("is refused to a caller with no role on the matter", async () => {
    const { w, am } = await exportedWithViewer();
    const nobody = { ...am, role: "nobody" } as unknown as AuthorizedMatter;
    expect(errorOf(() => w.services.feedback.myRating(nobody))).toMatchObject({
      name: "ForbiddenError",
      action: "memo.read",
    });
  });
});
