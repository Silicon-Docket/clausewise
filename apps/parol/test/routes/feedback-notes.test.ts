import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FIELDS } from "../../src/server/pages/forms.js";
import { REFUSAL_JUMP, REFUSAL_PHRASES, REFUSAL_TODO } from "../../src/server/routes/notices.js";
import { urls } from "../../src/server/urls.js";
import { NOTE_BUTTON, NOTES_EMPTY, noteCountLabel } from "../../src/server/views/feedback.js";
import { CANNOT_ADD_NOTE } from "../../src/services/phrases.js";
import type { FindingView, MatterFeedbackView, NoteView } from "../../src/services/views.js";
import { expectAccessible, tabStops } from "../a11y/rules.js";
import {
  all,
  attr,
  byId,
  first,
  hasAttr,
  hasClass,
  parseHtml,
  readable,
  withClass,
  type El,
} from "../pages/html.js";
import {
  IDS,
  OUTSIDER,
  VIEWER,
  cleanup,
  fingerprint,
  makeSite,
  prepareMatter,
  type Browser,
  type Page,
  type Prepared,
  type Site,
} from "./support.js";

/**
 * The note on a finding, as a form on the finding pane and as JSON (package W2.6a, slice D). Any
 * member of a matter can add a note to a finding that is current; it is stored for the person who
 * is signed in and for the finding in the path, is read by every member beside the finding, and
 * changes no finding, decision or gate. A form that is refused is answered with the finding's page,
 * the words of the refusal and what was typed; the JSON API answers the same refusals with the same
 * codes. A finding of another matter in the path is a 404, the same as one that is nowhere, and
 * nothing is written for a request without its token.
 */

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let site: Site;
let associate: Browser;
let reviewer: Browser;
let viewer: Browser;
let outsider: Browser;

beforeAll(async () => {
  site = makeSite();
  associate = await site.as(IDS.associate);
  reviewer = await site.as(IDS.reviewer);
  viewer = await site.as(VIEWER);
  outsider = await site.as(OUTSIDER);
});

/** A matter in review with a finished review, so that each test writes on one of its own. */
const open = (name = "A matter for notes"): Promise<Prepared> =>
  prepareMatter(site, { name, exported: false });

const findingUrl = (ids: Prepared, findingId = ids.findingId): string =>
  urls.finding(ids.matterId, findingId);
const formAction = (ids: Prepared, findingId = ids.findingId): string =>
  urls.notes(ids.matterId, findingId);
const apiNotes = (ids: Prepared, findingId = ids.findingId): string =>
  `/api/matters/${ids.matterId}/findings/${findingId}/notes`;
const apiFeedback = (ids: Prepared): string => `/api/matters/${ids.matterId}/feedback`;

/** A post made by hand, with values the form's controls do not offer. */
async function byHand(
  who: Browser,
  to: string,
  fields: Record<string, string>,
  token?: string | null,
): Promise<Response> {
  const sent = new URLSearchParams(fields);
  const csrf = token === undefined ? await who.apiToken() : token;
  if (csrf !== null) sent.set("_csrf", csrf);
  return who.send("POST", to, {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: sent.toString(),
  });
}

/** The rows the routes can change, by the fingerprint of the suite, and the rows of feedback it does not count. */
const stateOf = (matterId?: string): Record<string, number> => {
  const where = matterId === undefined ? "" : " WHERE matter_id = ?";
  const feedback = site.w.repo.db
    .prepare(`SELECT COUNT(*) AS n FROM feedback${where}`)
    .get(...(matterId === undefined ? [] : [matterId])) as { n: number };
  return { ...fingerprint(site, matterId), feedback: feedback.n };
};

const notesOf = (ids: Prepared, findingId = ids.findingId) =>
  site.w.repo.listFeedback(ids.matterId, { kind: "comment", findingId });

const asPage = async (response: Response, status: number): Promise<Page> => {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toMatch(/^text\/html/);
  const html = await response.text();
  return { response, html, root: parseHtml(html) };
};

const noticeOf = (page: Page): El =>
  first(page.root, (el) => attr(el, "role") === "alert" && hasClass(el, "notice-error"));

