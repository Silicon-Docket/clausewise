import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FIELDS } from "../../src/server/pages/forms.js";
import { REFUSAL_JUMP, REFUSAL_PHRASES, REFUSAL_TODO } from "../../src/server/routes/notices.js";
import { urls } from "../../src/server/urls.js";
import {
  RATING_LABEL,
  RATING_MISSED_ISSUE_LINK,
  RATING_NO_MEMO,
  RATING_QUESTION,
  ratingChoiceLabel,
} from "../../src/server/views/feedback.js";
import type { MatterFeedbackView, RatingView } from "../../src/services/views.js";
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
 * The rating of a matter, as a form on the memos page and as JSON (package W2.6a, slice C). Any
 * member of a matter can rate it once it has a memo, once, for good: the rating is stored for the
 * person who is signed in and for the matter in the path, is read by that person and by nobody
 * else, and changes no finding, decision, memo or gate. A form that is refused is answered with the
 * memos page, the words of the refusal and what was chosen and typed; the JSON API answers the same
 * refusals with the same codes. A person with no part in the matter is answered as for a matter
 * that is nowhere, and nothing is written for a request without its token.
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

/** A matter that was reviewed, decided and exported, so that each test rates one of its own. */
const exported = (name = "A matter for ratings"): Promise<Prepared> =>
  prepareMatter(site, { name });
/** A matter in review: it has a finished review and no memo. */
const unexported = (name = "A matter with no memo"): Promise<Prepared> =>
  prepareMatter(site, { name, exported: false });

const memosUrl = (ids: Prepared): string => urls.memos(ids.matterId);
const formAction = (ids: Prepared): string => urls.rating(ids.matterId);
const apiRating = (ids: Prepared): string => `/api/matters/${ids.matterId}/rating`;
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

const ratings = (ids: Prepared) => site.w.repo.listFeedback(ids.matterId, { kind: "rating" });

const asPage = async (response: Response, status: number): Promise<Page> => {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toMatch(/^text\/html/);
  const html = await response.text();
  return { response, html, root: parseHtml(html) };
};

const noticeOf = (page: Page): El =>
  first(page.root, (el) => attr(el, "role") === "alert" && hasClass(el, "notice-error"));

const section = (page: Page): El => byId(page.root, "rating")!;

const control = (page: Page, name: string): El =>
  first(
    page.root,
    (el) => ["input", "select", "textarea"].includes(el.name) && attr(el, "name") === name,
    `the control ${name}`,
  );

/** The radios of the scale, by value, and which of them is chosen. */
const marks = (page: Page): { value: string; label: string; checked: boolean }[] =>
  all(section(page), (el) => el.name === "input" && attr(el, "type") === "radio").map((radio) => ({
    value: attr(radio, "value") ?? "",
    label: readable(
      first(section(page), (el) => el.name === "label" && attr(el, "for") === attr(radio, "id")),
    ),
    checked: hasAttr(radio, "checked"),
  }));

function accessible(page: Page): void {
  expectAccessible(page.html);
}

const error = async (response: Response): Promise<{ kind: string; code?: string }> =>
  ((await response.json()) as { error: { kind: string; code?: string } }).error;

// ---------------------------------------------------------------------------------------------

