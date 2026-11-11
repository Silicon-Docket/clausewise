import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { REASON_CODES } from "../../src/contracts.js";
import { FIELDS, MINOR_EDIT_VALUE } from "../../src/server/pages/forms.js";
import { REFUSAL_JUMP, REFUSAL_PHRASES, REFUSAL_TODO } from "../../src/server/routes/notices.js";
import { urls } from "../../src/server/urls.js";
import { REASON_CODE_LABEL } from "../../src/server/views/feedback.js";
import type { FindingView, IssueRow } from "../../src/services/views.js";
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
} from "../pages/html.js";
import {
  IDS,
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
 * The reason code and the minor-edit mark on the decision form and in the decision JSON (package
 * W2.6a, slice A). An edit or a reject carries a code from the list; an accept or an escalate carries
 * none; only an edit may be marked minor, and never one that changes the status. A decision that is
 * refused is answered with its own page, the words of the refusal, what was typed, and a link to the
 * control to mend; the JSON API answers the same refusals with the same codes. The decision is still
 * bound to the finding content it was made on.
 */

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let site: Site;
let reviewer: Browser;
let associate: Browser;

beforeAll(async () => {
  site = makeSite();
  reviewer = await site.as(IDS.reviewer);
  associate = await site.as(IDS.associate);
});

/** A matter in review, so that each test decides findings of its own. */
async function open(): Promise<{ ids: Prepared; dur: FindingView; pty: FindingView; page: Page }> {
  const ids = await prepareMatter(site, { exported: false });
  const finding = async (id: string): Promise<FindingView> =>
    (await (
      await reviewer.api("GET", `/api/matters/${ids.matterId}/findings/${id}`)
    ).json()) as FindingView;
  const table = (await (
    await reviewer.api("GET", `/api/matters/${ids.matterId}/runs/${ids.runId}/findings`)
  ).json()) as { findings: IssueRow[] };
  const dur = await finding(ids.findingId);
  const pty = await finding(table.findings.find((f) => f.ruleKey === "pty-1")!.findingId);
  return {
    ids,
    dur,
    pty,
    page: await reviewer.page(urls.finding(ids.matterId, dur.issue.findingId)),
  };
}

const action = (ids: Prepared, findingId: string): string => urls.review(ids.matterId, findingId);
const apiPath = (ids: Prepared, findingId: string): string =>
  `/api/matters/${ids.matterId}/findings/${findingId}/reviews`;

/** A post made by hand, with values the form's controls do not offer. */
async function byHand(to: string, fields: Record<string, string>): Promise<Response> {
  return reviewer.send("POST", to, {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: await reviewer.apiToken(), ...fields }).toString(),
  });
}

const reviewsOf = async (ids: Prepared, findingId: string): Promise<FindingView["reviews"]> =>
  (
    (await (
      await reviewer.api("GET", `/api/matters/${ids.matterId}/findings/${findingId}`)
    ).json()) as FindingView
  ).reviews;

const refusedPage = async (response: Response, status: number): Promise<Page> => {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toMatch(/^text\/html/);
  const html = await response.text();
  return { response, html, root: parseHtml(html) };
};

/** The values chosen in a select of the page, as a person sees them. */
const chosen = (page: Page, name: string): string[] =>
  all(
    first(page.root, (el) => el.name === "select" && attr(el, "name") === name),
    (el) => el.name === "option" && hasAttr(el, "selected"),
  ).map((el) => attr(el, "value") ?? "");

const noticeOf = (page: Page) =>
  first(page.root, (el) => attr(el, "role") === "alert" && hasClass(el, "notice-error"));

