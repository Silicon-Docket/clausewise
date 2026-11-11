import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FindingView } from "../../src/services/views.js";
import { FIELDS, NOT_COVERED_VALUE } from "../../src/server/pages/forms.js";
import type { Notice } from "../../src/server/pages/layout.js";
import { pageWithLiveJump } from "../../src/server/routes/refusal-jumps.js";
import {
  REFUSAL_JUMP,
  REFUSAL_PHRASES,
  REFUSAL_TODO,
  type Refusal,
} from "../../src/server/routes/notices.js";
import { urls } from "../../src/server/urls.js";
import { expectAccessible } from "../a11y/rules.js";
import { all, attr, byId, first, hasClass, parseHtml, readable, withClass } from "../pages/html.js";
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
 * A refusal that links to a control of a form, answered on a page that has no such form (package
 * W2.6a). The parsers and the store check a decision's code and a report's fields before the state
 * of the finding, the matter or the review, so a decision on a finding that cannot be decided any
 * more, or a report against a review that cannot be reported on, is refused for its fields on a
 * page that shows the sentence of its state and no form. A link to a control that is not there
 * leads nowhere, so the notice keeps its words and drops the link; where the form is on the page,
 * the link stays.
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

const asPage = async (response: Response, status: number): Promise<Page> => {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toMatch(/^text\/html/);
  const html = await response.text();
  return { response, html, root: parseHtml(html) };
};

const noticeOf = (page: Page) =>
  first(page.root, (el) => attr(el, "role") === "alert" && hasClass(el, "notice-error"));

const linksOf = (page: Page): string[] =>
  all(noticeOf(page), (el) => el.name === "a" && hasClass(el, "notice-jump")).map(
    (a) => attr(a, "href") ?? "",
  );

/** A post made by hand, as a person's browser would make it with the form's fields. */
const byHand = async (
  who: Browser,
  to: string,
  fields: Record<string, string>,
): Promise<Response> =>
  who.send("POST", to, {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: await who.apiToken(), ...fields }).toString(),
  });

const findingOf = async (ids: Prepared): Promise<FindingView> =>
  (await (
    await reviewer.api("GET", `/api/matters/${ids.matterId}/findings/${ids.findingId}`)
  ).json()) as FindingView;

/** A reject with a reason and no reason code: refused for the code, whatever the state. */
const rejectWithoutCode = async (ids: Prepared): Promise<Page> => {
  const finding = await findingOf(ids);
  return asPage(
    await byHand(reviewer, urls.review(ids.matterId, ids.findingId), {
      [FIELDS.decision]: "reject",
      [FIELDS.reason]: "The explanation does not match the clause.",
      [FIELDS.findingContentSha256]: finding.contentSha256,
    }),
    400,
  );
};

/** What a refused page must say when the form it would link to is not on it. */
function expectWordsWithoutLink(page: Page, code: string): void {
  const alert = noticeOf(page);
  expect(readable(alert)).toBe(`Problem ${REFUSAL_PHRASES[code]}`);
  expect(withClass(alert, "todo").map(readable)).toEqual([REFUSAL_TODO[code]]);
  expect(linksOf(page)).toEqual([]);
  // No anchor of the page leads to an id the page does not have.
  expectAccessible(page.html);
}