const section = (page: Page): El => byId(page.root, "notes")!;
const box = (page: Page): El => byId(page.root, "note-text")!;

/** A finding of the matter that is not the one under test. */
const otherFinding = (ids: Prepared): string =>
  site.w.services.runs
    .issues(site.w.grant(site.w.associate, ids.matterId), ids.runId)
    .find((i) => i.findingId !== ids.findingId)!.findingId;

/** Starts a review again on unchanged documents, so that the findings of the first are out of date. */
async function replace(ids: Prepared): Promise<void> {
  site.w.services.runs.start(site.w.grant(site.w.associate, ids.matterId), {
    workflowLabel: "v2",
  });
  await site.w.services.runs.idle();
}

const error = async (response: Response): Promise<{ kind: string; code?: string }> =>
  ((await response.json()) as { error: { kind: string; code?: string } }).error;

// ---------------------------------------------------------------------------------------------

describe("the note form, on the finding's page", () => {
  it("is offered to every member: a labelled box and a button in the section of the notes, posting to the finding's own address", async () => {
    const ids = await open();
    for (const who of [associate, reviewer, viewer]) {
      const page = await who.page(findingUrl(ids));
      expectAccessible(page.html);
      const form = who.formOf(page, formAction(ids));
      expect(attr(form, "method")).toBe("post");
      expect(readable(first(section(page), (el) => el.name === "h2"))).toContain(
        "Notes on this finding",
      );
      expect(readable(first(form, (el) => el.name === "button"))).toBe(NOTE_BUTTON);
      expect(readable(section(page))).toContain(NOTES_EMPTY);
      // Tab order of the form: the box, then the button.
      const stops = tabStops(form).map((el) => attr(el, "name") ?? el.name);
      expect(stops.filter((n) => n !== "_csrf")).toEqual([FIELDS.note, "button"]);
    }
  });

  it("is in the inspector of the review page too, with the same address", async () => {
    const ids = await open();
    const page = await associate.page(urls.run(ids.matterId, ids.runId, ids.findingId));
    expectAccessible(page.html);
    expect(associate.hasForm(page, formAction(ids))).toBe(true);
    const inspector = first(page.root, (el) => attr(el, "id") === "inspector");
    expect(byId(inspector, "notes")).toBeDefined();
  });

  it("adds a note: 303 to the review table with the finding selected and a signed notice, and the note is there for everyone", async () => {
    const ids = await open();
    const page = await associate.page(findingUrl(ids));
    // A browser posts a line break as CR LF: the note is kept with the plain one.
    const response = await associate.submit(page, formAction(ids), {
      set: { [FIELDS.note]: "I read Section 9.3 differently.\r\nPlease check the amendment." },
    });
    expect(response.status).toBe(303);
    const to = response.headers.get("location")!;
    expect(
      to.startsWith(`${urls.run(ids.matterId, ids.runId, ids.findingId)}&notice=note-saved&nt=`),
    ).toBe(true);
    const after = await associate.page(to);
    expectAccessible(after.html);
    expect(readable(first(after.root, (el) => attr(el, "role") === "status"))).toContain(
      "Your note was added to the finding.",
    );
    const items = all(section(after), (el) => el.name === "li");
    expect(items).toHaveLength(1);
    expect(readable(items[0]!)).toContain(
      "I read Section 9.3 differently. Please check the amendment.",
    );
    // The reviewer reads it beside the finding, and the issue table says there is one note.
    const theirs = await reviewer.page(urls.run(ids.matterId, ids.runId, ids.findingId));
    expect(readable(section(theirs))).toContain("I read Section 9.3 differently.");
    const counts = all(theirs.root, (el) => hasAttr(el, "data-note-count")).map(readable);
    expect(counts).toEqual([noteCountLabel(1)]);
    const [stored] = notesOf(ids);
    expect(stored).toMatchObject({
      userId: IDS.associate,
      matterId: ids.matterId,
      runId: ids.runId,
      findingId: ids.findingId,
      kind: "comment",
      text: "I read Section 9.3 differently.\nPlease check the amendment.",
      rating: null,
      reasonCode: null,
      ruleKey: null,
      location: null,
    });
    // The notice cannot be made by a link: without its proof the page says nothing of it.
    const forged = await associate.page(`${findingUrl(ids)}?notice=note-saved`);
    expect(
      all(forged.root, (el) => attr(el, "role") === "status" && hasClass(el, "notice")),
    ).toEqual([]);
  });

  it("lets every member write one, and a finding hold the notes of several people in the order they were written", async () => {
    const ids = await open();
    for (const [who, words] of [
      [associate, "First, by the associate."],
      [reviewer, "Second, by the reviewer."],
      [viewer, "Third, by the viewer."],
    ] as const) {
      const response = await byHand(who, formAction(ids), { [FIELDS.note]: words });
      expect(response.status, words).toBe(303);
    }
    expect(notesOf(ids).map((n) => [n.userId, n.text])).toEqual([
      [IDS.associate, "First, by the associate."],
      [IDS.reviewer, "Second, by the reviewer."],
      [VIEWER, "Third, by the viewer."],
    ]);
    for (const who of [associate, reviewer, viewer]) {
      const page = await who.page(findingUrl(ids));
      expect(all(section(page), (el) => el.name === "li").map((li) => readable(li))).toEqual([
        expect.stringContaining("First, by the associate."),
        expect.stringContaining("Second, by the reviewer."),
        expect.stringContaining("Third, by the viewer."),
      ]);
    }
  });

  it("stores the note for the signed-in person, the matter and the finding in the path, whatever else the form names", async () => {
    const ids = await open();
    const other = await open("Another matter for notes");
    const response = await byHand(associate, formAction(ids), {
      [FIELDS.note]: "My note.",
      // None of these is read: the person is the session's, the matter and the finding the path's.
      userId: IDS.reviewer,
      role: "reviewer",
      matterId: other.matterId,
      runId: other.runId,
      findingId: other.findingId,
      feedbackId: "fbk_chosen",
      createdAt: "2001-01-01T00:00:00.000Z",
      kind: "missed_issue",
      reasonCode: "other",
      ruleKey: "dur-1",
      location: "Section 6.1",
      rating: "5",
    });
    expect(response.status).toBe(303);
    expect(notesOf(other)).toEqual([]);
    expect(site.w.repo.listFeedback(other.matterId)).toEqual([]);
    const [stored] = notesOf(ids);
    expect(stored).toMatchObject({
      userId: IDS.associate,
      matterId: ids.matterId,
      runId: ids.runId,
      findingId: ids.findingId,
      kind: "comment",
      rating: null,
      reasonCode: null,
      ruleKey: null,
      location: null,
    });
    expect(stored?.id).not.toBe("fbk_chosen");
    expect(stored?.createdAt).not.toBe("2001-01-01T00:00:00.000Z");
  });

  it("writes one audit event with ids and flags, and the access log and the event hold none of the words", async () => {
    const ids = await open();
    const words = "ZQ-NOTE-ROUTE-WORDS the clause says something else";
    const logsBefore = site.logs.length;
    const response = await byHand(reviewer, formAction(ids), { [FIELDS.note]: words });
    expect(response.status).toBe(303);
    const events = site.w.repo.listAuditEvents({ matterId: ids.matterId, action: "feedback.add" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorId: IDS.reviewer,
      detail: {
        kind: "comment",
        findingId: ids.findingId,
        runId: ids.runId,
        hasText: true,
        hasLocation: false,
      },
    });
    expect(JSON.stringify(events)).not.toContain("ZQ-NOTE");
    expect(site.logs.slice(logsBefore).join("\n")).not.toContain("ZQ-NOTE");
  });

  it("is still offered once the memo is exported: a note is not a decision", async () => {
    const ids = await prepareMatter(site, { name: "An exported matter for notes" });
    const page = await reviewer.page(findingUrl(ids));
    expect(reviewer.hasForm(page, formAction(ids))).toBe(true);
    const response = await reviewer.submit(page, formAction(ids), {
      set: { [FIELDS.note]: "A note after the export." },
    });
    expect(response.status).toBe(303);
    expect(notesOf(ids)).toHaveLength(1);
  });
});