describe("the rating section, on the memos page", () => {
  it("says there is nothing to rate until the matter has a memo, offers no form, and leads nowhere", async () => {
    const ids = await unexported();
    for (const who of [associate, reviewer, viewer]) {
      const page = await who.page(memosUrl(ids));
      accessible(page);
      expect(readable(section(page))).toContain(RATING_NO_MEMO);
      expect(who.hasForm(page, formAction(ids))).toBe(false);
      expect(
        all(section(page), (el) => el.name === "a"),
        "no link to a report of a missed issue without a memo",
      ).toEqual([]);
    }
  });

  it("is a form for every member of an exported matter: five marks in order, a comment, a button, and a link to the report", async () => {
    const ids = await exported();
    for (const who of [associate, reviewer, viewer]) {
      const page = await who.page(memosUrl(ids));
      accessible(page);
      const form = who.formOf(page, formAction(ids));
      expect(attr(form, "method")).toBe("post");
      expect(readable(first(section(page), (el) => el.name === "legend"))).toBe(RATING_QUESTION);
      expect(marks(page)).toEqual(
        [1, 2, 3, 4, 5].map((mark) => ({
          value: String(mark),
          label: `${mark} ${RATING_LABEL[mark as 1 | 2 | 3 | 4 | 5]}`,
          checked: false,
        })),
      );
      // Nothing is chosen until the person chooses, and each mark is needed.
      for (const radio of all(form, (el) => el.name === "input" && attr(el, "type") === "radio"))
        expect(hasAttr(radio, "required")).toBe(true);
      expect(readable(control(page, FIELDS.comment))).toBe("");
      // The link leads to the report on the review the memo was made from.
      const link = first(
        section(page),
        (el) => el.name === "a" && readable(el) === RATING_MISSED_ISSUE_LINK,
      );
      expect(attr(link, "href")).toBe(`${urls.run(ids.matterId, ids.runId)}#missed-issue`);
      // Tab order: the group of marks is one stop, then the comment, then the button.
      const stops = tabStops(form, { groupRadios: true }).map((el) => attr(el, "name") ?? el.name);
      expect(stops.filter((n) => n !== "_csrf")).toEqual([FIELDS.rating, FIELDS.comment, "button"]);
    }
  });

  it("saves a rating: 303 to the memos page with a signed notice, and the page then shows what was given and no form", async () => {
    const ids = await exported();
    const page = await reviewer.page(memosUrl(ids));
    const response = await reviewer.submit(page, formAction(ids), {
      set: { [FIELDS.rating]: "4", [FIELDS.comment]: "It found the deletion.\nI would use it." },
    });
    expect(response.status).toBe(303);
    const to = response.headers.get("location")!;
    expect(to).toMatch(new RegExp(`^${memosUrl(ids)}\\?notice=rating-saved&nt=`));
    const after = await reviewer.page(to);
    accessible(after);
    expect(readable(first(after.root, (el) => attr(el, "role") === "status"))).toContain(
      "Your rating was saved. Thank you.",
    );
    const text = readable(section(after));
    expect(text).toContain("You rated this matter 4 of 5 (Agree)");
    expect(readable(first(section(after), (el) => hasClass(el, "doc-text")))).toBe(
      "It found the deletion. I would use it.",
    );
    // A rating is final: the form is gone, and so is every control of it.
    expect(reviewer.hasForm(after, formAction(ids))).toBe(false);
    expect(
      all(section(after), (el) => ["input", "textarea", "button", "select"].includes(el.name)),
    ).toEqual([]);
    // The link to the report of a missed issue is still there.
    expect(readable(section(after))).toContain(RATING_MISSED_ISSUE_LINK);
    const [stored] = ratings(ids);
    expect(stored).toMatchObject({
      userId: IDS.reviewer,
      matterId: ids.matterId,
      kind: "rating",
      rating: 4,
      text: "It found the deletion.\nI would use it.",
      findingId: null,
    });
    // The review it is recorded against is the one the memo was made from.
    expect(stored?.runId).toBe(ids.runId);
    // The notice cannot be made by a link: without its proof the page says nothing of it.
    const forged = await reviewer.page(`${memosUrl(ids)}?notice=rating-saved`);
    expect(
      all(forged.root, (el) => attr(el, "role") === "status" && hasClass(el, "notice")),
    ).toEqual([]);
  });

  it("takes a rating with no comment, and each of the five marks", async () => {
    for (const [who, id, mark] of [
      [associate, IDS.associate, "1"],
      [reviewer, IDS.reviewer, "3"],
      [viewer, VIEWER, "5"],
    ] as const) {
      const ids = await exported();
      const response = await byHand(who, formAction(ids), {
        [FIELDS.rating]: mark,
        [FIELDS.comment]: "",
      });
      expect(response.status).toBe(303);
      expect(ratings(ids)).toMatchObject([{ userId: id, rating: Number(mark), text: null }]);
      const page = await who.page(memosUrl(ids));
      expect(readable(section(page))).toContain(
        `You rated this matter ${mark} of 5 (${RATING_LABEL[Number(mark) as 1 | 2 | 3 | 4 | 5]})`,
      );
      expect(all(section(page), (el) => hasClass(el, "doc-text"))).toEqual([]);
    }
  });

  it("stores the rating for the signed-in person and the matter in the path, whatever else the form names", async () => {
    const ids = await exported();
    const other = await exported("Another matter for ratings");
    const response = await byHand(associate, formAction(ids), {
      [FIELDS.rating]: "2",
      // None of these is read: the person is the session's, the matter and the review the path's
      // and the memo's.
      userId: IDS.reviewer,
      role: "reviewer",
      matterId: other.matterId,
      runId: other.runId,
      feedbackId: "fbk_chosen",
      createdAt: "2001-01-01T00:00:00.000Z",
      kind: "missed_issue",
      findingId: ids.findingId,
      reasonCode: "other",
      ruleKey: "dur-1",
      location: "Section 6.1",
    });
    expect(response.status).toBe(303);
    expect(ratings(other)).toEqual([]);
    const [stored] = ratings(ids);
    expect(stored).toMatchObject({
      userId: IDS.associate,
      matterId: ids.matterId,
      runId: ids.runId,
      kind: "rating",
      rating: 2,
      findingId: null,
      reasonCode: null,
      ruleKey: null,
      location: null,
    });
    expect(stored?.id).not.toBe("fbk_chosen");
    expect(stored?.createdAt).not.toBe("2001-01-01T00:00:00.000Z");
  });

  it("writes one audit event with the mark and the flag, and the access log and the event hold none of the words", async () => {
    const ids = await exported();
    const words = "ZQ-RATING-ROUTE-WORDS the review was useful";
    const logsBefore = site.logs.length;
    const response = await byHand(reviewer, formAction(ids), {
      [FIELDS.rating]: "4",
      [FIELDS.comment]: words,
    });
    expect(response.status).toBe(303);
    const events = site.w.repo.listAuditEvents({ matterId: ids.matterId, action: "feedback.add" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorId: IDS.reviewer,
      detail: { kind: "rating", rating: 4, hasText: true, hasLocation: false, runId: ids.runId },
    });
    expect(JSON.stringify(events)).not.toContain("ZQ-RATING");
    expect(site.logs.slice(logsBefore).join("\n")).not.toContain("ZQ-RATING");
  });
});

