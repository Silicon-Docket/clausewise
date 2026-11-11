import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FIELDS } from "../../src/server/pages/forms.js";
import { PILOT_ANCHORS, referenceSeverityField } from "../../src/server/pages/pilotfields.js";
import { pilotJumpHasTarget } from "../../src/server/routes/page-renderers.js";
import { urls } from "../../src/server/urls.js";
import { expectAccessible, tabStops } from "../a11y/rules.js";
import { all, attr, byId, byTag, hasAttr, hasClass, readable, type El } from "../pages/html.js";
import { buildReference, buildTimer } from "../pages/pilot-support.js";
import {
  Browser,
  IDS,
  VIEWER,
  addMember,
  checkPage,
  cleanup,
  makeSite,
  newMatter,
  uploadCase,
  type Page,
  type Site,
} from "./support.js";

/**
 * The timer and the reference list as the matter page shows them to the people of a real matter
 * (package W2.6b): who is given each panel, that the form a panel writes is the form the route reads
 * (the forms here are submitted the way a browser submits them, from the page, not built by hand),
 * what each panel reads after a change, and that a refusal is answered with the page and a link that
 * leads to a place that is on it. The routes themselves, with their guard, token and audit, are in
 * test/routes/pilot.test.ts.
 */

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const FORM = { "content-type": "application/x-www-form-urlencoded" };

const timerSection = (page: Page): El | undefined => byId(page.root, PILOT_ANCHORS.timer);
const referenceSection = (page: Page): El | undefined =>
  byId(page.root, PILOT_ANCHORS.referenceList);
const buttonsOf = (section: El): string[] => byTag(section, "button").map((b) => readable(b));

/** A browser's submit of the one form of a panel, with the button it pressed. */
async function press(
  browser: Browser,
  page: Page,
  action: string,
  options: { name: string; value: string } | { set: Record<string, string> },
): Promise<Response> {
  return "set" in options
    ? browser.submit(page, action, { set: options.set })
    : browser.submit(page, action, { submitter: options });
}

describe("who is given which panel", () => {
  let site: Site;
  let matterId: string;
  beforeAll(() => {
    site = makeSite();
    matterId = newMatter(site.w).matterId;
    addMember(site, matterId, VIEWER, "viewer");
  });

  it("gives the associate the timer and not the reference list, and the page passes the page rules", async () => {
    const page = await (await site.as(IDS.associate)).page(urls.matter(matterId));
    expectAccessible(page.html);
    checkPage(site, page);
    expect(timerSection(page)).toBeDefined();
    expect(referenceSection(page)).toBeUndefined();
    expect(readable(page.root)).not.toContain("Reference list for shadow mode");
  });

  it("gives the reviewing attorney both, the timer first, and both before the people", async () => {
    const page = await (await site.as(IDS.reviewer)).page(urls.matter(matterId));
    expectAccessible(page.html);
    checkPage(site, page);
    expect(timerSection(page)).toBeDefined();
    expect(referenceSection(page)).toBeDefined();
    const order = all(page.root, (el) => el.name === "section").map((s) => attr(s, "id"));
    expect(order.indexOf("memos")).toBeLessThan(order.indexOf(PILOT_ANCHORS.timer));
    expect(order.indexOf(PILOT_ANCHORS.timer)).toBeLessThan(
      order.indexOf(PILOT_ANCHORS.referenceList),
    );
    expect(order.indexOf(PILOT_ANCHORS.referenceList)).toBeLessThan(order.indexOf("people"));
  });

  it("gives a viewer neither, with no button of either and no mention of either", async () => {
    const page = await (await site.as(VIEWER)).page(urls.matter(matterId));
    expectAccessible(page.html);
    expect(timerSection(page)).toBeUndefined();
    expect(referenceSection(page)).toBeUndefined();
    const text = readable(page.root);
    for (const word of ["Start timer", "Stop timer", "reference list", "Reference list"])
      expect(text, word).not.toContain(word);
    expect(all(page.root, (el) => el.name === "form").map((f) => attr(f, "action"))).not.toContain(
      urls.matterTimer(matterId),
    );
  });

  it("gives the training matter neither: no measure counts it, and its page keeps the playbook's rules back", async () => {
    const training = site.w.services.matters.create(site.w.associate, {
      name: "Training: Lanternfish / Corvane NDA (T01)",
      clientLegalName: "Lanternfish Software, Inc.",
      playbookVersionId: site.w.playbookVersionId,
      reviewerUserId: site.w.reviewer.userId,
      training: "T01",
    });
    for (const userId of [IDS.associate, IDS.reviewer]) {
      const page = await (await site.as(userId)).page(urls.matter(training.id));
      expect(timerSection(page), userId).toBeUndefined();
      expect(referenceSection(page), userId).toBeUndefined();
      expect(readable(page.root).toLowerCase(), userId).not.toContain("pds-1");
    }
  });

  it("shows each person their own timer only: another person's running timer is not on this page", async () => {
    const associate = await site.as(IDS.associate);
    const reviewer = await site.as(IDS.reviewer);
    const first = await associate.page(urls.matter(matterId));
    expect(
      (
        await press(associate, first, urls.matterTimer(matterId), {
          name: "intent",
          value: "start",
        })
      ).status,
    ).toBe(303);
    const theirs = await reviewer.page(urls.matter(matterId));
    expect(buttonsOf(timerSection(theirs) as El)).toEqual(["Start timer"]);
    expect(readable(timerSection(theirs) as El)).not.toContain("A timer is running since");
    // Put the associate's timer away for the tests that follow.
    const again = await associate.page(urls.matter(matterId));
    expect(
      (await press(associate, again, urls.matterTimer(matterId), { name: "intent", value: "stop" }))
        .status,
    ).toBe(303);
  });
});

