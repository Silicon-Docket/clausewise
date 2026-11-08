import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEMO_BANNER } from "../../src/server/pages/layout.js";
import { WORKFLOW_FIELD } from "../../src/server/pages/matter.js";
import { FIELDS } from "../../src/server/pages/forms.js";
import { exportBlockedReason } from "../../src/server/routes/shared.js";
import { urls } from "../../src/server/urls.js";
import type { MatterView, RunSummary } from "../../src/services/views.js";
import { all, attr, byId, first, hasAttr, hasClass, readable, withClass } from "../pages/html.js";
import { matterPage } from "../pages/render.js";
import { buildMatterView, buildMatterSummary, buildRunSummary } from "../pages/support.js";
import {
  IDS,
  OTHER_ASSOCIATE,
  OUTSIDER,
  VIEWER,
  addMember,
  checkPage,
  cleanup,
  gate,
  makeSite,
  newMatter,
  prepareMatter,
  routeFor,
  uploadCase,
  type Browser,
  type Page,
  type Prepared,
  type Site,
} from "./support.js";

/**
 * The pages, as the routes build them from what the services return: the start, the lists, the
 * matter with the props only a route can work out (who may delete, why the export is blocked), the
 * run with its selection, the progress route, and the notices that carry a result across a redirect.
 */

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const formsTo = (page: Page, action: string): number =>
  all(page.root, (el) => el.name === "form" && attr(el, "action") === action).length;

describe("the start page", () => {
  it("offers the demo identities to a visitor, with a token that signs them in", async () => {
    const site = makeSite();
    const visitor = site.anonymous();
    const page = await visitor.page("/");
    checkPage(site, page);
    const buttons = all(
      page.root,
      (el) => el.name === "button" && attr(el, "name") === FIELDS.userId,
    );
    expect(buttons.map((b) => attr(b, "value"))).toEqual(
      expect.arrayContaining([IDS.associate, IDS.reviewer, IDS.legalEngineer, IDS.admin]),
    );
    // The visitor was given the anonymous cookie that the token on the form is bound to.
    expect([...visitor.jar.keys()]).toEqual(["parol_anon"]);
    await visitor.signIn(IDS.reviewer);
    expect([...visitor.jar.keys()].sort()).toEqual(["parol_session"]);
  });

  it("lists nobody when the demo identity is off, and signing in fails", async () => {
    const site = makeSite({ demoIdentity: false });
    const visitor = site.anonymous();
    const page = await visitor.page("/");
    // The people exist and sign-in is off; the page used to say none had been set up.
    const text = readable(page.root);
    expect(text).toContain("Sign-in is switched off");
    expect(text).toContain("PAROL_DEMO_IDENTITY=1");
    expect(text).not.toContain("No demo identities have been set up");
    expect(text).not.toContain("pick a person to act as");
    expect(all(page.root, (el) => attr(el, "name") === FIELDS.userId)).toEqual([]);
    const token = await visitor.apiToken();
    const response = await visitor.send("POST", "/session", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: token,
        intent: "sign-in",
        userId: IDS.associate,
      }).toString(),
    });
    expect(response.status).toBe(404);
  });

  it("shows a signed-in person their matters, and only theirs", async () => {
    const site = makeSite();
    const mine = await prepareMatter(site, { name: "Mine to read", exported: false });
    await prepareMatter(site, { name: "Somebody else's", exported: false });
    // Somebody else's matter has the associate as a member too; make one the associate is not on.
    const stranger = site.w.services.matters.create(site.w.principal(OTHER_ASSOCIATE), {
      name: "Not for the associate",
      clientLegalName: "Elsewhere, Inc.",
      playbookVersionId: null,
      reviewerUserId: null,
    });
    const viewer = await site.as(VIEWER);
    const home = await viewer.page("/");
    checkPage(site, home);
    const list = readable(byId(home.root, "matter-list")!);
    expect(list).toContain("Mine to read");
    expect(list).toContain("Somebody else's");
    expect(list).not.toContain("Not for the associate");
    expect(list).not.toContain(stranger.id);
    // The same page at /matters, and the links go to the matters.
    const matters = await viewer.page(urls.matters());
    expect(readable(byId(matters.root, "matter-list")!)).toBe(list);
    const links = all(
      home.root,
      (el) => el.name === "a" && /^\/matters\/mat_/.test(attr(el, "href") ?? ""),
    );
    expect(links.map((l) => attr(l, "href"))).toContain(urls.matter(mine.matterId));
  });

  it("sends a signed-out visitor from a page that needs a person to the start", async () => {
    const site = makeSite();
    const response = await site.anonymous().get(urls.matters());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
  });
});

