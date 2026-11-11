import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  REFUSAL_JUMP,
  REFUSAL_PHRASES,
  REFUSAL_TODO,
  refusalOf,
} from "../../src/server/routes/notices.js";
import { urls } from "../../src/server/urls.js";
import {
  ActiveRunError,
  ConflictError,
  InvalidTransitionError,
  StaleRunError,
} from "../../src/store/errors.js";
import { all, attr, hasClass, parseHtml, readable, type El } from "../pages/html.js";
import {
  IDS,
  cleanup,
  gate,
  makeSite,
  newMatter,
  prepareMatter,
  uploadCase,
  type Browser,
  type Prepared,
  type Site,
} from "../routes/support.js";

/**
 * Six refusals of the forms of the matter page that a person meets in ordinary use (a second tab,
 * a click on a review that has just finished) used to be answered with the general sentence of
 * their status. Each now says what has happened and what to do, and the ones that have a place on
 * the page to go to carry a link to it. What these tests can show: the words, that the link leads
 * to an element of the page that is answered, and that the form's refusal changes nothing. What
 * they cannot show: that a person who reads the words does what they ask.
 */

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const NO_DASH = /[\u2013\u2014]/;
const FORM = { "content-type": "application/x-www-form-urlencoded" };

/** The codes, with the words they were given, the part that says what to do, and the link. */
const CODES = [
  {
    code: "member_exists",
    phrase:
      "That person is already on this matter, so they were not added again. Check the list of people for the role they have.",
    todo: "Check the list of people for the role they have.",
    jump: { href: "#people", label: "Go to the people on this matter" },
    error: () => new ConflictError("member_exists", "x"),
  },
  {
    code: "remove_later_first",
    phrase:
      "A document can be removed only after the documents that come after it have been removed. Remove the later documents first.",
    todo: "Remove the later documents first.",
    jump: { href: "#documents", label: "Go to the documents" },
    error: () => new ConflictError("remove_later_first", "x"),
  },
  {
    code: "active_run",
    phrase:
      "A review is already running on this matter, so another was not started. Follow the review in progress, or cancel it and start a new one.",
    todo: "Follow the review in progress, or cancel it and start a new one.",
    jump: { href: "#active-run", label: "Go to the review in progress" },
    error: () => new ActiveRunError("run_a1b2c3"),
  },
  {
    code: "invalid_transition",
    phrase:
      "The review is no longer in a state where that can be done: it may have finished, failed or been cancelled already. Reload the page to see how the review stands.",
    todo: "Reload the page to see how the review stands.",
    jump: undefined,
    error: () => new InvalidTransitionError("run", "succeeded", "cancelled"),
  },
  {
    code: "stale_run",
    phrase:
      "That review is out of date, because the documents or the playbook changed after it started. Start a new review.",
    todo: "Start a new review.",
    jump: undefined,
    error: () => new StaleRunError("superseded"),
  },
] as const;

describe("the words of the refusals", () => {
  it.each(CODES)(
    "$code: a phrase that ends in what to do, a link where there is a place to go",
    (row) => {
      expect(REFUSAL_PHRASES[row.code]).toBe(row.phrase);
      expect(REFUSAL_TODO[row.code]).toBe(row.todo);
      expect(row.phrase.endsWith(row.todo)).toBe(true);
      expect(REFUSAL_JUMP[row.code]).toEqual(row.jump);
      expect(row.phrase).not.toMatch(NO_DASH);
      expect(row.todo).not.toMatch(NO_DASH);
      if (row.jump !== undefined) expect(row.jump.label).not.toMatch(NO_DASH);
    },
  );

  it.each(CODES)(
    "$code: a form refused with it is told the words, with the status of a conflict",
    (row) => {
      const refusal = refusalOf(row.error());
      expect(refusal?.status).toBe(409);
      expect(refusal?.code).toBe(row.code);
      expect(refusal?.notice).toEqual({
        kind: "error",
        text: row.phrase,
        todo: row.todo,
        ...(row.jump === undefined ? {} : { jump: row.jump }),
      });
    },
  );

  it("does not hand the general sentence of the status to any of them", () => {
    for (const row of CODES) {
      expect(refusalOf(row.error())?.notice.text).not.toContain(
        "That conflicts with the current state",
      );
    }
  });
});

// ---------------------------------------------------------------------------------------------
// In the pages
// ---------------------------------------------------------------------------------------------

/** The error notice of a page, read as the page draws it: its words, its todo and its link. */
function alertOf(html: string): { root: El; text: string; hrefs: string[] } {
  const root = parseHtml(html);
  const alerts = all(root, (el) => attr(el, "role") === "alert");
  expect(alerts).toHaveLength(1);
  expect(hasClass(alerts[0]!, "notice-error")).toBe(true);
  const hrefs = all(alerts[0]!, (el) => el.name === "a").map((a) => attr(a, "href") ?? "");
  return { root, text: readable(alerts[0]!), hrefs };
}

const hasId = (root: El, id: string): boolean =>
  all(root, (el) => attr(el, "id") === id).length > 0;

