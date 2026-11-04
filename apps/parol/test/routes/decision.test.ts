import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FIELDS, evidenceRoleField } from "../../src/server/pages/forms.js";
import { decisionFromBody, decisionFromForm } from "../../src/server/routes/decision.js";
import { urls } from "../../src/server/urls.js";
import type { FindingView, IssueRow } from "../../src/services/views.js";
import {
  all,
  attr,
  first,
  hasAttr,
  hasClass,
  parseHtml,
  readable,
  textOf,
  type El,
} from "../pages/html.js";
import {
  IDS,
  baseWorld,
  cleanup,
  makeSite,
  prepareMatter,
  revisedAnswer,
  type Browser,
  type Page,
  type Prepared,
  type Site,
} from "./support.js";

/**
 * The decision form and the decision JSON: what a reviewer's choices become when they reach the
 * review service. The model's answer for the duration rule has line breaks in it, so the form's
 * text areas (which a browser posts with CR LF) are the case that matters: an untouched field must
 * not look like an edit.
 */

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const WITH_NEWLINES = {
  answers: {
    "dur-1": {
      ...revisedAnswer(baseWorld),
      discrepancy: "Section 6.1 is deleted.\nNothing else limits the term.",
      fallbackLanguage:
        "The obligations continue for three (3) years,\nor longer for a trade secret.",
    },
  },
};

let site: Site;
let reviewer: Browser;
let associate: Browser;

beforeAll(async () => {
  site = makeSite({ model: WITH_NEWLINES });
  reviewer = await site.as(IDS.reviewer);
  associate = await site.as(IDS.associate);
});

/** A matter in review, so that each test decides a finding of its own. */
async function open(): Promise<{
  ids: Prepared;
  dur: FindingView;
  pty: FindingView;
  page: Page;
  ptyPage: Page;
}> {
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
    ptyPage: await reviewer.page(urls.finding(ids.matterId, pty.issue.findingId)),
  };
}

