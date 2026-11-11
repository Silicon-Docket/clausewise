import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NOT_COVERED_VALUE, FIELDS } from "../../src/server/pages/forms.js";
import { REFUSAL_JUMP, REFUSAL_PHRASES, REFUSAL_TODO } from "../../src/server/routes/notices.js";
import { urls } from "../../src/server/urls.js";
import {
  MISSED_ISSUE_EMPTY,
  NOT_COVERED_LABEL,
  ruleChoiceLabel,
} from "../../src/server/views/feedback.js";
import type { MissedIssueView } from "../../src/services/views.js";
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
 * The report of a missed issue, as a form on the review page and as JSON (package W2.6a, slice B).
 * Any member of a matter can report, against a review that has findings, a rule of that review's
 * playbook (or none), where it was missed and what; the report is stored for the person who is
 * signed in and for the review in the path, and changes no finding, decision or gate. A form that
 * is refused is answered with the review page, the words of the refusal and what was typed; the
 * JSON API answers the same refusals with the same codes. A review of another matter in the path is
 * a 404, the same as one that is nowhere, and nothing is written for a request without its token.
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

/** A matter in review with a finished review, so that each test reports on one of its own. */
const open = (name = "A matter for reports"): Promise<Prepared> =>
  prepareMatter(site, { name, exported: false });

const runUrl = (ids: Prepared): string => urls.run(ids.matterId, ids.runId);
const formAction = (ids: Prepared): string => urls.missedIssues(ids.matterId, ids.runId);
const apiPath = (ids: Prepared, runId = ids.runId): string =>
  `/api/matters/${ids.matterId}/runs/${runId}/missed-issues`;

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

/**
 * The rows the routes can change, counted by the fingerprint of the suite, and the rows of feedback
 * that it does not count (a refused report must leave both as they were).
 */
const stateOf = (matterId?: string): Record<string, number> => {
  const where = matterId === undefined ? "" : " WHERE matter_id = ?";
  const feedback = site.w.repo.db
    .prepare(`SELECT COUNT(*) AS n FROM feedback${where}`)
    .get(...(matterId === undefined ? [] : [matterId])) as { n: number };
  return { ...fingerprint(site, matterId), feedback: feedback.n };
};

const reports = (ids: Prepared) => site.w.repo.listFeedback(ids.matterId, { kind: "missed_issue" });

const asPage = async (response: Response, status: number): Promise<Page> => {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toMatch(/^text\/html/);
  const html = await response.text();
  return { response, html, root: parseHtml(html) };
};

const noticeOf = (page: Page): El =>
  first(page.root, (el) => attr(el, "role") === "alert" && hasClass(el, "notice-error"));

const control = (page: Page, name: string): El =>
  first(
    page.root,
    (el) => ["input", "select", "textarea"].includes(el.name) && attr(el, "name") === name,
    `the control ${name}`,
  );

const section = (page: Page): El => byId(page.root, "missed-issue")!;

/** The rows of the table of reports, as the cells a person reads. */
const rowsOf = (page: Page): string[][] =>
  all(section(page), (el) => el.name === "tr")
    .filter((tr) => all(tr, (el) => el.name === "td").length > 0)
    .map((tr) => all(tr, (el) => el.name === "td").map(readable));

const error = async (response: Response): Promise<{ kind: string; code?: string }> =>
  ((await response.json()) as { error: { kind: string; code?: string } }).error;

// ---------------------------------------------------------------------------------------------

