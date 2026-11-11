import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FIELDS } from "../../src/server/pages/forms.js";
import { urls } from "../../src/server/urls.js";
import { all, attr, byTag, first, hasClass, parseHtml, readable } from "../pages/html.js";
import {
  IDS,
  VIEWER,
  cleanup,
  makeSite,
  prepareMatter,
  type Browser,
  type Prepared,
  type Site,
} from "./support.js";

/**
 * The page of a finding has a way back to the issue table of the review the matter shows now. It
 * matters most after a refusal: the form is answered at the address it was posted to, and the
 * person has the table one link away and not only by the back button. What these tests can show is
 * the link and where it leads; whether a person finds it is not tested.
 */

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let site: Site;
let ids: Prepared;
let reviewer: Browser;
let viewer: Browser;

beforeAll(async () => {
  site = makeSite();
  ids = await prepareMatter(site, { exported: false });
  reviewer = await site.as(IDS.reviewer);
  viewer = await site.as(VIEWER);
});

const crumbs = (html: string): { href: string | null | undefined; text: string }[] => {
  const nav = first(parseHtml(html), (el) => hasClass(el, "crumbs"));
  return byTag(nav, "li").map((li) => ({
    href: all(li, (el) => el.name === "a").map((a) => attr(a, "href"))[0],
    text: readable(li),
  }));
};

describe("the finding page and the way back to the review", () => {
  const review = (): string => urls.run(ids.matterId, ids.runId, ids.findingId);

  it("links to the table of the current review, with the finding chosen, for a reviewer and a viewer", async () => {
    for (const browser of [reviewer, viewer]) {
      const page = await browser.page(urls.finding(ids.matterId, ids.findingId));
      const list = crumbs(page.html);
      expect(list.map((c) => c.text)).toEqual([
        "Matters",
        "Lanternfish / Corvane NDA",
        "Review",
        "Duration of confidentiality obligations",
      ]);
      expect(list.slice(0, 3).map((c) => c.href)).toEqual([
        urls.matters(),
        urls.matter(ids.matterId),
        review(),
      ]);
    }
  });

  it("leads to a page that shows the finding in the inspector", async () => {
    const page = await reviewer.page(review());
    expect(readable(first(page.root, (el) => el.name === "h1"))).toBe("Issues");
    expect(
      byTag(page.root, "aside").filter((el) => attr(el, "data-inspector") !== undefined),
    ).toHaveLength(1);
    expect(readable(first(page.root, (el) => attr(el, "data-inspector") !== undefined))).toContain(
      "Duration of confidentiality obligations",
    );
  });

  it("is on the page that answers a refused decision, at the address the form was posted to", async () => {
    const page = await reviewer.page(urls.finding(ids.matterId, ids.findingId));
    const action = urls.review(ids.matterId, ids.findingId);
    const response = await reviewer.submit(page, action, { set: { [FIELDS.decision]: "" } });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(readable(parseHtml(html))).toContain("Choose a decision.");
    expect(crumbs(html).map((c) => c.href)).toContain(review());
  });
});
