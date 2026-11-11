import { afterAll, describe, expect, it } from "vitest";
import { SpendRefusedError } from "../../src/services/errors.js";
import { createApp } from "../../src/server/app.js";
import { renderErrorPage } from "../../src/server/pages/index.js";
import { WORKFLOW_FIELD } from "../../src/server/pages/matter.js";
import { refusalOf } from "../../src/server/routes/notices.js";
import { registerRoutes } from "../../src/server/routes/index.js";
import { urls } from "../../src/server/urls.js";
import { expectAccessible, tabStops } from "../a11y/rules.js";
import { urlEncoded } from "../integration/layers-support.js";
import { all, attr, byId, parseHtml, readable } from "../pages/html.js";
import {
  attachSpend,
  nearWorst,
  reviewBound,
  type SpendWorld,
  type SpendWorldOptions,
} from "../usage/spend-support.js";
import {
  Browser,
  IDS,
  OUTSIDER,
  cleanup,
  csrfOf,
  makeSite,
  newMatter,
  uploadCase,
  type Site,
} from "./support.js";

afterAll(cleanup);

/**
 * A review the spend guard refuses is answered in the shell's words: a form gets its page back
 * with the reason and the status 409, a script gets the same words and the figures in JSON. The
 * guard is consulted after the shell has decided who is asking, so it never changes who is told
 * what: a person outside the matter meets the same 404, a person who may not start a review the
 * same 403, and a request with no token the same 403. The site is the real application over a
 * scripted model; the prices and limits are invented.
 */

const MARKER = "CANARY-7731-MATTER-NAME";
const CLIENT_MARKER = "CANARY-5520-CLIENT-NAME";
// The prompts name the client, so a matter made with the client marker has its own bound.
const BOUND = reviewBound("v2", undefined, CLIENT_MARKER);
const BASE_BOUND = reviewBound("v2");

/** A site whose services are under a spend guard with the given limits. */
function spendSite(
  limits: { perReviewUsd: number; perDayUsd: number },
  usage?: SpendWorldOptions["usage"],
) {
  const site = makeSite();
  const w = attachSpend(site.w, site.w.model, {
    limits,
    ...(usage === undefined ? {} : { usage }),
  });
  return { site, w, ...appOver(site, w) };
}

/** The application over a world's services; the site's store and files are the world's. */
function appOver(site: Site, w: SpendWorld) {
  const deps = { ...site.deps, services: w.services };
  const app = createApp(deps, { log: () => {}, renderError: renderErrorPage });
  registerRoutes(app, deps);
  return {
    app,
    as: async (userId: string) => {
      const browser = new Browser(app);
      await browser.signIn(userId);
      return browser;
    },
  };
}

async function prepared(
  limits: { perReviewUsd: number; perDayUsd: number } = {
    perReviewUsd: BOUND * 0.9,
    perDayUsd: BOUND * 10,
  },
) {
  const s = spendSite(limits);
  const created = s.w.services.matters.create(s.w.associate, {
    name: MARKER,
    clientLegalName: CLIENT_MARKER,
    playbookVersionId: s.w.playbookVersionId,
    reviewerUserId: s.w.reviewer.userId,
  });
  await uploadCase(s.w, created.id);
  const associate = await s.as(IDS.associate);
  return { ...s, matterId: created.id, associate };
}

const noticeOf = (html: string): string => {
  const found = /<div class="notice notice-error"[^>]*>(.*?)<\/div>/s.exec(html);
  // The chip that names the kind of notice ("Problem") comes first; the words are what follows.
  return found === null
    ? ""
    : found[1]!
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^Problem /, "");
};

