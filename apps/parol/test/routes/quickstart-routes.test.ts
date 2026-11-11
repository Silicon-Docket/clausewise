import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { describeRoutes } from "../../src/server/matter-route.js";
import { FIELDS } from "../../src/server/pages/forms.js";
import { urls } from "../../src/server/urls.js";
import { T01, TRAINING_STEPS } from "../../src/training/index.js";
import { expectAccessible } from "../a11y/rules.js";
import {
  all,
  attr,
  byTag,
  controls,
  hasAttr,
  parseHtml,
  readable,
  type El,
} from "../pages/html.js";
import { simulatedModel, trainingMatterIds } from "../training/support.js";
import {
  IDS,
  OTHER_ASSOCIATE,
  OUTSIDER,
  VIEWER,
  checkPage,
  cleanup,
  fingerprint,
  makeSite,
  matterIdFrom,
  type Browser,
  type Site,
} from "./support.js";

/**
 * The quickstart and the help pages through the routes (package W2.8): `GET /quickstart` and
 * `GET /help`. Both are open to everyone and name no matter, so what these tests show is who gets
 * them, that a signed-in person's page holds that person's own training matter and nobody else's,
 * that the form on the page is the one the start route accepts, and that no answer key is on
 * either page. The start route itself is in training-routes.test.ts.
 */

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let site: Site;
let visitor: Browser;
const trainingIds = (): string[] => trainingMatterIds(site.w.repo);

beforeAll(() => {
  site = makeSite({ model2: simulatedModel() });
  visitor = site.anonymous();
});

/** What a page must never show a trainee: the trainer's answers, and the rule the exercise plants. */
function expectNoKey(html: string, where: string): void {
  const text = readable(byTag(parseHtml(html), "main")[0]!).toLowerCase();
  for (const step of TRAINING_STEPS)
    expect(text, `${where}: the key of step ${step.n}`).not.toContain(step.key.toLowerCase());
  expect(text, where).not.toContain("pds-1");
  expect(text, where).not.toContain("disclosure to representatives");
  expect(text, where).not.toContain("definition clause");
}

describe("who gets the pages", () => {
  it("answers a visitor with the pages, 200, and no redirect to sign in", async () => {
    for (const path of [urls.quickstart(), urls.help()]) {
      const response = await visitor.get(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type"), path).toMatch(/^text\/html/);
      const html = await response.text();
      expect(html, path).toContain("<h1>");
      expect(html, path).not.toContain("_csrf");
    }
  });

  it("answers every signed-in person with the pages, whatever their role", async () => {
    for (const userId of [
      IDS.associate,
      IDS.reviewer,
      IDS.legalEngineer,
      IDS.admin,
      VIEWER,
      OUTSIDER,
    ]) {
      const who = await site.as(userId);
      for (const path of [urls.quickstart(), urls.help()]) {
        const page = await who.page(path);
        checkPage(site, page);
        expectAccessible(page.root);
      }
    }
  });

  it("registers the two routes as public, naming no matter and no global action", () => {
    const routes = describeRoutes(site.app).filter(
      (route) => route.path === urls.quickstart() || route.path === urls.help(),
    );
    expect(routes.map((r) => `${r.method} ${r.path} ${r.kind}`).sort()).toEqual(
      [`GET ${urls.help()} public`, `GET ${urls.quickstart()} public`].sort(),
    );
    for (const route of routes) {
      expect(route.action).toBeNull();
      expect(route.globalAction).toBeNull();
    }
  });

  it("has no write on either address: a post with the right token finds nothing there and changes nothing", async () => {
    const who = await site.as(IDS.associate);
    const before = fingerprint(site);
    for (const path of [urls.quickstart(), urls.help()]) {
      const response = await who.send("POST", path, {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _csrf: await who.apiToken() }).toString(),
      });
      expect(response.status, path).toBe(404);
    }
    expect(fingerprint(site)).toEqual(before);
  });
});