describe("the matter page", () => {
  let site: Site;
  let ids: Prepared;
  let associate: Browser;
  let reviewer: Browser;
  let admin: Browser;

  beforeAll(async () => {
    site = makeSite();
    ids = await prepareMatter(site, { exported: false });
    addMember(site, ids.matterId, IDS.admin, "viewer");
    associate = await site.as(IDS.associate);
    reviewer = await site.as(IDS.reviewer);
    admin = await site.as(IDS.admin);
  });

  it("offers the delete form to the creator and an administrator, and to nobody else", async () => {
    const delAction = urls.matterDelete(ids.matterId);
    expect(formsTo(await associate.page(urls.matter(ids.matterId)), delAction)).toBe(1);
    expect(formsTo(await admin.page(urls.matter(ids.matterId)), delAction)).toBe(1);
    expect(formsTo(await reviewer.page(urls.matter(ids.matterId)), delAction)).toBe(0);
    const viewer = await site.as(VIEWER);
    expect(formsTo(await viewer.page(urls.matter(ids.matterId)), delAction)).toBe(0);
  });

  it("shows each role the forms its role can use and no others", async () => {
    const forAssociate = await associate.page(urls.matter(ids.matterId));
    checkPage(site, forAssociate);
    for (const action of [
      urls.documents(ids.matterId),
      urls.matterSettings(ids.matterId),
      urls.members(ids.matterId),
      urls.runs(ids.matterId),
    ])
      expect(formsTo(forAssociate, action), action).toBe(1);

    const forReviewer = await reviewer.page(urls.matter(ids.matterId));
    checkPage(site, forReviewer);
    for (const action of [
      urls.documents(ids.matterId),
      urls.matterSettings(ids.matterId),
      urls.members(ids.matterId),
      urls.runs(ids.matterId),
    ])
      expect(formsTo(forReviewer, action), action).toBe(0);
    // The reviewer exports; the associate does not.
    expect(formsTo(forReviewer, urls.memos(ids.matterId))).toBe(1);
    expect(formsTo(forAssociate, urls.memos(ids.matterId))).toBe(0);
  });

  it("lists the people who can be added, and not those already on the matter", async () => {
    const page = await associate.page(urls.matter(ids.matterId));
    const select = first(
      page.root,
      (el) => el.name === "select" && attr(el, "name") === FIELDS.memberUserId,
    );
    const offered = all(select, (el) => el.name === "option").map((o) => attr(o, "value"));
    expect(offered).toContain(OTHER_ASSOCIATE);
    expect(offered).toContain(OUTSIDER);
    for (const member of [IDS.associate, IDS.reviewer, VIEWER, IDS.admin])
      expect(offered).not.toContain(member);
    // A reviewer is not shown the list at all.
    const forReviewer = await reviewer.page(urls.matter(ids.matterId));
    expect(all(forReviewer.root, (el) => attr(el, "name") === FIELDS.memberUserId)).toEqual([]);
  });

  it("adds a person with the add-a-person form, and they can then open the matter", async () => {
    const page = await associate.page(urls.matter(ids.matterId));
    const response = await associate.submit(page, urls.members(ids.matterId), {
      set: { [FIELDS.memberUserId]: OUTSIDER, [FIELDS.memberRole]: "viewer" },
    });
    expect(response.status).toBe(303);
    const landed = await associate.page(response.headers.get("location")!);
    expect(landed.html).toContain("The person was added to the matter.");
    expect((await (await site.as(OUTSIDER)).get(urls.matter(ids.matterId))).status).toBe(200);
  });

  it("changes the client name and the playbook with the settings form, and the review goes out of date", async () => {
    const page = await associate.page(urls.matter(ids.matterId));
    const response = await associate.submit(page, urls.matterSettings(ids.matterId), {
      set: { [FIELDS.clientLegalName]: "Lanternfish Software, Incorporated" },
    });
    expect(response.status).toBe(303);
    const landed = await associate.page(response.headers.get("location")!);
    expect(landed.html).toContain("The settings were saved.");
    expect(readable(withClass(landed.root, "matter-meta")[0]!)).toContain(
      "Our client: Lanternfish Software, Incorporated",
    );
    expect(readable(landed.root)).toContain("Results are out of date");
  });

  it("sets and clears a stated date with the date form", async () => {
    const view = (): MatterView =>
      site.w.services.matters.view(site.w.grant(site.w.associate, ids.matterId));
    const page = await associate.page(urls.matter(ids.matterId));
    const action = urls.statedDate(ids.matterId, ids.versionId);
    const set = await associate.submit(page, action, {
      set: { [FIELDS.statedDate]: "2026-09-20" },
    });
    expect(set.status).toBe(303);
    expect(view().documents[1]!.versions[0]!.statedDate).toBe("2026-09-20");
    const cleared = await associate.submit(page, action, { set: { [FIELDS.statedDate]: "" } });
    expect(cleared.status).toBe(303);
    expect(view().documents[1]!.versions[0]!.statedDate).toBeNull();
    const bad = await associate.submit(page, action, {
      set: { [FIELDS.statedDate]: "2026-02-30" },
    });
    expect(bad.status).toBe(400);
  });

  it("removes the last document with the remove form, and only when the person says they mean it", async () => {
    const page = await associate.page(urls.matter(ids.matterId));
    const action = urls.documentRemove(ids.matterId, ids.lastDocumentId);
    // The checkbox is not ticked: the form posts nothing for it.
    expect((await associate.submit(page, action)).status).toBe(400);
    // The NDA cannot go while an amendment stands.
    // The page offers no form for it, so this is posted by hand.
    const first_ = urls.documentRemove(ids.matterId, ids.firstDocumentId);
    expect(formsTo(page, first_)).toBe(0);
    const byHand = await associate.send("POST", first_, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: await associate.apiToken(), confirm: "yes" }).toString(),
    });
    expect(byHand.status).toBe(409);
    const response = await associate.submit(page, action, { set: { [FIELDS.confirm]: "yes" } });
    expect(response.status).toBe(303);
    expect((await associate.page(response.headers.get("location")!)).html).toContain(
      "The document was removed.",
    );
    const view = site.w.services.matters.view(site.w.grant(site.w.associate, ids.matterId));
    expect(view.documents.map((d) => d.label)).toEqual(["D1"]);
  });
});