describe("the timer, from the page", () => {
  let site: Site;
  let matterId: string;
  let otherId: string;
  beforeAll(() => {
    site = makeSite();
    matterId = newMatter(site.w).matterId;
    otherId = newMatter(site.w, "A second NDA").matterId;
  });

  it("starts from the Start button of the page, shows the running state, and stops from the Stop button", async () => {
    const associate = await site.as(IDS.associate);
    let page = await associate.page(urls.matter(matterId));
    expect(buttonsOf(timerSection(page) as El)).toEqual(["Start timer"]);
    expect(readable(timerSection(page) as El)).toContain("No timer is running on this matter.");

    const started = await press(associate, page, urls.matterTimer(matterId), {
      name: FIELDS.intent,
      value: "start",
    });
    expect(started.status).toBe(303);
    page = await associate.page(started.headers.get("location") ?? "");
    expectAccessible(page.html);
    const running = timerSection(page) as El;
    expect(buttonsOf(running)).toEqual(["Stop timer"]);
    expect(readable(running)).toMatch(
      /A timer is running since \d+ November 2026, \d\d:\d\d UTC\./,
    );
    expect(readable(running)).toContain("You have not stopped a timer on this matter yet.");
    expect(readable(page.root)).toContain("The timer is running.");

    const stopped = await press(associate, page, urls.matterTimer(matterId), {
      name: FIELDS.intent,
      value: "stop",
    });
    expect(stopped.status).toBe(303);
    page = await associate.page(stopped.headers.get("location") ?? "");
    expectAccessible(page.html);
    const after = timerSection(page) as El;
    expect(buttonsOf(after)).toEqual(["Start timer"]);
    expect(readable(after)).toMatch(
      /You have 1 stopped session on this matter, \d+ seconds? in all\./,
    );
  });

  it("adds each closed session to the total, and counts the sessions", async () => {
    const reviewer = await site.as(IDS.reviewer);
    for (let i = 0; i < 2; i += 1) {
      let page = await reviewer.page(urls.matter(matterId));
      await press(reviewer, page, urls.matterTimer(matterId), {
        name: FIELDS.intent,
        value: "start",
      });
      page = await reviewer.page(urls.matter(matterId));
      await press(reviewer, page, urls.matterTimer(matterId), {
        name: FIELDS.intent,
        value: "stop",
      });
    }
    const page = await reviewer.page(urls.matter(matterId));
    expect(readable(timerSection(page) as El)).toMatch(
      /You have 2 stopped sessions on this matter,/,
    );
  });

  it("shows a timer that runs on another matter as running elsewhere: no button, and no matter named", async () => {
    const associate = await site.as(IDS.associate);
    const there = await associate.page(urls.matter(otherId));
    expect(
      (
        await press(associate, there, urls.matterTimer(otherId), {
          name: FIELDS.intent,
          value: "start",
        })
      ).status,
    ).toBe(303);

    const here = await associate.page(urls.matter(matterId));
    expectAccessible(here.html);
    const section = timerSection(here) as El;
    expect(buttonsOf(section)).toEqual([]);
    expect(byTag(section, "form")).toEqual([]);
    const text = readable(section);
    expect(text).toContain("You have a timer running on another matter. Stop it there first");
    expect(text).not.toContain("A second NDA");
    expect(text).not.toContain(otherId);
    expect(readable(all(section, (el) => hasClass(el, "chip"))[0] as El)).toBe("Running elsewhere");
    // Nothing on the page of this matter leads to the other one.
    expect(tabStops(here.root).map((el) => attr(el, "href") ?? "")).not.toContain(
      urls.matter(otherId),
    );

    const stop = await associate.page(urls.matter(otherId));
    expect(
      (
        await press(associate, stop, urls.matterTimer(otherId), {
          name: FIELDS.intent,
          value: "stop",
        })
      ).status,
    ).toBe(303);
    const freed = await associate.page(urls.matter(matterId));
    expect(buttonsOf(timerSection(freed) as El)).toEqual(["Start timer"]);
  });

  it("answers a second start by hand with the page and the words, and the Stop button still there", async () => {
    const associate = await site.as(IDS.associate);
    const page = await associate.page(urls.matter(matterId));
    await press(associate, page, urls.matterTimer(matterId), {
      name: FIELDS.intent,
      value: "start",
    });
    const stale = page; // the page the person opened before, with a Start button
    const refused = await press(associate, stale, urls.matterTimer(matterId), {
      name: FIELDS.intent,
      value: "start",
    });
    expect(refused.status).toBe(409);
    const html = await refused.text();
    const root = expectAccessible(html);
    expect(readable(all(root, (el) => attr(el, "role") === "alert")[0] as El)).toContain(
      "You already have a timer running. Stop it before starting another one.",
    );
    expect(buttonsOf(byId(root, PILOT_ANCHORS.timer) as El)).toEqual(["Stop timer"]);
    const open = await associate.page(urls.matter(matterId));
    await press(associate, open, urls.matterTimer(matterId), {
      name: FIELDS.intent,
      value: "stop",
    });
  });
});