describe("a note that is refused on the page", () => {
  /**
   * The finding's page, answered with the status and the words of the refusal, the todo marked
   * inside them, the jump to the note when the form is on the page, and nothing stored.
   */
  async function refused(
    who: Browser,
    ids: Prepared,
    fields: Record<string, string>,
    code: string,
    status: 400 | 409,
    // False when the page does not show the form (the finding is out of date): the refusal is
    // told in words and leads nowhere, because the control it names is not there.
    formShown = true,
  ): Promise<Page> {
    const before = stateOf();
    const page = await asPage(await byHand(who, formAction(ids), fields), status);
    expectAccessible(page.html);
    const alert = noticeOf(page);
    const jump = formShown ? REFUSAL_JUMP[code] : undefined;
    expect(readable(alert)).toBe(
      `Problem ${REFUSAL_PHRASES[code]}${jump === undefined ? "" : ` ${jump.label}`}`,
    );
    expect(withClass(alert, "todo").map(readable)).toEqual([REFUSAL_TODO[code]]);
    const links = all(alert, (el) => el.name === "a" && hasClass(el, "notice-jump"));
    expect(links.map((a) => attr(a, "href"))).toEqual(jump === undefined ? [] : [jump.href]);
    // The place the link leads to is on the page.
    if (jump !== undefined) expect(byId(page.root, jump.href.slice(1))).toBeDefined();
    expect(stateOf()).toEqual(before);
    return page;
  }

  it("with no words: 400, the words, a link to the note, and nothing stored", async () => {
    const ids = await open();
    const page = await refused(associate, ids, { [FIELDS.note]: "" }, "finding_note_required", 400);
    expect(readable(noticeOf(page))).toContain("Go to the note");
    expect(readable(box(page))).toBe("");
    // Left out of the form altogether, blank, or only white space: the same refusal.
    await refused(associate, ids, {}, "finding_note_required", 400);
    await refused(associate, ids, { [FIELDS.note]: "   " }, "finding_note_required", 400);
    await refused(associate, ids, { [FIELDS.note]: "\r\n\t " }, "finding_note_required", 400);
    expect(notesOf(ids)).toEqual([]);
  });

  it("with more than 4,000 characters: 400, a link to the note, and the long text shown back", async () => {
    const ids = await open();
    const long = "n".repeat(4001);
    const page = await refused(
      reviewer,
      ids,
      { [FIELDS.note]: long },
      "finding_note_too_long",
      400,
    );
    expect(readable(box(page))).toBe(long);
    // The longest that is accepted goes in.
    const ok = await byHand(reviewer, formAction(ids), { [FIELDS.note]: "n".repeat(4000) });
    expect(ok.status).toBe(303);
    expect(notesOf(ids)[0]?.text).toHaveLength(4000);
  });

  it("a control character in the words: 400 from the store, answered with the words of bad_text, its todo and no link", async () => {
    const ids = await open();
    await refused(associate, ids, { [FIELDS.note]: "a\u0007b" }, "bad_text", 400);
    expect(REFUSAL_JUMP["bad_text"]).toBeUndefined();
    expect(REFUSAL_TODO["bad_text"]).toBe("Check it and try again.");
    expect(REFUSAL_PHRASES["bad_text"]).toContain(REFUSAL_TODO["bad_text"]);
    expect(notesOf(ids)).toEqual([]);
  });

  it("shows again what was typed, with its line breaks, in the box", async () => {
    const ids = await open();
    const page = await asPage(
      await byHand(associate, formAction(ids), {
        [FIELDS.note]: `${"x".repeat(4001)}\nSecond line.`,
      }),
      400,
    );
    const text = box(page)
      .children.map((c) => (c.type === "text" ? c.text : ""))
      .join("");
    expect(text).toBe(`\n${"x".repeat(4001)}\nSecond line.`);
  });

  it("when the finding is out of date: 409 finding_not_current, the finding's page without a form, and the notes it had still listed", async () => {
    const ids = await open();
    expect((await byHand(associate, formAction(ids), { [FIELDS.note]: "Before." })).status).toBe(
      303,
    );
    await replace(ids);
    const page = await refused(
      associate,
      ids,
      { [FIELDS.note]: "Too late." },
      "finding_not_current",
      409,
      false,
    );
    expect(associate.hasForm(page, formAction(ids))).toBe(false);
    expect(readable(first(section(page), (el) => attr(el, "role") === "note"))).toBe(
      CANNOT_ADD_NOTE.stale,
    );
    expect(readable(section(page))).toContain("Before.");
    expect(page.html).not.toContain("Too late.");
    expect(notesOf(ids).map((n) => n.text)).toEqual(["Before."]);
  });

  it("checks the words before the state: no words on an out of date finding is 400, and the page does not link to a form it has not got", async () => {
    const ids = await open();
    await replace(ids);
    const page = await refused(
      reviewer,
      ids,
      { [FIELDS.note]: "" },
      "finding_note_required",
      400,
      false,
    );
    expect(byId(page.root, "note-text")).toBeUndefined();
    expect(all(noticeOf(page), (el) => el.name === "a")).toEqual([]);
    await refused(
      reviewer,
      ids,
      { [FIELDS.note]: "n".repeat(4001) },
      "finding_note_too_long",
      400,
      false,
    );
  });

  it("when this person has written the most they may: 409 feedback_limit, and the 20 are the person's own", async () => {
    const ids = await open();
    for (let i = 0; i < 20; i += 1)
      expect(
        (await byHand(associate, formAction(ids), { [FIELDS.note]: `Note number ${i}.` })).status,
      ).toBe(303);
    const page = await refused(
      associate,
      ids,
      { [FIELDS.note]: "One more." },
      "feedback_limit",
      409,
    );
    expect(readable(box(page))).toBe("One more.");
    expect(notesOf(ids)).toHaveLength(20);
    // Another person, and the same person on another finding, are not held to the count.
    expect((await byHand(reviewer, formAction(ids), { [FIELDS.note]: "Mine." })).status).toBe(303);
    expect(
      (await byHand(associate, formAction(ids, otherFinding(ids)), { [FIELDS.note]: "Here." }))
        .status,
    ).toBe(303);
  });

  it("names the one thing wrong and no other: the page of a refusal does not hold the words of another note", async () => {
    const ids = await open();
    await byHand(reviewer, formAction(ids), { [FIELDS.note]: "ZQ-ANOTHER-NOTE" });
    const page = await refused(associate, ids, { [FIELDS.note]: "" }, "finding_note_required", 400);
    // Every member reads every note beside the finding, so the other note is shown: that is the feature.
    expect(readable(section(page))).toContain("ZQ-ANOTHER-NOTE");
  });
});