describe("a rating that is refused on the page", () => {
  /**
   * The memos page, answered with the status and the words of the refusal, the todo marked inside
   * them, the jump to the control to mend, and nothing stored.
   */
  async function refused(
    who: Browser,
    ids: Prepared,
    fields: Record<string, string>,
    code: string,
    status: 400 | 409,
    // False when the page does not show the form (no memo yet, or the person has rated): the
    // refusal is told in words and leads nowhere, because the control it names is not there.
    formShown = true,
  ): Promise<Page> {
    const before = stateOf();
    const page = await asPage(await byHand(who, formAction(ids), fields), status);
    accessible(page);
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

  it("with no mark chosen: 400, the words, a link to the marks, and the comment kept", async () => {
    const ids = await exported();
    const page = await refused(
      associate,
      ids,
      { [FIELDS.comment]: "Words I do not want to lose." },
      "rating_required",
      400,
    );
    expect(readable(control(page, FIELDS.comment))).toBe("Words I do not want to lose.");
    expect(marks(page).filter((m) => m.checked)).toEqual([]);
    expect(readable(noticeOf(page))).toContain("Go to the rating");
    expect(attr(byId(page.root, "rating-choice")!, "id")).toBe("rating-choice");
    // The mark left out of the form altogether is the same refusal, and so is a blank one.
    await refused(associate, ids, {}, "rating_required", 400);
    await refused(associate, ids, { [FIELDS.rating]: "" }, "rating_required", 400);
    await refused(associate, ids, { [FIELDS.rating]: "  " }, "rating_required", 400);
  });

  it("with a mark that is not one of the five: 400, and the mark is not offered back", async () => {
    const ids = await exported();
    for (const mark of [
      "0",
      "6",
      "-1",
      "4.5",
      "4.0",
      "04",
      " 4",
      "4 ",
      "five",
      "٤",
      "1e0",
      "NaN",
    ]) {
      const page = await refused(
        reviewer,
        ids,
        { [FIELDS.rating]: mark, [FIELDS.comment]: "Words." },
        "bad_rating",
        400,
      );
      expect(
        marks(page).filter((m) => m.checked),
        mark,
      ).toEqual([]);
      expect(readable(control(page, FIELDS.comment)), mark).toBe("Words.");
    }
    expect(ratings(ids)).toEqual([]);
  });

  it("with a comment over 4,000 characters: 400, a link to the comment, the mark kept and the long text shown back", async () => {
    const ids = await exported();
    const long = "c".repeat(4001);
    const page = await refused(
      associate,
      ids,
      { [FIELDS.rating]: "3", [FIELDS.comment]: long },
      "comment_too_long",
      400,
    );
    expect(readable(control(page, FIELDS.comment))).toBe(long);
    expect(marks(page).filter((m) => m.checked)).toEqual([
      { value: "3", label: ratingChoiceLabel(3), checked: true },
    ]);
    // The longest that is accepted goes in.
    const ok = await byHand(associate, formAction(ids), {
      [FIELDS.rating]: "3",
      [FIELDS.comment]: "c".repeat(4000),
    });
    expect(ok.status).toBe(303);
    expect(ratings(ids)[0]?.text).toHaveLength(4000);
  });

  it("names the first thing wrong, in the order the form is laid out: the mark, then the comment", async () => {
    const ids = await exported();
    await refused(
      associate,
      ids,
      { [FIELDS.rating]: "", [FIELDS.comment]: "c".repeat(4001) },
      "rating_required",
      400,
    );
    await refused(
      associate,
      ids,
      { [FIELDS.rating]: "9", [FIELDS.comment]: "c".repeat(4001) },
      "bad_rating",
      400,
    );
  });

  it("before the matter has a memo: 409 not_exported, the sentence that says so, no form, and nothing stored", async () => {
    const ids = await unexported();
    const page = await refused(
      associate,
      ids,
      { [FIELDS.rating]: "4", [FIELDS.comment]: "Too early." },
      "not_exported",
      409,
    );
    expect(readable(section(page))).toContain(RATING_NO_MEMO);
    // The mark is looked at first: a mark that is no mark is a 400 before the state is. The form
    // is not on this page, so the refusal has no link to a control that is not there.
    const bad = await refused(associate, ids, { [FIELDS.rating]: "7" }, "bad_rating", 400, false);
    expect(byId(bad.root, "rating-choice")).toBeUndefined();
  });

  it("when the form is not on the page, every refusal of the form is told in words and leads nowhere", async () => {
    const early = await unexported();
    const rated = await exported();
    expect((await byHand(associate, formAction(rated), { [FIELDS.rating]: "4" })).status).toBe(303);
    for (const ids of [early, rated])
      for (const [fields, code] of [
        [{}, "rating_required"],
        [{ [FIELDS.rating]: "9" }, "bad_rating"],
        [{ [FIELDS.rating]: "3", [FIELDS.comment]: "c".repeat(4001) }, "comment_too_long"],
      ] as const) {
        const page = await refused(associate, ids, { ...fields }, code, 400, false);
        expect(all(noticeOf(page), (el) => el.name === "a")).toEqual([]);
      }
  });

  it("the second time: 409 already_rated, the first rating shown, no form, and the first stays whatever the second said", async () => {
    const ids = await exported();
    expect(
      (await byHand(viewer, formAction(ids), { [FIELDS.rating]: "2", [FIELDS.comment]: "First." }))
        .status,
    ).toBe(303);
    const page = await refused(
      viewer,
      ids,
      { [FIELDS.rating]: "5", [FIELDS.comment]: "A second thought." },
      "already_rated",
      409,
    );
    expect(readable(section(page))).toContain("You rated this matter 2 of 5 (Disagree)");
    expect(page.html).not.toContain("A second thought.");
    expect(viewer.hasForm(page, formAction(ids))).toBe(false);
    expect(ratings(ids)).toMatchObject([{ userId: VIEWER, rating: 2, text: "First." }]);
    // Another member of the matter is not held to the first one's rating.
    expect((await byHand(associate, formAction(ids), { [FIELDS.rating]: "5" })).status).toBe(303);
    expect(ratings(ids).map((r) => [r.userId, r.rating])).toEqual([
      [VIEWER, 2],
      [IDS.associate, 5],
    ]);
  });
});

describe("the rating as JSON", () => {
  it("answers 201 with the rating as the view has it, for every member, once the matter has a memo", async () => {
    const ids = await exported();
    for (const [who, mark] of [
      [associate, 5],
      [reviewer, 2],
      [viewer, 4],
    ] as const) {
      const response = await who.api("POST", apiRating(ids), {
        rating: mark,
        comment: `A comment for ${mark}.`,
      });
      expect(response.status).toBe(201);
      const view = (await response.json()) as RatingView;
      expect(view).toMatchObject({ rating: mark, comment: `A comment for ${mark}.` });
      expect(view.feedbackId).toMatch(/^fbk_/);
      expect(Object.keys(view).sort()).toEqual(["at", "comment", "feedbackId", "rating"]);
    }
    expect(ratings(ids).map((r) => r.userId)).toEqual([IDS.associate, IDS.reviewer, VIEWER]);
    // A null or empty comment is none, and so is a comment left out.
    for (const [who, body] of [
      [associate, { rating: 3, comment: null }],
      [reviewer, { rating: 3, comment: "" }],
      [viewer, { rating: 3 }],
    ] as const) {
      const fresh = await exported("A matter for ratings without words");
      const response = await who.api("POST", apiRating(fresh), body);
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ rating: 3, comment: null });
    }
  });

  it("refuses what the form refuses, with the same codes, and stores nothing", async () => {
    const ids = await exported();
    const before = stateOf();
    const cases: [unknown, string][] = [
      [{}, "rating_required"],
      [{ rating: null }, "rating_required"],
      [{ comment: "Words." }, "rating_required"],
      [{ rating: 0 }, "bad_rating"],
      [{ rating: 6 }, "bad_rating"],
      [{ rating: -2 }, "bad_rating"],
      [{ rating: 4.5 }, "bad_rating"],
      [{ rating: 1e9 }, "bad_rating"],
      [{ rating: 4, comment: "c".repeat(4001) }, "comment_too_long"],
      // A body of the wrong shape or the wrong types is refused as a body.
      [{ rating: "4" }, "invalid"],
      [{ rating: true }, "invalid"],
      [{ rating: [4] }, "invalid"],
      [{ rating: 4, comment: 7 }, "invalid"],
      [{ rating: 4, comment: ["words"] }, "invalid"],
      [[], "invalid"],
      ["4", "invalid"],
      [4, "invalid"],
      [null, "invalid"],
    ];
    for (const [body, code] of cases) {
      const response = await reviewer.api("POST", apiRating(ids), body);
      const label = JSON.stringify(body)?.slice(0, 60);
      expect(response.status, label).toBe(400);
      const e = await error(response);
      expect(e.kind, label).toBe("invalid_request");
      expect(e.code, label).toBe(code);
    }
    expect(stateOf()).toEqual(before);
  });

  it("refuses a key the operation does not offer, __proto__ included, as an unknown key", async () => {
    const ids = await exported();
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
      { createdAt: "2001-01-01T00:00:00.000Z" },
    ])
      expect((await reviewer.api("POST", apiRating(ids), { rating: 4, ...extra })).status).toBe(
        400,
      );
    const raw = await reviewer.send("POST", apiRating(ids), {
      headers: {
        "content-type": "application/json",
        "x-csrf-token": await reviewer.apiToken(),
      },
      body: '{"rating":4,"__proto__":{"userId":"usr_demo_admin"}}',
    });
    expect(raw.status).toBe(400);
    expect(stateOf()).toEqual(before);
  });

  it("answers a matter with no memo with 409 not_exported, and a second rating with 409 already_rated", async () => {
    const early = await unexported();
    const before = stateOf();
    const response = await associate.api("POST", apiRating(early), { rating: 4 });
    expect(response.status).toBe(409);
    expect(await error(response)).toMatchObject({ kind: "conflict", code: "not_exported" });
    expect(stateOf()).toEqual(before);

    const ids = await exported();
    expect(
      (await associate.api("POST", apiRating(ids), { rating: 4, comment: "First." })).status,
    ).toBe(201);
    const again = await associate.api("POST", apiRating(ids), { rating: 1, comment: "Second." });
    expect(again.status).toBe(409);
    expect(await error(again)).toMatchObject({ kind: "conflict", code: "already_rated" });
    expect(ratings(ids)).toMatchObject([{ rating: 4, text: "First." }]);
  });
});