describe("deleting a matter", () => {
  it("is done by the creator, with the confirmation, and takes the matter and its files with it", async () => {
    const site = makeSite();
    const ids = await prepareMatter(site, { exported: false });
    const associate = await site.as(IDS.associate);
    const reviewer = await site.as(IDS.reviewer);
    const folder = join(site.w.files.root, ids.matterId);
    expect(existsSync(folder)).toBe(true);

    const page = await associate.page(urls.matter(ids.matterId));
    const action = urls.matterDelete(ids.matterId);
    // Without the tick: refused. For a reviewer: refused, whatever the form carries.
    expect((await associate.submit(page, action)).status).toBe(400);
    const sneaky = await reviewer.send("POST", action, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: await reviewer.apiToken(), confirm: "yes" }).toString(),
    });
    expect(sneaky.status).toBe(403);
    expect(existsSync(folder)).toBe(true);

    const response = await associate.submit(page, action, { set: { [FIELDS.confirm]: "yes" } });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toMatch(
      /^\/matters\?notice=matter-deleted&nt=\d+\.[A-Za-z0-9_-]{43}$/,
    );
    const landed = await associate.page(response.headers.get("location")!);
    expect(landed.html).toContain("The matter and everything in it was deleted.");
    expect(readable(byId(landed.root, "matter-list")!)).not.toContain("Lanternfish / Corvane NDA");
    expect(existsSync(folder)).toBe(false);
    // Gone for everyone who was on it.
    expect((await associate.get(urls.matter(ids.matterId))).status).toBe(404);
    expect((await reviewer.get(urls.matter(ids.matterId))).status).toBe(404);
    expect((await reviewer.api("GET", `/api/matters/${ids.matterId}`)).status).toBe(404);
  });

  it("is done by an administrator who is not on the matter, through the API", async () => {
    const site = makeSite();
    const ids = await prepareMatter(site, { exported: false });
    const admin = await site.as(IDS.admin);
    expect((await admin.get(urls.matter(ids.matterId))).status).toBe(404);
    const response = await admin.api("DELETE", `/api/matters/${ids.matterId}`);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    const associate = await site.as(IDS.associate);
    expect((await associate.get(urls.matter(ids.matterId))).status).toBe(404);
  });

  it("is refused to a legal engineer who is neither the creator nor an administrator", async () => {
    const site = makeSite();
    const ids = await prepareMatter(site, { exported: false });
    addMember(site, ids.matterId, IDS.legalEngineer, "viewer");
    const engineer = await site.as(IDS.legalEngineer);
    expect((await engineer.api("DELETE", `/api/matters/${ids.matterId}`)).status).toBe(403);
    expect(existsSync(join(site.w.files.root, ids.matterId))).toBe(true);
  });
});