describe("the reference list, from the page", () => {
  let site: Site;
  let matterId: string;
  beforeAll(() => {
    site = makeSite();
    matterId = newMatter(site.w).matterId;
  });
  const selectedOf = (section: El): Record<string, string> =>
    Object.fromEntries(
      byTag(section, "select").map((select) => [
        attr(select, "name") ?? "",
        attr(byTag(select, "option").find((o) => hasAttr(o, "selected")) as El, "value") ?? "",
      ]),
    );

  it("opens with one select for each rule of the playbook, nothing marked, and every count at 0", async () => {
    const page = await (await site.as(IDS.reviewer)).page(urls.matter(matterId));
    const section = referenceSection(page) as El;
    const keys = site.w.repo.listRules(site.w.playbookVersionId).map((rule) => rule.key);
    expect(Object.keys(selectedOf(section))).toEqual(keys.map(referenceSeverityField));
    expect(new Set(Object.values(selectedOf(section)))).toEqual(new Set([""]));
    const counts = byTag(section, "input").filter((i) => attr(i, "type") === "number");
    expect(counts.map((i) => attr(i, "value"))).toEqual(["0", "0", "0"]);
    expect(readable(section)).toContain(
      `Saved: 0 of ${keys.length} rules marked as an issue, and 0 issues no rule covers.`,
    );
  });

  it("saves what the reviewer chose on the page, and shows it as saved on the next one", async () => {
    const reviewer = await site.as(IDS.reviewer);
    const page = await reviewer.page(urls.matter(matterId));
    const response = await press(reviewer, page, urls.matterReferenceList(matterId), {
      set: {
        [referenceSeverityField("dur-1")]: "high",
        [referenceSeverityField("pds-1")]: "medium",
        [FIELDS.outsideLow]: "2",
      },
    });
    expect(response.status).toBe(303);
    const next = await reviewer.page(response.headers.get("location") ?? "");
    expectAccessible(next.html);
    const section = referenceSection(next) as El;
    const chosen = selectedOf(section);
    expect(chosen[referenceSeverityField("dur-1")]).toBe("high");
    expect(chosen[referenceSeverityField("pds-1")]).toBe("medium");
    expect(Object.values(chosen).filter((value) => value !== "")).toHaveLength(2);
    expect(
      byTag(section, "input")
        .filter((i) => attr(i, "type") === "number")
        .map((i) => attr(i, "value")),
    ).toEqual(["0", "0", "2"]);
    expect(readable(section)).toMatch(
      /Saved: 2 of \d+ rules marked as an issue, and 2 issues no rule covers\./,
    );
    expect(readable(next.root)).toContain("The reference list was saved.");
  });

  it("answers a count out of range with the page, the words, and a link to the counts that is on the page", async () => {
    const reviewer = await site.as(IDS.reviewer);
    const page = await reviewer.page(urls.matter(matterId));
    const response = await press(reviewer, page, urls.matterReferenceList(matterId), {
      set: { [FIELDS.outsideHigh]: "12" },
    });
    expect(response.status).toBe(400);
    const root = expectAccessible(await response.text());
    const alert = all(root, (el) => attr(el, "role") === "alert")[0] as El;
    expect(readable(alert)).toContain("That is not a count the list can hold.");
    const link = all(alert, (el) => el.name === "a")[0] as El;
    expect(attr(link, "href")).toBe("#reference-outside");
    expect(byId(root, "reference-outside")).toBeDefined();
    // The list as it was saved is what the page shows again.
    expect(
      selectedOf(byId(root, PILOT_ANCHORS.referenceList) as El)[referenceSeverityField("dur-1")],
    ).toBe("high");
  });

  it("closes when a review starts: the list is shown as it was left, read only, and a hand-posted change is answered without a dangling link", async () => {
    const reviewer = await site.as(IDS.reviewer);
    await uploadCase(site.w, matterId);
    site.w.services.runs.start(site.w.grant(site.w.associate, matterId), { workflowLabel: "v2" });
    await site.w.services.runs.idle();

    const page = await reviewer.page(urls.matter(matterId));
    const section = referenceSection(page) as El;
    expect(readable(section)).toContain("This list is closed because a review has started.");
    expect(byTag(section, "form")).toEqual([]);
    expect(byTag(section, "select")).toEqual([]);
    const rows = all(byTag(section, "tbody")[0] as El, (el) => el.name === "tr").map((tr) =>
      byTag(tr, "th")
        .concat(byTag(tr, "td"))
        .map((cell) => readable(cell)),
    );
    // The playbook's order, then the issues no rule covers.
    expect(rows.map((row) => row.slice(1))).toEqual([
      ["Medium", "1"],
      ["High", "1"],
      ["Low", "2"],
    ]);
    const titles = new Map(
      site.w.repo.listRules(site.w.playbookVersionId).map((rule) => [rule.key, rule.title]),
    );
    expect(rows.map((row) => row[0])).toEqual([
      titles.get("pds-1"),
      titles.get("dur-1"),
      "No rule covers it",
    ]);
    checkPage(site, page);

    // A count out of range is refused for its own sake before the list is looked at; the control it
    // names is not on this page any more, so the words stand without a link to nowhere.
    const response = await reviewer.send("POST", urls.matterReferenceList(matterId), {
      headers: FORM,
      body: new URLSearchParams({ _csrf: await reviewer.apiToken(), outsideHigh: "x" }).toString(),
    });
    expect(response.status).toBe(400);
    const root = expectAccessible(await response.text());
    const alert = all(root, (el) => attr(el, "role") === "alert")[0] as El;
    expect(readable(alert)).toContain("That is not a count the list can hold.");
    expect(all(alert, (el) => el.name === "a")).toEqual([]);
    expect(byId(root, "reference-outside")).toBeUndefined();
  });
});