describe("a finding of another matter, in the path", () => {
  it("is a 404 for the form and for JSON, the same as a finding that is nowhere, and writes nothing", async () => {
    const ids = await open();
    const other = await open("A matter the caller has no note in");
    const before = stateOf();
    const body = { [FIELDS.note]: "A valid note." };
    const foreign = await byHand(associate, formAction(ids, other.findingId), body);
    const nowhere = await byHand(associate, formAction(ids, "fnd_0000000000000000"), body);
    expect(foreign.status).toBe(404);
    expect(nowhere.status).toBe(404);
    expect(await foreign.text()).toBe(await nowhere.text());
    const jsonForeign = await associate.api("POST", apiNotes(ids, other.findingId), {
      note: "A valid note.",
    });
    const jsonNowhere = await associate.api("POST", apiNotes(ids, "fnd_0000000000000000"), {
      note: "A valid note.",
    });
    expect(jsonForeign.status).toBe(404);
    expect(jsonNowhere.status).toBe(404);
    expect(await jsonForeign.text()).toBe(await jsonNowhere.text());
    expect(stateOf()).toEqual(before);
    expect(notesOf(other)).toEqual([]);
    expect(notesOf(ids, other.findingId)).toEqual([]);
  });

  it("is looked up before the body is read: an empty body for a foreign finding is a 404 and not a 400", async () => {
    const ids = await open();
    const other = await open("Another matter, empty body");
    for (const response of [
      await byHand(associate, formAction(ids, other.findingId), {}),
      await associate.api("POST", apiNotes(ids, other.findingId), {}),
    ])
      expect(response.status).toBe(404);
  });
});