describe("the reason an export is blocked", () => {
  it("is the same on the matter page and the memos page, in every state that blocks it", async () => {
    const site = makeSite();
    const associate = await site.as(IDS.associate);
    const reviewer = await site.as(IDS.reviewer);
    const reasonOn = (page: Page, id: string): string | null => {
      const hint = byId(page.root, id);
      return hint === undefined ? null : readable(hint);
    };

    // 1. No review yet: the matter has its documents and no run.
    const { matterId: bare } = newMatter(site.w);
    await uploadCase(site.w, bare);
    // 2. In review: a run with undecided findings.
    const open = await prepareMatter(site, { exported: false });
    // 3. Finished: every finding decided, and the memo exported.
    const done = await prepareMatter(site);

    const states: [string, string, string | null][] = [
      ["no review yet", bare, "There is no current review to export."],
      [
        "in review",
        open.matterId,
        "Every finding needs a current decision before the memo can be exported.",
      ],
      ["exported", done.matterId, null],
    ];
    for (const [name, matterId, reason] of states) {
      const onMatter = reasonOn(await reviewer.page(urls.matter(matterId)), "export-reason");
      const onMemos = reasonOn(await reviewer.page(urls.memos(matterId)), "export-reason");
      expect(onMatter, name).toBe(reason);
      expect(onMemos, name).toBe(reason);
    }
    // Where the reason is null the button works: not disabled on either page.
    const enabled = first(
      await reviewer.page(urls.memos(done.matterId)).then((p) => p.root),
      (el) => el.name === "button" && readable(el) === "Export memo",
    );
    expect(hasAttr(enabled, "disabled")).toBe(false);

    // The associate is not shown the form on the memos page.
    expect(
      formsTo(await associate.page(urls.memos(open.matterId)), urls.memos(open.matterId)),
    ).toBe(0);
    expect(formsTo(await reviewer.page(urls.memos(open.matterId)), urls.memos(open.matterId))).toBe(
      1,
    );
  });

  it("is worked out in the order the matter page works it out, for every state of a matter", () => {
    const states: [string, Partial<MatterView>][] = [
      ["no current run", { currentRun: null, matter: buildMatterSummary({ role: "reviewer" }) }],
      ["stale", { matter: buildMatterSummary({ status: "stale", role: "reviewer" }) }],
      ["in review", { matter: buildMatterSummary({ status: "in_review", role: "reviewer" }) }],
      ["running", { matter: buildMatterSummary({ status: "running", role: "reviewer" }) }],
      ["draft", { matter: buildMatterSummary({ status: "draft", role: "reviewer" }) }],
      [
        "review complete",
        { matter: buildMatterSummary({ status: "review_complete", role: "reviewer" }) },
      ],
      ["exported", { matter: buildMatterSummary({ status: "exported", role: "reviewer" }) }],
    ];
    for (const [name, overrides] of states) {
      const view = buildMatterView({ currentRun: buildRunSummary(), ...overrides });
      const html = matterPage(view, { canDelete: false });
      const reason = exportBlockedReason(view);
      if (reason === null) {
        // The page offers a button that works: no hint under it.
        expect(html, name).not.toContain('id="export-reason"');
      } else {
        expect(html, name).toContain(reason);
      }
    }
    // And the words themselves, which a page test elsewhere pins on the page.
    expect(exportBlockedReason(buildMatterView({ currentRun: null }))).toBe(
      "There is no current review to export.",
    );
    expect(
      exportBlockedReason(buildMatterView({ matter: buildMatterSummary({ status: "stale" }) })),
    ).toBe("The results are out of date. Run the review again first.");
    // A new document makes the review stale and takes the current review away at once. The reason
    // is then that the results are out of date, not that no review was ever run.
    expect(
      exportBlockedReason(
        buildMatterView({ currentRun: null, matter: buildMatterSummary({ status: "stale" }) }),
      ),
    ).toBe("The results are out of date. Run the review again first.");
  });
});