describe("the decision form, on the page", () => {
  it("refuses a reject with no reason code: 400, the fixed words, the todo marked, a link to the list, what was typed kept", async () => {
    const { ids, dur, page } = await open();
    const typed = "The explanation does not match the clause.";
    const response = await reviewer.submit(page, action(ids, dur.issue.findingId), {
      set: { [FIELDS.decision]: "reject", [FIELDS.reason]: typed },
    });
    const refused = await refusedPage(response, 400);
    const alert = noticeOf(refused);
    // The words, the sentence that says what to do (marked inside them), and where to do it.
    expect(readable(alert)).toBe(
      `Problem ${REFUSAL_PHRASES["reason_code_required"]} ${REFUSAL_JUMP["reason_code_required"]!.label}`,
    );
    expect(withClass(alert, "todo").map(readable)).toEqual([REFUSAL_TODO["reason_code_required"]]);
    const link = all(alert, (el) => el.name === "a" && hasClass(el, "notice-jump"));
    expect(link.map((a) => attr(a, "href"))).toEqual(["#decision-reason-code"]);
    // The place it leads to is on the page, and it is the list of codes.
    const target = byId(refused.root, "decision-reason-code");
    expect(target?.name).toBe("select");
    // What was typed comes back: the choice, the reason, and the list still at its placeholder.
    expect(
      all(refused.root, (el) => attr(el, "name") === FIELDS.decision && hasAttr(el, "checked")).map(
        (el) => attr(el, "value"),
      ),
    ).toEqual(["reject"]);
    expect(readable(first(refused.root, (el) => attr(el, "name") === FIELDS.reason))).toBe(typed);
    expect(chosen(refused, FIELDS.reasonCode)).toEqual([""]);
    expect(await reviewsOf(ids, dur.issue.findingId)).toEqual([]);
    expectAccessible(refused.html);
  });

  it("saves a reject with a code, goes back to the table, and the history names the code", async () => {
    const { ids, dur, page } = await open();
    const response = await reviewer.submit(page, action(ids, dur.issue.findingId), {
      set: {
        [FIELDS.decision]: "reject",
        [FIELDS.reason]: "Not what the clause says.",
        [FIELDS.reasonCode]: "wrong_evidence",
      },
    });
    expect(response.status).toBe(303);
    const [review] = await reviewsOf(ids, dur.issue.findingId);
    expect(review).toMatchObject({
      decision: "reject",
      reasonCode: "wrong_evidence",
      minorEdit: null,
      edits: null,
    });
    const landed = await reviewer.page(response.headers.get("location")!);
    const history = first(landed.root, (el) => el.name === "ol" && hasClass(el, "history"));
    expect(readable(history)).toContain(`Reason code: ${REASON_CODE_LABEL.wrong_evidence}`);
    expect(readable(history)).not.toContain("minor edit");
  });

  it("keeps the code of a refusal that is not about the code, selects it again, and saves with the missing reason", async () => {
    const { ids, dur, page } = await open();
    const to = action(ids, dur.issue.findingId);
    const refused = await refusedPage(
      await reviewer.submit(page, to, {
        set: {
          [FIELDS.decision]: "edit",
          [FIELDS.reason]: "",
          [FIELDS.reasonCode]: "bad_fallback",
          [FIELDS.fallbackLanguage]: "6.1 Two years.",
          [FIELDS.minorEdit]: MINOR_EDIT_VALUE,
        },
      }),
      400,
    );
    expect(refused.html).toContain("Give a reason");
    expect(chosen(refused, FIELDS.reasonCode)).toEqual(["bad_fallback"]);
    const box = first(refused.root, (el) => attr(el, "name") === FIELDS.minorEdit);
    expect(hasAttr(box, "checked")).toBe(true);
    const saved = await reviewer.submit(refused, to, {
      set: { [FIELDS.reason]: "The date is clearer." },
    });
    expect(saved.status).toBe(303);
    const [review] = await reviewsOf(ids, dur.issue.findingId);
    expect(review).toMatchObject({
      decision: "edit",
      reasonCode: "bad_fallback",
      minorEdit: true,
      reason: "The date is clearer.",
      edits: { fallbackLanguage: "6.1 Two years." },
    });
  });

  it("stores no code and no mark for an accept or an escalate, though the form posts both", async () => {
    const { ids, dur, pty, page } = await open();
    const accepted = await reviewer.submit(page, action(ids, dur.issue.findingId), {
      set: {
        [FIELDS.decision]: "accept",
        [FIELDS.reasonCode]: "unclear",
        [FIELDS.minorEdit]: MINOR_EDIT_VALUE,
      },
    });
    expect(accepted.status).toBe(303);
    expect(await reviewsOf(ids, dur.issue.findingId)).toMatchObject([
      { decision: "accept", reasonCode: null, minorEdit: null },
    ]);
    const ptyPage = await reviewer.page(urls.finding(ids.matterId, pty.issue.findingId));
    const escalated = await reviewer.submit(ptyPage, action(ids, pty.issue.findingId), {
      set: {
        [FIELDS.decision]: "escalate",
        [FIELDS.reason]: "Needs a partner.",
        [FIELDS.reasonCode]: "other",
        [FIELDS.minorEdit]: MINOR_EDIT_VALUE,
      },
    });
    expect(escalated.status).toBe(303);
    expect(await reviewsOf(ids, pty.issue.findingId)).toMatchObject([
      { decision: "escalate", reasonCode: null, minorEdit: null },
    ]);
  });

  it("stores the box as the mark of an edit: ticked is minor, unticked is not", async () => {
    const { ids, dur, pty, page } = await open();
    const ticked = await reviewer.submit(page, action(ids, dur.issue.findingId), {
      set: {
        [FIELDS.decision]: "edit",
        [FIELDS.reason]: "Reworded.",
        [FIELDS.reasonCode]: "unclear",
        [FIELDS.discrepancy]: "Section 6.1 was deleted by the amendment.",
        [FIELDS.minorEdit]: MINOR_EDIT_VALUE,
      },
    });
    expect(ticked.status).toBe(303);
    expect((await reviewsOf(ids, dur.issue.findingId))[0]).toMatchObject({ minorEdit: true });
    const ptyPage = await reviewer.page(urls.finding(ids.matterId, pty.issue.findingId));
    const plain = await reviewer.submit(ptyPage, action(ids, pty.issue.findingId), {
      set: {
        [FIELDS.decision]: "edit",
        [FIELDS.reason]: "Reworded.",
        [FIELDS.reasonCode]: "unclear",
        [FIELDS.fallbackLanguage]: "The Receiving Party shall be Lanternfish Software, Inc.",
      },
    });
    expect(plain.status).toBe(303);
    expect((await reviewsOf(ids, pty.issue.findingId))[0]).toMatchObject({ minorEdit: false });
    const landed = await reviewer.page(plain.headers.get("location")!);
    expect(readable(landed.root)).not.toContain("Marked as a minor edit");
  });

  it("refuses an edit of the status marked as minor: 400, the fixed words, a link to the box, the choices kept", async () => {
    const { ids, dur, page } = await open();
    const other = dur.issue.status === "compliant" ? "deviation" : "compliant";
    const refused = await refusedPage(
      await reviewer.submit(page, action(ids, dur.issue.findingId), {
        set: {
          [FIELDS.decision]: "edit",
          [FIELDS.reason]: "The status is wrong.",
          [FIELDS.reasonCode]: "wrong_status",
          [FIELDS.status]: other,
          [FIELDS.minorEdit]: MINOR_EDIT_VALUE,
        },
      }),
      400,
    );
    const alert = noticeOf(refused);
    expect(readable(alert)).toBe(
      `Problem ${REFUSAL_PHRASES["minor_edit_status"]} ${REFUSAL_JUMP["minor_edit_status"]!.label}`,
    );
    expect(withClass(alert, "todo").map(readable)).toEqual([REFUSAL_TODO["minor_edit_status"]]);
    expect(all(alert, (el) => el.name === "a").map((a) => attr(a, "href"))).toEqual([
      "#edit-minor",
    ]);
    expect(byId(refused.root, "edit-minor")?.name).toBe("input");
    // Everything the reviewer chose is back, so that clearing the box is the only thing left to do.
    expect(chosen(refused, FIELDS.reasonCode)).toEqual(["wrong_status"]);
    expect(chosen(refused, FIELDS.status)).toEqual([other]);
    expect(hasAttr(byId(refused.root, "edit-minor")!, "checked")).toBe(true);
    expect(await reviewsOf(ids, dur.issue.findingId)).toEqual([]);
    // Clearing the box is enough: an unticked box is a field the form does not post.
    const saved = await byHand(action(ids, dur.issue.findingId), {
      [FIELDS.decision]: "edit",
      [FIELDS.reason]: "The status is wrong.",
      [FIELDS.reasonCode]: "wrong_status",
      [FIELDS.status]: other,
      [FIELDS.findingContentSha256]: dur.contentSha256,
    });
    expect(saved.status).toBe(303);
    expect((await reviewsOf(ids, dur.issue.findingId))[0]).toMatchObject({
      decision: "edit",
      reasonCode: "wrong_status",
      minorEdit: false,
      edits: { status: other },
    });
  });

  it("refuses a code that is not one of the six in words of its own, and echoes nothing", async () => {
    const { ids, dur } = await open();
    const to = action(ids, dur.issue.findingId);
    const marker = "ZQ-HOSTILE-CODE";
    for (const code of [marker, "Other", "wrong status", "__proto__", '"><script>x</script>']) {
      const response = await byHand(to, {
        [FIELDS.decision]: "reject",
        [FIELDS.reason]: "A reason.",
        [FIELDS.findingContentSha256]: dur.contentSha256,
        [FIELDS.reasonCode]: code,
      });
      const refused = await refusedPage(response, 400);
      expect(readable(noticeOf(refused)), code).toContain(REFUSAL_PHRASES["bad_reason_code"]);
      expect(refused.html, code).not.toContain(marker);
      expect(refused.html, code).not.toContain("<script>x");
      // The list is back at its placeholder: a value that is no choice is not offered again.
      expect(chosen(refused, FIELDS.reasonCode), code).toEqual([""]);
    }
    expect(await reviewsOf(ids, dur.issue.findingId)).toEqual([]);
  });

  it("is still bound to the finding content: a decision on content that moved is 409 and stores no code", async () => {
    const { ids, dur } = await open();
    const typed = "A reason typed against content that moved.";
    const before = fingerprint(site, ids.matterId);
    const response = await byHand(action(ids, dur.issue.findingId), {
      [FIELDS.decision]: "reject",
      [FIELDS.reason]: typed,
      [FIELDS.reasonCode]: "other",
      [FIELDS.findingContentSha256]: "0".repeat(64),
    });
    const refused = await refusedPage(response, 409);
    expect(readable(noticeOf(refused))).toContain(
      "The finding changed after this page was opened.",
    );
    // The typed words are not given back, and the code is not stored.
    expect(refused.html).not.toContain(typed);
    expect(chosen(refused, FIELDS.reasonCode)).toEqual([""]);
    expect(await reviewsOf(ids, dur.issue.findingId)).toEqual([]);
    expect(fingerprint(site, ids.matterId)).toEqual(before);
  });

  it("leaves the form out for the associate, who is refused if they post it, whatever the code", async () => {
    const { ids, dur } = await open();
    const asAssociate = await associate.page(urls.finding(ids.matterId, dur.issue.findingId));
    expect(all(asAssociate.root, (el) => attr(el, "name") === FIELDS.reasonCode)).toEqual([]);
    const posted = await associate.send("POST", action(ids, dur.issue.findingId), {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: await associate.apiToken(),
        decision: "reject",
        reason: "r",
        reasonCode: "other",
        findingContentSha256: dur.contentSha256,
      }).toString(),
    });
    expect(posted.status).toBe(403);
    expect(await reviewsOf(ids, dur.issue.findingId)).toEqual([]);
  });

  it("offers the list and the box on the table's inspector as well as on the page of the finding", async () => {
    const { ids, dur } = await open();
    const table = await reviewer.page(urls.run(ids.matterId, ids.runId, dur.issue.findingId));
    const select = first(
      table.root,
      (el) => el.name === "select" && attr(el, "name") === FIELDS.reasonCode,
    );
    expect(all(select, (el) => el.name === "option").map((el) => attr(el, "value"))).toEqual([
      "",
      ...REASON_CODES,
    ]);
    expect(byId(table.root, "edit-minor")).toBeDefined();
    expectAccessible(table.html);
    // The list takes a tab stop of its own, after the reason and before the status.
    const form = first(table.root, (el) => el.name === "form" && hasAttr(el, "data-decision-form"));
    const names = tabStops(form)
      .map((el) => attr(el, "name"))
      .filter((name): name is string => typeof name === "string" && name !== "_csrf");
    expect(names.indexOf(FIELDS.reason)).toBeGreaterThan(-1);
    expect(names.indexOf(FIELDS.reasonCode)).toBe(names.indexOf(FIELDS.reason) + 1);
    expect(names.indexOf(FIELDS.minorEdit)).toBeGreaterThan(names.indexOf(FIELDS.status));
  });
});