describe("what a member reads of a matter's feedback", () => {
  it("is the reports, the notes and the member's own rating, and no other person's, on the page and in JSON", async () => {
    const ids = await exported();
    const mine = "ZQ-MINE-WORDS";
    const theirs = "ZQ-THEIRS-WORDS";
    expect((await associate.api("POST", apiRating(ids), { rating: 5, comment: mine })).status).toBe(
      201,
    );
    expect(
      (await reviewer.api("POST", apiRating(ids), { rating: 1, comment: theirs })).status,
    ).toBe(201);
    // The JSON read.
    const own = await associate.api("GET", apiFeedback(ids));
    expect(own.status).toBe(200);
    const asAssociate = (await own.json()) as MatterFeedbackView;
    expect(asAssociate.myRating).toMatchObject({ rating: 5, comment: mine });
    expect(JSON.stringify(asAssociate)).not.toContain(theirs);
    const theirsView = (await (
      await reviewer.api("GET", apiFeedback(ids))
    ).json()) as MatterFeedbackView;
    expect(theirsView.myRating).toMatchObject({ rating: 1, comment: theirs });
    expect(JSON.stringify(theirsView)).not.toContain(mine);
    // A member who has not rated reads none at all.
    const none = (await (await viewer.api("GET", apiFeedback(ids))).json()) as MatterFeedbackView;
    expect(none.myRating).toBeNull();
    expect(JSON.stringify(none)).not.toMatch(/ZQ-(MINE|THEIRS)/);
    // The page.
    const page = await associate.page(memosUrl(ids));
    expect(readable(section(page))).toContain(mine);
    expect(page.html).not.toContain(theirs);
    expect((await reviewer.page(memosUrl(ids))).html).not.toContain(mine);
  });

  it("is nowhere else a member can read: no page or JSON answer of the matter holds another member's words", async () => {
    const ids = await exported();
    const mine = "ZQ-PRIVATE-ASSOCIATE";
    const theirs = "ZQ-PRIVATE-REVIEWER";
    await associate.api("POST", apiRating(ids), { rating: 5, comment: mine });
    await reviewer.api("POST", apiRating(ids), { rating: 2, comment: theirs });
    const m = ids.matterId;
    const addresses = [
      urls.matter(m),
      urls.memos(m),
      urls.run(m, ids.runId),
      `${urls.run(m, ids.runId)}?finding=${ids.findingId}`,
      urls.finding(m, ids.findingId),
      "/matters",
      `/api/matters/${m}`,
      `/api/matters/${m}/runs/${ids.runId}`,
      `/api/matters/${m}/runs/${ids.runId}/findings`,
      `/api/matters/${m}/findings/${ids.findingId}`,
      apiFeedback(ids),
    ];
    for (const [who, own, other] of [
      [associate, mine, theirs],
      [reviewer, theirs, mine],
      [viewer, "none", `${mine}|${theirs}`],
    ] as const) {
      for (const address of addresses) {
        const response = await who.get(address);
        expect(response.status, address).toBe(200);
        const body = await response.text();
        for (const word of other.split("|"))
          expect(body, `${address} for ${own}`).not.toContain(word);
      }
    }
    // The audit trail the administrator reads does not hold the words either.
    const admin = await site.as(IDS.admin);
    const audit = await admin.get("/audit");
    expect(audit.status).toBe(200);
    const text = await audit.text();
    expect(text).not.toContain(mine);
    expect(text).not.toContain(theirs);
  });

  it("is refused to a person with no part in the matter, as for a matter that is not there, and to a visitor", async () => {
    const ids = await exported();
    await associate.api("POST", apiRating(ids), { rating: 5, comment: "ZQ-HIDDEN" });
    const refused = await outsider.api("GET", apiFeedback(ids));
    const nowhere = await outsider.api("GET", "/api/matters/mat_0000000000000000/feedback");
    expect(refused.status).toBe(404);
    expect(nowhere.status).toBe(404);
    expect(await refused.text()).toBe(await nowhere.text());
    const admin = await site.as(IDS.admin);
    expect((await admin.api("GET", apiFeedback(ids))).status).toBe(404);
    expect((await site.anonymous().api("GET", apiFeedback(ids))).status).toBe(401);
    const page = await outsider.get(memosUrl(ids));
    expect(page.status).toBe(404);
    expect(await page.text()).not.toContain("ZQ-HIDDEN");
  });
});