describe("a matter with no playbook chosen", () => {
  let site: Site;
  let matterId: string;
  beforeAll(() => {
    site = makeSite();
    matterId = site.w.services.matters.create(site.w.associate, {
      name: "No playbook yet",
      clientLegalName: "Lanternfish Ltd",
      playbookVersionId: null,
      reviewerUserId: site.w.reviewer.userId,
    }).id;
  });

  it("offers the counts and no rules, says who chooses a playbook and links to the place", async () => {
    const reviewer = await site.as(IDS.reviewer);
    const page = await reviewer.page(urls.matter(matterId));
    expectAccessible(page.html);
    const section = referenceSection(page) as El;
    expect(byTag(section, "select")).toEqual([]);
    expect(readable(section)).toContain("No playbook version is chosen for this matter yet");
    const link = byTag(section, "a")[0] as El;
    expect(attr(link, "href")).toBe("#settings");
    expect(byId(page.root, "settings")).toBeDefined();

    const response = await press(reviewer, page, urls.matterReferenceList(matterId), {
      set: { [FIELDS.outsideMedium]: "3" },
    });
    expect(response.status).toBe(303);
    const next = await reviewer.page(response.headers.get("location") ?? "");
    expect(readable(referenceSection(next) as El)).toContain("3 issues no rule covers");
  });
});