describe("the note as JSON", () => {
  it("answers 201 with the note as the view has it, for every member, and the finding then carries it", async () => {
    const ids = await open();
    for (const [who, words] of [
      [associate, "By the associate."],
      [reviewer, "By the reviewer."],
      [viewer, "By the viewer."],
    ] as const) {
      const response = await who.api("POST", apiNotes(ids), { note: words });
      expect(response.status).toBe(201);
      const view = (await response.json()) as NoteView;
      expect(view).toMatchObject({ findingId: ids.findingId, note: words });
      expect(view.feedbackId).toMatch(/^fbk_/);
      expect(Object.keys(view).sort()).toEqual([
        "at",
        "authorName",
        "feedbackId",
        "findingId",
        "note",
      ]);
    }
    expect(notesOf(ids).map((n) => n.userId)).toEqual([IDS.associate, IDS.reviewer, VIEWER]);
    // The finding as JSON carries them, with the answer to whether another can be added.
    const finding = (await (
      await associate.api("GET", `/api/matters/${ids.matterId}/findings/${ids.findingId}`)
    ).json()) as FindingView;
    expect(finding.notes?.map((n) => n.note)).toEqual([
      "By the associate.",
      "By the reviewer.",
      "By the viewer.",
    ]);
    expect(finding.canAddNote).toEqual({ allowed: true, reason: null });
    expect(finding.issue.noteCount).toBe(3);
  });

  it("refuses what the form refuses, with the same codes, and stores nothing", async () => {
    const ids = await open();
    const before = stateOf();
    const cases: [unknown, string][] = [
      [{}, "finding_note_required"],
      [{ note: null }, "finding_note_required"],
      [{ note: "" }, "finding_note_required"],
      [{ note: "  \n " }, "finding_note_required"],
      [{ note: "n".repeat(4001) }, "finding_note_too_long"],
      // A body of the wrong shape or the wrong types is refused as a body.
      [{ note: 7 }, "invalid"],
      [{ note: ["words"] }, "invalid"],
      [{ note: { text: "words" } }, "invalid"],
      [[], "invalid"],
      ["note", "invalid"],
      [4, "invalid"],
      [null, "invalid"],
    ];
    for (const [body, code] of cases) {
      const response = await reviewer.api("POST", apiNotes(ids), body);
      const label = JSON.stringify(body)?.slice(0, 60);
      expect(response.status, label).toBe(400);
      const e = await error(response);
      expect(e.kind, label).toBe("invalid_request");
      expect(e.code, label).toBe(code);
    }
    expect(stateOf()).toEqual(before);
  });

  it("refuses a key the operation does not offer, __proto__ included, as an unknown key", async () => {
    const ids = await open();
    const before = stateOf();
    for (const extra of [
      { userId: IDS.associate },
      { role: "reviewer" },
      { matterId: ids.matterId },
      { runId: ids.runId },
      { findingId: ids.findingId },
      { feedbackId: "fbk_chosen" },
      { kind: "missed_issue" },
      { reasonCode: "other" },
      { ruleKey: "dur-1" },
      { location: "Section 6.1" },
      { rating: 4 },
      { createdAt: "2001-01-01T00:00:00.000Z" },
    ])
      expect(
        (await reviewer.api("POST", apiNotes(ids), { note: "A note.", ...extra })).status,
        JSON.stringify(extra),
      ).toBe(400);
    const raw = await reviewer.send("POST", apiNotes(ids), {
      headers: {
        "content-type": "application/json",
        "x-csrf-token": await reviewer.apiToken(),
      },
      body: '{"note":"A note.","__proto__":{"userId":"usr_demo_admin"}}',
    });
    expect(raw.status).toBe(400);
    expect(stateOf()).toEqual(before);
  });

  it("answers an out of date finding with 409 finding_not_current, and the cap with 409 feedback_limit", async () => {
    const ids = await open();
    for (let i = 0; i < 20; i += 1)
      expect((await associate.api("POST", apiNotes(ids), { note: `Note ${i}.` })).status).toBe(201);
    const capped = await associate.api("POST", apiNotes(ids), { note: "One more." });
    expect(capped.status).toBe(409);
    expect(await error(capped)).toMatchObject({ kind: "conflict", code: "feedback_limit" });
    await replace(ids);
    const before = stateOf();
    const late = await reviewer.api("POST", apiNotes(ids), { note: "Too late." });
    expect(late.status).toBe(409);
    expect(await error(late)).toMatchObject({ kind: "conflict", code: "finding_not_current" });
    expect(stateOf()).toEqual(before);
    expect(notesOf(ids)).toHaveLength(20);
  });
});