describe("the report form, on the review page", () => {
  it("is there for every member, posts to the review's own address, and offers the rules of its playbook", async () => {
    const ids = await open();
    const rules = site.w.services.feedback.ruleChoices(
      site.w.grant(site.w.associate, ids.matterId),
      ids.runId,
    );
    expect(rules.length).toBeGreaterThan(3);
    for (const who of [associate, reviewer, viewer]) {
      const page = await who.page(runUrl(ids));
      expectAccessible(page.html);
      const form = who.formOf(page, formAction(ids));
      expect(attr(form, "method")).toBe("post");
      const select = control(page, FIELDS.ruleKey);
      const options = all(select, (el) => el.name === "option");
      expect(options.map((o) => attr(o, "value"))).toEqual([
        "",
        ...rules.map((r) => r.ruleKey),
        NOT_COVERED_VALUE,
      ]);
      expect(options.map(readable).at(-1)).toBe(NOT_COVERED_LABEL);
      expect(options.map(readable)[1]).toBe(ruleChoiceLabel(rules[0]!.ruleKey, rules[0]!.title));
      // Nothing is chosen until the person chooses, and the section says there is nothing yet.
      expect(options.filter((o) => hasAttr(o, "selected")).map((o) => attr(o, "value"))).toEqual([
        "",
      ]);
      expect(readable(section(page))).toContain(MISSED_ISSUE_EMPTY);
    }
  });

  it("saves a report: 303 to the review with a signed notice, the report in the list, stored for the person who sent it", async () => {
    const ids = await open();
    const page = await reviewer.page(runUrl(ids));
    const response = await reviewer.submit(page, formAction(ids), {
      set: {
        [FIELDS.ruleKey]: "dur-1",
        [FIELDS.location]: "Amendment, paragraph 2",
        [FIELDS.note]: "Section 6.1 is deleted.\nThe review said it stands.",
      },
    });
    expect(response.status).toBe(303);
    const to = response.headers.get("location")!;
    expect(to).toMatch(new RegExp(`^${runUrl(ids)}\\?notice=missed-issue-saved&nt=`));
    const after = await reviewer.page(to);
    expectAccessible(after.html);
    expect(readable(first(after.root, (el) => attr(el, "role") === "status"))).toContain(
      "Your report was saved. It does not change any finding or decision.",
    );
    const rows = rowsOf(after);
    expect(rows).toHaveLength(1);
    expect(rows[0]![0]).toContain("dur-1");
    expect(rows[0]![1]).toBe("Amendment, paragraph 2");
    expect(rows[0]![2]).toBe("Section 6.1 is deleted. The review said it stands.");
    const [stored] = reports(ids);
    expect(stored).toMatchObject({
      userId: IDS.reviewer,
      runId: ids.runId,
      ruleKey: "dur-1",
      location: "Amendment, paragraph 2",
      // The line break the browser sent as CR LF is stored as one.
      text: "Section 6.1 is deleted.\nThe review said it stands.",
    });
    // The notice cannot be made by a link: without its proof the page says nothing of it.
    const forged = await reviewer.page(`${runUrl(ids)}?notice=missed-issue-saved`);
    expect(
      all(forged.root, (el) => attr(el, "role") === "status" && hasClass(el, "notice")),
    ).toEqual([]);
  });

  it("takes 'Not covered by any rule' and a missing location, and the viewer's report too", async () => {
    const ids = await open();
    const page = await viewer.page(runUrl(ids));
    const response = await viewer.submit(page, formAction(ids), {
      set: { [FIELDS.ruleKey]: NOT_COVERED_VALUE, [FIELDS.note]: "Nothing covers the clause." },
    });
    expect(response.status).toBe(303);
    expect(reports(ids)).toMatchObject([
      { userId: VIEWER, ruleKey: null, location: null, text: "Nothing covers the clause." },
    ]);
    const after = await viewer.page(response.headers.get("location")!);
    expect(rowsOf(after)[0]!.slice(0, 2)).toEqual([NOT_COVERED_LABEL, "Not given"]);
  });

  it("stores the report for the signed-in person and the review in the path, whatever else the form names", async () => {
    const ids = await open();
    const other = await open("Another matter for reports");
    const response = await byHand(associate, formAction(ids), {
      [FIELDS.ruleKey]: "gov-1",
      [FIELDS.note]: "Governing law is missing.",
      // None of these is read: the person is the session's, the matter and the review the path's.
      userId: IDS.reviewer,
      role: "reviewer",
      matterId: other.matterId,
      runId: other.runId,
      feedbackId: "fbk_chosen",
      createdAt: "2001-01-01T00:00:00.000Z",
      kind: "rating",
      rating: "5",
      findingId: ids.findingId,
      reasonCode: "other",
    });
    expect(response.status).toBe(303);
    const [stored] = reports(ids);
    expect(stored).toMatchObject({
      userId: IDS.associate,
      matterId: ids.matterId,
      runId: ids.runId,
      kind: "missed_issue",
      findingId: null,
      rating: null,
      reasonCode: null,
    });
    expect(stored!.id).not.toBe("fbk_chosen");
    expect(stored!.createdAt).not.toMatch(/^2001/);
    expect(site.w.repo.listFeedback(other.matterId)).toEqual([]);
  });

  it("writes one audit event with the rule and the flags, and the access log and the event hold none of the words", async () => {
    const ids = await open();
    const note = "ZQ-ROUTE-NOTE the clause";
    const place = "ZQ-ROUTE-PLACE section 6.1";
    const before = site.w.repo.listAuditEvents({ matterId: ids.matterId, action: "feedback.add" });
    await byHand(reviewer, formAction(ids), {
      [FIELDS.ruleKey]: "dur-1",
      [FIELDS.location]: place,
      [FIELDS.note]: note,
    });
    const events = site.w.repo.listAuditEvents({ matterId: ids.matterId, action: "feedback.add" });
    expect(events).toHaveLength(before.length + 1);
    expect(events.at(-1)).toMatchObject({
      actorId: IDS.reviewer,
      detail: { kind: "missed_issue", ruleKey: "dur-1", hasText: true, hasLocation: true },
    });
    expect(JSON.stringify(events)).not.toContain("ZQ-ROUTE");
    expect(site.logs.join("\n")).not.toContain("ZQ-ROUTE");
  });
});