describe("the run page", () => {
  let site: Site;
  let ids: Prepared;
  let associate: Browser;
  let reviewer: Browser;
  const rowsOf = (page: Page): string[] =>
    all(page.root, (el) => el.name === "code" && hasClass(el, "rule-key")).map(readable);

  beforeAll(async () => {
    site = makeSite();
    ids = await prepareMatter(site, { exported: false });
    associate = await site.as(IDS.associate);
    reviewer = await site.as(IDS.reviewer);
  });

  it("lists every finding of the run", async () => {
    const page = await associate.page(urls.run(ids.matterId, ids.runId));
    checkPage(site, page);
    expect(rowsOf(page).sort()).toEqual(
      ["pty-1", "def-1", "exc-1", "pds-1", "pds-2", "dur-1", "ret-1", "gov-1"].sort(),
    );
  });

  it("selects the finding named by ?finding= and shows its inspector with the decision form to the reviewer", async () => {
    const path = urls.run(ids.matterId, ids.runId, ids.findingId);
    const forReviewer = await reviewer.page(path);
    checkPage(site, forReviewer);
    const pane = first(
      forReviewer.root,
      (el) => el.name === "article" && hasClass(el, "finding-pane"),
    );
    expect(attr(pane, "data-finding")).toBe(ids.findingId);
    expect(formsTo(forReviewer, urls.review(ids.matterId, ids.findingId))).toBe(1);
    expect(formsTo(await associate.page(path), urls.review(ids.matterId, ids.findingId))).toBe(0);
    const selected = all(forReviewer.root, (el) => el.name === "tr" && hasClass(el, "is-selected"));
    expect(selected).toHaveLength(1);
  });

  it("says so when the named finding is not part of the run, and when none is named", async () => {
    const missing = await associate.page(
      `${urls.run(ids.matterId, ids.runId)}?finding=fnd_nothing`,
    );
    expect(missing.html).toContain("That finding is not part of this review");
    const none = await associate.page(urls.run(ids.matterId, ids.runId));
    expect(none.html).toContain("Choose a rule in the table");
    const empty = await associate.page(`${urls.run(ids.matterId, ids.runId)}?finding=`);
    expect(empty.html).toContain("Choose a rule in the table");
  });

  it("filters by ?filter= through the known filters and treats anything else as all", async () => {
    const decide = await reviewer.api(
      "POST",
      `/api/matters/${ids.matterId}/findings/${ids.findingId}/reviews`,
      {
        decision: "accept",
        findingContentSha256: site.w.services.runs.finding(
          site.w.grant(site.w.reviewer, ids.matterId),
          ids.findingId,
        ).contentSha256,
      },
    );
    expect(decide.status).toBe(201);
    const filtered = async (filter: string): Promise<string[]> =>
      rowsOf(await associate.page(`${urls.run(ids.matterId, ids.runId)}?filter=${filter}`));
    expect(await filtered("open")).not.toContain("dur-1");
    expect((await filtered("open")).length).toBe(7);
    expect(await filtered("all")).toHaveLength(8);
    expect(await filtered("nonsense")).toHaveLength(8);
    expect(await filtered("%3Cscript%3E")).toHaveLength(8);
  });

  it("answers the progress route with the payload the script reads", async () => {
    const response = await associate.get(urls.runStatus(ids.matterId, ids.runId));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await response.json()).toEqual({
      status: "succeeded",
      label: "Finished",
      finished: true,
      progress: null,
    });
    expect(urls.runStatus(ids.matterId, ids.runId)).toBe(
      `${urls.run(ids.matterId, ids.runId)}/status`,
    );
  });

  it("names the progress route in the page of a review that is running, and the route follows it to the end", async () => {
    // A review held at its first model call, so that the pages are read while it is in flight.
    const hold = gate();
    const running = makeSite({
      model: { before: (call) => (call.kind === "extract" ? hold.pass() : undefined) },
    });
    const { matterId, am } = newMatter(running.w);
    await uploadCase(running.w, matterId);
    const browser = await running.as(IDS.associate);
    const started = await browser.api("POST", `/api/matters/${matterId}/runs`, { workflow: "v2" });
    expect(started.status).toBe(202);
    const run = (await started.json()) as RunSummary;
    await hold.reached(1);

    for (const path of [urls.matter(matterId), urls.run(matterId, run.id)]) {
      const page = await browser.page(path);
      checkPage(running, page);
      const box = first(page.root, (el) => hasAttr(el, "data-status-url"));
      expect(attr(box, "data-status-url")).toBe(urls.runStatus(matterId, run.id));
      // The findings are not shown while it runs, and the page says so.
      expect(all(page.root, (el) => el.name === "tr" && hasAttr(el, "data-issue-row"))).toEqual([]);
    }
    const midway = (await (await browser.get(urls.runStatus(matterId, run.id))).json()) as {
      status: string;
      finished: boolean;
      progress: { stage: string } | null;
    };
    expect(midway).toMatchObject({
      status: "extracting",
      finished: false,
      progress: { stage: "extract" },
    });

    // The associate may cancel it from the page the progress shows on.
    const page = await browser.page(urls.matter(matterId));
    expect(formsTo(page, urls.runCancel(matterId, run.id))).toBe(1);
    hold.open();
    await running.w.services.runs.idle();
    const done = (await (await browser.get(urls.runStatus(matterId, run.id))).json()) as {
      finished: boolean;
    };
    expect(done.finished).toBe(true);
    expect(running.w.services.runs.get(am, run.id).status).toBe("succeeded");
  });

  it("cancels a review in flight with the cancel form, and resumes nothing that did not fail", async () => {
    const hold = gate();
    const running = makeSite({
      model: { before: (call) => (call.kind === "extract" ? hold.pass() : undefined) },
    });
    const { matterId, am } = newMatter(running.w);
    await uploadCase(running.w, matterId);
    const browser = await running.as(IDS.associate);
    const run = (await (
      await browser.api("POST", `/api/matters/${matterId}/runs`, { workflow: "v2" })
    ).json()) as RunSummary;
    await hold.reached(1);
    const page = await browser.page(urls.matter(matterId));
    const response = await browser.submit(page, urls.runCancel(matterId, run.id));
    expect(response.status).toBe(303);
    expect((await browser.page(response.headers.get("location")!)).html).toContain(
      "The review was cancelled.",
    );
    hold.open();
    await running.w.services.runs.idle();
    expect(running.w.services.runs.get(am, run.id).status).toBe("cancelled");
    // Resuming a cancelled review is not a thing: the state machine refuses it.
    const resume = await browser.api("POST", `/api/matters/${matterId}/runs/${run.id}/resume`);
    expect(resume.status).toBe(409);
  });
});