describe("what a member reads of a matter's notes", () => {
  it("is every note of the matter, with its author, in JSON, and none of another matter's", async () => {
    const ids = await open();
    const other = await open("Another matter, other notes");
    await associate.api("POST", apiNotes(ids), { note: "ZQ-HERE-ONE" });
    await reviewer.api("POST", apiNotes(ids, otherFinding(ids)), { note: "ZQ-HERE-TWO" });
    await associate.api("POST", apiNotes(other), { note: "ZQ-ELSEWHERE" });
    for (const who of [associate, reviewer, viewer]) {
      const response = await who.api("GET", apiFeedback(ids));
      expect(response.status).toBe(200);
      const seen = (await response.json()) as MatterFeedbackView;
      expect(seen.notes.map((n) => n.note)).toEqual(["ZQ-HERE-ONE", "ZQ-HERE-TWO"]);
      expect(JSON.stringify(seen)).not.toContain("ZQ-ELSEWHERE");
    }
  });

  it("is refused to a person with no part in the matter, as for a matter that is not there", async () => {
    const ids = await open();
    await associate.api("POST", apiNotes(ids), { note: "ZQ-HIDDEN-NOTE" });
    const refusedPage = await outsider.get(findingUrl(ids));
    const nowhere = await outsider.get(findingUrl({ ...ids, matterId: "mat_0000000000000000" }));
    expect(refusedPage.status).toBe(404);
    expect(nowhere.status).toBe(404);
    const text = await refusedPage.text();
    expect(text).not.toContain("ZQ-HIDDEN-NOTE");
    expect(text).toBe(
      await nowhere.text().then((t) => t.replace("mat_0000000000000000", ids.matterId)),
    );
    const admin = await site.as(IDS.admin);
    expect((await admin.get(findingUrl(ids))).status).toBe(404);
  });
});

