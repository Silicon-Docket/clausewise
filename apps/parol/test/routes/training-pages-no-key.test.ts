import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authorizeMatter } from "../../src/auth/authorize.js";
import { FIELDS } from "../../src/server/pages/forms.js";
import { urls } from "../../src/server/urls.js";
import { TRAINING_STEPS } from "../../src/training/index.js";
import {
  all,
  attr,
  byTag,
  hasClass,
  parseHtml,
  readable,
  withClass,
  type El,
} from "../pages/html.js";
import { simulatedModel } from "../training/support.js";
import { IDS, cleanup, makeSite, matterIdFrom, type Browser, type Site } from "./support.js";

/**
 * No page a trainee is shown holds the trainer's answer or the identity of the finding the
 * exercise is about (package W2.8). The pages are the real ones, read through the real routes as
 * the associate and as the reviewing attorney: the quickstart, the help page, the matter page of
 * the training matter before any review and after one, the review page, every finding in it as a
 * pane and as a page of its own, and the memos page.
 *
 * What the exercise needs to keep: (a) none of the seven answers is anywhere on these pages; (b)
 * the rule and its title are not on the quickstart, the help page, the matter page or a note of
 * the progress (they are on the review page and the finding pages only as the ordinary row and
 * pane of that rule); (c) the words "planted", "deliberately" and "on purpose" are nowhere on a
 * review page or a finding page except inside the banner of the training matter. The planted
 * finding is the simulated reader's script and is the exercise, so it must look like any other.
 */

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const FORM = { "content-type": "application/x-www-form-urlencoded" };

let site: Site;
let matterId: string;
let alex: Browser;
let dana: Browser;
let visitor: Browser;

beforeAll(async () => {
  site = makeSite({ model2: simulatedModel() });
  alex = await site.as(IDS.associate);
  dana = await site.as(IDS.reviewer);
  visitor = site.anonymous();
  const pairs = new URLSearchParams({
    [FIELDS.reviewerUserId]: IDS.reviewer,
    [FIELDS.trainerUserId]: IDS.legalEngineer,
    _csrf: await alex.apiToken(),
  });
  const made = await alex.send("POST", urls.training(), { headers: FORM, body: pairs.toString() });
  expect(made.status).toBe(303);
  matterId = matterIdFrom(made);
});

const PLANTED_WORDS = ["planted", "deliberately", "on purpose"];
const RULE_WORDS = ["pds-1", "disclosure to representatives"];

interface Seen {
  who: string;
  path: string;
  html: string;
  root: El;
  text: string;
}

async function read(who: string, browser: Browser, path: string): Promise<Seen> {
  const response = await browser.get(path);
  expect(response.status, `${who} ${path}`).toBe(200);
  const html = await response.text();
  const root = parseHtml(html);
  return { who, path, html, root, text: readable(root).toLowerCase() };
}

/** The text of the main part of a page outside the banner of the training matter, lower case. */
function outsideBanner(page: Seen): string {
  return byTag(page.root, "main")
    .map((main) => {
      const banner = withClass(main, "banner-training")[0];
      const whole = readable(main);
      return (banner === undefined ? whole : whole.replace(readable(banner), "")).toLowerCase();
    })
    .join(" ");
}

function expectNoAnswer(page: Seen): void {
  for (const step of TRAINING_STEPS)
    expect(page.text, `${page.who} ${page.path}: the answer to step ${step.n}`).not.toContain(
      step.key.toLowerCase(),
    );
}

describe("before any review", () => {
  it("shows no answer and no rule on the quickstart, the help page and the matter page", async () => {
    const pages = [
      await read("visitor", visitor, urls.quickstart()),
      await read("associate", alex, urls.quickstart()),
      await read("reviewer", dana, urls.quickstart()),
      await read("visitor", visitor, urls.help()),
      await read("associate", alex, urls.help()),
      await read("associate", alex, urls.matter(matterId)),
      await read("reviewer", dana, urls.matter(matterId)),
    ];
    for (const page of pages) {
      expectNoAnswer(page);
      for (const word of RULE_WORDS)
        expect(page.text, `${page.who} ${page.path}: "${word}"`).not.toContain(word);
    }
    // The pages are the ones that were meant: the matter page has its banner and its table.
    const matter = pages[5] as Seen;
    expect(withClass(matter.root, "banner-training")).toHaveLength(1);
    expect(matter.text).toContain("training progress");
    expect(matter.text).toContain("0 of those 5 are done");
  });
});