describe("notices", () => {
  const noticeOf = (page: Page): string[] =>
    all(page.root, (el) => hasClass(el, "notice")).map(readable);

  it("shows the notice a redirect carried, and nothing for a code that only a link supplied", async () => {
    const site = makeSite();
    const ids = await prepareMatter(site, { exported: false });
    const associate = await site.as(IDS.associate);
    const reviewer = await site.as(IDS.reviewer);

    // The real thing: the redirect after a form carries the code and a signature for this person
    // and this page.
    const page = await associate.page(urls.matter(ids.matterId));
    const response = await associate.submit(page, urls.matterSettings(ids.matterId), {
      set: { [FIELDS.clientLegalName]: "Lanternfish Software, Incorporated" },
    });
    const location = response.headers.get("location")!;
    expect(location).toMatch(/\?notice=settings-saved&nt=\d+\.[A-Za-z0-9_-]{43}$/);
    expect(noticeOf(await associate.page(location))).toEqual(["Done The settings were saved."]);

    // A link that names a code proves nothing: nothing happened, so nothing is claimed.
    const matter = urls.matter(ids.matterId);
    const memos = urls.memos(ids.matterId);
    const run = urls.run(ids.matterId, ids.runId);
    for (const forged of [
      `${matter}?notice=settings-saved`,
      `${memos}?notice=memo-exported`,
      `${run}?notice=decision-saved`,
      `${urls.matters()}?notice=matter-deleted`,
      `${matter}?notice=settings-saved&nt=`,
      `${matter}?notice=settings-saved&nt=1.${"A".repeat(43)}`,
    ])
      expect(noticeOf(await reviewer.page(forged)), forged).toEqual([]);

    // A real signature is good for the code, the page and the person it was made for.
    const [path, query] = location.split("?") as [string, string];
    const swappedCode = query.replace("settings-saved", "member-added");
    const flipped = location.slice(0, -1) + (location.endsWith("A") ? "B" : "A");
    const otherPage = `${memos}?${query}`;
    for (const reused of [`${path}?${swappedCode}`, flipped, otherPage])
      expect(noticeOf(await associate.page(reused)), reused).toEqual([]);
    // Another person who is handed the link sees no notice either.
    expect(noticeOf(await reviewer.page(location))).toEqual([]);
  });

  it("shows nothing for anything that is not a code of the application", async () => {
    const site = makeSite();
    const ids = await prepareMatter(site, { exported: false });
    const browser = await site.as(IDS.associate);
    for (const code of [
      "nonsense",
      "",
      "constructor",
      "__proto__",
      "toString",
      "<script>alert(1)</script>",
      "settings-saved%20",
    ]) {
      const page = await browser.page(
        `${urls.matter(ids.matterId)}?notice=${encodeURIComponent(code)}`,
      );
      expect(noticeOf(page), JSON.stringify(code)).toEqual([]);
      expect(page.html).not.toContain("alert(1)");
    }
  });
});