describe("a start that the guard refuses, through the page", () => {
  it("answers 409 with the matter's own page and the reason in words, and starts nothing", async () => {
    const { associate, matterId, w } = await prepared();
    const page = await associate.page(urls.matter(matterId));
    const refused = await associate.send("POST", urls.runs(matterId), {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: urlEncoded([
        ["_csrf", csrfOf(page)],
        [WORKFLOW_FIELD, "v2"],
      ]),
    });
    expect(refused.status).toBe(409);
    const html = await refused.text();
    const text = noticeOf(html);
    expect(text).toContain("This review could cost up to $");
    expect(text).toContain("the limit for one review is $");
    expect(text).toContain("PAROL_MAX_REVIEW_COST_USD");
    // It is an alert, and the page is the matter's, with its form to start a review again.
    expect(html).toContain('role="alert"');
    // What to do about it is shown apart, as the other refusals show theirs.
    expect(html).toContain(
      '<span class="todo">Remove a document you do not need, or ask whoever runs this server to ' +
        "raise the limit (PAROL_MAX_REVIEW_COST_USD).</span>",
    );
    expect(html).toContain(`action="${urls.runs(matterId)}"`);
    // Nothing was made or sent.
    expect(w.repo.listRunsForMatter(matterId)).toEqual([]);
    expect(w.wire.sent).toBe(0);
  });

  it("shows the notice as an accessible alert that adds no stop to the keyboard's path", async () => {
    const { associate, matterId } = await prepared();
    const page = await associate.page(urls.matter(matterId));
    const refused = await associate.send("POST", urls.runs(matterId), {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: urlEncoded([
        ["_csrf", csrfOf(page)],
        [WORKFLOW_FIELD, "v2"],
      ]),
    });
    expect(refused.status).toBe(409);
    const root = parseHtml(await refused.text());
    // The rest of the matter page has findings of its own that the sweep of the pages is to fix
    // (W2.9-fix); the notice this refusal adds is audited alone, as a pane.
    const alerts = all(root, (el) => attr(el, "role") === "alert");
    expect(alerts).toHaveLength(1);
    expectAccessible(alerts[0]!, { fragment: true });
    // It is text with a span in it: nothing in it can be tabbed to, and the page has the stops it
    // had before the refusal.
    expect(tabStops(alerts[0]!)).toEqual([]);
    expect(tabStops(root).map((el) => el.name)).toEqual(tabStops(page.root).map((el) => el.name));
  });

  it("says the same in the shell's words as the JSON does, and nothing about a matter, a run or a person", async () => {
    const { associate, matterId } = await prepared();
    const page = await associate.page(urls.matter(matterId));
    const refused = await associate.send("POST", urls.runs(matterId), {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: urlEncoded([["_csrf", csrfOf(page)]]),
    });
    const api = await associate.api("POST", `/api/matters/${matterId}/runs`, { workflow: "v2" });
    expect(api.status).toBe(409);
    const body = (await api.json()) as {
      error: { kind: string; code: string; message: string; figures: Record<string, unknown> };
    };
    expect(body.error.kind).toBe("spend_refused");
    expect(body.error.code).toBe("spend_over_review_limit");
    expect(body.error.message).toBe(noticeOf(await refused.text()));
    // Four figures, each a number, and nothing else.
    expect(Object.keys(body.error.figures).sort()).toEqual([
      "boundUsd",
      "heldUsd",
      "limitUsd",
      "usedUsd",
    ]);
    for (const value of Object.values(body.error.figures)) expect(typeof value).toBe("number");
    // The figures are the guard's own: the bound it planned, the limit, nothing used or set aside.
    expect(body.error.figures["boundUsd"]).toBeCloseTo(BOUND, 10);
    expect(body.error.figures["limitUsd"]).toBeCloseTo(BOUND * 0.9, 10);
    expect(body.error.figures["usedUsd"]).toBe(0);
    expect(body.error.figures["heldUsd"]).toBe(0);
    const json = JSON.stringify(body);
    expect(json).not.toContain(MARKER);
    expect(json).not.toContain(CLIENT_MARKER);
    expect(json).not.toMatch(/mat_|run_|usr_/);
    expect(body.error.message).not.toMatch(/mat_|run_|usr_/);
  });

  it("is a refusal of the day, in its own words, when the day is what is short", async () => {
    const { associate, matterId } = await prepared({
      perReviewUsd: BOUND * 5,
      perDayUsd: BOUND * 0.5,
    });
    const api = await associate.api("POST", `/api/matters/${matterId}/runs`, { workflow: "v2" });
    expect(api.status).toBe(409);
    const body = (await api.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("spend_over_daily_limit");
    expect(body.error.message).toContain("Today's limit of $");
    expect(body.error.message).toContain("PAROL_MAX_DAILY_COST_USD");
  });

  it("is not an error page of the server: it is a conflict, not a fault, and nothing is logged as one", async () => {
    const { associate, matterId, site } = await prepared();
    const before = site.logs.length;
    const api = await associate.api("POST", `/api/matters/${matterId}/runs`, {});
    expect(api.status).toBe(409);
    const lines = site.logs.slice(before).join("\n");
    expect(lines).not.toContain("SpendRefusedError");
    expect(lines).not.toContain(MARKER);
  });
});

describe("who is told what, with a guard that would refuse", () => {
  it("tells a person outside the matter what it tells about a matter that does not exist", async () => {
    const { matterId, as } = await prepared();
    const outsider = await as(OUTSIDER);
    const real = await outsider.api("POST", `/api/matters/${matterId}/runs`, {});
    const missing = await outsider.api("POST", "/api/matters/mat_0000000000000000/runs", {});
    expect(real.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await real.text()).toBe(await missing.text());
    const page = await outsider.send("POST", urls.runs(matterId), {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: urlEncoded([["_csrf", "x"]]),
    });
    expect(page.status).not.toBe(409);
  });

  it("tells a reviewer, who may not start a review, 403 and not 409", async () => {
    const { matterId, as } = await prepared();
    const reviewer = await as(IDS.reviewer);
    const api = await reviewer.api("POST", `/api/matters/${matterId}/runs`, {});
    expect(api.status).toBe(403);
    const page = await reviewer.page(urls.matter(matterId));
    // The reviewer is not offered the form that starts a review.
    expect(reviewer.hasForm(page, urls.runs(matterId))).toBe(false);
  });

  it("refuses a request with no token before the guard is asked: 403, and no figure", async () => {
    const { associate, matterId, w } = await prepared();
    const api = await associate.api("POST", `/api/matters/${matterId}/runs`, {}, false);
    expect(api.status).toBe(403);
    expect(await api.text()).not.toContain("spend");
    const wrong = await associate.api("POST", `/api/matters/${matterId}/runs`, {}, "not-the-token");
    expect(wrong.status).toBe(403);
    expect(w.repo.listRunsForMatter(matterId)).toEqual([]);
  });
});

describe("a resume that the guard refuses", () => {
  /** A review stopped at its limit, then the same server again with the same limit. */
  async function stoppedThenResumed() {
    const site = makeSite();
    const first = attachSpend(site.w, site.w.model, {
      limits: { perReviewUsd: BASE_BOUND, perDayUsd: BASE_BOUND * 10 },
      usage: nearWorst(0.9),
    });
    const { matterId, am } = newMatter(first);
    await uploadCase(first, matterId);
    const run = first.services.runs.start(am, { workflowLabel: "v2" });
    await first.services.runs.idle();
    expect(first.services.runs.get(am, run.id).errorKind).toBe("spend_review_limit");
    // The server started again under the same limit.
    const again = first.restart({});
    const { as } = appOver(site, again);
    return { matterId, runId: run.id, browser: await as(IDS.associate), w: again };
  }

  it("is answered on the matter's page with the reason, as a resume on another model is", async () => {
    const { matterId, runId, browser } = await stoppedThenResumed();
    const page = await browser.page(urls.matter(matterId));
    expect(browser.hasForm(page, urls.runResume(matterId, runId))).toBe(true);
    const refused = await browser.send("POST", urls.runResume(matterId, runId), {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: urlEncoded([["_csrf", csrfOf(page)]]),
    });
    expect(refused.status).toBe(409);
    const text = noticeOf(await refused.text());
    expect(text).toContain("The rest of this review could cost up to $");
    expect(text).toContain("the work already done is not paid for again");
    const api = await browser.api("POST", `/api/matters/${matterId}/runs/${runId}/resume`);
    expect(api.status).toBe(409);
    expect(((await api.json()) as { error: { kind: string } }).error.kind).toBe("spend_refused");
  });

  it("shows the run as stopped by the limit, with what to do, on the pages of the matter and of the run", async () => {
    const { matterId, runId, browser } = await stoppedThenResumed();
    const matter = await browser.page(urls.matter(matterId));
    expect(readable(byId(matter.root, "runs")!)).toContain(
      "The review stopped because its cost reached the limit for one review.",
    );
    const run = await browser.page(urls.run(matterId, runId));
    const text = readable(run.root);
    expect(text).toContain("The review stopped because its cost reached the limit for one review.");
    expect(text).toContain("finished work is not paid for again");
  });
});

describe("the notice of a refusal", () => {
  const FIGURES = { boundUsd: 0.5, limitUsd: 0.25, usedUsd: 0.125, heldUsd: 0.0625 };
  const REFUSALS: [string, SpendRefusedError][] = [
    [
      "a start over the limit for one review",
      new SpendRefusedError("spend_over_review_limit", FIGURES),
    ],
    [
      "a resume over the limit for one review",
      new SpendRefusedError("spend_over_review_limit", FIGURES, "resume"),
    ],
    ["a start over the limit for a day", new SpendRefusedError("spend_over_daily_limit", FIGURES)],
  ];

  for (const [what, error] of REFUSALS)
    it(`is a 409 with the words, the code, and a todo that occurs inside the words: ${what}`, () => {
      const refusal = refusalOf(error);
      expect(refusal?.status).toBe(409);
      expect(refusal?.code).toBe(error.code);
      expect(refusal?.notice.kind).toBe("error");
      expect(refusal?.notice.text).toBe(error.userText());
      const todo = refusal?.notice.todo;
      expect(todo).toBe(error.todoText());
      expect(todo?.length).toBeGreaterThan(20);
      expect(refusal?.notice.text).toContain(todo!);
      // It says whom to ask or what to wait for, and which setting.
      expect(todo).toMatch(/PAROL_MAX_(REVIEW|DAILY)_COST_USD\)/);
    });

  it("is not the shell's sentence for a conflict: the figures are in the words", () => {
    const refusal = refusalOf(REFUSALS[0]![1]);
    expect(refusal?.notice.text).toContain("$0.5000");
    expect(refusal?.notice.text).toContain("$0.2500");
  });
});
