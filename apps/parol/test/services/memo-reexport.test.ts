import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanup, decideAll, makeWorld, reviewed } from "./support.js";

afterAll(cleanup);

/**
 * Exporting a review whose memo is already on record is that memo. A second copy would mark the
 * first "superseded", which the page explains as "the documents or playbook changed": untrue, since
 * nothing did.
 */

describe("exporting a review that was already exported", () => {
  it("answers with the memo that is on record, makes no second one and supersedes nothing", async () => {
    const w = makeWorld();
    const { matterId, am, reviewerAm, runId } = await reviewed(w);
    decideAll(w, reviewerAm, w.services.runs.issues(am, runId));
    const first = await w.services.reviews.exportMemo(reviewerAm);

    // Four more, two of them at once.
    const [a, b] = await Promise.all([
      w.services.reviews.exportMemo(reviewerAm),
      w.services.reviews.exportMemo(reviewerAm),
    ]);
    const c = await w.services.reviews.exportMemo(reviewerAm);
    const d = await w.services.reviews.exportMemo(reviewerAm);

    for (const again of [a, b, c, d]) expect(again).toEqual(first);
    expect(w.services.reviews.listMemos(am)).toEqual([first]);
    expect(w.services.matters.view(am).matter.status).toBe("exported");
    // One memo file and the two uploads: the copies that were built are not left behind.
    expect(readdirSync(join(w.files.root, matterId))).toHaveLength(3);
    expect(w.repo.listAuditEvents({ matterId, action: "memo.export" })).toHaveLength(1);
  });

  it("still supersedes the memo when the review was run again and decided again", async () => {
    const w = makeWorld();
    const { am, reviewerAm, runId } = await reviewed(w);
    decideAll(w, reviewerAm, w.services.runs.issues(am, runId));
    const first = await w.services.reviews.exportMemo(reviewerAm);

    w.services.runs.start(am, { workflowLabel: "v2" });
    await w.services.runs.idle();
    decideAll(w, reviewerAm, w.services.runs.issues(am));
    const second = await w.services.reviews.exportMemo(reviewerAm);

    expect(second.memoId).not.toBe(first.memoId);
    expect(w.services.reviews.listMemos(am).map((m) => m.status)).toEqual([
      "current",
      "superseded",
    ]);
  });
});