describe("the workflow choice on the start form", () => {
  it("offers every live workflow, the default first and chosen, and starts the one chosen", async () => {
    const site = makeSite();
    const ids = await prepareMatter(site, { exported: false });
    const associate = await site.as(IDS.associate);
    const page = await associate.page(urls.matter(ids.matterId));
    const select = first(
      page.root,
      (el) => el.name === "select" && attr(el, "name") === WORKFLOW_FIELD,
    );
    const options = all(select, (el) => el.name === "option");
    expect(options.map((o) => [attr(o, "value"), readable(o), hasAttr(o, "selected")])).toEqual([
      ["v1", "v1 (candidate, default)", true],
      ["v2", "v2 (candidate)", false],
    ]);
    const response = await associate.submit(page, urls.runs(ids.matterId), {
      set: { [WORKFLOW_FIELD]: "v2" },
    });
    expect(response.status).toBe(303);
    await site.w.services.runs.idle();
    const runs = site.w.repo.listRunsForMatter(ids.matterId);
    expect(runs.map((r) => r.manifest.workflow.label)).toContain("v2");
    expect(runs[0]!.manifest.workflow.label).toBe("v2");
  });

  it("puts a promoted workflow first, as the one a review uses when none is chosen", async () => {
    const site = makeSite();
    const ids = await prepareMatter(site, { exported: false });
    const v2 = site.w.repo.getWorkflowVersionByLabel("v2")!;
    site.w.repo.promoteWorkflowVersion(v2.id, {
      actorId: IDS.admin,
      promotionRecord: "evals/results/synthetic-comparison.json",
    });
    const associate = await site.as(IDS.associate);
    const page = await associate.page(urls.matter(ids.matterId));
    const select = first(
      page.root,
      (el) => el.name === "select" && attr(el, "name") === WORKFLOW_FIELD,
    );
    expect(
      all(select, (el) => el.name === "option").map((o) => [
        attr(o, "value"),
        hasAttr(o, "selected"),
      ]),
    ).toEqual([
      ["v2", true],
      ["v1", false],
    ]);
    // Left alone, the form starts the one it preselected, which is the one the service picks.
    const response = await associate.submit(page, urls.runs(ids.matterId), {});
    expect(response.status).toBe(303);
    await site.w.services.runs.idle();
    expect(site.w.repo.listRunsForMatter(ids.matterId)[0]!.manifest.workflow.label).toBe("v2");
  });

  it("starts the default when the field is left out, and refuses a label that is not registered", async () => {
    const site = makeSite();
    const ids = await prepareMatter(site, { exported: false });
    const associate = await site.as(IDS.associate);
    const bare = await associate.api("POST", `/api/matters/${ids.matterId}/runs`, {});
    expect(bare.status).toBe(202);
    expect(((await bare.json()) as RunSummary).workflowLabel).toBe("v1");
    await site.w.services.runs.idle();
    const none = await associate.api("POST", `/api/matters/${ids.matterId}/runs`);
    expect(none.status).toBe(202);
    await site.w.services.runs.idle();
    for (const workflow of ["v9", "../v2", "v2 ", "V2"]) {
      const response = await associate.api("POST", `/api/matters/${ids.matterId}/runs`, {
        workflow,
      });
      expect([400, 404], workflow).toContain(response.status);
    }
  });

  it("is not shown when there is nothing to choose between", () => {
    const base = buildMatterView();
    const one = matterPage({
      ...base,
      workflows: [{ label: "v1", status: "candidate", isDefault: true }],
    });
    const absent = matterPage(base);
    const two = matterPage({
      ...base,
      workflows: [
        { label: "v1", status: "candidate", isDefault: true },
        { label: "v2", status: "candidate", isDefault: false },
      ],
    });
    expect(one).not.toContain(`name="${WORKFLOW_FIELD}"`);
    expect(absent).not.toContain(`name="${WORKFLOW_FIELD}"`);
    expect(two).toContain(`name="${WORKFLOW_FIELD}"`);
    expect(two).toContain("v2 (candidate)");
  });
});

