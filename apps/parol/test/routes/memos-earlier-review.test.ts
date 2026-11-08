import { afterAll, describe, expect, it, vi } from "vitest";
import { urls } from "../../src/server/urls.js";
import { decideAll } from "../services/support.js";
import { all, byId, hasClass, readable } from "../pages/html.js";
import { IDS, cleanup, makeSite, prepareMatter, type Prepared, type Site } from "./support.js";

/**
 * A review started again on unchanged documents, with a different answer for one rule. The memo of
 * the first review stays the matter's current memo until the new review is exported (docs/parol/06,
 * gate 5), and the pages must not let that read as "the review on screen was exported".
 */

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const chipsOf = (root: Parameters<typeof all>[0]): string[] =>
  all(root, (el) => hasClass(el, "chip")).map((el) => readable(el));

async function rerun(site: Site, ids: Prepared): Promise<void> {
  const am = site.w.grant(site.w.associate, ids.matterId);
  site.w.services.runs.start(am, { workflowLabel: "v1" });
  await site.w.services.runs.idle();
}

describe("the memos page after a re-run", () => {
  it("labels the memo of the earlier review as such, on the memos page and on the matter page", async () => {
    const site = makeSite();
    const ids = await prepareMatter(site);
    await rerun(site, ids);
    const reviewer = await site.as(IDS.reviewer);

    const memos = await reviewer.page(urls.memos(ids.matterId));
    const list = byId(memos.root, "memo-list")!;
    expect(chipsOf(list)).toEqual(["Earlier review"]);
    expect(readable(list)).not.toMatch(/\bCurrent\b/);
    expect(readable(list)).toContain("has not been exported");
    expect(readable(list)).toContain("Open the earlier review");

    const matter = await reviewer.page(urls.matter(ids.matterId));
    const section = byId(matter.root, "memos")!;
    expect(chipsOf(section)).toEqual(["Earlier review"]);
    expect(readable(section)).not.toMatch(/\bCurrent\b/);
  });

  it("calls the memo Current again once the new review has been exported, and the old one Superseded", async () => {
    const site = makeSite();
    const ids = await prepareMatter(site);
    await rerun(site, ids);
    const am = site.w.grant(site.w.associate, ids.matterId);
    const reviewerAm = site.w.grant(site.w.reviewer, ids.matterId);
    decideAll(site.w, reviewerAm, site.w.services.runs.issues(am));
    await site.w.services.reviews.exportMemo(reviewerAm);

    const reviewer = await site.as(IDS.reviewer);
    const memos = await reviewer.page(urls.memos(ids.matterId));
    const list = byId(memos.root, "memo-list")!;
    expect(chipsOf(list)).toEqual(["Current", "Superseded"]);
    expect(readable(list)).not.toContain("Earlier review");
  });

  it("keeps saying Current for the memo of the review that was exported when nothing was re-run", async () => {
    const site = makeSite();
    const ids = await prepareMatter(site);
    const reviewer = await site.as(IDS.reviewer);
    const memos = await reviewer.page(urls.memos(ids.matterId));
    expect(chipsOf(byId(memos.root, "memo-list")!)).toEqual(["Current"]);
  });
});