describe("the quickstart for a signed-in person", () => {
  it("offers a person without a training matter the form the start route accepts, and makes the matter from it", async () => {
    const who = await site.as(IDS.associate);
    const page = await who.page(urls.quickstart());
    checkPage(site, page);
    expect(who.hasForm(page, urls.training())).toBe(true);
    const reviewer = controls(who.formOf(page, urls.training()), FIELDS.reviewerUserId)[0] as El;
    expect(hasAttr(reviewer, "required")).toBe(true);
    // The reviewing attorney is picked from the list of people, whose names say which is which.
    const option = all(
      reviewer,
      (el) => el.name === "option" && attr(el, "value") === IDS.reviewer,
    );
    expect(option.map((o) => readable(o))).toEqual(["Dana Whitfield (reviewing attorney)"]);
    const before = trainingIds().length;
    const response = await who.submit(page, urls.training(), {
      set: { [FIELDS.reviewerUserId]: IDS.reviewer },
    });
    expect(response.status).toBe(303);
    const matterId = matterIdFrom(response);
    expect(trainingIds()).toHaveLength(before + 1);
    expect(site.w.repo.getMatter(matterId)).toMatchObject({
      trainingKey: "T01",
      createdBy: IDS.associate,
    });
    expect(site.w.repo.getMember(matterId, IDS.reviewer)?.role).toBe("reviewer");
  });

  it("then links that person to their own training matter, and offers no second form", async () => {
    const who = await site.as(IDS.associate);
    const page = await who.page(urls.quickstart());
    checkPage(site, page);
    const mine = trainingIds().find(
      (id) => site.w.repo.getMember(id, IDS.associate)?.role === "associate",
    )!;
    const link = all(
      page.root,
      (el) => el.name === "a" && readable(el) === "Open the training matter",
    );
    expect(link.map((a) => attr(a, "href"))).toEqual([urls.matter(mine)]);
    expect(who.hasForm(page, urls.training())).toBe(false);
    expectAccessible(page.root);
    // The link is a page the person can open.
    const opened = await who.page(attr(link[0] as El, "href") as string);
    expect(readable(opened.root)).toContain(T01.matterName);
  });

  it("does not show that matter to its reviewing attorney as their own, who still has the form", async () => {
    const dana = await site.as(IDS.reviewer);
    const mine = trainingIds()[0]!;
    expect(site.w.repo.getMember(mine, IDS.reviewer)?.role).toBe("reviewer");
    const page = await dana.page(urls.quickstart());
    expect(page.html).not.toContain(mine);
    expect(page.html).not.toContain(T01.matterName);
    expect(dana.hasForm(page, urls.training())).toBe(true);
  });

  it("never carries another person's training matter: not its id, not its name", async () => {
    const owner = await site.as(IDS.associate);
    const theirs = trainingIds().find(
      (id) => site.w.repo.getMember(id, IDS.associate)?.role === "associate",
    )!;
    for (const userId of [OTHER_ASSOCIATE, VIEWER, OUTSIDER, IDS.admin, IDS.legalEngineer]) {
      const who = await site.as(userId);
      for (const path of [urls.quickstart(), urls.help()]) {
        const html = (await who.page(path)).html;
        expect(html, `${userId} ${path}`).not.toContain(theirs);
        expect(html, `${userId} ${path}`).not.toContain(T01.matterName);
      }
    }
    // The owner's own page does have it.
    expect((await owner.page(urls.quickstart())).html).toContain(theirs);
  });

  it("tells a person with no approved playbook version that, in place of the form", async () => {
    const services = {
      ...site.deps.services,
      matters: { ...site.deps.services.matters, playbooks: () => [] },
    };
    const { createApp } = await import("../../src/server/app.js");
    const { registerRoutes } = await import("../../src/server/routes/index.js");
    const { renderErrorPage } = await import("../../src/server/pages/index.js");
    const deps = { ...site.deps, services };
    const app = createApp(deps, { log: () => {}, renderError: renderErrorPage });
    registerRoutes(app, deps);
    const { Browser: B } = await import("./support.js");
    const who = new B(app);
    await who.signIn(VIEWER);
    const page = await who.page(urls.quickstart());
    expect(who.hasForm(page, urls.training())).toBe(false);
    expect(readable(page.root)).toContain("No approved playbook version is available");
    expectAccessible(page.root);
  });
});

describe("a server for one person", () => {
  it("lets the person leave the reviewing attorney empty, and makes the matter from that", async () => {
    const single = makeSite({ model2: simulatedModel(), relaxed: true });
    const who = await single.as(IDS.associate);
    const page = await who.page(urls.quickstart());
    const reviewer = controls(who.formOf(page, urls.training()), FIELDS.reviewerUserId)[0] as El;
    expect(hasAttr(reviewer, "required")).toBe(false);
    const response = await who.submit(page, urls.training());
    expect(response.status).toBe(303);
    const matter = single.w.repo.getMatter(matterIdFrom(response))!;
    expect(matter.trainingKey).toBe("T01");
    expect(single.w.repo.listMembers(matter.id).map((m) => m.userId)).toEqual([IDS.associate]);
  });
});

describe("the answer key", () => {
  it("is on neither page, for a visitor or for any signed-in person, with or without a training matter", async () => {
    const pages: [string, string][] = [];
    pages.push(["visitor quickstart", (await visitor.page(urls.quickstart())).html]);
    pages.push(["visitor help", (await visitor.page(urls.help())).html]);
    for (const [name, userId] of [
      ["the associate", IDS.associate],
      ["the reviewing attorney", IDS.reviewer],
      ["the legal engineer", IDS.legalEngineer],
      ["the administrator", IDS.admin],
    ] as const) {
      const who = await site.as(userId);
      pages.push([`${name}'s quickstart`, (await who.page(urls.quickstart())).html]);
      pages.push([`${name}'s help`, (await who.page(urls.help())).html]);
    }
    expect(pages).toHaveLength(10);
    for (const [where, html] of pages) expectNoKey(html, where);
  });

  it("has no address of the trainer's key on a page a visitor reads", async () => {
    for (const path of [urls.quickstart(), urls.help()])
      expect((await visitor.page(path)).html).not.toContain(urls.trainerKey());
  });
});