describe("a decision that is refused for its code on a finding that cannot be decided", () => {
  it("on a finding of an exported matter: the words and the todo, no link, no form", async () => {
    const ids = await prepareMatter(site, { name: "Exported, then refused", exported: true });
    const before = fingerprint(site, ids.matterId);
    const page = await rejectWithoutCode(ids);
    expectWordsWithoutLink(page, "reason_code_required");
    // The page has no decision form, and says so in its own words.
    expect(byId(page.root, "decision-reason-code")).toBeUndefined();
    expect(byId(page.root, "edit-minor")).toBeUndefined();
    expect(readable(page.root)).toContain("This finding cannot be decided here.");
    expect(fingerprint(site, ids.matterId)).toEqual(before);
  });

  it("on a finding that has gone out of date: the words and the todo, no link, no form", async () => {
    const ids = await prepareMatter(site, { name: "Stale, then refused", exported: false });
    const finding = await findingOf(ids);
    // The inputs changed after the page was opened: the finding is stale, and its form is gone.
    site.w.repo.applyInputChange(ids.matterId, {
      reason: "rerun_requested",
      actorId: IDS.associate,
    });
    const page = await asPage(
      await byHand(reviewer, urls.review(ids.matterId, ids.findingId), {
        [FIELDS.decision]: "reject",
        [FIELDS.reason]: "The explanation does not match the clause.",
        [FIELDS.findingContentSha256]: finding.contentSha256,
      }),
      400,
    );
    expectWordsWithoutLink(page, "reason_code_required");
    expect(byId(page.root, "decision-reason-code")).toBeUndefined();
    expect(readable(page.root)).toContain("This finding cannot be decided here.");
  });

  it("with a code that is not one of the six, on an exported matter: the words and the todo, no link", async () => {
    const ids = await prepareMatter(site, { name: "Exported, bad code", exported: true });
    const finding = await findingOf(ids);
    const page = await asPage(
      await byHand(reviewer, urls.review(ids.matterId, ids.findingId), {
        [FIELDS.decision]: "reject",
        [FIELDS.reason]: "The explanation does not match the clause.",
        [FIELDS.reasonCode]: "not-a-code",
        [FIELDS.findingContentSha256]: finding.contentSha256,
      }),
      400,
    );
    expectWordsWithoutLink(page, "bad_reason_code");
    expect(byId(page.root, "decision-reason-code")).toBeUndefined();
  });

  it("is not fooled by the id written in the name of the matter, which the page shows as text", async () => {
    const hostile = 'Matter id="decision-reason-code" and id="edit-minor"';
    const ids = await prepareMatter(site, { name: hostile, exported: true });
    const page = await rejectWithoutCode(ids);
    // The name is on the page, as text, with its quotes escaped, and it made no element.
    expect(readable(page.root)).toContain(hostile);
    expectWordsWithoutLink(page, "reason_code_required");
    expect(byId(page.root, "decision-reason-code")).toBeUndefined();
  });

  it("keeps the link where the form is on the page, and it leads to the list of codes", async () => {
    const ids = await prepareMatter(site, { name: "Open, refused", exported: false });
    const page = await rejectWithoutCode(ids);
    const alert = noticeOf(page);
    expect(readable(alert)).toBe(
      `Problem ${REFUSAL_PHRASES["reason_code_required"]} ${REFUSAL_JUMP["reason_code_required"]!.label}`,
    );
    expect(linksOf(page)).toEqual(["#decision-reason-code"]);
    expect(byId(page.root, "decision-reason-code")?.name).toBe("select");
    expectAccessible(page.html);
  });
});

/** A review of the matter that was cancelled before it produced anything: no finding. */
function emptyRun(ids: Prepared): string {
  const { repo } = site.w;
  const manifest = repo.buildRunManifest(ids.matterId, {
    workflowVersionId: repo.getWorkflowVersionByLabel("v2")!.id,
    modelProvider: "scripted",
    model: "scripted-1",
  });
  repo.applyInputChange(ids.matterId, { reason: "rerun_requested", actorId: IDS.associate });
  const empty = repo.createRun(ids.matterId, { manifest, startedBy: IDS.associate });
  repo.updateRunStatus(ids.matterId, empty.id, "cancelled");
  return empty.id;
}

/** A review that has started and not finished: the report form is not shown while it runs. */
function activeRun(ids: Prepared): string {
  const { repo } = site.w;
  const manifest = repo.buildRunManifest(ids.matterId, {
    workflowVersionId: repo.getWorkflowVersionByLabel("v2")!.id,
    modelProvider: "scripted",
    model: "scripted-1",
  });
  repo.applyInputChange(ids.matterId, { reason: "rerun_requested", actorId: IDS.associate });
  return repo.createRun(ids.matterId, { manifest, startedBy: IDS.associate }).id;
}

const CONTROLS = ["missed-issue-rule", "missed-issue-note", "missed-issue-location"] as const;

describe("a report that is refused for its fields on a review that cannot be reported on", () => {
  const refusedReports: [string, Record<string, string>, string][] = [
    ["no rule chosen", {}, "rule_required"],
    ["no note", { [FIELDS.ruleKey]: NOT_COVERED_VALUE, [FIELDS.note]: "" }, "note_required"],
    [
      "a place that is too long",
      {
        [FIELDS.ruleKey]: NOT_COVERED_VALUE,
        [FIELDS.location]: "x".repeat(201),
        [FIELDS.note]: "A note.",
      },
      "location_too_long",
    ],
  ];

  for (const [title, fields, code] of refusedReports) {
    it(`on a review with no findings, ${title}: the words and the todo, no link, no form`, async () => {
      const ids = await prepareMatter(site, { name: `No findings, ${title}`, exported: false });
      const runId = emptyRun(ids);
      const before = fingerprint(site, ids.matterId);
      const page = await asPage(
        await byHand(associate, urls.missedIssues(ids.matterId, runId), fields),
        400,
      );
      expectWordsWithoutLink(page, code);
      for (const id of CONTROLS) expect(byId(page.root, id), id).toBeUndefined();
      expect(readable(page.root)).toContain("This review has no findings");
      expect(fingerprint(site, ids.matterId)).toEqual(before);
    });

    it(`on a review that is still running, ${title}: the words and the todo, no link, no form`, async () => {
      const ids = await prepareMatter(site, { name: `Running, ${title}`, exported: false });
      const runId = activeRun(ids);
      const page = await asPage(
        await byHand(associate, urls.missedIssues(ids.matterId, runId), fields),
        400,
      );
      expectWordsWithoutLink(page, code);
      for (const id of CONTROLS) expect(byId(page.root, id), id).toBeUndefined();
    });
  }

  it("on a review that has findings: the link stays and leads to the control of the form", async () => {
    const ids = await prepareMatter(site, { name: "Findings, refused", exported: false });
    const page = await asPage(
      await byHand(associate, urls.missedIssues(ids.matterId, ids.runId), {}),
      400,
    );
    expect(readable(noticeOf(page))).toBe(
      `Problem ${REFUSAL_PHRASES["rule_required"]} ${REFUSAL_JUMP["rule_required"]!.label}`,
    );
    expect(linksOf(page)).toEqual(["#missed-issue-rule"]);
    expect(byId(page.root, "missed-issue-rule")?.name).toBe("select");
    expectAccessible(page.html);
  });
});