describe("who may rate", () => {
  it("lets in the three roles, answers a person with no part in the matter as for a matter that is not there, and sends a visitor to sign in", async () => {
    const ids = await exported();
    for (const who of [associate, reviewer, viewer])
      expect((await byHand(who, formAction(ids), { [FIELDS.rating]: "4" })).status).toBe(303);
    expect(ratings(ids)).toHaveLength(3);

    const before = stateOf();
    const body = { [FIELDS.rating]: "4" };
    const refused = await byHand(outsider, formAction(ids), body);
    const nowhere = await byHand(outsider, urls.rating("mat_0000000000000000"), body);
    expect(refused.status).toBe(404);
    expect(nowhere.status).toBe(404);
    expect(await refused.text()).toBe(await nowhere.text());
    expect((await outsider.api("POST", apiRating(ids), { rating: 4 })).status).toBe(404);

    // A visitor with no session is sent to sign in, or told so in JSON, and nothing is looked up.
    const visitor = site.anonymous();
    const page = await visitor.send("POST", formAction(ids), {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe("/");
    const api = await visitor.send("POST", apiRating(ids), {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rating: 4 }),
    });
    expect(api.status).toBe(401);
    expect(stateOf()).toEqual(before);
  });

  it("does not let the administrator rate a matter they are not a member of", async () => {
    const ids = await exported();
    const admin = await site.as(IDS.admin);
    const before = stateOf();
    expect((await byHand(admin, formAction(ids), { [FIELDS.rating]: "4" })).status).toBe(404);
    expect((await admin.api("POST", apiRating(ids), { rating: 4 })).status).toBe(404);
    expect(stateOf()).toEqual(before);
  });
});

