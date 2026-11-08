import { afterAll, describe, expect, it } from "vitest";
import { CANNOT_DECIDE } from "../../src/services/phrases.js";
import { cleanup, decideAll, makeWorld, reviewed } from "./support.js";

afterAll(cleanup);

/**
 * What a person is told when a review has been replaced. A finding of a run that a re-run replaced
 * is stale because a newer review exists, not because anything the review read has changed, and the
 * memo of the earlier review stays on record under a name that tells it from the later one.
 */

describe("a finding of a review that a re-run replaced", () => {
  it("says a newer review replaced it, not that the documents or the playbook changed", async () => {
    const w = makeWorld();
    const { am, reviewerAm, runId } = await reviewed(w);
    const old = w.services.runs.issues(am, runId).find((i) => i.ruleKey === "dur-1")!;

    // Nothing is edited between the two reviews.
    w.services.runs.start(am, { workflowLabel: "v2" });
    await w.services.runs.idle();

    const stale = w.services.runs.finding(reviewerAm, old.findingId);
    expect(stale.issue.validity).toBe("stale");
    expect(stale.canDecide.allowed).toBe(false);
    expect(stale.canDecide.reason).toBe(CANNOT_DECIDE.replaced);
    expect(stale.canDecide.reason).not.toBe(CANNOT_DECIDE.stale);
    expect(stale.canDecide.reason).not.toMatch(/documents or the playbook changed/);
    expect(stale.canDecide.reason).toMatch(/newer review/);
  });

  it("still says the documents changed when a document changed", async () => {
    const w = makeWorld();
    const { am, reviewerAm, runId } = await reviewed(w);
    const old = w.services.runs.issues(am, runId).find((i) => i.ruleKey === "dur-1")!;
    const amendment = w.services.matters.view(am).documents[1]!;
    w.services.matters.setStatedDate(am, amendment.versions[0]!.versionId, "2026-09-16");

    const stale = w.services.runs.finding(reviewerAm, old.findingId);
    expect(stale.canDecide).toEqual({ allowed: false, reason: CANNOT_DECIDE.stale });
  });
});

describe("the memos of a matter that was reviewed twice", () => {
  it("download under different names, and the replaced one says so in its name", async () => {
    const w = makeWorld();
    const { am, reviewerAm, runId } = await reviewed(w);
    decideAll(w, reviewerAm, w.services.runs.issues(am, runId));
    const first = await w.services.reviews.exportMemo(reviewerAm);
    expect(first.fileName).not.toMatch(/superseded/);

    w.services.runs.start(am, { workflowLabel: "v2" });
    await w.services.runs.idle();
    decideAll(w, reviewerAm, w.services.runs.issues(am));
    const second = await w.services.reviews.exportMemo(reviewerAm);

    const [now, before] = w.services.reviews.listMemos(am);
    expect(now).toMatchObject({ memoId: second.memoId, status: "current" });
    expect(before).toMatchObject({ memoId: first.memoId, status: "superseded" });
    expect(now!.fileName).not.toBe(before!.fileName);
    expect(now!.fileName).not.toMatch(/superseded/);
    expect(before!.fileName).toMatch(/superseded/);
    // Both are names a header can carry, and neither carries anything but an id and a date.
    for (const name of [now!.fileName, before!.fileName])
      expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
    // The download of each is under its own summary's name.
    expect((await w.services.reviews.memoFile(am, before!.memoId)).fileName).toBe(before!.fileName);
    expect((await w.services.reviews.memoFile(am, now!.memoId)).fileName).toBe(now!.fileName);
  });

  it("keeps two replaced memos of the same day apart", async () => {
    const w = makeWorld();
    const { am, reviewerAm, runId } = await reviewed(w);
    decideAll(w, reviewerAm, w.services.runs.issues(am, runId));
    await w.services.reviews.exportMemo(reviewerAm);
    for (const label of ["v2", "v1"]) {
      w.services.runs.start(am, { workflowLabel: label });
      await w.services.runs.idle();
      decideAll(w, reviewerAm, w.services.runs.issues(am));
      await w.services.reviews.exportMemo(reviewerAm);
    }
    const names = w.services.reviews.listMemos(am).map((m) => m.fileName);
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3);
  });
});
