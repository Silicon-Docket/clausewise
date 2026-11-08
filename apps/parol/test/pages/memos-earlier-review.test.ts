import { describe, expect, it } from "vitest";
import { MemosPage, render } from "../../src/server/pages/index.js";
import { urls } from "../../src/server/urls.js";
import { checkInvariants } from "./invariants.js";
import { all, attr, byId, byTag, first, hasClass, readable } from "./html.js";
import { IDS, buildChrome, buildMatterSummary, buildMemo } from "./support.js";

/**
 * After a re-run on unchanged inputs the matter keeps the memo of the earlier review as its current
 * memo, until the new review is exported (docs/parol/06, gate 5). The page must not read that as
 * "this review was exported": the memo is labelled as the record of an earlier review, with the
 * reason printed beside it.
 */

const NEWER = "r_0200";

const page = (memos: ReturnType<typeof buildMemo>[], currentRunId?: string | null): string =>
  render(
    MemosPage({
      chrome: buildChrome(),
      matter: buildMatterSummary({ status: "in_review" }),
      memos,
      canExport: true,
      exportBlockedReason:
        "Every finding needs a current decision before the memo can be exported.",
      ...(currentRunId === undefined ? {} : { currentRunId }),
    }),
  );

const chips = (html: string): string[] =>
  all(checkInvariants(html), (el) => hasClass(el, "chip")).map((el) => readable(el));

describe("the memo of an earlier review", () => {
  const html = page([buildMemo({ runId: IDS.run })], NEWER);
  const root = checkInvariants(html);
  const list = byId(root, "memo-list")!;

  it("is not labelled Current", () => {
    expect(chips(html)).toEqual(["Earlier review"]);
    expect(readable(list)).not.toMatch(/\bCurrent\b/);
  });

  it("says in the page, not in a hover, that a newer review has not been exported", () => {
    expect(readable(list)).toMatch(/Earlier review records a previous review/);
    expect(readable(list)).toMatch(/newer review has been started and has not been exported/);
  });

  it("still links to the file and to the review it records, and says which review that is", () => {
    const row = byTag(list, "tbody")[0]!;
    const file = first(row, (el) => el.name === "a" && attr(el, "download") !== undefined);
    expect(attr(file, "href")).toBe(urls.memoFile(IDS.matter, IDS.memo));
    const review = first(
      row,
      (el) => el.name === "a" && readable(el) === "Open the earlier review",
    );
    expect(attr(review, "href")).toBe(urls.run(IDS.matter, IDS.run));
  });
});

describe("the memo of the review on screen", () => {
  it("is Current, with no note about an earlier review", () => {
    const html = page([buildMemo({ runId: IDS.run })], IDS.run);
    expect(chips(html)).toEqual(["Current"]);
    expect(readable(checkInvariants(html))).not.toMatch(/Earlier review/);
  });

  it("is Current when the page is not told which review is on screen", () => {
    expect(chips(page([buildMemo({ runId: IDS.run })]))).toEqual(["Current"]);
  });
});

describe("a re-run that has not produced a review yet", () => {
  it("still marks the memo as the record of an earlier review", () => {
    const html = page([buildMemo({ runId: IDS.run })], null);
    expect(chips(html)).toEqual(["Earlier review"]);
  });
});

describe("a list with a newer memo and a replaced one", () => {
  it("marks the newer Current, the replaced Superseded, and prints no note", () => {
    const html = page(
      [
        buildMemo({ memoId: "memo_new", runId: NEWER }),
        buildMemo({ memoId: "memo_old", runId: IDS.run, status: "superseded" }),
      ],
      NEWER,
    );
    expect(chips(html)).toEqual(["Current", "Superseded"]);
    expect(readable(checkInvariants(html))).not.toMatch(/Earlier review/);
  });
});