// ---------------------------------------------------------------------------------------------
// The helper on its own
// ---------------------------------------------------------------------------------------------

const refusalWith = (code: string): Refusal => {
  const jump = REFUSAL_JUMP[code];
  const notice: Notice = {
    kind: "error",
    text: REFUSAL_PHRASES[code] ?? "A phrase.",
    todo: REFUSAL_TODO[code] ?? "Do it.",
    ...(jump === undefined ? {} : { jump: { href: jump.href as `#${string}`, label: jump.label } }),
  };
  return { status: 400, code, notice };
};

/** A stand-in page: it holds the ids it is given, and the link of the notice it is shown. */
const standIn =
  (ids: string[]) =>
  (shown: Refusal | undefined): string =>
    `<main>${ids.map((id) => `<input id="${id}">`).join("")}${
      shown?.notice.jump === undefined
        ? ""
        : `<a class="notice-jump" href="${shown.notice.jump.href}">go</a>`
    }</main>`;

const DECISION_AND_REPORT_JUMPS = [
  "reason_code_required",
  "reason_code_not_allowed",
  "bad_reason_code",
  "minor_edit_not_allowed",
  "minor_edit_status",
  "rule_required",
  "note_required",
  "note_too_long",
  "location_too_long",
];

describe("the helper that keeps a link only if its control is on the page", () => {
  it("covers every refusal of a decision and of a report that links to a control", () => {
    for (const code of DECISION_AND_REPORT_JUMPS) {
      const refusal = refusalWith(code);
      const id = refusal.notice.jump!.href.slice(1);
      // The control is on the page: the page is the one built with the link.
      expect(pageWithLiveJump(refusal, standIn([id])), code).toContain(`href="#${id}"`);
      // The control is not: the page is built again with the notice as it is, less its link.
      const without = pageWithLiveJump(refusal, standIn(["something-else"]));
      expect(without, code).not.toContain("notice-jump");
      const { jump: _jump, ...notice } = refusal.notice;
      expect(without, code).toBe(standIn(["something-else"])({ ...refusal, notice }));
    }
  });

  it("is not fooled by an id that only starts with, ends with or contains the target", () => {
    const refusal = refusalWith("reason_code_required");
    const page = pageWithLiveJump(
      refusal,
      standIn(["decision-reason-code-hint", "x-decision-reason-code", "decision-reason-code2"]),
    );
    expect(page).not.toContain("notice-jump");
  });

  it("is not fooled by the target written in text, or in an attribute that is not an id", () => {
    const refusal = refusalWith("reason_code_required");
    const build = (shown: Refusal | undefined): string =>
      `<p>id=&quot;decision-reason-code&quot;</p><p data-id="decision-reason-code" title="id=&quot;decision-reason-code&quot;"></p>${
        shown?.notice.jump === undefined ? "" : '<a class="notice-jump">go</a>'
      }`;
    expect(pageWithLiveJump(refusal, build)).not.toContain("notice-jump");
  });

  it("builds the page once for a page that is not a refusal, and for a refusal with no link", () => {
    let built = 0;
    const count = (shown: Refusal | undefined): string => {
      built += 1;
      return standIn([])(shown);
    };
    pageWithLiveJump(undefined, count);
    expect(built).toBe(1);
    pageWithLiveJump(refusalWith("unknown_rule"), count);
    expect(built).toBe(2);
    // With a link that leads nowhere it is built a second time, without it.
    pageWithLiveJump(refusalWith("rule_required"), count);
    expect(built).toBe(4);
  });
});