describe("who may add a note", () => {
  it("lets in the three roles, answers a person with no part in the matter as for a matter that is not there, and sends a visitor to sign in", async () => {
    const ids = await open();
    for (const who of [associate, reviewer, viewer])
      expect((await byHand(who, formAction(ids), { [FIELDS.note]: "A note." })).status).toBe(303);
    expect(notesOf(ids)).toHaveLength(3);

    const before = stateOf();
    const body = { [FIELDS.note]: "A note." };
    const refused = await byHand(outsider, formAction(ids), body);
    const nowhere = await byHand(outsider, urls.notes("mat_0000000000000000", ids.findingId), body);
    expect(refused.status).toBe(404);
    expect(nowhere.status).toBe(404);
    expect(await refused.text()).toBe(await nowhere.text());
    expect((await outsider.api("POST", apiNotes(ids), { note: "A note." })).status).toBe(404);

    // A visitor with no session is sent to sign in, or told so in JSON, and nothing is looked up.
    const visitor = site.anonymous();
    const page = await visitor.send("POST", formAction(ids), {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe("/");
    const api = await visitor.send("POST", apiNotes(ids), {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "A note." }),
    });
    expect(api.status).toBe(401);
    expect(stateOf()).toEqual(before);
  });

  it("does not let the administrator write on a matter they are not a member of", async () => {
    const ids = await open();
    const admin = await site.as(IDS.admin);
    const before = stateOf();
    expect((await byHand(admin, formAction(ids), { [FIELDS.note]: "A note." })).status).toBe(404);
    expect((await admin.api("POST", apiNotes(ids), { note: "A note." })).status).toBe(404);
    expect(stateOf()).toEqual(before);
  });
});

