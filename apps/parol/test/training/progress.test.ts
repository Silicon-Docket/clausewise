import { afterAll, describe, expect, it } from "vitest";
import { authorizeMatter } from "../../src/auth/authorize.js";
import { registerAll } from "../../src/boot/register.js";
import type { Principal } from "../../src/auth/types.js";
import type { ReviewDecision } from "../../src/contracts.js";
import { PLANTED_RULE_KEY } from "../../src/demo/training-example.js";
import { ForbiddenError } from "../../src/services/errors.js";
import type { TrainingProgressView } from "../../src/services/views.js";
import { DEMO_USER_IDS, NotFoundError, ValidationError } from "../../src/store/index.js";
import { CHECKABLE_STEPS, trainedUserIds, trainingProgress } from "../../src/training/progress.js";
import { startTraining } from "../../src/training/start.js";
import { T01 } from "../../src/training/t01.js";
import { cleanupWorlds, simulatedWorld } from "./support.js";

/**
 * How far a person has got through the training exercise, read from what is stored (package
 * W2.8). Every step is done through the services as a person does it, with the simulated reader
 * as the model, and the progress is read back. Nothing here calls a network, and every document,
 * party and person is synthetic.
 */

afterAll(cleanupWorlds);

function setup() {
  const w = simulatedWorld();
  const registered = registerAll(w.repo, { seedDemoUsers: true });
  const alex = w.principal(DEMO_USER_IDS.associate);
  const dana = w.principal(DEMO_USER_IDS.reviewer);
  const lee = w.principal(DEMO_USER_IDS.legalEngineer);
  const sam = w.principal(DEMO_USER_IDS.admin);
  const start = (who: Principal = alex, reviewerUserId: string = DEMO_USER_IDS.reviewer) =>
    startTraining({ services: w.services, repo: w.repo, relaxedSegregation: false }, who, {
      playbookVersionId: registered.playbook.id,
      reviewerUserId,
      trainerUserId: DEMO_USER_IDS.legalEngineer,
    });

  /** A review as the associate starts it, finished. */
  async function review(matterId: string, workflowLabel: "v1" | "v2" = "v2") {
    const am = authorizeMatter(w.repo, alex, matterId, "run.start");
    const run = w.services.runs.start(am, { workflowLabel });
    await w.services.runs.idle();
    return run;
  }

  const findingsOf = (matterId: string, runId: string) =>
    new Map(w.repo.listFindings(matterId, runId).map((f) => [f.ruleKey, f]));

  /** A decision as the reviewing attorney makes it. A rejection carries a reason code, as the form asks. */
  function decide(
    matterId: string,
    runId: string,
    ruleKey: string,
    decision: ReviewDecision,
    reason: string | null,
  ) {
    const finding = findingsOf(matterId, runId).get(ruleKey)!;
    const am = authorizeMatter(w.repo, dana, matterId, "review.decide");
    return w.services.reviews.decide(am, finding.id, {
      decision,
      findingContentSha256: finding.contentSha256,
      edits: null,
      reason,
      ...(decision === "reject" ? { reasonCode: "wrong_evidence" as const } : {}),
    });
  }

  /** Every finding of the run decided: the planted rule rejected, DUR-1 escalated, the rest accepted. */
  function decideAll(matterId: string, runId: string) {
    for (const key of findingsOf(matterId, runId).keys()) {
      if (key === PLANTED_RULE_KEY) decide(matterId, runId, key, "reject", "Does not support it.");
      else if (key === "dur-1") decide(matterId, runId, key, "escalate", "Send to a partner.");
      else decide(matterId, runId, key, "accept", null);
    }
  }

  async function exportMemo(matterId: string) {
    return w.services.reviews.exportMemo(authorizeMatter(w.repo, dana, matterId, "memo.export"));
  }

  function changeDate(matterId: string, date = "2026-10-01") {
    const amendment = w.repo.listVersions(matterId).find((v) => v.mediaType === "txt")!;
    w.services.matters.setStatedDate(
      authorizeMatter(w.repo, alex, matterId, "document.write"),
      amendment.id,
      date,
    );
  }

  const progress = (matterId: string): TrainingProgressView => trainingProgress(w.repo, matterId);
  const stateOf = (view: TrainingProgressView) =>
    Object.fromEntries(view.steps.map((s) => [s.n, s.state]));

  return {
    w,
    alex,
    dana,
    lee,
    sam,
    start,
    review,
    findingsOf,
    decide,
    decideAll,
    exportMemo,
    changeDate,
    progress,
    stateOf,
  };
}

