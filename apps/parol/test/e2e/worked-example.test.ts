import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../src/canonical.js";
import { FIELDS } from "../../src/server/pages/forms.js";
import { WORKFLOW_FIELD } from "../../src/server/pages/matter.js";
import { urls } from "../../src/server/urls.js";
import type {
  FindingView,
  IssueRow,
  MatterView,
  MemoSummary,
  RunSummary,
} from "../../src/services/views.js";
import {
  all,
  attr,
  byId,
  first,
  hasAttr,
  hasClass,
  readable,
  textOf,
  type El,
} from "../pages/html.js";
import {
  IDS,
  baseWorld,
  checkPage,
  cleanup,
  makeSite,
  matterIdFrom,
  workedExampleModel,
  type Browser,
  type Page,
  type Site,
} from "../routes/support.js";

/**
 * The worked example of docs/parol/04 (PAROL-D05) from the first click to a memo and back to a
 * stale review, through HTTP only: the real shell, the real routes, the real services over an
 * in-memory store, and a scripted stand-in for the model that answers from the case's answer key.
 * What the model says here is a script and is not a measurement of any model. Every document,
 * party and person is synthetic.
 *
 * The tests run in order and share the story; each one is a step a person takes.
 */

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const NDA = baseWorld.files.find((f) => f.label === "D1")!;
const AMENDMENT = baseWorld.files.find((f) => f.label === "D2")!;
const docOf = (label: string) => baseWorld.documents.find((d) => d.label === label)!;

/** The amendment, corrected: Section 2 now extends the term and no longer deletes it. */
const CORRECTED_AMENDMENT = new TextEncoder().encode(
  new TextDecoder()
    .decode(AMENDMENT.bytes)
    .replace(
      "2. Section 6.1 of the Agreement is deleted in its entirety.",
      '2. Section 6.1 of the Agreement is amended by replacing "two (2) years" with "three (3) years".',
    ),
);

const rowsOf = (page: Page): El[] =>
  all(page.root, (el) => el.name === "tr" && hasAttr(el, "data-issue-row"));
const ruleKeyOf = (row: El): string =>
  readable(first(row, (el) => el.name === "code" && hasClass(el, "rule-key")));
const linkOf = (row: El): string =>
  attr(
    first(row, (el) => el.name === "a" && hasAttr(el, "data-row-link")),
    "href",
  ) ?? "";
const noticeOf = (page: Page): string =>
  readable(all(page.root, (el) => hasClass(el, "notice"))[0] ?? { type: "text", text: "" });

/**
 * The reviewer's edit of docs/parol/04 section 5: the term the parties had already agreed is put
 * back in place of the playbook's three years, with the reason that goes with it.
 */
const EDITED_FALLBACK =
  "6.1 The obligations of each Receiving Party under Section 4 shall continue for two (2) years from the date of each disclosure of Confidential Information, except that obligations with respect to any trade secret shall continue for so long as it remains a trade secret under applicable law.";
const EDIT_REASON =
  "The parties agreed two years in February. Propose reinstating it; three years from disclosure is the playbook's outer limit if Corvane resists.";

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
};

/** The text of each paragraph of a Word document.xml, with the entities read back. */
const paragraphsOf = (xml: string): string[] =>
  xml
    .split("</w:p>")
    .map((part) =>
      [...part.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)]
        .map((m) => m[1]!.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (e) => XML_ENTITIES[e]!))
        .join(""),
    )
    .filter((text) => text !== "");