describe("a report that is refused on the page", () => {
  /**
   * The review page, answered with the status and the words of the refusal, the todo marked inside
   * them, the jump to the control to mend, and nothing stored.
   */
  async function refused(
    who: Browser,
    ids: Prepared,
    fields: Record<string, string>,
    code: string,
    status: 400 | 409,
  ): Promise<Page> {
    const before = stateOf();
    const page = await asPage(await byHand(who, formAction(ids), fields), status);
    expectAccessible(page.html);
    const alert = noticeOf(page);
    const jump = REFUSAL_JUMP[code];
    expect(readable(alert)).toBe(
      `Problem ${REFUSAL_PHRASES[code]}${jump === undefined ? "" : ` ${jump.label}`}`,
    );
    expect(withClass(alert, "todo").map(readable)).toEqual([REFUSAL_TODO[code]]);
    const links = all(alert, (el) => el.name === "a" && hasClass(el, "notice-jump"));
    expect(links.map((a) => attr(a, "href"))).toEqual(jump === undefined ? [] : [jump.href]);
    // The place the link leads to is on the page, and in the form that was refused.
    if (jump !== undefined) expect(byId(page.root, jump.href.slice(1))).toBeDefined();
    expect(stateOf()).toEqual(before);
    return page;
  }

  it("with no rule chosen: 400, the words, a link to the list, and what was typed kept", async () => {
    const ids = await open();
    const typed = "A note that took a while to write.\nOn two lines.";
    const page = await refused(
      associate,
      ids,
      { [FIELDS.ruleKey]: "", [FIELDS.location]: "Section 9", [FIELDS.note]: typed },
      "rule_required",
      400,
    );
    expect(byId(page.root, "missed-issue-rule")?.name).toBe("select");
    expect(readable(control(page, FIELDS.note))).toBe(typed.replace("\n", " "));
    expect(attr(control(page, FIELDS.location), "value")).toBe("Section 9");
    expect(
      all(
        control(page, FIELDS.ruleKey),
        (el) => el.name === "option" && hasAttr(el, "selected"),
      ).map((o) => attr(o, "value")),
    ).toEqual([""]);
    // It is the review page: the table of findings is there as it was.
    expect(all(page.root, (el) => el.name === "h1").map(readable)).toEqual(["Issues"]);
  });

  it("with the rule left out of the form altogether: the same refusal, never 'not covered'", async () => {
    const ids = await open();
    await refused(associate, ids, { [FIELDS.note]: "A note." }, "rule_required", 400);
    expect(reports(ids)).toEqual([]);
  });

  it("with a rule that is not in the playbook: 400, no link, and the rule that was chosen is not offered back", async () => {
    const ids = await open();
    for (const ruleKey of ["not-a-rule", "DUR-1", "dur-1 ", "has space", "../dur-1"]) {
      const page = await refused(
        associate,
        ids,
        { [FIELDS.ruleKey]: ruleKey, [FIELDS.note]: "A note." },
        "unknown_rule",
        400,
      );
      // The choice comes back as the placeholder: a value the list does not hold is not offered back.
      expect(
        all(
          control(page, FIELDS.ruleKey),
          (el) => el.name === "option" && hasAttr(el, "selected"),
        ).map((o) => attr(o, "value")),
        ruleKey,
      ).toEqual([""]);
    }
    expect(reports(ids)).toEqual([]);
  });

  it("with an empty note, or one of spaces: 400, a link to the note, and the rule that was chosen kept", async () => {
    const ids = await open();
    for (const note of ["", "   ", "\r\n\t "]) {
      const page = await refused(
        reviewer,
        ids,
        { [FIELDS.ruleKey]: "dur-1", [FIELDS.note]: note },
        "note_required",
        400,
      );
      expect(
        all(
          control(page, FIELDS.ruleKey),
          (el) => el.name === "option" && hasAttr(el, "selected"),
        ).map((o) => attr(o, "value")),
      ).toEqual(["dur-1"]);
    }
  });

  it("with a note over 4,000 characters or a location over 200: 400, and the long text is shown back to be shortened", async () => {
    const ids = await open();
    const long = "n".repeat(4001);
    const page = await refused(
      reviewer,
      ids,
      { [FIELDS.ruleKey]: NOT_COVERED_VALUE, [FIELDS.note]: long },
      "note_too_long",
      400,
    );
    expect(readable(control(page, FIELDS.note))).toBe(long);
    expect(
      all(
        control(page, FIELDS.ruleKey),
        (el) => el.name === "option" && hasAttr(el, "selected"),
      ).map((o) => attr(o, "value")),
    ).toEqual([NOT_COVERED_VALUE]);
    const place = await refused(
      reviewer,
      ids,
      { [FIELDS.ruleKey]: "dur-1", [FIELDS.location]: "l".repeat(201), [FIELDS.note]: "A note." },
      "location_too_long",
      400,
    );
    expect(attr(control(place, FIELDS.location), "value")).toBe("l".repeat(201));
    // The longest that is accepted goes in.
    const ok = await byHand(reviewer, formAction(ids), {
      [FIELDS.ruleKey]: "dur-1",
      [FIELDS.location]: "l".repeat(200),
      [FIELDS.note]: "n".repeat(4000),
    });
    expect(ok.status).toBe(303);
    expect(reports(ids)).toHaveLength(1);
  });

  it("names the first thing wrong, in the order the form is laid out", async () => {
    const ids = await open();
    await refused(
      reviewer,
      ids,
      { [FIELDS.ruleKey]: "", [FIELDS.location]: "l".repeat(201), [FIELDS.note]: "" },
      "rule_required",
      400,
    );
    await refused(
      reviewer,
      ids,
      { [FIELDS.ruleKey]: "dur-1", [FIELDS.location]: "l".repeat(201), [FIELDS.note]: "" },
      "location_too_long",
      400,
    );
  });

  it("with the 51st report by one person on one review: 409, and no more is stored", async () => {
    const ids = await open();
    const am = site.w.grant(site.w.reviewer, ids.matterId);
    for (let i = 0; i < 50; i += 1)
      site.w.services.feedback.reportMissedIssue(am, ids.runId, {
        ruleKey: null,
        location: null,
        note: `Report ${i}.`,
      });
    const page = await refused(
      reviewer,
      ids,
      { [FIELDS.ruleKey]: NOT_COVERED_VALUE, [FIELDS.note]: "One too many." },
      "feedback_limit",
      409,
    );
    expect(rowsOf(page)).toHaveLength(50);
    // Somebody else may still report on that review.
    const other = await byHand(associate, formAction(ids), {
      [FIELDS.ruleKey]: NOT_COVERED_VALUE,
      [FIELDS.note]: "My own report.",
    });
    expect(other.status).toBe(303);
  });

  it("on a review that has no findings: 409, the sentence in place of the form, and nothing stored", async () => {
    const ids = await open();
    // A review that was cancelled before it produced anything has no findings.
    const manifest = site.w.repo.buildRunManifest(ids.matterId, {
      workflowVersionId: site.w.repo.getWorkflowVersionByLabel("v2")!.id,
      modelProvider: "scripted",
      model: "scripted-1",
    });
    site.w.repo.applyInputChange(ids.matterId, {
      reason: "rerun_requested",
      actorId: IDS.associate,
    });
    const empty = site.w.repo.createRun(ids.matterId, { manifest, startedBy: IDS.associate });
    site.w.repo.updateRunStatus(ids.matterId, empty.id, "cancelled");
    const page = await asPage(
      await byHand(associate, urls.missedIssues(ids.matterId, empty.id), {
        [FIELDS.ruleKey]: NOT_COVERED_VALUE,
        [FIELDS.note]: "A note.",
      }),
      409,
    );
    expect(readable(noticeOf(page))).toContain(REFUSAL_PHRASES["run_has_no_findings"]);
    expect(withClass(noticeOf(page), "todo").map(readable)).toEqual([
      REFUSAL_TODO["run_has_no_findings"],
    ]);
    expect(
      all(section(page), (el) => el.name === "form"),
      "no form to fill in",
    ).toEqual([]);
    expect(reports(ids)).toEqual([]);
  });
});