/** What the page of a refused form says, for a code with the words and the link of the table. */
function expectRefusalPage(html: string, row: (typeof CODES)[number]): void {
  const { root, text, hrefs } = alertOf(html);
  const link = row.jump === undefined ? "" : ` ${row.jump.label}`;
  expect(text).toBe(`Problem ${row.phrase}${link}`);
  // The part that says what to do is set apart, and it is the part the table names.
  const todos = all(root, (el) => hasClass(el, "todo"));
  expect(todos.map(readable)).toEqual([row.todo]);
  if (row.jump === undefined) expect(hrefs).toEqual([]);
  else {
    expect(hrefs).toEqual([row.jump.href]);
    // A link that leads nowhere is worse than none: the place it names is on the page.
    expect(hasId(root, row.jump.href.slice(1)), `the page has #${row.jump.href.slice(1)}`).toBe(
      true,
    );
  }
}

const row = (code: string): (typeof CODES)[number] => CODES.find((r) => r.code === code)!;

describe("a matter whose review has finished", () => {
  let site: Site;
  let ids: Prepared;
  let associate: Browser;

  beforeAll(async () => {
    site = makeSite();
    ids = await prepareMatter(site, { exported: false });
    associate = await site.as(IDS.associate);
  });

  const post = async (path: string, fields: Record<string, string> = {}): Promise<Response> =>
    associate.send("POST", path, {
      headers: FORM,
      body: new URLSearchParams({ _csrf: await associate.apiToken(), ...fields }).toString(),
    });

  const view = () => site.w.services.matters.view(site.w.grant(site.w.associate, ids.matterId));

  it("answers adding a person who is on the matter already with the words and a link to the people", async () => {
    const people = view().members.length;
    const response = await post(urls.members(ids.matterId), {
      userId: IDS.reviewer,
      role: "reviewer",
    });
    expect(response.status).toBe(409);
    expectRefusalPage(await response.text(), row("member_exists"));
    expect(view().members).toHaveLength(people);
  });

  it("answers removing a document that has a later one with the words and a link to the documents", async () => {
    const documents = view().documents.length;
    const response = await post(urls.documentRemove(ids.matterId, ids.firstDocumentId), {
      confirm: "yes",
    });
    expect(response.status).toBe(409);
    expectRefusalPage(await response.text(), row("remove_later_first"));
    expect(view().documents).toHaveLength(documents);
  });

  it("answers cancelling and resuming a review that has finished with the words and no link", async () => {
    const cancel = await post(urls.runCancel(ids.matterId, ids.runId));
    expect(cancel.status).toBe(409);
    expectRefusalPage(await cancel.text(), row("invalid_transition"));
    const resume = await post(urls.runResume(ids.matterId, ids.runId));
    expect(resume.status).toBe(409);
    expectRefusalPage(await resume.text(), row("invalid_transition"));
    expect(
      site.w.services.runs.get(site.w.grant(site.w.associate, ids.matterId), ids.runId).status,
    ).toBe("succeeded");
  });

  it("answers cancelling and resuming a review that the documents have outdated with the words and no link", async () => {
    // A second matter, so that the one above keeps its finished review.
    const other = await prepareMatter(site, {
      exported: false,
      name: "A matter whose documents change",
    });
    const am = site.w.grant(site.w.associate, other.matterId);
    site.w.services.matters.setStatedDate(am, other.versionId, "2026-01-02");
    expect(site.w.services.runs.get(am, other.runId).status).toBe("superseded");
    for (const path of [
      urls.runCancel(other.matterId, other.runId),
      urls.runResume(other.matterId, other.runId),
    ]) {
      const response = await post(path);
      expect(response.status).toBe(409);
      expectRefusalPage(await response.text(), row("stale_run"));
    }
    expect(site.w.services.runs.get(am, other.runId).status).toBe("superseded");
  });
});

describe("a matter with a review in progress", () => {
  const hold = gate();
  let site: Site;
  let matterId: string;
  let associate: Browser;

  beforeAll(async () => {
    site = makeSite({
      model: { before: (call) => (call.kind === "extract" ? hold.pass() : undefined) },
    });
    ({ matterId } = newMatter(site.w, "A matter with a review in progress"));
    await uploadCase(site.w, matterId);
    associate = await site.as(IDS.associate);
    const started = await associate.api("POST", `/api/matters/${matterId}/runs`, {
      workflow: "v2",
    });
    expect(started.status).toBe(202);
    await hold.reached(1);
  });

  afterAll(async () => {
    hold.open();
    await site.w.services.runs.idle();
  });

  const post = async (
    who: Browser,
    path: string,
    fields: Record<string, string>,
  ): Promise<Response> =>
    who.send("POST", path, {
      headers: FORM,
      body: new URLSearchParams({ _csrf: await who.apiToken(), ...fields }).toString(),
    });

  it("answers a second review with the words and a link to the review in progress", async () => {
    const before = site.w.services.runs.list(site.w.grant(site.w.associate, matterId)).length;
    const response = await post(associate, urls.runs(matterId), { workflow: "v2" });
    expect(response.status).toBe(409);
    expectRefusalPage(await response.text(), row("active_run"));
    expect(site.w.services.runs.list(site.w.grant(site.w.associate, matterId))).toHaveLength(
      before,
    );
  });
});