describe("the worked example, through HTTP only", () => {
  let site: Site;
  let associate: Browser;
  let reviewer: Browser;
  let matterId = "";
  let v1: RunSummary;
  let v2: RunSummary;
  let durId = "";
  let ndaDocumentId = "";
  let amendmentDocumentId = "";
  let memoId = "";

  beforeAll(async () => {
    // The model answers the duration rule from what it is shown, as docs/parol/04 tells it.
    site = makeSite({ model2: workedExampleModel() });
    associate = await site.as(IDS.associate);
  });

  /** Polls the status route the matter page names, as the page's script does, until it is final. */
  async function untilFinished(browser: Browser, page: Page): Promise<RunSummary> {
    const live = first(page.root, (el) => hasAttr(el, "data-status-url"), "the progress box");
    const statusUrl = attr(live, "data-status-url")!;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const response = await browser.get(statusUrl);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^application\/json/);
      const payload = (await response.json()) as { finished: boolean };
      if (payload.finished) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await site.w.services.runs.idle();
    const runId = statusUrl.split("/")[4]!;
    const run = (await (
      await browser.api("GET", `/api/matters/${matterId}/runs/${runId}`)
    ).json()) as RunSummary;
    return run;
  }

  async function matterPage(browser: Browser = associate): Promise<Page> {
    return browser.page(urls.matter(matterId));
  }

  it("signs in as the associate and creates the matter with the new-matter form", async () => {
    const page = await associate.page(urls.matters());
    checkPage(site, page);
    const reviewerOption = all(page.root, (el) => el.name === "option").find(
      (o) => attr(o, "value") === IDS.reviewer,
    );
    expect(reviewerOption).toBeDefined();
    const response = await associate.submit(page, urls.matters(), {
      set: {
        [FIELDS.name]: "Lanternfish / Corvane NDA",
        [FIELDS.clientLegalName]: baseWorld.manifest.clientLegalName,
        [FIELDS.reviewerUserId]: IDS.reviewer,
        [FIELDS.playbookVersionId]: site.w.playbookVersionId,
      },
    });
    expect(response.status).toBe(303);
    matterId = matterIdFrom(response);
    const created = await associate.page(response.headers.get("location")!);
    checkPage(site, created);
    expect(noticeOf(created)).toContain("The matter was created");
    // The notice is a fixed phrase for a fixed code; the page shows nothing else of the query.
    expect(site.logs.join("\n")).not.toContain("Lanternfish");
  });

  it("uploads the NDA (DOCX) and the amendment (TXT) with the add-document form", async () => {
    for (const file of [NDA, AMENDMENT]) {
      const page = await matterPage();
      checkPage(site, page);
      const document = docOf(file.label);
      const response = await associate.upload(
        page,
        urls.documents(matterId),
        { name: file.file, bytes: file.bytes },
        {
          set: {
            [FIELDS.title]: document.title,
            [FIELDS.kind]: document.kind,
            [FIELDS.statedDate]: document.statedDate ?? "",
          },
        },
      );
      expect(response.status, file.file).toBe(303);
      expect(noticeOf(await associate.page(response.headers.get("location")!))).toContain(
        "The document was added",
      );
    }
    const page = await matterPage();
    const view = (await (
      await associate.api("GET", `/api/matters/${matterId}`)
    ).json()) as MatterView;
    expect(view.documents.map((d) => [d.label, d.kind, d.title])).toEqual([
      ["D1", "nda", "Mutual NDA"],
      ["D2", "amendment", "Amendment No. 1"],
    ]);
    ndaDocumentId = view.documents[0]!.documentId;
    amendmentDocumentId = view.documents[1]!.documentId;
    expect(view.matter.status).toBe("ready");
    expect(readable(byId(page.root, "documents")!)).toContain("Amendment No. 1");
    // The instruction-free worked example raises no warning.
    expect(view.warnings).toEqual([]);
  });

  it("chooses the operative version of each document with the operative form", async () => {
    for (const documentId of [ndaDocumentId, amendmentDocumentId]) {
      const page = await matterPage();
      const view = (await (
        await associate.api("GET", `/api/matters/${matterId}`)
      ).json()) as MatterView;
      const version = view.documents.find((d) => d.documentId === documentId)!.versions[0]!;
      const response = await associate.submit(page, urls.operative(matterId, documentId), {
        set: { [FIELDS.versionId]: version.versionId },
      });
      expect(response.status).toBe(303);
      expect(noticeOf(await associate.page(response.headers.get("location")!))).toContain(
        "operative version was saved",
      );
    }
    const view = (await (
      await associate.api("GET", `/api/matters/${matterId}`)
    ).json()) as MatterView;
    expect(view.documents.every((d) => d.versions.every((v) => v.operative))).toBe(true);
    expect(view.start).toEqual({ ready: true, reasons: [] });
  });

  it("starts a run with workflow v1 and another with v2, choosing the workflow on the start form", async () => {
    const page = await matterPage();
    // The form offers the choice, with the default first and preselected.
    const select = first(
      page.root,
      (el) => el.name === "select" && attr(el, "name") === WORKFLOW_FIELD,
    );
    const options = all(select, (el) => el.name === "option").map((o) => attr(o, "value"));
    expect(options).toEqual(["v1", "v2"]);

    const first_ = await associate.submit(page, urls.runs(matterId), {
      set: { [WORKFLOW_FIELD]: "v1" },
    });
    expect(first_.status).toBe(303);
    const running = await associate.page(first_.headers.get("location")!);
    checkPage(site, running);
    expect(noticeOf(running)).toContain("The review has started");
    v1 = await untilFinished(associate, running);
    expect(v1).toMatchObject({ status: "succeeded", workflowLabel: "v1", findingCount: 8 });
    // The field really chose the workflow, and not only its label. Under v1 the duration rule is
    // read from the NDA alone: the amendment is not put in front of the model, so it answers
    // "compliant" from Section 6.1 and every check passes, because the quote is there and the NDA
    // does say two years. This is the verified, wrong answer that docs/parol/04 (section 3) builds
    // the improvement around. (The model is a script; none was measured.)
    const early = (await (
      await associate.api("GET", `/api/matters/${matterId}/runs/${v1.id}/findings`)
    ).json()) as { findings: IssueRow[] };
    const earlyDur = early.findings.find((f) => f.ruleKey === "dur-1")!;
    expect(earlyDur).toMatchObject({
      status: "compliant",
      severity: "high",
      validity: "current",
      verificationState: "verified",
      escalations: [],
    });
    const wrong = (await (
      await associate.api("GET", `/api/matters/${matterId}/findings/${earlyDur.findingId}`)
    ).json()) as FindingView;
    expect(wrong.evidence.map((e) => [e.role, e.location, e.quoteCheck])).toEqual([
      ["governing", "Mutual NDA (v1), Section 6.1, paragraph 19", "verified"],
    ]);
    expect(wrong.checks.every((check) => check.outcome !== "fail")).toBe(true);

    const again = await matterPage();
    const second = await associate.submit(again, urls.runs(matterId), {
      set: { [WORKFLOW_FIELD]: "v2" },
    });
    expect(second.status).toBe(303);
    v2 = await untilFinished(associate, await associate.page(second.headers.get("location")!));
    expect(v2).toMatchObject({
      status: "succeeded",
      workflowLabel: "v2",
      findingCount: 8,
      current: true,
    });
    expect(v2.id).not.toBe(v1.id);

    // Only the later run stands: the earlier one is out of date, whatever it found.
    const runs = (await (await associate.api("GET", `/api/matters/${matterId}/runs`)).json()) as {
      runs: RunSummary[];
    };
    expect(runs.runs.map((r) => [r.workflowLabel, r.current])).toEqual([
      ["v2", true],
      ["v1", false],
    ]);
  });

  it("shows the issue table as a page and as JSON, and the two agree", async () => {
    const table = await associate.page(urls.run(matterId, v2.id));
    checkPage(site, table);
    const rows = rowsOf(table);
    expect(rows).toHaveLength(8);

    const json = (await (
      await associate.api("GET", `/api/matters/${matterId}/runs/${v2.id}/findings`)
    ).json()) as { runId: string; findings: IssueRow[] };
    expect(json.runId).toBe(v2.id);
    expect(json.findings.map((f) => f.ruleKey).sort()).toEqual(rows.map(ruleKeyOf).sort());
    const dur = json.findings.find((f) => f.ruleKey === "dur-1")!;
    durId = dur.findingId;
    expect(dur).toMatchObject({
      status: "deviation",
      severity: "high",
      validity: "current",
      verificationState: "verified",
    });
    // Each row links to its finding, in the table.
    const link = linkOf(rows.find((row) => ruleKeyOf(row) === "dur-1")!);
    expect(link).toBe(urls.run(matterId, v2.id, durId));
  });

  it("opens the dur-1 finding with its quote highlighted and the superseded passage struck through", async () => {
    const view = (await (
      await associate.api("GET", `/api/matters/${matterId}/findings/${durId}`)
    ).json()) as FindingView;
    expect(view.evidence.map((e) => [e.role, e.location])).toEqual([
      ["governing", "Amendment No. 1 (v1), Section 2, paragraph 3"],
      ["superseded", "Mutual NDA (v1), Section 6.1, paragraph 19"],
      ["supporting", "Mutual NDA (v1), Section 9.3, paragraph 29"],
    ]);

    for (const path of [urls.finding(matterId, durId), urls.run(matterId, v2.id, durId)]) {
      const page = await associate.page(path);
      checkPage(site, page);
      const pane = first(page.root, (el) => el.name === "article" && hasClass(el, "finding-pane"));
      const passages = all(pane, (el) => el.name === "article" && hasAttr(el, "data-passage"));
      expect(passages).toHaveLength(3);

      const governing = passages.find((p) => hasClass(p, "role-governing"))!;
      const marks = all(governing, (el) => el.name === "mark" && hasAttr(el, "data-quote"));
      expect(marks.map(textOf)).toEqual([
        "Section 6.1 of the Agreement is deleted in its entirety",
      ]);

      const superseded = passages.find((p) => hasClass(p, "role-superseded"))!;
      expect(hasClass(superseded, "is-superseded")).toBe(true);
      expect(readable(superseded)).toContain("Superseded.");
      const struck = first(
        superseded,
        (el) => el.name === "del" && hasClass(el, "superseded-text"),
      );
      expect(readable(struck)).toContain(
        "shall continue for two (2) years from the date of each disclosure",
      );
      expect(all(struck, (el) => el.name === "mark").map(textOf)).toEqual([
        "shall continue for two (2) years from the date of each disclosure",
      ]);
      // The associate cannot decide: the page says so instead of offering the form.
      expect(hasForm(page, urls.review(matterId, durId))).toBe(false);
    }
  });

  const hasForm = (page: Page, action: string): boolean => associate.hasForm(page, action);

  it("signs in as the reviewer and decides every finding through the form, with the token", async () => {
    reviewer = await site.as(IDS.reviewer);
    const table = await reviewer.page(urls.run(matterId, v2.id));
    const rows = rowsOf(table);
    expect(rows).toHaveLength(8);

    for (const row of rows) {
      const page = await reviewer.page(linkOf(row));
      checkPage(site, page);
      const action = [...all(page.root, (el) => el.name === "form")]
        .map((f) => attr(f, "action") ?? "")
        .find((a) => /\/reviews$/.test(a))!;
      const findingId = action.split("/")[4]!;
      const view = (await (
        await reviewer.api("GET", `/api/matters/${matterId}/findings/${findingId}`)
      ).json()) as FindingView;
      expect(view.canDecide).toEqual({ allowed: true, reason: null });
      const verified =
        view.issue.verificationState === "verified" && view.issue.status !== "undetermined";
      // Section 5 of docs/parol/04: the reviewer reads the amendment in place and edits the fallback
      // of the duration finding, with a reason. Every other finding is accepted, or escalated when
      // the workflow could not settle it. The form posts the whole finding back, so only the
      // fallback text may become an edit.
      const response = await reviewer.submit(page, action, {
        set:
          ruleKeyOf(row) === "dur-1"
            ? {
                [FIELDS.decision]: "edit",
                [FIELDS.fallbackLanguage]: EDITED_FALLBACK,
                [FIELDS.reason]: EDIT_REASON,
                [FIELDS.reasonCode]: "missed_context",
              }
            : verified
              ? { [FIELDS.decision]: "accept" }
              : {
                  [FIELDS.decision]: "escalate",
                  [FIELDS.reason]: "The workflow could not settle this rule.",
                },
      });
      expect(response.status, ruleKeyOf(row)).toBe(303);
      // Back in the table, with this finding selected.
      expect(response.headers.get("location")).toContain(urls.run(matterId, v2.id, findingId));
      const back = await reviewer.page(response.headers.get("location")!);
      expect(noticeOf(back)).toContain("The decision was saved");
    }

    const after = (await (
      await reviewer.api("GET", `/api/matters/${matterId}/runs/${v2.id}/findings`)
    ).json()) as { findings: IssueRow[] };
    expect(after.findings.every((f) => f.review?.validity === "current")).toBe(true);
    const view = (await (
      await reviewer.api("GET", `/api/matters/${matterId}`)
    ).json()) as MatterView;
    expect(view.matter.status).toBe("review_complete");

    // The edit is on record as the reviewer's, with only the field that was changed, and is bound
    // to the finding as it was when the reviewer decided.
    const edited = (await (
      await reviewer.api("GET", `/api/matters/${matterId}/findings/${durId}`)
    ).json()) as FindingView;
    expect(edited.reviews).toHaveLength(1);
    expect(edited.reviews[0]).toMatchObject({
      decision: "edit",
      validity: "current",
      reason: EDIT_REASON,
      reasonCode: "missed_context",
      minorEdit: false,
      edits: { fallbackLanguage: EDITED_FALLBACK },
    });
    expect(Object.keys(edited.reviews[0]!.edits ?? {})).toEqual(["fallbackLanguage"]);
    expect(edited.fallbackLanguage).not.toBe(EDITED_FALLBACK);
    // The other seven are accepted or escalated, none edited.
    const decisions = new Map<string, number>();
    for (const row of after.findings) {
      const decision = row.review!.decision;
      decisions.set(decision, (decisions.get(decision) ?? 0) + 1);
    }
    expect(decisions.get("edit")).toBe(1);
    expect([...decisions.values()].reduce((a, b) => a + b, 0)).toBe(8);
  });

  it("exports the memo from the memos page and downloads it", async () => {
    const memos = await reviewer.page(urls.memos(matterId));
    checkPage(site, memos);
    const response = await reviewer.submit(memos, urls.memos(matterId));
    expect(response.status).toBe(303);
    const after = await reviewer.page(response.headers.get("location")!);
    checkPage(site, after);
    expect(noticeOf(after)).toContain("The memo was exported");

    const list = (await (
      await reviewer.api("GET", `/api/matters/${matterId}`)
    ).json()) as MatterView;
    expect(list.matter.status).toBe("exported");
    const memo: MemoSummary = list.memos[0]!;
    memoId = memo.memoId;

    // The link on the page is the download.
    const link = first(
      after.root,
      (el) => el.name === "a" && attr(el, "href") === urls.memoFile(matterId, memoId),
      "the download link",
    );
    expect(attr(link, "href")).toBe(urls.memoFile(matterId, memoId));
    const file = await reviewer.get(urls.memoFile(matterId, memoId));
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(file.headers.get("content-disposition")).toBe(`attachment; filename="${memo.fileName}"`);
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect(sha256Hex(bytes)).toBe(memo.fileSha256);

    const zip = await JSZip.loadAsync(bytes);
    const body = await zip.file("word/document.xml")!.async("string");
    expect(body).toContain(baseWorld.manifest.clientLegalName);
    expect(body).toContain("Amendment No. 1 (v1), Section 2, paragraph 3");
    expect(body).toContain("Section 6.1 of the Agreement is deleted in its entirety");

    // Section 6 of docs/parol/04: the memo carries the reviewer's edit as the proposed language, says
    // that it is the reviewer's and what the workflow had proposed, and carries the reviewer's note.
    const lines = paragraphsOf(body);
    expect(
      lines.filter((line) => line.includes(`"${EDITED_FALLBACK}"`)),
      "the edited fallback is the proposed language",
    ).toHaveLength(1);
    expect(lines.find((line) => line.includes(EDITED_FALLBACK))).toMatch(
      /^Proposed language \(edited by the reviewer; the workflow's version was .+\):/,
    );
    expect(lines).toContain(`Reviewer note: ${EDIT_REASON}`);
    const originalFallback = (
      (await (
        await reviewer.api("GET", `/api/matters/${matterId}/findings/${durId}`)
      ).json()) as FindingView
    ).fallbackLanguage!;
    expect(lines).toContain(`Original before edit: "${originalFallback}"`);
    expect(lines.filter((line) => /^Decision: Edited by .+ on .+\.$/.test(line))).toHaveLength(1);

    // The associate and a viewer-free reader of the same matter may download it too.
    expect((await associate.get(urls.memoFile(matterId, memoId))).status).toBe(200);
  });

  it("makes the decisions stale when a corrected amendment is uploaded, and blocks the export", async () => {
    const page = await matterPage();
    const response = await associate.upload(
      page,
      urls.versions(matterId, amendmentDocumentId),
      { name: "amendment-1-corrected.txt", bytes: CORRECTED_AMENDMENT },
      { set: { [FIELDS.statedDate]: "2026-09-16" } },
    );
    expect(response.status).toBe(303);
    const after = await associate.page(response.headers.get("location")!);
    checkPage(site, after);
    expect(noticeOf(after)).toContain("The new version was added and is now the operative one.");

    // The upload alone did it: a version whose text differs governs at once, and the review made on
    // the old text is out of date, with no further click.
    const view = (await (
      await associate.api("GET", `/api/matters/${matterId}`)
    ).json()) as MatterView;
    const versions = view.documents.find((d) => d.documentId === amendmentDocumentId)!.versions;
    expect(versions.map((v) => [v.versionNo, v.operative])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(view.matter.status).toBe("stale");
    expect(view.staleReason).not.toBeNull();
    expect(view.currentRun).toBeNull();

    // The table still shows the old findings, every one marked out of date, and no decision counts.
    const table = (await (
      await reviewer.api("GET", `/api/matters/${matterId}/runs/${v2.id}/findings`)
    ).json()) as { findings: IssueRow[] };
    expect(table.findings.every((f) => f.validity === "stale")).toBe(true);
    const stalePage = await reviewer.page(urls.run(matterId, v2.id, durId));
    checkPage(site, stalePage);
    expect(readable(stalePage.root)).toContain("This review is out of date");
    expect(reviewerCannotDecide(stalePage)).toBe(true);

    // Export is blocked on the page and at the server.
    const memos = await reviewer.page(urls.memos(matterId));
    const button = first(
      memos.root,
      (el) => el.name === "button" && readable(el) === "Export memo",
    );
    expect(hasAttr(button, "disabled")).toBe(true);
    // The memos page and the matter page give the same reason in the same words.
    expect(readable(memos.root)).toContain(
      "The results are out of date. Run the review again first.",
    );
    expect(readable((await matterPage(reviewer)).root)).toContain(
      "The results are out of date. Run the review again first.",
    );
    const refused = await reviewer.submit(memos, urls.memos(matterId));
    expect(refused.status).toBe(409);
    const api = await reviewer.api("POST", `/api/matters/${matterId}/memos`);
    expect(api.status).toBe(409);
    expect(((await api.json()) as { error: { kind: string } }).error.kind).toBe("export_blocked");
    // The old memo is still on record and can still be read, marked superseded.
    const list = (await (
      await reviewer.api("GET", `/api/matters/${matterId}`)
    ).json()) as MatterView;
    expect(list.memos.map((m) => [m.memoId, m.status])).toEqual([[memoId, "superseded"]]);
  });

  const reviewerCannotDecide = (page: Page): boolean =>
    !all(page.root, (el) => el.name === "form").some((f) =>
      /\/reviews$/.test(attr(f, "action") ?? ""),
    );
});