describe("the report as JSON", () => {
  it("answers 201 with the report as the view has it, for every member", async () => {
    const ids = await open();
    for (const [who, id] of [
      [associate, IDS.associate],
      [reviewer, IDS.reviewer],
      [viewer, VIEWER],
    ] as const) {
      const response = await who.api("POST", apiPath(ids), {
        ruleKey: "dur-1",
        location: "Amendment, paragraph 2",
        note: "Section 6.1 is deleted.",
      });
      expect(response.status).toBe(201);
      const view = (await response.json()) as MissedIssueView;
      expect(view).toMatchObject({
        runId: ids.runId,
        ruleKey: "dur-1",
        location: "Amendment, paragraph 2",
        note: "Section 6.1 is deleted.",
        reporterName: site.w.repo.getUser(id)?.displayName,
      });
      expect(view.ruleTitle).toBeTruthy();
      expect(view.feedbackId).toMatch(/^fbk_/);
    }
    expect(reports(ids).map((r) => r.userId)).toEqual([IDS.associate, IDS.reviewer, VIEWER]);
    // A null rule is "not covered", and an empty or missing location is none.
    const bare = await associate.api("POST", apiPath(ids), {
      ruleKey: null,
      location: "",
      note: "Nothing covers it.",
    });
    expect(await bare.json()).toMatchObject({ ruleKey: null, ruleTitle: null, location: null });
    const absent = await associate.api("POST", apiPath(ids), { ruleKey: null, note: "Again." });
    expect(await absent.json()).toMatchObject({ location: null });
  });

  it("refuses what the form refuses, with the same codes, and stores nothing", async () => {
    const ids = await open();
    const before = stateOf();
    const cases: [unknown, string | undefined][] = [
      // What the form refuses, with the code the form gives.
      [{ ruleKey: "not-a-rule", note: "A note." }, "unknown_rule"],
      [{ ruleKey: "DUR-1", note: "A note." }, "unknown_rule"],
      [{ ruleKey: "has space", note: "A note." }, "unknown_rule"],
      [{ ruleKey: "(none)", note: "A note." }, "unknown_rule"],
      [{ note: "A note." }, "rule_required"],
      [{ ruleKey: "", note: "A note." }, "rule_required"],
      [{ ruleKey: "  ", note: "A note." }, "rule_required"],
      [{ ruleKey: "dur-1", note: "" }, "note_required"],
      [{ ruleKey: "dur-1", note: "   \n" }, "note_required"],
      [{ ruleKey: "dur-1" }, "note_required"],
      [{ ruleKey: null }, "note_required"],
      [{ ruleKey: "dur-1", note: "n".repeat(4001) }, "note_too_long"],
      [{ ruleKey: "dur-1", location: "l".repeat(201), note: "A note." }, "location_too_long"],
      // A body of the wrong shape or the wrong types is refused as a body.
      [{ ruleKey: 7, note: "A note." }, "invalid"],
      [{ ruleKey: "dur-1", note: 7 }, "invalid"],
      [{ ruleKey: "dur-1", location: 7, note: "A note." }, "invalid"],
      [{ ruleKey: ["dur-1"], note: "A note." }, "invalid"],
      [{ ruleKey: { key: "dur-1" }, note: "A note." }, "invalid"],
      [[], "invalid"],
      ["a note", "invalid"],
      [null, "invalid"],
    ];
    for (const [body, code] of cases) {
      const response = await reviewer.api("POST", apiPath(ids), body);
      const label = JSON.stringify(body).slice(0, 60);
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
    const base = { ruleKey: "dur-1", note: "A note." };
    for (const extra of [
      { userId: IDS.associate },
      { role: "reviewer" },
      { matterId: ids.matterId },
      { runId: ids.runId },
      { findingId: ids.findingId },
      { feedbackId: "fbk_chosen" },
      { kind: "rating" },
      { rating: 5 },
      { reasonCode: "other" },
      { createdAt: "2001-01-01T00:00:00.000Z" },
    ])
      expect((await reviewer.api("POST", apiPath(ids), { ...base, ...extra })).status).toBe(400);
    const raw = await reviewer.send("POST", apiPath(ids), {
      headers: {
        "content-type": "application/json",
        "x-csrf-token": await reviewer.apiToken(),
      },
      body: '{"ruleKey":"dur-1","note":"A note.","__proto__":{"userId":"usr_demo_admin"}}',
    });
    expect(raw.status).toBe(400);
    expect(stateOf()).toEqual(before);
  });

  it("answers a review that has no findings with 409 and the code, and one that is full with feedback_limit", async () => {
    const ids = await open();
    const am = site.w.grant(site.w.associate, ids.matterId);
    for (let i = 0; i < 50; i += 1)
      site.w.services.feedback.reportMissedIssue(am, ids.runId, {
        ruleKey: null,
        location: null,
        note: `Report ${i}.`,
      });
    const full = await associate.api("POST", apiPath(ids), { ruleKey: null, note: "One more." });
    expect(full.status).toBe(409);
    expect((await error(full)).code).toBe("feedback_limit");
    expect(reports(ids)).toHaveLength(50);
  });
});

describe("another matter's review in the path", () => {
  it("is a 404, byte for byte the answer for a review that is nowhere, on the page and in JSON", async () => {
    const ids = await open("The matter the request goes to");
    const other = await open("The matter whose review is borrowed");
    const before = stateOf();
    const otherBefore = stateOf(other.matterId);
    const body = {
      [FIELDS.ruleKey]: NOT_COVERED_VALUE,
      [FIELDS.note]: "A report written by a probe.",
    };
    const missing = "run_0000000000000000";
    const answers: string[] = [];
    for (const runId of [other.runId, missing]) {
      const page = await byHand(reviewer, urls.missedIssues(ids.matterId, runId), body);
      expect(page.status).toBe(404);
      answers.push(`${page.headers.get("content-type")}|${await page.text()}`);
      const json = await reviewer.api("POST", apiPath(ids, runId), {
        ruleKey: null,
        note: "A report written by a probe.",
      });
      expect(json.status).toBe(404);
      answers.push(`${json.headers.get("content-type")}|${await json.text()}`);
    }
    expect(answers[0]).toBe(answers[2]);
    expect(answers[1]).toBe(answers[3]);
    expect(stateOf()).toEqual(before);
    expect(stateOf(other.matterId)).toEqual(otherBefore);
    // The lookup comes before the body: an empty body to a borrowed review is a 404 too, not a 400.
    expect((await byHand(reviewer, urls.missedIssues(ids.matterId, other.runId), {})).status).toBe(
      404,
    );
    expect((await reviewer.api("POST", apiPath(ids, other.runId), {})).status).toBe(404);
  });
});

describe("who may report", () => {
  it("lets in the three roles, answers a person with no part in the matter as for a matter that is not there, and sends a visitor to sign in", async () => {
    const ids = await open();
    const body = { [FIELDS.ruleKey]: NOT_COVERED_VALUE, [FIELDS.note]: "A note." };
    for (const who of [associate, reviewer, viewer])
      expect((await byHand(who, formAction(ids), body)).status).toBe(303);
    expect(reports(ids)).toHaveLength(3);

    const before = stateOf();
    const nowhere = await byHand(
      outsider,
      urls.missedIssues("mat_0000000000000000", "run_0"),
      body,
    );
    const refused = await byHand(outsider, formAction(ids), body);
    expect(refused.status).toBe(404);
    expect(nowhere.status).toBe(404);
    expect(await refused.text()).toBe(await nowhere.text());
    const json = await outsider.api("POST", apiPath(ids), { ruleKey: null, note: "A note." });
    expect(json.status).toBe(404);

    // A visitor with no session is sent to sign in, or told so in JSON, and nothing is looked up.
    const visitor = site.anonymous();
    const page = await visitor.send("POST", formAction(ids), {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe("/");
    const api = await visitor.send("POST", apiPath(ids), {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ruleKey: null, note: "A note." }),
    });
    expect(api.status).toBe(401);
    expect(stateOf()).toEqual(before);
  });

  it("does not let the administrator report on a matter they are not a member of", async () => {
    const ids = await open();
    const admin = await site.as(IDS.admin);
    const before = stateOf();
    const response = await byHand(admin, formAction(ids), {
      [FIELDS.ruleKey]: NOT_COVERED_VALUE,
      [FIELDS.note]: "A note.",
    });
    expect(response.status).toBe(404);
    expect(stateOf()).toEqual(before);
  });
});

describe("the token of a report", () => {
  it("is required by both routes: a missing, empty, wrong or foreign token is a 403 before the matter is looked up, and nothing is stored", async () => {
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
      const page = await byHand(
        reviewer,
        formAction(ids),
        { [FIELDS.ruleKey]: NOT_COVERED_VALUE, [FIELDS.note]: "A note." },
        token,
      );
      expect(page.status, `page, ${name}`).toBe(403);
      // The matter is not looked up: the same 403 for one that does not exist.
      const nowhere = await byHand(
        reviewer,
        urls.missedIssues("mat_0000000000000000", ids.runId),
        { [FIELDS.ruleKey]: NOT_COVERED_VALUE, [FIELDS.note]: "A note." },
        token,
      );
      expect(nowhere.status, `page nowhere, ${name}`).toBe(403);
      const json = await reviewer.api(
        "POST",
        apiPath(ids),
        { ruleKey: null, note: "A note." },
        token ?? false,
      );
      expect(json.status, `json, ${name}`).toBe(403);
      expect((await error(json)).kind).toBe("csrf");
    }
    expect(stateOf()).toEqual(before);
    expect(reports(ids)).toEqual([]);
  });
});