describe("after a review", () => {
  let runPath: string;
  let findingIds: string[];

  beforeAll(async () => {
    const principal = {
      userId: IDS.associate,
      displayName: "Alex",
      globalRole: "member" as const,
    };
    const am = authorizeMatter(site.w.repo, principal, matterId, "run.start");
    const run = site.w.services.runs.start(am, { workflowLabel: "v2" });
    await site.w.services.runs.idle();
    runPath = urls.run(matterId, run.id);
    findingIds = site.w.repo.listFindings(matterId, run.id).map((f) => f.id);
    expect(findingIds).toHaveLength(8);
  });

  it("shows no answer on the matter page, the review page, any pane or finding page, or the memos page", async () => {
    const seen: Seen[] = [];
    for (const [who, browser] of [
      ["associate", alex],
      ["reviewer", dana],
    ] as const) {
      seen.push(await read(who, browser, urls.matter(matterId)));
      seen.push(await read(who, browser, runPath));
      for (const id of findingIds) {
        seen.push(await read(who, browser, urls.run(matterId, runPath.split("/").at(-1)!, id)));
        seen.push(await read(who, browser, urls.finding(matterId, id)));
      }
      seen.push(await read(who, browser, urls.memos(matterId)));
    }
    // Two people, the matter, the review, eight panes, eight pages, the memos: 2 x 19 pages.
    expect(seen).toHaveLength(38);
    for (const page of seen) expectNoAnswer(page);
  });

  it("names the rule only as the ordinary row and pane of that rule, and never on the matter page", async () => {
    const matter = await read("associate", alex, urls.matter(matterId));
    for (const word of RULE_WORDS) expect(matter.text, word).not.toContain(word);
    // Its row is on the review page like every row, and its pane says what any compliant finding says.
    const run = await read("associate", alex, runPath);
    expect(run.text).toContain("disclosure to representatives");
    const rows = byTag(run.root, "tr").filter((tr) => readable(tr).includes("pds-1"));
    expect(rows).toHaveLength(1);
    expect(readable(rows[0] as El)).toContain("Compliant");
  });

  it("keeps the words of the plant inside the banner on the review page, and outside it on no page", async () => {
    const runId = runPath.split("/").at(-1)!;
    const reviewPages = [
      await read("associate", alex, runPath),
      await read("reviewer", dana, runPath),
    ];
    for (const id of findingIds)
      reviewPages.push(await read("reviewer", dana, urls.run(matterId, runId, id)));
    for (const page of reviewPages) {
      const outside = outsideBanner(page);
      for (const word of PLANTED_WORDS)
        expect(outside, `${page.who} ${page.path}: "${word}" outside the banner`).not.toContain(
          word,
        );
      // The banner is there to carry them.
      expect(withClass(page.root, "banner-training")).toHaveLength(1);
    }
    // A finding page of its own carries the words nowhere but in a banner, if it has one: the page
    // belongs to another package in this phase and gets the banner when the lead applies the request
    // in the report of package W2.8, and this holds before and after.
    for (const id of findingIds) {
      const page = await read("reviewer", dana, urls.finding(matterId, id));
      const outside = outsideBanner(page);
      for (const word of PLANTED_WORDS)
        expect(outside, `${page.path}: "${word}" outside a banner`).not.toContain(word);
    }
  });

  it("has the same shape for the planted row as for any other row of the table", async () => {
    const run = await read("associate", alex, runPath);
    const body = byTag(run.root, "tr").filter((tr) => byTag(tr, "td").length > 0);
    const compliant = body.filter((tr) => readable(tr).includes("Compliant"));
    expect(compliant.length).toBeGreaterThanOrEqual(5);
    const planted = compliant.find((tr) => readable(tr).includes("pds-1")) as El;
    const other = compliant.find((tr) => readable(tr).includes("pds-2")) as El;
    const shape = (tr: El): string =>
      all(tr, () => true)
        .map(
          (el) => `${el.name}.${(attr(el, "class") ?? "").replace(/\bis-selected\b/, "").trim()}`,
        )
        .join(" ");
    expect(shape(planted)).toBe(shape(other));
    expect(hasClass(planted, "is-stale")).toBe(false);
  });
});