describe("the token of a rating", () => {
  it("is required by both routes: a missing, empty, wrong or foreign token is a 403 before the matter is looked up, and nothing is stored", async () => {
    const ids = await exported();
    const before = stateOf();
    const foreign = await associate.apiToken();
    const tokens: [string, string | null][] = [
      ["none", null],
      ["empty", ""],
      ["wrong", "not-a-token-0123456789abcdefghijklmnopqrstuv"],
      ["another session's", foreign],
    ];
    for (const [name, token] of tokens) {
      const page = await byHand(reviewer, formAction(ids), { [FIELDS.rating]: "4" }, token);
      expect(page.status, `page, ${name}`).toBe(403);
      // The matter is not looked up: the same 403 for one that does not exist.
      const nowhere = await byHand(
        reviewer,
        urls.rating("mat_0000000000000000"),
        { [FIELDS.rating]: "4" },
        token,
      );
      expect(nowhere.status, `page nowhere, ${name}`).toBe(403);
      const json = await reviewer.api("POST", apiRating(ids), { rating: 4 }, token ?? false);
      expect(json.status, `json, ${name}`).toBe(403);
      expect((await error(json)).kind).toBe("csrf");
    }
    expect(stateOf()).toEqual(before);
    expect(ratings(ids)).toEqual([]);
  });
});