/** A post made by hand, with a value the form's selects do not offer. */
async function byHand(action: string, fields: Record<string, string>): Promise<Response> {
  return reviewer.send("POST", action, {
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

describe("the decision form", () => {
  it("records only what the reviewer changed, so an untouched text area is not an edit", async () => {
    const { ids, dur, page } = await open();
    // The finding has line breaks in both texts; the form posts them as CR LF.
    expect(dur.discrepancy).toContain("\n");
    expect(dur.fallbackLanguage).toContain("\n");
    const response = await reviewer.submit(page, urls.review(ids.matterId, dur.issue.findingId), {
      set: {
        [FIELDS.decision]: "edit",
        [FIELDS.reason]: "The status is wrong.",
        [FIELDS.status]: "compliant",
      },
    });
    expect(response.status).toBe(303);
    const [review] = await reviewsOf(ids, dur.issue.findingId);
    expect(review!.edits).toEqual({ status: "compliant" });
    expect(review!.reason).toBe("The status is wrong.");
  });

  it("records an edited text with the line breaks the finding itself uses", async () => {
    const { ids, dur, page } = await open();
    const edited = "Section 6.1 is deleted.\nNothing else limits the term.\nA third line.";
    const response = await reviewer.submit(page, urls.review(ids.matterId, dur.issue.findingId), {
      set: {
        [FIELDS.decision]: "edit",
        [FIELDS.reason]: "Added a line.",
        [FIELDS.discrepancy]: edited,
      },
    });
    expect(response.status).toBe(303);
    const [review] = await reviewsOf(ids, dur.issue.findingId);
    // Only the discrepancy: the fallback language, posted in full with CR LF, was not edited.
    expect(review!.edits).toEqual({ discrepancy: edited });
  });

  it("compares the fallback language with an empty string when the finding has none", async () => {
    const { ids, pty, ptyPage } = await open();
    expect(pty.fallbackLanguage).toBeNull();
    const none = await reviewer.submit(ptyPage, urls.review(ids.matterId, pty.issue.findingId), {
      set: { [FIELDS.decision]: "edit", [FIELDS.reason]: "No change, really." },
    });
    // Nothing changed: the empty text area is "none" and not an edit.
    expect(none.status).toBe(400);

    const given = await reviewer.submit(ptyPage, urls.review(ids.matterId, pty.issue.findingId), {
      set: {
        [FIELDS.decision]: "edit",
        [FIELDS.reason]: "Add wording.",
        [FIELDS.fallbackLanguage]: "The Receiving Party shall be Lanternfish Software, Inc.",
      },
    });
    expect(given.status).toBe(303);
    const [review] = await reviewsOf(ids, pty.issue.findingId);
    expect(review!.edits).toEqual({
      fallbackLanguage: "The Receiving Party shall be Lanternfish Software, Inc.",
    });
  });

  it("records a relabelled passage by its id, and only the ones that changed", async () => {
    const { ids, dur, page } = await open();
    const [first, second] = dur.evidence;
    expect(first!.role).toBe("governing");
    const response = await reviewer.submit(page, urls.review(ids.matterId, dur.issue.findingId), {
      set: {
        [FIELDS.decision]: "edit",
        [FIELDS.reason]: "The survival clause only supports.",
        [evidenceRoleField(second!.evidenceId)]: "supporting",
      },
    });
    expect(response.status).toBe(303);
    const [review] = await reviewsOf(ids, dur.issue.findingId);
    expect(review!.edits).toEqual({
      evidenceRoles: [{ evidenceId: second!.evidenceId, role: "supporting" }],
    });
  });

  it("refuses an edit that changes nothing, and a label that is not one of the five", async () => {
    const { ids, dur, page } = await open();
    const action = urls.review(ids.matterId, dur.issue.findingId);
    const same = await reviewer.submit(page, action, {
      set: { [FIELDS.decision]: "edit", [FIELDS.reason]: "Nothing to change." },
    });
    expect(same.status).toBe(400);
    // The select has no such option; posting one by hand is refused.
    const bad = await byHand(action, {
      [FIELDS.decision]: "edit",
      [FIELDS.reason]: "A made-up label.",
      [FIELDS.findingContentSha256]: dur.contentSha256,
      [evidenceRoleField(dur.evidence[0]!.evidenceId)]: "decisive",
    });
    expect(bad.status).toBe(400);
    expect(await reviewsOf(ids, dur.issue.findingId)).toEqual([]);
  });

  it("makes a blank reason none: accepted without one, refused without one for reject and escalate", async () => {
    const { ids, dur, page } = await open();
    const action = urls.review(ids.matterId, dur.issue.findingId);
    for (const decision of ["reject", "escalate"])
      for (const reason of ["", "   ", "\r\n \r\n"]) {
        const response = await reviewer.submit(page, action, {
          set: { [FIELDS.decision]: decision, [FIELDS.reason]: reason },
        });
        expect(response.status, `${decision} ${JSON.stringify(reason)}`).toBe(400);
      }
    expect(await reviewsOf(ids, dur.issue.findingId)).toEqual([]);

    const accepted = await reviewer.submit(page, action, {
      set: { [FIELDS.decision]: "accept", [FIELDS.reason]: "   " },
    });
    expect(accepted.status).toBe(303);
    const [review] = await reviewsOf(ids, dur.issue.findingId);
    expect(review).toMatchObject({ decision: "accept", reason: null, edits: null });
  });

  it("keeps no edits for a decision that is not an edit, whatever the form holds", async () => {
    const { ids, dur, page } = await open();
    const response = await reviewer.submit(page, urls.review(ids.matterId, dur.issue.findingId), {
      set: {
        [FIELDS.decision]: "reject",
        [FIELDS.reason]: "Not acceptable.\r\nSecond line.",
        [FIELDS.status]: "compliant",
        [FIELDS.discrepancy]: "Something else entirely.",
        [evidenceRoleField(dur.evidence[0]!.evidenceId)]: "superseded",
      },
    });
    expect(response.status).toBe(303);
    const [review] = await reviewsOf(ids, dur.issue.findingId);
    expect(review).toMatchObject({ decision: "reject", edits: null });
    // The reason is stored with the line breaks the finding's own texts use.
    expect(review!.reason).toBe("Not acceptable.\nSecond line.");
  });

  it("refuses a form that names no decision, an unknown one, or the wrong hash", async () => {
    const { ids, dur, page } = await open();
    const action = urls.review(ids.matterId, dur.issue.findingId);
    const hash = { [FIELDS.findingContentSha256]: dur.contentSha256 };
    for (const fields of [
      { ...hash, [FIELDS.decision]: "" },
      { ...hash, [FIELDS.decision]: "approve" },
      { [FIELDS.decision]: "accept" },
      { [FIELDS.decision]: "accept", [FIELDS.findingContentSha256]: "not a hash" },
      { [FIELDS.decision]: "accept", [FIELDS.findingContentSha256]: "" },
      { ...hash, [FIELDS.decision]: "edit", [FIELDS.reason]: "x", [FIELDS.status]: "perfect" },
    ]) {
      const response = await byHand(action, fields);
      expect(response.status, JSON.stringify(fields)).toBe(400);
    }
    void page;
    expect(await reviewsOf(ids, dur.issue.findingId)).toEqual([]);
  });

  it("goes back to the table with the finding selected, and says it was saved", async () => {
    const { ids, dur, page } = await open();
    const response = await reviewer.submit(page, urls.review(ids.matterId, dur.issue.findingId), {
      set: { [FIELDS.decision]: "accept" },
    });
    expect(response.status).toBe(303);
    // The table, with this finding selected, and the notice with the proof that it was this action.
    expect(response.headers.get("location")).toMatch(
      new RegExp(
        `^${urls.run(ids.matterId, ids.runId, dur.issue.findingId).replace("?", "\\?")}&notice=decision-saved&nt=\\d+\\.[A-Za-z0-9_-]{43}$`,
      ),
    );
    const landed = await reviewer.page(response.headers.get("location")!);
    expect(landed.html).toContain("The decision was saved");
    expect(landed.html).toContain("finding-pane");
    // The form on the table is the same form and posts to the same route.
    const forms = all(landed.root, (el) => el.name === "form").map((f) => attr(f, "action"));
    expect(forms).toContain(urls.review(ids.matterId, dur.issue.findingId));
  });

  it("is not offered to the associate, and refused if posted", async () => {
    const { ids, dur } = await open();
    const asAssociate = await associate.page(urls.finding(ids.matterId, dur.issue.findingId));
    expect(readable(asAssociate.root)).toContain(
      "Only the reviewing attorney can record a decision.",
    );
    expect(all(asAssociate.root, (el) => el.name === "textarea" && hasAttr(el, "name"))).toEqual(
      [],
    );
    const posted = await associate.send("POST", urls.review(ids.matterId, dur.issue.findingId), {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: await associate.apiToken(),
        decision: "accept",
        findingContentSha256: dur.contentSha256,
      }).toString(),
    });
    expect(posted.status).toBe(403);
    expect(await reviewsOf(ids, dur.issue.findingId)).toEqual([]);
  });
});

describe("the decision form, when the server refuses it", () => {
  const refused = async (
    response: Response,
    status: number,
  ): Promise<{ html: string; notices: string[]; root: El }> => {
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    const html = await response.text();
    const root = parseHtml(html);
    // The problem notices of the page, as a person reads them.
    const notices = all(root, (el) => hasClass(el, "notice-error")).map(readable);
    return { html, notices, root };
  };

  it("tells the reviewer a reason is needed, on the finding, with the status the shell gives", async () => {
    const { ids, dur, page } = await open();
    const action = urls.review(ids.matterId, dur.issue.findingId);
    for (const decision of ["reject", "escalate", "edit"]) {
      const response = await reviewer.submit(page, action, {
        set: {
          [FIELDS.decision]: decision,
          [FIELDS.reason]: "",
          [FIELDS.status]: decision === "edit" ? "compliant" : dur.issue.status,
        },
      });
      const { notices, root } = await refused(response, 400);
      expect(notices, decision).toEqual([
        "Problem Give a reason. A decision to edit, reject or escalate needs one.",
      ]);
      // The finding is on the page again, with the form to try once more.
      expect(all(root, (el) => el.name === "form").map((f) => attr(f, "action"))).toContain(action);
    }
    expect(await reviewsOf(ids, dur.issue.findingId)).toEqual([]);
  });

  it("tells the reviewer when an edit changes nothing, and when no decision was chosen", async () => {
    const { ids, dur, page } = await open();
    const action = urls.review(ids.matterId, dur.issue.findingId);
    const same = await reviewer.submit(page, action, {
      set: { [FIELDS.decision]: "edit", [FIELDS.reason]: "Nothing to change." },
    });
    expect((await refused(same, 400)).notices).toEqual([
      "Problem Nothing was changed. Change the status, a text or a label to edit this finding, or choose another decision.",
    ]);
    const none = await byHand(action, {
      [FIELDS.decision]: "",
      [FIELDS.findingContentSha256]: dur.contentSha256,
    });
    expect((await refused(none, 400)).notices).toEqual(["Problem Choose a decision."]);
  });

  it("tells the reviewer that the finding changed, and does not give the typed text back", async () => {
    const { ids, dur } = await open();
    const typed = "A reason typed against content that moved.";
    const response = await byHand(urls.review(ids.matterId, dur.issue.findingId), {
      [FIELDS.decision]: "reject",
      [FIELDS.reason]: typed,
      [FIELDS.findingContentSha256]: "0".repeat(64),
    });
    const { html, notices } = await refused(response, 409);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("The finding changed after this page was opened.");
    // Fixed words only: nothing the request carried is printed back.
    expect(html).not.toContain(typed);
    expect(await reviewsOf(ids, dur.issue.findingId)).toEqual([]);
  });

  it("tells the reviewer that a finding is out of date once a new version has been uploaded", async () => {
    const { ids, dur, page } = await open();
    const fixed = await associate.apiUpload(
      `/api/matters/${ids.matterId}/documents/${ids.lastDocumentId}/versions`,
      {},
      {
        name: "amendment-corrected.txt",
        bytes: new TextEncoder().encode(
          "AMENDMENT NO. 1 TO MUTUAL NONDISCLOSURE AGREEMENT\n\n2. A corrected paragraph of synthetic text.\n",
        ),
      },
    );
    expect(fixed.status).toBe(201);
    const response = await reviewer.submit(page, urls.review(ids.matterId, dur.issue.findingId), {
      set: { [FIELDS.decision]: "accept" },
    });
    const { notices } = await refused(response, 409);
    expect(notices).toEqual([
      "Problem This finding is out of date because the documents or the playbook changed. Run the review again to decide it.",
    ]);
  });

  it("leaves the answer for a finding of another matter, and for the associate, as it was", async () => {
    const { ids, dur } = await open();
    const other = await open();
    const forged = await byHand(urls.review(ids.matterId, other.dur.issue.findingId), {
      [FIELDS.decision]: "accept",
      [FIELDS.findingContentSha256]: other.dur.contentSha256,
    });
    expect(forged.status).toBe(404);
    expect(await forged.text()).not.toContain("notice");
    void dur;
  });
});

describe("the decision form, after a refusal, gives back what was typed", () => {
  /** The refused answer, read as a page that the same reviewer can submit again. */
  const refusedPage = async (response: Response): Promise<Page> => {
    expect(response.status).toBe(400);
    const html = await response.text();
    return { response, html, root: parseHtml(html) };
  };
  const valueOf = (page: Page, name: string): string => {
    const control = first(page.root, (el) => attr(el, "name") === name, name);
    return readable(control) === "" ? "" : textOf(control).replace(/^\n/, "");
  };

  it("keeps an edit written without a reason, and saves it with one more sentence", async () => {
    // Found in a real browser: an Edit with a long new wording and no reason came back with the
    // original wording in the form, and the reviewer had to type it all again.
    const { ids, dur, page } = await open();
    const action = urls.review(ids.matterId, dur.issue.findingId);
    const [first1, second] = dur.evidence;
    const wording = "The obligations continue for two (2) years.\nSurvival is unchanged.";
    const note = "Section 6.1 is restored by the client.";
    const refused = await refusedPage(
      await reviewer.submit(page, action, {
        set: {
          [FIELDS.decision]: "edit",
          [FIELDS.reason]: "",
          [FIELDS.status]: "compliant",
          [FIELDS.discrepancy]: note,
          [FIELDS.fallbackLanguage]: wording,
          [evidenceRoleField(second!.evidenceId)]: "supporting",
        },
      }),
    );
    expect(refused.html).toContain("Give a reason");
    // The form holds what was typed, not the finding's own text.
    expect(valueOf(refused, FIELDS.fallbackLanguage)).toBe(wording);
    expect(valueOf(refused, FIELDS.discrepancy)).toBe(note);
    const chosen = all(
      refused.root,
      (el) => attr(el, "name") === FIELDS.decision && hasAttr(el, "checked"),
    );
    expect(chosen.map((el) => attr(el, "value"))).toEqual(["edit"]);
    const status = first(refused.root, (el) => attr(el, "name") === FIELDS.status);
    expect(
      all(status, (el) => el.name === "option" && hasAttr(el, "selected")).map((el) =>
        attr(el, "value"),
      ),
    ).toEqual(["compliant"]);
    const role = first(
      refused.root,
      (el) => attr(el, "name") === evidenceRoleField(second!.evidenceId),
    );
    expect(
      all(role, (el) => el.name === "option" && hasAttr(el, "selected")).map((el) =>
        attr(el, "value"),
      ),
    ).toEqual(["supporting"]);
    // The passage nobody touched keeps the label it had.
    const other = first(
      refused.root,
      (el) => attr(el, "name") === evidenceRoleField(first1!.evidenceId),
    );
    expect(
      all(other, (el) => el.name === "option" && hasAttr(el, "selected")).map((el) =>
        attr(el, "value"),
      ),
    ).toEqual([first1!.role]);

    // Adding the missing reason to that very page is enough.
    const saved = await reviewer.submit(refused, action, {
      set: { [FIELDS.reason]: "Client call." },
    });
    expect(saved.status).toBe(303);
    const [review] = await reviewsOf(ids, dur.issue.findingId);
    expect(review!.edits).toEqual({
      status: "compliant",
      discrepancy: note,
      fallbackLanguage: wording,
      evidenceRoles: [{ evidenceId: second!.evidenceId, role: "supporting" }],
    });
    expect(review!.reason).toBe("Client call.");
  });

  it("keeps the choice and the reason of a refusal that is not about the reason", async () => {
    const { ids, dur, page } = await open();
    const action = urls.review(ids.matterId, dur.issue.findingId);
    const refused = await refusedPage(
      await reviewer.submit(page, action, {
        set: { [FIELDS.decision]: "edit", [FIELDS.reason]: "Typed, but nothing was edited." },
      }),
    );
    expect(refused.html).toContain("Nothing was changed");
    expect(valueOf(refused, FIELDS.reason)).toBe("Typed, but nothing was edited.");
    const chosen = all(
      refused.root,
      (el) => attr(el, "name") === FIELDS.decision && hasAttr(el, "checked"),
    );
    expect(chosen.map((el) => attr(el, "value"))).toEqual(["edit"]);
  });

  it("shows nothing as chosen on a page that was not refused", async () => {
    const { page } = await open();
    expect(
      all(page.root, (el) => attr(el, "name") === FIELDS.decision && hasAttr(el, "checked")),
    ).toEqual([]);
  });

  it("returns only choices the form offers, cut to the length the store accepts, and escaped", async () => {
    const { ids, dur } = await open();
    const action = urls.review(ids.matterId, dur.issue.findingId);
    const long = "x".repeat(20_000);
    const hostile = '</textarea><script>alert("typed")</script>';
    const response = await byHand(action, {
      [FIELDS.decision]: "edit",
      [FIELDS.findingContentSha256]: dur.contentSha256,
      [FIELDS.status]: "not-a-status",
      [FIELDS.reason]: "",
      [FIELDS.discrepancy]: long,
      [FIELDS.fallbackLanguage]: hostile,
      [evidenceRoleField(dur.evidence[0]!.evidenceId)]: "not-a-role",
    });
    // An unknown status is refused before anything else.
    const refused = await refusedPage(response);
    expect(refused.html).not.toContain("<script>alert");
    expect(refused.html).not.toContain("not-a-status");
    expect(refused.html).not.toContain("not-a-role");
    expect(valueOf(refused, FIELDS.discrepancy)).toHaveLength(8000);
    expect(valueOf(refused, FIELDS.fallbackLanguage)).toBe(hostile);
    // The status the finding had is still the selected one.
    const status = first(refused.root, (el) => attr(el, "name") === FIELDS.status);
    expect(
      all(status, (el) => el.name === "option" && hasAttr(el, "selected")).map((el) =>
        attr(el, "value"),
      ),
    ).toEqual([dur.issue.status]);
  });
});

describe("the decision JSON", () => {
  const path = (ids: Prepared, findingId: string): string =>
    `/api/matters/${ids.matterId}/findings/${findingId}/reviews`;

  it("takes the payload of docs/parol/03 and answers with the finding as decided", async () => {
    const { ids, dur } = await open();
    const response = await reviewer.api("POST", path(ids, dur.issue.findingId), {
      decision: "edit",
      findingContentSha256: dur.contentSha256,
      edits: {
        status: "undetermined",
        evidenceRoles: [{ evidenceId: dur.evidence[1]!.evidenceId, role: "supporting" }],
      },
      reason: "Needs a second look.",
    });
    expect(response.status).toBe(201);
    const view = (await response.json()) as FindingView;
    expect(view.reviews[0]).toMatchObject({
      decision: "edit",
      reviewerName: "Dana Whitfield (reviewing attorney)",
      validity: "current",
      reason: "Needs a second look.",
      edits: {
        status: "undetermined",
        evidenceRoles: [{ evidenceId: dur.evidence[1]!.evidenceId, role: "supporting" }],
      },
    });
    expect(view.issue.review).toMatchObject({ decision: "edit", validity: "current" });
  });

  it("takes null for the edits and the reason, or leaves them out", async () => {
    const { ids, dur, pty } = await open();
    const a = await reviewer.api("POST", path(ids, dur.issue.findingId), {
      decision: "accept",
      findingContentSha256: dur.contentSha256,
      edits: null,
      reason: null,
    });
    const b = await reviewer.api("POST", path(ids, pty.issue.findingId), {
      decision: "accept",
      findingContentSha256: pty.contentSha256,
    });
    expect([a.status, b.status]).toEqual([201, 201]);
  });

  it("answers 400 where the store says the decision is not complete", async () => {
    const { ids, dur } = await open();
    const base = { findingContentSha256: dur.contentSha256 };
    const cases: [object, string][] = [
      [{ ...base, decision: "edit", reason: "r" }, "edits_required"],
      [{ ...base, decision: "edit", reason: "r", edits: {} }, "edit_changes_nothing"],
      [
        { ...base, decision: "edit", reason: "r", edits: { status: dur.issue.status } },
        "edit_changes_nothing",
      ],
      [{ ...base, decision: "accept", edits: { status: "compliant" } }, "edits_not_allowed"],
      [{ ...base, decision: "reject" }, "reason_required"],
      [{ ...base, decision: "escalate", reason: "  " }, "reason_required"],
    ];
    for (const [body, code] of cases) {
      const response = await reviewer.api("POST", path(ids, dur.issue.findingId), body);
      expect(response.status, code).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
    }
    expect(await reviewsOf(ids, dur.issue.findingId)).toEqual([]);
  });

  it("answers 400 for a body that is not the payload", async () => {
    const { ids, dur } = await open();
    const send = (body: string, type = "application/json"): Promise<Response> =>
      reviewer.api("POST", path(ids, dur.issue.findingId), undefined).then(async () =>
        reviewer.send("POST", path(ids, dur.issue.findingId), {
          headers: { "content-type": type, "x-csrf-token": await reviewer.apiToken() },
          body,
        }),
      );
    for (const [body, type] of [
      ["{not json", undefined],
      ["[]", undefined],
      ["null", undefined],
      ['"accept"', undefined],
      [JSON.stringify({ decision: "accept" }), undefined],
      [JSON.stringify({ decision: "accept", findingContentSha256: "short" }), undefined],
      [
        JSON.stringify({
          decision: "accept",
          findingContentSha256: dur.contentSha256.toUpperCase(),
        }),
        undefined,
      ],
      [JSON.stringify({ decision: 1, findingContentSha256: dur.contentSha256 }), undefined],
      [
        JSON.stringify({
          decision: "reject",
          reason: "x".repeat(4001),
          findingContentSha256: dur.contentSha256,
        }),
        undefined,
      ],
      [
        `decision=accept&findingContentSha256=${dur.contentSha256}`,
        "application/x-www-form-urlencoded",
      ],
    ] as [string, string | undefined][]) {
      const response = await send(body, type);
      expect(response.status, body.slice(0, 40)).toBe(400);
    }
    expect(await reviewsOf(ids, dur.issue.findingId)).toEqual([]);
  });
});

describe("the two readings of a decision", () => {
  it("make the same request from the same choices", async () => {
    const { dur } = await open();
    const fromForm = decisionFromForm(
      {
        decision: "edit",
        reason: "Because.\r\nAnd more.",
        findingContentSha256: dur.contentSha256,
        status: "compliant",
        discrepancy: dur.discrepancy.replace(/\n/g, "\r\n"),
        fallbackLanguage: (dur.fallbackLanguage ?? "").replace(/\n/g, "\r\n"),
        [evidenceRoleField(dur.evidence[0]!.evidenceId)]: dur.evidence[0]!.role,
        [evidenceRoleField(dur.evidence[1]!.evidenceId)]: "supporting",
      },
      dur,
    );
    const fromBody = decisionFromBody({
      decision: "edit",
      reason: "Because.\nAnd more.",
      findingContentSha256: dur.contentSha256,
      edits: {
        status: "compliant",
        evidenceRoles: [{ evidenceId: dur.evidence[1]!.evidenceId, role: "supporting" }],
      },
    });
    expect(fromForm).toEqual(fromBody);
  });
});