describe("a page", () => {
  it("carries the permanent banner and the headers of the shell, on every page the routes serve", async () => {
    const site = makeSite();
    const ids = await prepareMatter(site);
    const reviewer = await site.as(IDS.reviewer);
    for (const path of [
      "/",
      urls.matters(),
      urls.matter(ids.matterId),
      urls.run(ids.matterId, ids.runId, ids.findingId),
      urls.finding(ids.matterId, ids.findingId),
      urls.memos(ids.matterId),
    ]) {
      const page = await reviewer.page(path);
      checkPage(site, page);
      expect(page.html).toContain(DEMO_BANNER);
      expect(page.response.headers.get("content-type")).toMatch(/^text\/html/);
      expect(page.response.headers.get("cache-control")).toBe("no-store");
      expect(page.response.headers.get("content-security-policy")).toContain("default-src 'none'");
    }
  });

  it("links only to routes the application has: every internal link of every page answers", async () => {
    const site = makeSite();
    const ids = await prepareMatter(site);
    const reviewer = await site.as(IDS.reviewer);
    const seen = new Set<string>();
    for (const path of [
      "/",
      urls.matters(),
      urls.matter(ids.matterId),
      urls.run(ids.matterId, ids.runId, ids.findingId),
      urls.finding(ids.matterId, ids.findingId),
      urls.memos(ids.matterId),
    ]) {
      const page = await reviewer.page(path);
      for (const link of all(
        page.root,
        (el) => el.name === "a" || el.name === "link" || el.name === "script",
      )) {
        const target = attr(link, "href") ?? attr(link, "src");
        if (target === null || target === undefined || !target.startsWith("/")) continue;
        expect(routeFor(site.app, "GET", target), `${path} links to ${target}`).toBeDefined();
        seen.add(target.split("?")[0]!);
      }
    }
    // The links that matter most are among them.
    expect(seen).toContain(urls.memoFile(ids.matterId, ids.memoId!));
    expect(seen).toContain(urls.run(ids.matterId, ids.runId));
    expect(seen).toContain(urls.asset("parol.js"));
    // And what a link to a file answers.
    for (const target of [urls.memoFile(ids.matterId, ids.memoId!), urls.asset("parol.css")])
      expect((await reviewer.get(target)).status, target).toBe(200);
  });
});