describe("the section of the page, hostile text", () => {
  it("escapes what was typed: markup is text, and invisible characters are made visible", async () => {
    const ids = await exported();
    const hostile = '<script>window.pwned = 1</script> "quoted" pay ‮1000‬ now';
    await reviewer.api("POST", apiRating(ids), { rating: 3, comment: hostile });
    const page = await reviewer.page(memosUrl(ids));
    accessible(page);
    expect(page.html).not.toContain("<script>window.pwned");
    expect(page.html).not.toContain("‮");
    expect(readable(section(page))).toContain("<script>window.pwned = 1</script>");
    expect(withClass(section(page), "invisible").length).toBeGreaterThan(0);
  });

  it("shows hostile text back in the form that was refused, escaped", async () => {
    const ids = await exported();
    const hostile = "</textarea><script>window.pwned = 1</script> ‮";
    const page = await asPage(
      await byHand(associate, formAction(ids), { [FIELDS.comment]: hostile }),
      400,
    );
    accessible(page);
    expect(page.html).not.toContain("<script>window.pwned");
    expect(readable(control(page, FIELDS.comment))).toBe(hostile);
  });
});

describe("a rating changes nothing about the review", () => {
  it("leaves the findings, the decisions, the memos, the status of the matter and the readiness as they were", async () => {
    const ids = await exported();
    const am = site.w.grant(site.w.associate, ids.matterId);
    const reviewerAm = site.w.grant(site.w.reviewer, ids.matterId);
    const snapshot = () =>
      JSON.stringify({
        view: site.w.services.matters.view(am),
        issues: site.w.services.runs.issues(am, ids.runId),
        memos: site.w.services.reviews.listMemos(reviewerAm),
        readiness: site.w.repo.getExportReadiness(ids.matterId, ids.runId),
        rows: Object.fromEntries(
          Object.entries(fingerprint(site, ids.matterId)).filter(([k]) => k !== "audit"),
        ),
      });
    const before = snapshot();
    await reviewer.api("POST", apiRating(ids), { rating: 1, comment: "A rating." });
    await byHand(associate, formAction(ids), { [FIELDS.rating]: "5" });
    await byHand(viewer, formAction(ids), { [FIELDS.rating]: "3" });
    expect(snapshot()).toBe(before);
    expect(ratings(ids)).toHaveLength(3);
  });
});