describe("the link of a refusal", () => {
  const OPEN = buildReference();
  const LOCKED = buildReference({ state: "locked" });
  const TIMER = buildTimer();

  it("is kept when the place it leads to is on the page", () => {
    expect(pilotJumpHasTarget("#time", TIMER, null)).toBe(true);
    expect(pilotJumpHasTarget("#reference-list", TIMER, OPEN)).toBe(true);
    expect(pilotJumpHasTarget("#reference-list", TIMER, LOCKED)).toBe(true);
    expect(pilotJumpHasTarget("#reference-outside", TIMER, OPEN)).toBe(true);
    expect(
      pilotJumpHasTarget("#reference-outside", TIMER, buildReference({ state: "no_playbook" })),
    ).toBe(true);
  });

  it("is dropped when the person has no such panel, or the panel holds no such control", () => {
    expect(pilotJumpHasTarget("#time", buildTimer({ allowed: false }), null)).toBe(false);
    expect(pilotJumpHasTarget("#reference-list", TIMER, null)).toBe(false);
    expect(pilotJumpHasTarget("#reference-outside", TIMER, null)).toBe(false);
    expect(pilotJumpHasTarget("#reference-outside", TIMER, LOCKED)).toBe(false);
  });

  it("is left alone when it is not one of this fragment's places, or there is none", () => {
    expect(pilotJumpHasTarget(undefined, TIMER, null)).toBe(true);
    expect(pilotJumpHasTarget("#settings", TIMER, null)).toBe(true);
    expect(pilotJumpHasTarget("#retention", buildTimer({ allowed: false }), null)).toBe(true);
  });
});