describe("the section of the page after reports have been made", () => {
  it("lists them oldest first with who made them, to every member, and offers the form again", async () => {
    const ids = await open();
    await reviewer.api("POST", apiPath(ids), {
      ruleKey: "dur-1",
      location: "Section 6.1",
      note: "First.",
    });
    await associate.api("POST", apiPath(ids), { ruleKey: null, note: "Second." });
    for (const who of [associate, reviewer, viewer]) {
      const page = await who.page(runUrl(ids));
      expectAccessible(page.html);
      const rows = rowsOf(page);
      expect(rows.map((r) => r[2])).toEqual(["First.", "Second."]);
      expect(rows.map((r) => r[3])).toEqual([
        site.w.repo.getUser(IDS.reviewer)?.displayName,
        site.w.repo.getUser(IDS.associate)?.displayName,
      ]);
      expect(who.hasForm(page, formAction(ids))).toBe(true);
      // The skip link to the section is among the links at the top, and its target is the section.
      const jump = first(
        page.root,
        (el) => el.name === "a" && attr(el, "href") === "#missed-issue",
      );
      expect(readable(jump)).toBe("Report a missed issue");
      expect(byId(page.root, "missed-issue")?.name).toBe("section");
      // Tab order: the rule, the place, the note and the button follow each other.
      const names = tabStops(who.formOf(page, formAction(ids))).map(
        (el) => attr(el, "name") ?? el.name,
      );
      expect(names.filter((n) => n !== "_csrf")).toEqual([
        FIELDS.ruleKey,
        FIELDS.location,
        FIELDS.note,
        "button",
      ]);
    }
  });

  it("does not show another matter's reports, nor those of another review of this one", async () => {
    const ids = await open();
    const other = await open("Another matter, with a report");
    await reviewer.api("POST", apiPath(other), { ruleKey: null, note: "ZQ-NOT-HERE" });
    const page = await reviewer.page(runUrl(ids));
    expect(rowsOf(page)).toEqual([]);
    expect(page.html).not.toContain("ZQ-NOT-HERE");
  });

  it("escapes what was typed: markup is text, and invisible characters are made visible", async () => {
    const ids = await open();
    const hostile = '<script>window.pwned = 1</script> "quoted" pay ‮1000‬ now';
    await reviewer.api("POST", apiPath(ids), {
      ruleKey: null,
      location: "<img src=x onerror=1>",
      note: hostile,
    });
    const page = await associate.page(runUrl(ids));
    expect(page.html).not.toContain("<script>window.pwned");
    expect(page.html).not.toContain("<img src=x");
    expect(page.html).not.toContain("‮");
    expect(readable(section(page))).toContain("<script>window.pwned = 1</script>");
    expect(withClass(section(page), "invisible").length).toBeGreaterThan(0);
  });
});

describe("a report changes nothing about the review", () => {
  it("leaves the findings, the decisions, the status of the matter and the readiness to export as they were", async () => {
    const ids = await open();
    const am = site.w.grant(site.w.associate, ids.matterId);
    const snapshot = () =>
      JSON.stringify({
        view: site.w.services.matters.view(am),
        issues: site.w.services.runs.issues(am, ids.runId),
        readiness: site.w.repo.getExportReadiness(ids.matterId, ids.runId),
        rows: Object.fromEntries(
          Object.entries(fingerprint(site, ids.matterId)).filter(([k]) => k !== "audit"),
        ),
      });
    const before = snapshot();
    await reviewer.api("POST", apiPath(ids), { ruleKey: "dur-1", note: "A report." });
    await byHand(associate, formAction(ids), {
      [FIELDS.ruleKey]: NOT_COVERED_VALUE,
      [FIELDS.note]: "Another.",
    });
    expect(snapshot()).toBe(before);
    expect(reports(ids)).toHaveLength(2);
  });
});