describe("the decision JSON", () => {
  it("takes a code with a reject and with an edit, and answers with both on the decision", async () => {
    const { ids, dur, pty } = await open();
    const rejected = await reviewer.api("POST", apiPath(ids, dur.issue.findingId), {
      decision: "reject",
      findingContentSha256: dur.contentSha256,
      reason: "Not what the clause says.",
      reasonCode: "wrong_evidence",
    });
    expect(rejected.status).toBe(201);
    expect(((await rejected.json()) as FindingView).reviews[0]).toMatchObject({
      decision: "reject",
      reasonCode: "wrong_evidence",
      minorEdit: null,
    });
    const edited = await reviewer.api("POST", apiPath(ids, pty.issue.findingId), {
      decision: "edit",
      findingContentSha256: pty.contentSha256,
      edits: { fallbackLanguage: "The Receiving Party shall be Lanternfish Software, Inc." },
      reason: "Added the name.",
      reasonCode: "bad_fallback",
      minorEdit: true,
    });
    expect(edited.status).toBe(201);
    expect(((await edited.json()) as FindingView).reviews[0]).toMatchObject({
      decision: "edit",
      reasonCode: "bad_fallback",
      minorEdit: true,
    });
  });

  it("answers 400 with the code of the rule: a code is required for an edit and a reject, and not allowed for the rest", async () => {
    const { ids, dur } = await open();
    const base = { findingContentSha256: dur.contentSha256, reason: "r" };
    const cases: [object, string][] = [
      [{ ...base, decision: "reject" }, "reason_code_required"],
      [{ ...base, decision: "reject", reasonCode: null }, "reason_code_required"],
      [{ ...base, decision: "edit", edits: { discrepancy: "x" } }, "reason_code_required"],
      [{ ...base, decision: "accept", reasonCode: "other" }, "reason_code_not_allowed"],
      [{ ...base, decision: "escalate", reasonCode: "other" }, "reason_code_not_allowed"],
      [{ ...base, decision: "accept", minorEdit: true }, "minor_edit_not_allowed"],
      [
        { ...base, decision: "reject", reasonCode: "other", minorEdit: false },
        "minor_edit_not_allowed",
      ],
      [
        {
          ...base,
          decision: "edit",
          reasonCode: "wrong_status",
          minorEdit: true,
          edits: { status: dur.issue.status === "missing" ? "compliant" : "missing" },
        },
        "minor_edit_status",
      ],
    ];
    for (const [body, code] of cases) {
      const response = await reviewer.api("POST", apiPath(ids, dur.issue.findingId), body);
      expect(response.status, code).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
    }
    expect(await reviewsOf(ids, dur.issue.findingId)).toEqual([]);
  });

  it("answers 400 for a code that is not one of the six, a mark that is not a boolean, and an extra key", async () => {
    const { ids, dur } = await open();
    const base = {
      decision: "reject",
      findingContentSha256: dur.contentSha256,
      reason: "r",
      reasonCode: "other",
    };
    const before = fingerprint(site, ids.matterId);
    for (const body of [
      { ...base, reasonCode: "Other" },
      { ...base, reasonCode: "" },
      { ...base, reasonCode: 3 },
      { ...base, reasonCode: ["other"] },
      { ...base, reasonCode: "ZQ-HOSTILE-CODE" },
      { ...base, decision: "edit", edits: { discrepancy: "x" }, minorEdit: "yes" },
      { ...base, decision: "edit", edits: { discrepancy: "x" }, minorEdit: 1 },
      { ...base, reasonCodes: ["other"] },
    ]) {
      const response = await reviewer.api("POST", apiPath(ids, dur.issue.findingId), body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.text()).not.toContain("ZQ-HOSTILE-CODE");
    }
    expect(fingerprint(site, ids.matterId)).toEqual(before);
  });

  it("takes null for the code and the mark, or leaves them out, for the decisions that carry none", async () => {
    const { ids, dur, pty } = await open();
    const a = await reviewer.api("POST", apiPath(ids, dur.issue.findingId), {
      decision: "accept",
      findingContentSha256: dur.contentSha256,
      reasonCode: null,
      minorEdit: null,
    });
    const b = await reviewer.api("POST", apiPath(ids, pty.issue.findingId), {
      decision: "accept",
      findingContentSha256: pty.contentSha256,
    });
    expect([a.status, b.status]).toEqual([201, 201]);
  });

  it("is bound to the finding content: a stale hash is 409 content_mismatch and stores nothing", async () => {
    const { ids, dur } = await open();
    const response = await reviewer.api("POST", apiPath(ids, dur.issue.findingId), {
      decision: "reject",
      findingContentSha256: "1".repeat(64),
      reason: "r",
      reasonCode: "other",
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "content_mismatch",
    );
    expect(await reviewsOf(ids, dur.issue.findingId)).toEqual([]);
  });

  it("refuses the associate whatever the body carries", async () => {
    const { ids, dur } = await open();
    const body = {
      decision: "reject",
      findingContentSha256: dur.contentSha256,
      reason: "r",
      reasonCode: "other",
    };
    expect((await associate.api("POST", apiPath(ids, dur.issue.findingId), body)).status).toBe(403);
    expect(await reviewsOf(ids, dur.issue.findingId)).toEqual([]);
  });
});