describe("a training matter that was just made", () => {
  it("has step 1 set up, step 2 for the trainer, steps 3 to 7 not yet; five can be checked and none is done", async () => {
    const t = setup();
    const { matterId } = await t.start();
    const view = t.progress(matterId);
    expect(view.key).toBe("T01");
    expect(view.steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(t.stateOf(view)).toEqual({
      1: "seeded",
      2: "trainer",
      3: "not_yet",
      4: "not_yet",
      5: "not_yet",
      6: "not_yet",
      7: "not_yet",
    });
    expect(view.checkable).toBe(5);
    expect(view.checkable).toBe(CHECKABLE_STEPS.length);
    expect(view.checkableDone).toBe(0);
  });

  it("is reached through the matter service's view, and an ordinary matter has none", async () => {
    const t = setup();
    const { matterId } = await t.start();
    const am = authorizeMatter(t.w.repo, t.alex, matterId, "matter.read");
    expect(t.w.services.matters.view(am).training).toEqual(t.progress(matterId));
    expect(t.w.services.matters.view(am).matter.training).toBe("T01");

    const ordinary = t.w.services.matters.create(t.alex, {
      name: "An ordinary matter",
      clientLegalName: "Lanternfish Software, Inc.",
      playbookVersionId: null,
      reviewerUserId: DEMO_USER_IDS.reviewer,
    });
    const ordinaryAm = authorizeMatter(t.w.repo, t.alex, ordinary.id, "matter.read");
    expect(t.w.services.matters.view(ordinaryAm).training).toBeUndefined();
    // And the function itself refuses a matter that is not a training matter.
    expect(() => trainingProgress(t.w.repo, ordinary.id)).toThrow(NotFoundError);
    expect(() => trainingProgress(t.w.repo, "mat_does_not_exist")).toThrow(NotFoundError);
  });

  it("says step 1 is not yet when a document was taken away, and that is all it changes", async () => {
    const t = setup();
    const { matterId } = await t.start();
    const amendment = t.w.repo.listDocuments(matterId).find((d) => d.kind === "amendment")!;
    t.w.services.matters.removeDocument(
      authorizeMatter(t.w.repo, t.alex, matterId, "document.write"),
      amendment.id,
    );
    const view = t.progress(matterId);
    expect(view.steps[0]).toMatchObject({ n: 1, state: "not_yet" });
    expect(view.steps[0]!.note).toContain("start a new training matter");
    expect(view.checkableDone).toBe(0);
  });
});

describe("step 3, a review with workflow v2", () => {
  it("is not done by a v1 review, is done by a v2 review, and stays done when that review is superseded", async () => {
    const t = setup();
    const { matterId } = await t.start();
    await t.review(matterId, "v1");
    expect(t.stateOf(t.progress(matterId))[3]).toBe("not_yet");
    expect(t.progress(matterId).steps[2]!.note).toBe("Start a review with workflow version v2.");

    await t.review(matterId, "v2");
    const done = t.progress(matterId);
    expect(t.stateOf(done)[3]).toBe("done");
    expect(done.checkableDone).toBe(1);
    expect(done.steps[2]!.note).toContain("workflow version v2");

    // A changed date supersedes the run. The review under v2 still happened.
    t.changeDate(matterId);
    expect(t.w.repo.listRunsForMatter(matterId).some((r) => r.status === "superseded")).toBe(true);
    expect(t.stateOf(t.progress(matterId))[3]).toBe("done");
  });

  it("is not done by a v2 review that has not finished and so holds no findings, and is done when it has", async () => {
    const t = setup();
    const { matterId } = await t.start();
    // A review that is still queued has no findings yet: nothing can be read from it.
    const am = authorizeMatter(t.w.repo, t.alex, matterId, "run.start");
    t.w.services.runs.start(am, { workflowLabel: "v2" });
    expect(t.stateOf(t.progress(matterId))[3]).toBe("not_yet");
    await t.w.services.runs.idle();
    expect(t.stateOf(t.progress(matterId))[3]).toBe("done");
  });
});

describe("step 4, rejecting the finding the exercise is about", () => {
  it("is not done by a rejection without a reason (the store refuses it), is done with one, and is not done by rejecting another finding", async () => {
    const t = setup();
    const { matterId } = await t.start();
    const run = await t.review(matterId);

    expect(() => t.decide(matterId, run.id, PLANTED_RULE_KEY, "reject", null)).toThrow(
      ValidationError,
    );
    expect(() => t.decide(matterId, run.id, PLANTED_RULE_KEY, "reject", "   ")).toThrow(
      ValidationError,
    );
    expect(t.stateOf(t.progress(matterId))[4]).toBe("not_yet");

    // Another finding, rejected with a reason, is not the one.
    t.decide(matterId, run.id, "dur-1", "reject", "Not what the amendment says.");
    expect(t.stateOf(t.progress(matterId))[4]).toBe("not_yet");
    // And accepting the finding of the exercise is not rejecting it.
    t.decide(matterId, run.id, PLANTED_RULE_KEY, "accept", null);
    expect(t.stateOf(t.progress(matterId))[4]).toBe("not_yet");

    t.decide(matterId, run.id, PLANTED_RULE_KEY, "reject", "The clause does not say that.");
    const view = t.progress(matterId);
    expect(t.stateOf(view)[4]).toBe("done");
    expect(view.steps[3]!.note).toBe("A finding was rejected with a reason.");
  });

  it("stays done when the rejection goes out of date, because the exercise was done", async () => {
    const t = setup();
    const { matterId } = await t.start();
    const run = await t.review(matterId);
    t.decide(matterId, run.id, PLANTED_RULE_KEY, "reject", "The clause does not say that.");
    t.changeDate(matterId);
    const stale = t.w.repo.listReviews(matterId, t.findingsOf(matterId, run.id).get("pds-1")!.id);
    expect(stale.every((r) => r.validity === "stale")).toBe(true);
    expect(t.stateOf(t.progress(matterId))[4]).toBe("done");
  });
});

describe("step 5, escalating", () => {
  it("is done by an escalation with a reason, and not by an acceptance", async () => {
    const t = setup();
    const { matterId } = await t.start();
    const run = await t.review(matterId);
    t.decide(matterId, run.id, "dur-1", "accept", null);
    expect(t.stateOf(t.progress(matterId))[5]).toBe("not_yet");
    expect(() => t.decide(matterId, run.id, "dur-1", "escalate", null)).toThrow(ValidationError);
    expect(t.stateOf(t.progress(matterId))[5]).toBe("not_yet");
    t.decide(matterId, run.id, "ret-1", "escalate", "A partner should see this.");
    const view = t.progress(matterId);
    expect(t.stateOf(view)[5]).toBe("done");
    expect(view.steps[4]!.note).toBe("A finding was escalated with a reason.");
  });
});

describe("step 6, a change that takes decisions out of date", () => {
  it("is done by a changed stated date after a review, and not by a plain second review", async () => {
    const t = setup();
    const { matterId } = await t.start();
    const first = await t.review(matterId);
    t.decide(matterId, first.id, "ret-1", "accept", null);
    // A second review on unchanged documents is not a change of inputs.
    await t.review(matterId);
    expect(t.stateOf(t.progress(matterId))[6]).toBe("not_yet");

    t.changeDate(matterId);
    const view = t.progress(matterId);
    expect(t.stateOf(view)[6]).toBe("done");
    expect(view.steps[5]!.note).toBe(
      "An input changed after a review and the decisions went out of date.",
    );
  });

  it("is not done by a change made before any review, which takes nothing out of date", async () => {
    const t = setup();
    const { matterId } = await t.start();
    t.changeDate(matterId, "2026-09-30");
    t.changeDate(matterId, "2026-10-01");
    expect(t.stateOf(t.progress(matterId))[6]).toBe("not_yet");
    // A review made on the changed dates, then a change: that is the step.
    await t.review(matterId);
    t.changeDate(matterId, "2026-10-02");
    expect(t.stateOf(t.progress(matterId))[6]).toBe("done");
  });
});

describe("step 7, running again, deciding, exporting and finding the rejection in the memo", () => {
  it("needs a memo of a review that started after the change, and names each missing part", async () => {
    const t = setup();
    const { matterId } = await t.start();
    const first = await t.review(matterId);
    t.decideAll(matterId, first.id);
    await t.exportMemo(matterId);
    // The memo of the first review is there, but nothing has changed yet.
    expect(t.stateOf(t.progress(matterId))[7]).toBe("not_yet");
    expect(t.progress(matterId).steps[6]!.note).toBe(
      "Not done yet. Still to do: run the review again after the change, decide every finding, export the memo, reject the finding from step 4 again.",
    );

    t.changeDate(matterId);
    // The old memo is superseded by the change and counts for nothing.
    expect(t.w.repo.listMemos(matterId).every((m) => m.status === "superseded")).toBe(true);
    expect(t.stateOf(t.progress(matterId))[7]).toBe("not_yet");

    const second = await t.review(matterId);
    expect(t.progress(matterId).steps[6]!.note).toBe(
      "Not done yet. Still to do: decide every finding, export the memo, reject the finding from step 4 again.",
    );

    // Everything but the planted one is decided, and that one accepted.
    for (const key of t.findingsOf(matterId, second.id).keys())
      if (key !== PLANTED_RULE_KEY) t.decide(matterId, second.id, key, "accept", null);
    t.decide(matterId, second.id, PLANTED_RULE_KEY, "accept", null);
    expect(t.progress(matterId).steps[6]!.note).toBe(
      "Not done yet. Still to do: export the memo, reject the finding from step 4 again.",
    );

    // Rejecting it again completes the decisions; the memo is the last part.
    t.decide(matterId, second.id, PLANTED_RULE_KEY, "reject", "Still does not support it.");
    expect(t.progress(matterId).steps[6]!.note).toBe("Not done yet. Still to do: export the memo.");

    await t.exportMemo(matterId);
    const done = t.progress(matterId);
    expect(t.stateOf(done)[7]).toBe("done");
    expect(done.steps[6]!.note).toBe(
      "The memo of a new review (workflow version v2) holds your rejected finding.",
    );
  });

  it("is not done by a memo whose review accepted the finding, even though a memo exists", async () => {
    const t = setup();
    const { matterId } = await t.start();
    const first = await t.review(matterId);
    t.decideAll(matterId, first.id);
    t.changeDate(matterId);
    const second = await t.review(matterId);
    for (const key of t.findingsOf(matterId, second.id).keys())
      t.decide(matterId, second.id, key, "accept", null);
    await t.exportMemo(matterId);
    const view = t.progress(matterId);
    expect(t.stateOf(view)[7]).toBe("not_yet");
    expect(view.steps[6]!.note).toBe(
      "Not done yet. Still to do: reject the finding from step 4 again.",
    );
  });

  it("is all five checkable steps done after the whole exercise, and the creator is then trained", async () => {
    const t = setup();
    const { matterId } = await t.start();
    expect(trainedUserIds(t.w.repo)).toEqual([]);
    const first = await t.review(matterId);
    t.decideAll(matterId, first.id);
    expect(trainedUserIds(t.w.repo)).toEqual([]);
    t.changeDate(matterId);
    expect(trainedUserIds(t.w.repo)).toEqual([]);
    const second = await t.review(matterId);
    t.decideAll(matterId, second.id);
    expect(trainedUserIds(t.w.repo)).toEqual([]);
    await t.exportMemo(matterId);

    const view = t.progress(matterId);
    expect(view.checkableDone).toBe(5);
    expect(t.stateOf(view)).toEqual({
      1: "seeded",
      2: "trainer",
      3: "done",
      4: "done",
      5: "done",
      6: "done",
      7: "done",
    });
    expect(trainedUserIds(t.w.repo)).toEqual([DEMO_USER_IDS.associate]);
  });
});

describe("what a note may say", () => {
  it("never names the rule, its title, the clause or the word planted, in any state of the exercise", async () => {
    const t = setup();
    const { matterId } = await t.start();
    const seen: string[] = [];
    const record = () => seen.push(...t.progress(matterId).steps.map((s) => s.note));
    record();
    await t.review(matterId, "v1");
    record();
    const again = await t.review(matterId, "v2");
    record();
    t.decide(matterId, again.id, PLANTED_RULE_KEY, "reject", "Not supported.");
    record();
    t.decide(matterId, again.id, "dur-1", "escalate", "Partner.");
    record();
    t.changeDate(matterId);
    record();
    const last = await t.review(matterId, "v2");
    record();
    t.decideAll(matterId, last.id);
    record();
    await t.exportMemo(matterId);
    record();

    expect(seen.length).toBeGreaterThan(40);
    for (const note of seen) {
      expect(note.trim(), note).not.toBe("");
      expect(note.toLowerCase(), note).not.toContain(PLANTED_RULE_KEY);
      expect(note.toLowerCase(), note).not.toContain("disclosure to representatives");
      expect(note.toLowerCase(), note).not.toContain("planted");
      expect(note.toLowerCase(), note).not.toContain("definition");
      expect(note, note).not.toMatch(/[\u2013\u2014]/);
    }
    // And the state word of every step is one of the four a page knows.
    const states = new Set(t.progress(matterId).steps.map((s) => s.state));
    for (const state of states) expect(["done", "not_yet", "seeded", "trainer"]).toContain(state);
  });
});

describe("who can read the progress, and who is counted as trained", () => {
  it("is read through matter.read: a stranger is told there is no such matter, the trainer as a viewer sees it and cannot decide", async () => {
    const t = setup();
    const { matterId } = await t.start();
    // Sam is an administrator and a member of nothing: he has no special reach into a matter.
    expect(() => authorizeMatter(t.w.repo, t.sam, matterId, "matter.read")).toThrow(NotFoundError);
    const lee = authorizeMatter(t.w.repo, t.lee, matterId, "matter.read");
    expect(lee.role).toBe("viewer");
    expect(t.w.services.matters.view(lee).training).toEqual(t.progress(matterId));
    expect(() => authorizeMatter(t.w.repo, t.lee, matterId, "review.decide")).toThrow(
      ForbiddenError,
    );
  });

  it("counts a creator once, whatever the other people do, and counts nobody for a matter that is not finished", async () => {
    const t = setup();
    const mine = await t.start(t.alex);
    // The reviewer starts a training matter of their own and does nothing in it.
    const theirs = await t.start(t.dana, DEMO_USER_IDS.associate);
    expect(mine.matterId).not.toBe(theirs.matterId);
    expect(trainedUserIds(t.w.repo)).toEqual([]);

    const run = await t.review(mine.matterId);
    t.decideAll(mine.matterId, run.id);
    t.changeDate(mine.matterId);
    const again = await t.review(mine.matterId);
    t.decideAll(mine.matterId, again.id);
    await t.exportMemo(mine.matterId);
    // Dana made a training matter of her own too, and it is not finished, so she is not counted;
    // and Alex's finished matter counts for Alex, not for the reviewer who decided its findings.
    expect(trainedUserIds(t.w.repo)).toEqual([DEMO_USER_IDS.associate]);
    expect(T01.key).toBe("T01");
  });
});