describe("the token of a note", () => {
  it("is required by both routes: a missing, empty, wrong or foreign token is a 403 before the finding is looked up, and nothing is stored", async () => {
    const ids = await open();
    const before = stateOf();
    const foreign = await associate.apiToken();
    const tokens: [string, string | null][] = [
      ["none", null],
      ["empty", ""],
      ["wrong", "not-a-token-0123456789abcdefghijklmnopqrstuv"],
      ["another session's", foreign],
    ];
    for (const [name, token] of tokens) {
      const page = await byHand(reviewer, formAction(ids), { [FIELDS.note]: "A note." }, token);
      expect(page.status, `page, ${name}`).toBe(403);
      // The finding is not looked up: the same 403 for one that does not exist.
      const nowhere = await byHand(
        reviewer,
        formAction(ids, "fnd_0000000000000000"),
        { [FIELDS.note]: "A note." },
        token,
      );
      expect(nowhere.status, `page nowhere, ${name}`).toBe(403);
      const json = await reviewer.api("POST", apiNotes(ids), { note: "A note." }, token ?? false);
      expect(json.status, `json, ${name}`).toBe(403);
      expect((await error(json)).kind).toBe("csrf");
    }
    expect(stateOf()).toEqual(before);
    expect(notesOf(ids)).toEqual([]);
  });
});

describe("the notes, hostile text", () => {
  it("escapes what was typed: markup is text, and invisible characters are made visible", async () => {
    const ids = await open();
    const hostile = '<script>window.pwned = 1</script> "quoted" pay ‮1000‬ now';
    await reviewer.api("POST", apiNotes(ids), { note: hostile });
    const page = await associate.page(findingUrl(ids));
    expectAccessible(page.html);
    expect(page.html).not.toContain("<script>window.pwned");
    expect(page.html).not.toContain("‮");
    expect(readable(section(page))).toContain("<script>window.pwned = 1</script>");
    expect(withClass(section(page), "invisible").length).toBeGreaterThan(0);
  });

  it("shows hostile text back in the form that was refused, escaped", async () => {
    const ids = await open();
    const hostile = `</textarea><script>window.pwned = 1</script> ‮${"h".repeat(4001)}`;
    const page = await asPage(
      await byHand(associate, formAction(ids), { [FIELDS.note]: hostile }),
      400,
    );
    expectAccessible(page.html);
    expect(page.html).not.toContain("<script>window.pwned");
    expect(readable(box(page))).toBe(hostile);
  });
});

describe("a note changes nothing about the review", () => {
  it("leaves the findings, the decisions, the memos, the status of the matter and the readiness as they were", async () => {
    const ids = await open();
    const am = site.w.grant(site.w.associate, ids.matterId);
    const reviewerAm = site.w.grant(site.w.reviewer, ids.matterId);
    const strip = (_key: string, v: unknown): unknown =>
      _key === "notes" || _key === "noteCount" ? undefined : v;
    const snapshot = () =>
      JSON.stringify(
        {
          view: site.w.services.matters.view(am),
          issues: site.w.services.runs.issues(am, ids.runId),
          findings: site.w.services.runs
            .issues(am, ids.runId)
            .map((i) => site.w.services.runs.finding(reviewerAm, i.findingId)),
          memos: site.w.services.reviews.listMemos(reviewerAm),
          readiness: site.w.repo.getExportReadiness(ids.matterId, ids.runId),
          hashes: site.w.repo.listFindings(ids.matterId, ids.runId).map((f) => f.contentSha256),
          rows: Object.fromEntries(
            Object.entries(fingerprint(site, ids.matterId)).filter(([k]) => k !== "audit"),
          ),
        },
        strip,
      );
    const before = snapshot();
    await reviewer.api("POST", apiNotes(ids), { note: "A note." });
    await byHand(associate, formAction(ids), { [FIELDS.note]: "Another." });
    await byHand(viewer, formAction(ids, otherFinding(ids)), { [FIELDS.note]: "A third." });
    expect(snapshot()).toBe(before);
    expect(notesOf(ids)).toHaveLength(2);
  });
});
