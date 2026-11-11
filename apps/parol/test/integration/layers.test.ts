import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import type { Context, Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ModelRequestError } from "@clausewise/llm";
import { csrfToken, readPrincipal } from "../../src/auth/index.js";
import { markInterruptedRuns } from "../../src/boot/index.js";
import type { AuthorizedMatter, Principal } from "../../src/auth/types.js";
import { CHECK_IDS } from "../../src/server/views/labels.js";
import { hashOf, sha256Hex } from "../../src/canonical.js";
import { WORKFLOWS } from "../../src/prompts/workflows.js";
import {
  CATEGORY_IDS,
  EVIDENCE_ROLES,
  REASON_CODES,
  REVIEW_DECISIONS,
  RUN_STATUSES,
  STATUSES,
  type EvidenceRole,
} from "../../src/contracts.js";
import { start as startServer, type RunningServer } from "../../src/main.js";
import { createApp } from "../../src/server/app.js";
import type { AppConfig } from "../../src/server/deps.js";
import { formString, readForm } from "../../src/server/http.js";
import { defineMatterRoute, defineRoute } from "../../src/server/matter-route.js";
import { CONTENT_SECURITY_POLICY } from "../../src/server/middleware/security-headers.js";
import {
  ErrorPage,
  CONFIRM_VALUE,
  DEMO_BANNER,
  FIELDS,
  FindingPage,
  ISSUE_FILTERS,
  MatterPage,
  MattersPage,
  MemosPage,
  RunPage,
  SignInPage,
  STALE_FINDING_REASON,
  evidenceIdOfRoleField,
  normalizeNewlines,
  render,
  renderErrorPage,
  runStatusPayload,
  type Chrome,
} from "../../src/server/pages/index.js";
import { idPart } from "../../src/server/pages/components.js";
import { MINOR_EDIT_VALUE } from "../../src/server/pages/forms.js";
import { RUN_ALREADY_ACTIVE } from "../../src/server/pages/matter.js";
import { urls } from "../../src/server/urls.js";
import * as labels from "../../src/server/views/labels.js";
import { createServices } from "../../src/services/index.js";
import { START_REASONS, CANNOT_DECIDE, staleReasonPhrase } from "../../src/services/phrases.js";
import { RUN_ERROR_KINDS } from "../../src/services/run-support.js";
import type {
  DecisionRequest,
  FindingView,
  IssueRow,
  MatterView,
} from "../../src/services/views.js";
import { DEMO_USER_IDS, INPUT_CHANGE_REASONS, ValidationError } from "../../src/store/index.js";
import { SCRIPT_PATH, runScript } from "../pages/fake-dom.js";
import { variants } from "../pages/variants.js";
import {
  ancestorsOf,
  all,
  attr,
  byId,
  byTag,
  first,
  formsTo,
  hasAttr,
  hasClass,
  parseHtml,
  readable,
  textOf,
  type El,
} from "../pages/html.js";
import { checkInvariants } from "../pages/invariants.js";
import { IDS } from "../pages/support.js";
import {
  Client,
  SECRET,
  addUser,
  mountProbes,
  parseSetCookies,
  snapshot,
} from "../server/support-app.js";
import {
  baseWorld,
  cleanup,
  controlledModel,
  gate,
  makeWorld,
  newMatter,
  revisedAnswer,
  uploadCase,
  type ModelOptions,
  type World,
} from "../services/support.js";
import { ROOT, buildCaseWorld, loadFixtures, runWorkflow, versionIdOf } from "./pipeline.js";
import {
  allowed,
  formFields,
  grantingDirectives,
  parseCsp,
  posted,
  urlEncoded,
  usesOf,
  watchReads,
} from "./layers-support.js";
import { readFileSync } from "node:fs";

/**
 * Whether the layers fit. The services, the pages and the shell were built apart against shared
 * interface files and each was tested with its own stand-ins for the others. Here the real ones
 * meet: the real services over an in-memory store and a temporary file store, run on the worked
 * example of docs/parol/04 (PAROL-D05) by a scripted model; the real page functions fed what the
 * services return; and the real shell (createApp, defineMatterRoute) around the same services,
 * driven through app.request(). Every document, party and name is synthetic and nothing calls a
 * network.
 *
 * The routes of the next phase are not here. The few routes this file mounts are synthetic: each
 * does the least that lets a page, the shell and a service meet, and says so.
 */

afterAll(cleanup);

// Each scene runs a whole review, and the full suite runs many files at once, so the limits are
// generous: a slow machine should not make a correct test fail.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// ---------------------------------------------------------------------------------------------
// The worked example, reviewed through the services
// ---------------------------------------------------------------------------------------------

/** The model's answers as docs/parol/04 gives them: the duration finding is the interesting one. */
const WORKED_EXAMPLE = { answers: { "dur-1": revisedAnswer(baseWorld) } };

interface Reviewed {
  w: World;
  matterId: string;
  runId: string;
  /** The associate who prepared the review. */
  am: AuthorizedMatter;
  /** The reviewing attorney. */
  reviewerAm: AuthorizedMatter;
}

async function reviewed(options: Parameters<typeof makeWorld>[0] = {}): Promise<Reviewed> {
  const w = makeWorld({ model: WORKED_EXAMPLE, ...options });
  const { matterId, am } = newMatter(w);
  await uploadCase(w, matterId);
  const started = w.services.runs.start(am, { workflowLabel: "v2" });
  await w.services.runs.idle();
  return { w, matterId, runId: started.id, am, reviewerAm: w.grant(w.reviewer, matterId) };
}

const chromeFor = (principal: Principal): Chrome => ({
  userName: principal.displayName,
  csrfToken: IDS.csrf,
});

/** Every URL a form of this matter may post to, from the shared table. */
function actionsOf(r: Pick<Reviewed, "w" | "am" | "matterId">): Set<string> {
  const m = r.matterId;
  const view = r.w.services.matters.view(r.am);
  const issues = r.w.services.runs.issues(r.am);
  return new Set<string>([
    urls.session(),
    urls.matters(),
    urls.matterSettings(m),
    urls.matterRetention(m),
    urls.matterDelete(m),
    urls.members(m),
    urls.documents(m),
    urls.runs(m),
    urls.memos(m),
    ...view.runs.flatMap((run) => [urls.runResume(m, run.id), urls.runCancel(m, run.id)]),
    ...view.documents.flatMap((d) => [
      urls.versions(m, d.documentId),
      urls.operative(m, d.documentId),
      urls.documentRemove(m, d.documentId),
      ...d.versions.map((v) => urls.statedDate(m, v.versionId)),
    ]),
    ...issues.map((i) => urls.review(m, i.findingId)),
    ...issues.map((i) => urls.notes(m, i.findingId)),
  ]);
}

const durOf = (r: Reviewed, as: AuthorizedMatter): FindingView => {
  const issue = r.w.services.runs.issues(as, r.runId).find((i) => i.ruleKey === "dur-1")!;
  return r.w.services.runs.finding(as, issue.findingId);
};

/** The text before, inside and after the first `mark` below an element. */
function around(root: El, mark: El): { before: string; inside: string; after: string } {
  const out = { before: "", inside: "", after: "" };
  let phase: keyof typeof out = "before";
  const visit = (node: El["children"][number]): void => {
    if (node.type === "text") {
      out[phase] += node.text;
      return;
    }
    if (node === mark) {
      phase = "inside";
      out.inside += textOf(node);
      phase = "after";
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const child of root.children) visit(child);
  return out;
}

const passageOf = (pane: El, evidenceId: string): El =>
  first(
    pane,
    (el) =>
      el.name === "article" &&
      attr(el, "aria-labelledby") === `passage-${idPart(evidenceId)}-where`,
    `passage ${evidenceId}`,
  );

describe("the worked example, from the services into the pages", () => {
  let r: Reviewed;
  let finding: FindingView;
  let view: MatterView;
  let issues: IssueRow[];
  const missing = new Set<string>();
  let runHtml = "";
  let matterHtml = "";
  let reviewerPane: El;

  beforeAll(async () => {
    r = await reviewed();
    finding = durOf(r, r.reviewerAm);
    view = r.w.services.matters.view(r.am);
    issues = r.w.services.runs.issues(r.am, r.runId);
    const watch = <T extends object>(value: T): T => watchReads(value, missing);
    const reviewerChrome = chromeFor(r.reviewerAm.principal);
    runHtml = render(
      RunPage({
        chrome: reviewerChrome,
        matter: watch(view.matter),
        run: watch(r.w.services.runs.get(r.reviewerAm, r.runId)),
        issues: watch(issues),
        selected: watch(finding),
        warnings: watch(view.warnings),
        documents: watch(view.documents),
      }),
    );
    matterHtml = render(
      MatterPage({
        chrome: chromeFor(r.am.principal),
        view: watch(view),
        users: watch(r.w.services.matters.users()),
        canDelete: true,
      }),
    );
    reviewerPane = first(
      checkInvariants(runHtml, { actions: actionsOf(r) }),
      (el) => el.name === "article" && hasClass(el, "finding-pane"),
      "the inspector",
    );
  });

  it("reviews the two documents of PAROL-D05 and finds the duration deviation", () => {
    expect(view.matter.status).toBe("in_review");
    expect(issues).toHaveLength(8);
    expect(finding.issue).toMatchObject({
      ruleKey: "dur-1",
      status: "deviation",
      severity: "high",
      validity: "current",
      verificationState: "verified",
    });
    expect(finding.evidence.map((e) => [e.role, e.quoteCheck])).toEqual([
      ["governing", "verified"],
      ["superseded", "verified"],
      ["supporting", "verified"],
    ]);
  });

  it("renders every page without reading a field the services do not fill", () => {
    // A page that reads `view.something` the service never sets would get undefined, which the
    // types call impossible. Every property read on a view model is recorded, and none was missing.
    const matters = r.w.services.matters;
    const principal = r.am.principal;
    const watch = <T extends object>(value: T): T => watchReads(value, missing);
    const memos = watch(r.w.services.reviews.listMemos(r.am));
    const pages = [
      render(
        MattersPage({
          chrome: chromeFor(principal),
          matters: watch(matters.list(principal)),
          playbooks: watch(matters.playbooks()),
          users: watch(matters.users()),
        }),
      ),
      render(
        FindingPage({
          chrome: chromeFor(principal),
          matterId: r.matterId,
          finding: watch(finding),
          matterName: view.matter.name,
        }),
      ),
      render(
        MemosPage({
          chrome: chromeFor(principal),
          matter: watch(view.matter),
          memos,
          canExport: false,
          exportBlockedReason:
            "Every finding needs a current decision before the memo can be exported.",
        }),
      ),
      render(
        SignInPage({
          chrome: { userName: null, csrfToken: IDS.csrf },
          users: watch(matters.users()),
        }),
      ),
    ];
    for (const html of pages) checkInvariants(html, { actions: actionsOf(r) });
    expect([...missing]).toEqual([]);
  });

  it("shows the matter with its banner, its documents, its run and its token on every form", () => {
    const root = checkInvariants(matterHtml, { actions: actionsOf(r) });
    // The banner is exact and permanent (checkInvariants pins the words); here it is a landmark.
    expect(readable(first(root, (el) => hasClass(el, "demo-banner")))).toMatch(/^DEMO:/);
    const docs = readable(byId(root, "documents")!);
    expect(docs).toContain("Mutual NDA");
    expect(docs).toContain("Amendment No. 1");
    expect(readable(first(root, (el) => hasClass(el, "matter-head")))).toContain("In review");
    expect(
      all(root, (el) => el.name === "a" && attr(el, "href") === urls.run(r.matterId, r.runId)),
    ).not.toHaveLength(0);
    // The associate may not export, so the button is not offered, whatever the matter's state.
    expect(readable(byId(root, "memos")!)).toContain(
      "Only the reviewing attorney can export a memo.",
    );
    expect(formsTo(root, urls.memos(r.matterId))).toHaveLength(0);
    // The destination sentence is the generator's own disclosure.
    expect(readable(byId(root, "start")!)).toContain(r.w.model.generator.disclosure);
  });

  it("shows the issue table with the duration finding selected", () => {
    const root = parseHtml(runHtml);
    const rows = all(root, (el) => el.name === "tr" && hasAttr(el, "data-issue-row"));
    expect(rows).toHaveLength(8);
    const selected = rows.filter((row) => hasClass(row, "is-selected"));
    expect(selected).toHaveLength(1);
    expect(readable(selected[0]!)).toContain("Duration of confidentiality obligations");
    expect(readable(selected[0]!)).toContain("Deviation");
    expect(readable(selected[0]!)).toContain("High");
    // The selected row links to the finding by the id the service gave.
    expect(
      attr(
        first(selected[0]!, (el) => el.name === "a"),
        "href",
      ),
    ).toBe(urls.run(r.matterId, r.runId, finding.issue.findingId));
  });

  it("highlights each quote at the offsets the service gave, in the paragraph as stored", () => {
    for (const evidence of finding.evidence) {
      const article = passageOf(reviewerPane, evidence.evidenceId);
      const paragraph = first(
        article,
        (el) => el.name === "blockquote" && hasClass(el, "doc-text"),
      );
      const mark = first(paragraph, (el) => el.name === "mark" && hasAttr(el, "data-quote"));
      const { before, inside, after } = around(paragraph, mark);
      const { start, end } = evidence.offsets!;
      expect(before + inside + after).toBe(evidence.spanText);
      expect(before).toBe(evidence.spanText.slice(0, start));
      expect(inside).toBe(evidence.spanText.slice(start, end));
      expect(inside).toBe(evidence.quote);
      expect(after).toBe(evidence.spanText.slice(end));
      expect(readable(article)).toContain(evidence.location);
    }
  });

  it("labels the replaced clause superseded and strikes it through", () => {
    const superseded = finding.evidence.find((e) => e.role === "superseded")!;
    expect(superseded.location).toBe("Mutual NDA (v1), Section 6.1, paragraph 19");
    const article = passageOf(reviewerPane, superseded.evidenceId);
    expect(hasClass(article, "is-superseded")).toBe(true);
    expect(readable(article)).toContain("Superseded");
    const mark = first(article, (el) => el.name === "mark");
    expect(
      ancestorsOf(article, mark).some((el) => el.name === "del" && hasClass(el, "superseded-text")),
    ).toBe(true);
    // The governing amendment is not struck through.
    const governing = passageOf(
      reviewerPane,
      finding.evidence.find((e) => e.role === "governing")!.evidenceId,
    );
    expect(all(governing, (el) => el.name === "del")).toHaveLength(0);
  });

  it("offers the reviewer a decision form bound to the finding's hash and carrying the token", () => {
    const form = first(
      reviewerPane,
      (el) => el.name === "form" && hasAttr(el, "data-decision-form"),
    );
    expect(attr(form, "action")).toBe(urls.review(r.matterId, finding.issue.findingId));
    const fields = formFields(form, { set: { decision: "accept" } });
    expect(posted(fields, FIELDS.findingContentSha256)).toBe(finding.contentSha256);
    expect(posted(fields, "_csrf")).toBe(IDS.csrf);
    expect(posted(fields, FIELDS.decision)).toBe("accept");
    // The hash is the one the store checks a decision against, recomputed from the stored record.
    const stored = r.w.repo.getFinding(r.matterId, finding.issue.findingId)!;
    expect(stored.contentSha256).toBe(finding.contentSha256);
    // One select per passage, named so that a route can read it back.
    const roleFields = fields.filter(([name]) => evidenceIdOfRoleField(name) !== null);
    expect(roleFields.map(([name]) => evidenceIdOfRoleField(name))).toEqual(
      finding.evidence.map((e) => e.evidenceId),
    );
    expect(roleFields.map(([, role]) => role)).toEqual(finding.evidence.map((e) => e.role));
  });

  it("offers the associate no form: the service says the reviewing attorney decides", () => {
    const asAssociate = durOf(r, r.am);
    expect(asAssociate.contentSha256).toBe(finding.contentSha256);
    expect(asAssociate.canDecide).toEqual({ allowed: false, reason: CANNOT_DECIDE.role });
    const html = render(
      FindingPage({
        chrome: chromeFor(r.am.principal),
        matterId: r.matterId,
        finding: asAssociate,
        matterName: view.matter.name,
      }),
    );
    const root = checkInvariants(html, { actions: actionsOf(r) });
    expect(all(root, (el) => el.name === "form" && hasAttr(el, "data-decision-form"))).toHaveLength(
      0,
    );
    expect(
      all(root, (el) => el.name === "input" && attr(el, "name") === FIELDS.decision),
    ).toHaveLength(0);
    expect(readable(byId(root, "decision")!)).toContain(CANNOT_DECIDE.role);
  });

  it("agrees with the service about the one sentence both write for a run in flight", () => {
    expect(RUN_ALREADY_ACTIVE).toBe(START_REASONS.runInFlight);
  });
});

describe("a review in flight", () => {
  it("is listed once as the reason a new one cannot start, and its progress is on the page", async () => {
    const hold = gate();
    const w = makeWorld({ model: { ...WORKED_EXAMPLE, before: () => hold.pass() } });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, { workflowLabel: "v2" });
    await hold.reached(1);
    try {
      const view = w.services.matters.view(am);
      expect(view.activeRun?.id).toBe(run.id);
      expect(view.start).toEqual({ ready: false, reasons: [START_REASONS.runInFlight] });
      const html = render(
        MatterPage({
          chrome: chromeFor(am.principal),
          view,
          users: w.services.matters.users(),
          canDelete: true,
        }),
      );
      const root = parseHtml(html);
      // The service already says it; the page must not say it a second time in other words.
      expect(byTag(byId(root, "start-reasons")!, "li").map((li) => readable(li))).toEqual([
        START_REASONS.runInFlight,
      ]);
      const live = first(root, (el) => hasAttr(el, "data-status-url"));
      expect(attr(live, "data-status-url")).toBe(`${urls.run(matterId, run.id)}/status`);
      // The progress the service reports is the shape the status payload and the script read.
      const payload = runStatusPayload(w.services.runs.get(am, run.id));
      expect(payload.finished).toBe(false);
      expect(payload.progress).toMatchObject({ stage: "extract" });
    } finally {
      hold.open();
      await w.services.runs.idle();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// A stale matter
// ---------------------------------------------------------------------------------------------

describe("a matter whose documents changed after the review", () => {
  it("shows no enabled decision form, in the issue table, on the finding page or on the matter", async () => {
    const r = await reviewed();
    const before = durOf(r, r.reviewerAm);
    // The reviewer decides every finding and the memo is exported, so that there are decisions
    // and a memo to go out of date.
    decideEverything(r);
    const memo = await r.w.services.reviews.exportMemo(r.reviewerAm);
    expect(memo.status).toBe("current");

    // The associate corrects a stated date. Nothing else changes, and the results are stale.
    const amendment = r.w.services.matters.view(r.am).documents[1]!;
    r.w.services.matters.setStatedDate(r.am, amendment.versions[0]!.versionId, "2026-09-16");

    const view = r.w.services.matters.view(r.reviewerAm);
    expect(view.matter.status).toBe("stale");
    expect(view.staleReason).toBe(staleReasonPhrase(INPUT_CHANGE_REASONS.statedDateChanged));
    expect(view.currentRun).toBeNull();
    const run = r.w.services.runs.get(r.reviewerAm, r.runId);
    expect(run).toMatchObject({ status: "superseded", current: false });

    const issues = r.w.services.runs.issues(r.reviewerAm, r.runId);
    expect(issues).toHaveLength(8);
    expect(issues.every((i) => i.validity === "stale")).toBe(true);
    const stale = durOf(r, r.reviewerAm);
    expect(stale.canDecide).toEqual({ allowed: false, reason: CANNOT_DECIDE.stale });
    // The finding is unchanged; it is the decision and the right to make one that went stale.
    expect(stale.contentSha256).toBe(before.contentSha256);

    const watched = new Set<string>();
    const chrome = chromeFor(r.reviewerAm.principal);
    const runHtml = render(
      RunPage({
        chrome,
        matter: view.matter,
        run: watchReads(run, watched),
        issues: watchReads(issues, watched),
        selected: watchReads(stale, watched),
        warnings: view.warnings,
        documents: view.documents,
      }),
    );
    const paneHtml = render(
      FindingPage({ chrome, matterId: r.matterId, finding: stale, matterName: view.matter.name }),
    );
    const matterHtml = render(
      MatterPage({ chrome, view: watchReads(view, watched), canDelete: false }),
    );
    expect([...watched]).toEqual([]);

    for (const html of [runHtml, paneHtml, matterHtml]) {
      const root = checkInvariants(html, { actions: actionsOf(r) });
      expect(
        all(root, (el) => el.name === "form" && hasAttr(el, "data-decision-form")),
      ).toHaveLength(0);
      expect(formsTo(root, urls.review(r.matterId, stale.issue.findingId))).toHaveLength(0);
      expect(
        all(root, (el) => el.name === "input" && attr(el, "name") === FIELDS.decision),
      ).toHaveLength(0);
    }
    const root = parseHtml(runHtml);
    const inspector = first(root, (el) => hasClass(el, "finding-pane"));
    expect(readable(inspector)).toContain(STALE_FINDING_REASON);
    // Every row says its decision is out of date, and the one made earlier is kept as history.
    const rows = all(root, (el) => el.name === "tr" && hasAttr(el, "data-issue-row"));
    expect(rows).toHaveLength(8);
    expect(
      rows.every(
        (row) => readable(row).includes("Not decided") || readable(row).includes("Out of date"),
      ),
    ).toBe(true);
    expect(
      readable(first(parseHtml(paneHtml), (el) => el.name === "ol" && hasClass(el, "history"))),
    ).toContain("Out of date");

    // The memo made before is kept on record, and the pages call it superseded. Its download name
    // says so too, so it cannot be mistaken for the memo that replaces it.
    const supersededName = `${memo.fileName.replace(/\.docx$/, "")}-superseded-${memo.memoId.slice(5, 13)}.docx`;
    expect(view.memos).toEqual([{ ...memo, status: "superseded", fileName: supersededName }]);
    const memosHtml = render(
      MemosPage({
        chrome,
        matter: view.matter,
        memos: watchReads(r.w.services.reviews.listMemos(r.reviewerAm), watched),
        canExport: true,
        exportBlockedReason: "The results are out of date. Run the review again first.",
      }),
    );
    const memosRoot = checkInvariants(memosHtml, { actions: actionsOf(r) });
    expect(readable(first(memosRoot, (el) => el.name === "table"))).toContain("Superseded");
    expect(readable(first(memosRoot, (el) => el.name === "table"))).toContain(supersededName);
    expect(readable(first(memosRoot, (el) => el.name === "table"))).toContain(
      memo.fileSha256.slice(0, 12),
    );
    expect(readable(byId(parseHtml(matterHtml), "memos")!)).toContain("Superseded");
    expect([...watched]).toEqual([]);

    // The matter says why, and the export button is there for the reviewer but cannot be pressed.
    const matterRoot = parseHtml(matterHtml);
    expect(readable(first(matterRoot, (el) => hasClass(el, "banner-stale")))).toContain(
      view.staleReason!,
    );
    const exportForm = formsTo(matterRoot, urls.memos(r.matterId));
    expect(exportForm).toHaveLength(1);
    expect(
      hasAttr(
        first(exportForm[0]!, (el) => el.name === "button"),
        "disabled",
      ),
    ).toBe(true);
    expect(readable(byId(matterRoot, "export-reason")!)).toBe(
      "The results are out of date. Run the review again first.",
    );

    // And the service agrees with the page: a decision on the stale finding is refused.
    expect(() =>
      r.w.services.reviews.decide(r.reviewerAm, stale.issue.findingId, {
        decision: "accept",
        findingContentSha256: stale.contentSha256,
        edits: null,
        reason: null,
      }),
    ).toThrow(/stale/);
  });
});

// ---------------------------------------------------------------------------------------------
// Text from a document is data, from the upload to the memo
// ---------------------------------------------------------------------------------------------

const HOSTILE_QUOTE = `<img src=x onerror=alert(1)> & "the Parties" can't`;

describe("document text that looks like markup", () => {
  it("is escaped by the page, highlighted at its offsets, and written into the memo as text", async () => {
    // The amendment's paragraph carries markup, a quotation mark, an ampersand and an apostrophe,
    // and the model quotes it back.
    const original = new TextDecoder().decode(baseWorld.files.find((f) => f.label === "D2")!.bytes);
    const marker = "deleted in its entirety.";
    expect(original).toContain(marker);
    const hostile = original.replace(marker, `${marker} ${HOSTILE_QUOTE} bind us.`);
    const answer = revisedAnswer(baseWorld);
    const governing = answer.evidence[0]!;
    const w = makeWorld({
      model: {
        answers: {
          "dur-1": {
            ...answer,
            evidence: [
              { ...governing, quote: `entirety. ${HOSTILE_QUOTE}` },
              ...answer.evidence.slice(1),
            ],
          },
        },
      },
    });
    const { matterId, am } = newMatter(w);
    const nda = baseWorld.files.find((f) => f.label === "D1")!;
    const amendment = baseWorld.files.find((f) => f.label === "D2")!;
    const documents = baseWorld.documents;
    await w.services.matters.addDocument(am, {
      title: documents[0]!.title,
      kind: "nda",
      fileName: nda.file,
      bytes: nda.bytes,
      statedDate: documents[0]!.statedDate,
    });
    await w.services.matters.addDocument(am, {
      title: documents[1]!.title,
      kind: "amendment",
      fileName: amendment.file,
      bytes: new TextEncoder().encode(hostile),
      statedDate: documents[1]!.statedDate,
    });
    const run = w.services.runs.start(am, { workflowLabel: "v2" });
    await w.services.runs.idle();
    const reviewerAm = w.grant(w.reviewer, matterId);
    const issue = w.services.runs.issues(reviewerAm, run.id).find((i) => i.ruleKey === "dur-1")!;
    const finding = w.services.runs.finding(reviewerAm, issue.findingId);
    const evidence = finding.evidence.find((e) => e.role === "governing")!;
    expect(evidence.quote).toContain("<img");
    expect(evidence.quoteCheck).toBe("verified");

    const html = render(
      FindingPage({
        chrome: chromeFor(reviewerAm.principal),
        matterId,
        finding,
        matterName: "Synthetic",
      }),
    );
    // The strict reader throws on a raw angle bracket in text or an attribute, so a parse is a proof.
    const root = parseHtml(html);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(byTag(root, "img")).toHaveLength(0);
    expect(all(root, (el) => el.attrs.some((a) => a.name.startsWith("on")))).toHaveLength(0);
    const article = passageOf(root, evidence.evidenceId);
    const paragraph = first(article, (el) => el.name === "blockquote");
    const mark = first(paragraph, (el) => el.name === "mark");
    const split = around(paragraph, mark);
    expect(split.inside).toBe(evidence.quote);
    expect(split.before + split.inside + split.after).toBe(evidence.spanText);

    // Through to the memo: decided, exported, and the text is escaped in the Word file as well.
    for (const row of w.services.runs.issues(reviewerAm, run.id)) {
      const view = w.services.runs.finding(reviewerAm, row.findingId);
      const ok =
        view.issue.verificationState === "verified" && view.issue.status !== "undetermined";
      w.services.reviews.decide(reviewerAm, row.findingId, {
        decision: ok ? "accept" : "escalate",
        findingContentSha256: view.contentSha256,
        edits: null,
        reason: ok ? null : "The workflow could not settle this rule.",
      });
    }
    const memo = await w.services.reviews.exportMemo(reviewerAm);
    const file = await w.services.reviews.memoFile(reviewerAm, memo.memoId);
    const zip = await JSZip.loadAsync(file.bytes);
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).not.toContain("<img");
    expect(xml).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(xml).toContain("&amp;");
    // The file name is generated: nothing of the document or the matter is in it.
    expect(file.fileName).toMatch(/^parol-memo-[0-9a-f]+-\d{8}\.docx$/);
  });
});

// ---------------------------------------------------------------------------------------------
// The real shell around the real services
// ---------------------------------------------------------------------------------------------

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const emptyToNull = (value: string | undefined): string | null =>
  value === undefined || value === "" ? null : value;

/**
 * What a route has to make of the decision form. This is the reference for the route of the next
 * phase, kept here because it is what proves that the form, the field names and `DecisionRequest`
 * fit: only what the reviewer changed becomes an edit (so every posted text goes through
 * `normalizeNewlines` first), and only an Edit decision carries edits at all.
 */
function decisionFromForm(
  form: Record<string, string | File>,
  finding: FindingView,
): DecisionRequest {
  const text = (name: string): string | undefined => {
    const value = formString(form, name);
    return value === undefined ? undefined : normalizeNewlines(value);
  };
  const decision = REVIEW_DECISIONS.find((d) => d === text(FIELDS.decision));
  if (decision === undefined) throw new ValidationError("bad_decision", "choose a decision");
  const reason = text(FIELDS.reason);
  let edits: DecisionRequest["edits"] = null;
  if (decision === "edit") {
    const changed: NonNullable<DecisionRequest["edits"]> = {};
    const status = STATUSES.find((s) => s === text(FIELDS.status));
    if (status !== undefined && status !== finding.issue.status) changed.status = status;
    const discrepancy = text(FIELDS.discrepancy);
    if (discrepancy !== undefined && discrepancy !== finding.discrepancy)
      changed.discrepancy = discrepancy;
    const fallback = text(FIELDS.fallbackLanguage);
    if (fallback !== undefined && fallback !== (finding.fallbackLanguage ?? ""))
      changed.fallbackLanguage = fallback;
    const roles: { evidenceId: string; role: EvidenceRole }[] = [];
    for (const name of Object.keys(form)) {
      const evidenceId = evidenceIdOfRoleField(name);
      const role = EVIDENCE_ROLES.find((r) => r === text(name));
      const current = finding.evidence.find((e) => e.evidenceId === evidenceId);
      if (
        evidenceId !== null &&
        role !== undefined &&
        current !== undefined &&
        current.role !== role
      )
        roles.push({ evidenceId, role });
    }
    if (roles.length > 0) changed.evidenceRoles = roles;
    edits = Object.keys(changed).length === 0 ? null : changed;
  }
  // The reason code of an edit or a reject, and the minor-edit box of an edit; the form posts both
  // whatever was chosen, so the others drop them as they drop the edits.
  const posted = text(FIELDS.reasonCode);
  const reasonCode =
    decision === "edit" || decision === "reject"
      ? (REASON_CODES.find((code) => code === posted) ?? null)
      : null;
  return {
    decision,
    findingContentSha256: formString(form, FIELDS.findingContentSha256) ?? "",
    edits,
    reason: reason === undefined || reason.trim() === "" ? null : reason,
    reasonCode,
    minorEdit: decision === "edit" ? text(FIELDS.minorEdit) === MINOR_EDIT_VALUE : null,
  };
}

/**
 * The few routes the tests need, mounted with the real `defineRoute` and `defineMatterRoute` over
 * the real services. They are synthetic: each does the least that lets a page, the shell and a
 * service meet, and none of them is the routes module of the next phase.
 */
function mountSyntheticRoutes(app: Hono, w: World): void {
  const { matters, runs, reviews } = w.services;
  const chromeOf = (c: Context, principal: Principal): Chrome => ({
    userName: principal.displayName,
    csrfToken: csrfToken(c),
  });

  defineRoute(app, {
    method: "GET",
    path: urls.home(),
    access: "public",
    handler: (c) =>
      readPrincipal(c) !== null
        ? c.redirect(urls.matters(), 303)
        : c.html(
            render(
              SignInPage({
                chrome: { userName: null, csrfToken: csrfToken(c) },
                users: matters.users(),
              }),
            ),
          ),
  });
  defineRoute(app, {
    method: "GET",
    path: urls.matters(),
    access: "principal",
    handler: (c, principal) =>
      c.html(
        render(
          MattersPage({
            chrome: chromeOf(c, principal),
            matters: matters.list(principal),
            playbooks: matters.playbooks(),
            users: matters.users(),
          }),
        ),
      ),
  });
  defineRoute(app, {
    method: "POST",
    path: urls.matters(),
    access: "principal",
    handler: async (c, principal) => {
      const form = await readForm(c);
      const created = matters.create(principal, {
        name: formString(form, FIELDS.name) ?? "",
        clientLegalName: formString(form, FIELDS.clientLegalName) ?? "",
        playbookVersionId: emptyToNull(formString(form, FIELDS.playbookVersionId)),
        reviewerUserId: emptyToNull(formString(form, FIELDS.reviewerUserId)),
      });
      return c.redirect(urls.matter(created.id), 303);
    },
  });

  defineMatterRoute(app, {
    method: "GET",
    path: "/matters/:matterId",
    action: "matter.read",
    handler: (c, am) =>
      c.html(
        render(
          MatterPage({
            chrome: chromeOf(c, am.principal),
            view: matters.view(am),
            users: matters.users(),
            canDelete: false,
          }),
        ),
      ),
  });
  defineMatterRoute(app, {
    method: "POST",
    path: "/matters/:matterId/documents",
    action: "document.write",
    handler: async (c, am) => {
      const form = await readForm(c);
      const file = form[FIELDS.file];
      if (!(file instanceof File)) throw new ValidationError("no_file", "choose a file");
      await matters.addDocument(am, {
        title: formString(form, FIELDS.title) ?? "",
        kind: formString(form, FIELDS.kind) === "amendment" ? "amendment" : "nda",
        fileName: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
        statedDate: emptyToNull(formString(form, FIELDS.statedDate)),
      });
      return c.redirect(urls.matter(am.matterId), 303);
    },
  });
  defineMatterRoute(app, {
    method: "POST",
    path: "/matters/:matterId/runs",
    action: "run.start",
    handler: (c, am) => {
      runs.start(am, { workflowLabel: "v2" });
      return c.redirect(urls.matter(am.matterId), 303);
    },
  });
  defineMatterRoute(app, {
    method: "GET",
    path: "/matters/:matterId/runs/:runId",
    action: "run.read",
    handler: (c, am) => {
      const runId = c.req.param("runId") ?? "";
      const view = matters.view(am);
      const issues = runs.issues(am, runId);
      const wanted = c.req.query("finding");
      const chosen = issues.find((i) => i.findingId === wanted);
      return c.html(
        render(
          RunPage({
            chrome: chromeOf(c, am.principal),
            matter: view.matter,
            run: runs.get(am, runId),
            issues,
            selected: chosen === undefined ? null : runs.finding(am, chosen.findingId),
            selectionMissing: wanted !== undefined && chosen === undefined,
            filter: ISSUE_FILTERS.find((f) => f === c.req.query("filter")) ?? "all",
            warnings: view.warnings,
            documents: view.documents,
          }),
        ),
      );
    },
  });
  defineMatterRoute(app, {
    method: "GET",
    path: "/matters/:matterId/runs/:runId/status",
    action: "run.read",
    handler: (c, am) => c.json(runStatusPayload(runs.get(am, c.req.param("runId") ?? ""))),
  });
  defineMatterRoute(app, {
    method: "GET",
    path: "/matters/:matterId/findings/:findingId",
    action: "finding.read",
    handler: (c, am) => {
      const finding = runs.finding(am, c.req.param("findingId") ?? "");
      return c.html(
        render(
          FindingPage({
            chrome: chromeOf(c, am.principal),
            matterId: am.matterId,
            finding,
            matterName: matters.view(am).matter.name,
          }),
        ),
      );
    },
  });
  defineMatterRoute(app, {
    method: "POST",
    path: "/matters/:matterId/findings/:findingId/reviews",
    action: "review.decide",
    handler: async (c, am) => {
      const findingId = c.req.param("findingId") ?? "";
      const form = await readForm(c);
      reviews.decide(am, findingId, decisionFromForm(form, runs.finding(am, findingId)));
      return c.redirect(urls.finding(am.matterId, findingId), 303);
    },
  });
  defineMatterRoute(app, {
    method: "POST",
    path: "/matters/:matterId/memos",
    action: "memo.export",
    handler: async (c, am) => {
      await reviews.exportMemo(am);
      return c.redirect(urls.memos(am.matterId), 303);
    },
  });
  defineMatterRoute(app, {
    method: "GET",
    path: "/matters/:matterId/memos",
    action: "memo.read",
    handler: (c, am) => {
      const view = matters.view(am);
      return c.html(
        render(
          MemosPage({
            chrome: chromeOf(c, am.principal),
            matter: view.matter,
            memos: reviews.listMemos(am),
            canExport: am.role === "reviewer",
            exportBlockedReason:
              view.matter.status === "in_review" ? "Not every finding is decided." : null,
          }),
        ),
      );
    },
  });
  defineMatterRoute(app, {
    method: "GET",
    path: "/matters/:matterId/memos/:memoId/file",
    action: "memo.read",
    handler: async (c, am) => {
      const file = await reviews.memoFile(am, c.req.param("memoId") ?? "");
      return new Response(new Uint8Array(file.bytes), {
        headers: {
          "content-type": DOCX_TYPE,
          "content-disposition": `attachment; filename="${file.fileName}"`,
        },
      });
    },
  });

  // The JSON side, for the refusals that a script would see.
  defineMatterRoute(app, {
    method: "GET",
    path: "/api/matters/:matterId/findings/:findingId",
    action: "finding.read",
    handler: (c, am) => c.json(runs.finding(am, c.req.param("findingId") ?? "")),
  });
  defineMatterRoute(app, {
    method: "POST",
    path: "/api/matters/:matterId/runs",
    action: "run.start",
    handler: (c, am) => c.json(runs.start(am, { workflowLabel: "v2" }), 202),
  });
  defineMatterRoute(app, {
    method: "POST",
    path: "/api/matters/:matterId/memos",
    action: "memo.export",
    handler: async (c, am) => c.json(await reviews.exportMemo(am), 201),
  });
}

interface Web {
  app: Hono;
  logs: string[];
  /** A browser that has signed in as the user, through the real sign-in form. */
  as(userId: string): Promise<Client>;
  anonymous(): Client;
}

function webOver(w: World, options: { relaxed?: boolean } = {}): Web {
  const logs: string[] = [];
  const config: AppConfig = {
    demoIdentity: true,
    cookieSecret: SECRET,
    secureCookies: false,
    maxUploadBytes: 1024 * 1024,
    ...(options.relaxed === true ? { relaxedSegregation: true } : {}),
  };
  const app = createApp(
    { repo: w.repo, services: w.services, config, now: w.deps.now },
    { log: (line) => logs.push(line), renderError: renderErrorPage },
  );
  mountProbes(app);
  mountSyntheticRoutes(app, w);
  // A defect, for the 500 page.
  defineRoute(app, {
    method: "GET",
    path: "/__test/boom",
    access: "public",
    handler: () => {
      throw new TypeError("a defect with a message that must not reach the page");
    },
  });
  return {
    app,
    logs,
    anonymous: () => new Client(app),
    async as(userId) {
      const client = new Client(app);
      const response = await client.post(urls.session(), { intent: "sign-in", userId });
      expect(response.status).toBe(303);
      return client;
    },
  };
}

/** Submits a form of a page the way a browser does, using the token the page itself carried. */
async function submit(
  client: Client,
  page: El,
  action: string,
  options: Parameters<typeof formFields>[1] = {},
): Promise<Response> {
  const form = first(
    page,
    (el) => el.name === "form" && attr(el, "action") === action,
    `form ${action}`,
  );
  return client.send("POST", action, {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: urlEncoded(formFields(form, options, page)),
  });
}

async function pageOf(
  client: Client,
  path: string,
): Promise<{ root: El; html: string; response: Response }> {
  const response = await client.get(path);
  expect(response.status, path).toBe(200);
  const html = await response.text();
  return { root: parseHtml(html), html, response };
}

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

describe("the real shell around the real services", () => {
  let r: Reviewed;
  let web: Web;
  let associate: Client;
  let reviewer: Client;
  let viewer: Client;
  let outsider: Client;
  let finding: FindingView;
  const OUTSIDER = "usr_outsider";

  const decisionPath = (findingId = finding.issue.findingId): string =>
    `/matters/${r.matterId}/findings/${findingId}/reviews`;
  const runPath = (): string => urls.run(r.matterId, r.runId, finding.issue.findingId);
  const reviewsOf = (): FindingView["reviews"] => durOf(r, r.reviewerAm).reviews;
  /** The fields of a decision by hand, as an attacker or a script would send them. */
  const rawDecision = (extra: Record<string, string> = {}): Record<string, string> => ({
    decision: "accept",
    findingContentSha256: finding.contentSha256,
    ...extra,
  });

  beforeAll(async () => {
    r = await reviewed({ model: WITH_NEWLINES });
    finding = durOf(r, r.reviewerAm);
    r.w.services.matters.addMember(r.am, { userId: DEMO_USER_IDS.legalEngineer, role: "viewer" });
    addUser(r.w.repo, OUTSIDER);
    web = webOver(r.w);
    associate = await web.as(DEMO_USER_IDS.associate);
    reviewer = await web.as(DEMO_USER_IDS.reviewer);
    viewer = await web.as(DEMO_USER_IDS.legalEngineer);
    outsider = await web.as(OUTSIDER);
  });

  it("serves the pages with the headers of the shell and the session's token in every form", async () => {
    const { root, html, response } = await pageOf(reviewer, runPath());
    expect(response.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    checkInvariants(html, { actions: actionsOf(r), csrf: await reviewer.token() });
    // The tokens of two sessions differ, so a form of one cannot be posted by the other.
    expect(await reviewer.token()).not.toBe(await associate.token());
    expect(readable(first(root, (el) => hasClass(el, "finding-pane")))).toContain(
      "Duration of confidentiality obligations",
    );
    // The user the page names is the one the session belongs to.
    expect(readable(first(root, (el) => hasClass(el, "whoami")))).toContain(
      r.reviewerAm.principal.displayName,
    );
  });

  it("serves the stylesheet and the script the pages name, as what they are", async () => {
    const { root } = await pageOf(reviewer, urls.matter(r.matterId));
    const css = attr(
      first(root, (el) => el.name === "link"),
      "href",
    )!;
    const js = attr(
      first(root, (el) => el.name === "script"),
      "src",
    )!;
    const style = await reviewer.get(css);
    const script = await reviewer.get(js);
    expect(style.status).toBe(200);
    expect(style.headers.get("content-type")).toMatch(/^text\/css/);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toMatch(/^text\/javascript/);
    for (const asset of [style, script]) {
      expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
      expect(asset.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
    }
    expect(await script.text()).toBe(readFileSync(SCRIPT_PATH, "utf8"));
  });

  it("shows the decision form to the reviewing attorney and to nobody else", async () => {
    const forms = async (client: Client): Promise<number> =>
      all(
        (await pageOf(client, runPath())).root,
        (el) => el.name === "form" && hasAttr(el, "data-decision-form"),
      ).length;
    expect(await forms(reviewer)).toBe(1);
    expect(await forms(associate)).toBe(0);
    expect(await forms(viewer)).toBe(0);
  });

  it("answers with the application's own error pages: the same bytes for a refusal, a reference for a fault", async () => {
    const missing = await reviewer.get("/nothing-here");
    expect(missing.status).toBe(404);
    const root = checkInvariants(await missing.text(), { csrf: "" });
    expect(readable(first(root, (el) => hasClass(el, "error-page")))).toContain("Error 404");

    // A refusal of a member and a 404 for a stranger are pages of the same family, none naming
    // the matter, the finding or the person.
    const refused = await viewer.post(decisionPath(), rawDecision());
    expect(refused.status).toBe(403);
    const refusedHtml = await refused.text();
    checkInvariants(refusedHtml, { csrf: "" });
    expect(refusedHtml).not.toContain(r.matterId);
    expect(refusedHtml).not.toContain(finding.issue.findingId);

    // A defect shows a reference, the one in the header, and nothing of its message.
    const boom = await reviewer.get("/__test/boom");
    expect(boom.status).toBe(500);
    const requestId = boom.headers.get("x-request-id")!;
    const boomHtml = await boom.text();
    expect(readable(checkInvariants(boomHtml, { csrf: "" }))).toContain(`Reference: ${requestId}`);
    expect(boomHtml).not.toContain("must not reach the page");
    // Only a fault carries the reference.
    expect(await (await reviewer.get("/nothing-here")).text()).not.toContain("Reference");
  });

  describe("refuses", () => {
    it("a request with no session: the page sends the visitor to sign in, the API says 401", async () => {
      const anonymous = web.anonymous();
      const page = await anonymous.get(runPath());
      expect(page.status).toBe(303);
      expect(page.headers.get("location")).toBe(urls.home());
      const api = await anonymous.get(
        `/api/matters/${r.matterId}/findings/${finding.issue.findingId}`,
      );
      expect(api.status).toBe(401);
      expect(((await api.json()) as { error: { kind: string } }).error.kind).toBe(
        "unauthenticated",
      );
      // A post with no session does nothing, with or without a token.
      for (const csrf of [true, false] as const) {
        const post = await anonymous.post(decisionPath(), rawDecision(), csrf);
        expect(post.status).toBe(303);
        expect(post.headers.get("location")).toBe(urls.home());
      }
      expect(reviewsOf()).toEqual([]);
    });

    it("a post without the token, or with the token of another session", async () => {
      const without = await reviewer.post(decisionPath(), rawDecision(), false);
      expect(without.status).toBe(403);
      const theirs = await reviewer.post(decisionPath(), rawDecision(), await associate.token());
      expect(theirs.status).toBe(403);
      const forged = await reviewer.post(decisionPath(), rawDecision(), "0".repeat(43));
      expect(forged.status).toBe(403);
      // The same through the JSON header.
      const header = await reviewer.json("POST", `/api/matters/${r.matterId}/runs`, {}, false);
      expect(header.status).toBe(403);
      expect(reviewsOf()).toEqual([]);
    });

    it("a viewer and the associate who prepared the review: 403, and nothing is recorded", async () => {
      for (const client of [viewer, associate]) {
        const response = await client.post(decisionPath(), rawDecision());
        expect(response.status).toBe(403);
        expect(await response.text()).not.toContain(finding.contentSha256);
      }
      expect(reviewsOf()).toEqual([]);
      expect(r.w.services.matters.view(r.reviewerAm).matter.status).toBe("in_review");
    });

    it("a non-member exactly as it refuses a matter that does not exist", async () => {
      const unknown = "mat_0000000000000000";
      const paths = (matterId: string, findingId: string): [string, string, string][] => [
        ["GET", `/matters/${matterId}`, ""],
        ["GET", `/matters/${matterId}/runs/run_0000000000000000`, ""],
        ["GET", `/api/matters/${matterId}/findings/${findingId}`, ""],
        ["POST", `/matters/${matterId}/findings/${findingId}/reviews`, "form"],
        ["POST", `/api/matters/${matterId}/memos`, "json"],
      ];
      const real = paths(r.matterId, finding.issue.findingId);
      const none = paths(unknown, finding.issue.findingId);
      for (const [i, [method, path, kind]] of real.entries()) {
        const send = async (to: string): Promise<Response> =>
          kind === "form"
            ? outsider.post(to, rawDecision())
            : kind === "json"
              ? outsider.json("POST", to, {})
              : outsider.send(method, to);
        const a = await send(path);
        const b = await send(none[i]![1]);
        expect(a.status, path).toBe(404);
        expect(await snapshot(a), path).toEqual(await snapshot(b));
      }
      expect(reviewsOf()).toEqual([]);
    });

    it("a finding of another matter, as a member of this one, as it refuses one that does not exist", async () => {
      // A second matter in the same database, with its own findings, that the reviewer also reviews.
      const other = newMatter(r.w, "Another synthetic NDA");
      await uploadCase(r.w, other.matterId);
      r.w.services.runs.start(other.am, { workflowLabel: "v2" });
      await r.w.services.runs.idle();
      const foreign = r.w.services.runs
        .issues(r.w.grant(r.w.reviewer, other.matterId))
        .find((i) => i.ruleKey === "dur-1")!;
      const a = await reviewer.post(decisionPath(foreign.findingId), rawDecision());
      const b = await reviewer.post(decisionPath("fnd_0000000000000000"), rawDecision());
      expect(a.status).toBe(404);
      expect(await snapshot(a)).toEqual(await snapshot(b));
      expect(
        r.w.services.runs.finding(r.w.grant(r.w.reviewer, other.matterId), foreign.findingId)
          .reviews,
      ).toEqual([]);
    });

    it("a decision on a finding that is not the one the reviewer saw: 409, nothing recorded", async () => {
      const response = await reviewer.post(
        decisionPath(),
        rawDecision({ findingContentSha256: "ab".repeat(32) }),
      );
      expect(response.status).toBe(409);
      expect(reviewsOf()).toEqual([]);
    });
  });

  describe("the reviewing attorney", () => {
    it("decides with the form the page rendered, and the service records what the page said", async () => {
      const { root } = await pageOf(reviewer, runPath());
      const response = await submit(reviewer, root, decisionPath(), {
        set: { decision: "accept" },
      });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(
        urls.finding(r.matterId, finding.issue.findingId),
      );
      const after = durOf(r, r.reviewerAm);
      expect(after.reviews).toEqual([
        expect.objectContaining({
          decision: "accept",
          reviewerName: r.reviewerAm.principal.displayName,
          validity: "current",
          edits: null,
        }),
      ]);
      expect(after.issue.review).toMatchObject({ decision: "accept", validity: "current" });
      // The finding page now says so, and the form says it replaces that decision.
      const next = await pageOf(associate, urls.finding(r.matterId, finding.issue.findingId));
      expect(
        readable(first(next.root, (el) => el.name === "ol" && hasClass(el, "history"))),
      ).toContain("Accepted");
      const again = await pageOf(reviewer, runPath());
      expect(
        readable(
          first(again.root, (el) => el.name === "form" && hasAttr(el, "data-decision-form")),
        ),
      ).toContain("Currently accepted by");
    });

    it("records as an edit only what was changed, though the browser sent every line break as CR LF", async () => {
      const { root } = await pageOf(reviewer, runPath());
      const form = first(root, (el) => el.name === "form" && hasAttr(el, "data-decision-form"));
      const supporting = finding.evidence.find((e) => e.role === "supporting")!;
      const set = {
        decision: "edit",
        reasonCode: "wrong_evidence",
        reason: "The third passage is a definition, not support.",
        [`evidenceRole:${supporting.evidenceId}`]: "definition",
      };
      const fields = formFields(form, { set });
      // The discrepancy goes back as it was shown, with CR LF. Without the normalisation it would
      // differ from the stored text and be recorded as an edit nobody made.
      const sent = posted(fields, FIELDS.discrepancy);
      expect(finding.discrepancy).toContain("\n");
      expect(sent).toContain("\r\n");
      expect(sent).not.toBe(finding.discrepancy);
      expect(normalizeNewlines(sent)).toBe(finding.discrepancy);

      const response = await submit(reviewer, root, decisionPath(), { set });
      expect(response.status).toBe(303);
      const current = durOf(r, r.reviewerAm).reviews.find((x) => x.validity === "current")!;
      expect(current.decision).toBe("edit");
      expect(current.reason).toBe(set.reason);
      expect(current.edits).toEqual({
        evidenceRoles: [{ evidenceId: supporting.evidenceId, role: "definition" }],
      });
      // The earlier decision is kept as history and is no longer the current one.
      expect(durOf(r, r.reviewerAm).reviews.map((x) => [x.decision, x.validity])).toEqual(
        expect.arrayContaining([
          ["accept", "stale"],
          ["edit", "current"],
        ]),
      );
    });

    it("cannot export before every finding is decided: 409 with the findings that block it", async () => {
      const response = await reviewer.json("POST", `/api/matters/${r.matterId}/memos`);
      expect(response.status).toBe(409);
      const body = (await response.json()) as {
        error: { kind: string; blockers: { findingId: string | null; reason: string }[] };
      };
      expect(body.error.kind).toBe("export_blocked");
      expect(body.error.blockers).toHaveLength(7);
      expect(new Set(body.error.blockers.map((b) => b.reason))).toEqual(new Set(["no_review"]));
      const known = new Set(r.w.services.runs.issues(r.reviewerAm).map((i) => i.findingId));
      for (const blocker of body.error.blockers) expect(known.has(blocker.findingId!)).toBe(true);
    });

    it("decides the rest, exports the memo, and the file downloads as what the service stored", async () => {
      const issues = r.w.services.runs.issues(r.reviewerAm);
      for (const issue of issues.filter((i) => i.ruleKey !== "dur-1")) {
        const view = r.w.services.runs.finding(r.reviewerAm, issue.findingId);
        const open = await pageOf(reviewer, urls.finding(r.matterId, issue.findingId));
        const ok =
          view.issue.verificationState === "verified" && view.issue.status !== "undetermined";
        const response = await submit(reviewer, open.root, decisionPath(issue.findingId), {
          set: ok
            ? { decision: "accept" }
            : { decision: "escalate", reason: "The workflow could not settle this rule." },
        });
        expect(response.status, issue.ruleKey).toBe(303);
      }
      expect(r.w.services.matters.view(r.reviewerAm).matter.status).toBe("review_complete");

      // The matter page now offers the export, and the form on it works.
      const matter = await pageOf(reviewer, urls.matter(r.matterId));
      const exportForm = first(
        matter.root,
        (el) => el.name === "form" && attr(el, "action") === urls.memos(r.matterId),
      );
      expect(
        hasAttr(
          first(exportForm, (el) => el.name === "button"),
          "disabled",
        ),
      ).toBe(false);
      const exported = await submit(reviewer, matter.root, urls.memos(r.matterId));
      expect(exported.status).toBe(303);
      expect(exported.headers.get("location")).toBe(urls.memos(r.matterId));

      const list = await pageOf(associate, urls.memos(r.matterId));
      const link = first(list.root, (el) => el.name === "a" && hasAttr(el, "download"));
      const download = await associate.get(attr(link, "href")!);
      expect(download.status).toBe(200);
      expect(download.headers.get("content-type")).toBe(DOCX_TYPE);
      expect(download.headers.get("x-content-type-options")).toBe("nosniff");
      expect(download.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
      const memo = r.w.services.reviews.listMemos(r.am)[0]!;
      expect(download.headers.get("content-disposition")).toBe(
        `attachment; filename="${memo.fileName}"`,
      );
      const bytes = new Uint8Array(await download.arrayBuffer());
      expect(sha256Hex(bytes)).toBe(memo.fileSha256);
      const zip = await JSZip.loadAsync(bytes);
      expect(await zip.file("word/document.xml")!.async("string")).toContain(
        "Lanternfish Software, Inc.",
      );
      // A viewer may read the memo list, and a stranger to the matter gets the 404 of any other path.
      expect((await viewer.get(urls.memos(r.matterId))).status).toBe(200);
      expect((await outsider.get(urls.memos(r.matterId))).status).toBe(404);
      expect((await outsider.get(attr(link, "href")!)).status).toBe(404);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// A person at a browser, from the sign-in page to a review in progress
// ---------------------------------------------------------------------------------------------

describe("a journey through the forms of the pages", () => {
  const hold = gate();
  let w: World;
  let web: Web;
  let associate: Client;
  let matterId = "";
  let runStatusUrl = "";

  beforeAll(() => {
    // The model is held at its first call, so the review can be watched while it is in flight.
    w = makeWorld({ model: { ...WORKED_EXAMPLE, before: () => hold.pass() } });
    web = webOver(w);
    associate = web.anonymous();
  });
  afterAll(async () => {
    hold.open();
    await w.services.runs.idle();
  });

  it("signs in by pressing the name of a demo identity on the page", async () => {
    const home = await pageOf(associate, urls.home());
    checkInvariants(home.html, {
      actions: new Set([urls.session()]),
      csrf: await associate.token(),
    });
    // One button per demo user, each with its own user id: nothing else says who signs in.
    const buttons = all(
      home.root,
      (el) => el.name === "button" && attr(el, "name") === FIELDS.userId,
    );
    expect(buttons.map((b) => attr(b, "value")).sort()).toEqual(
      Object.values(DEMO_USER_IDS).sort(),
    );
    const response = await submit(associate, home.root, urls.session(), {
      submitter: { name: FIELDS.userId, value: DEMO_USER_IDS.associate },
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(urls.matters());
    expect(await associate.whoami()).toMatchObject({ userId: DEMO_USER_IDS.associate });
    const cookie = parseSetCookies(response).find((c) => c.name.includes("session"));
    expect(cookie?.attributes.get("httponly")).toBe(true);
    expect(cookie?.attributes.get("samesite")).toBe("Strict");
  });

  it("creates a matter with the new-matter form, naming the reviewer and the playbook", async () => {
    const list = await pageOf(associate, urls.matters());
    expect(readable(byId(list.root, "matter-list")!)).toContain("You have no matters yet");
    const playbook = w.services.matters.playbooks()[0]!;
    const response = await submit(associate, list.root, urls.matters(), {
      set: {
        [FIELDS.name]: "Lanternfish / Corvane NDA",
        [FIELDS.clientLegalName]: baseWorld.manifest.clientLegalName,
        [FIELDS.reviewerUserId]: DEMO_USER_IDS.reviewer,
        [FIELDS.playbookVersionId]: playbook.versionId,
      },
    });
    expect(response.status).toBe(303);
    const location = response.headers.get("location")!;
    expect(location).toMatch(/^\/matters\/mat_[0-9a-f]+$/);
    matterId = location.slice("/matters/".length);
    const am = w.grant(w.principal(DEMO_USER_IDS.associate), matterId);
    const view = w.services.matters.view(am);
    expect(view.members.map((m) => [m.userId, m.role])).toEqual([
      [DEMO_USER_IDS.associate, "associate"],
      [DEMO_USER_IDS.reviewer, "reviewer"],
    ]);
    expect(view.matter.playbook).toEqual({ slug: playbook.slug, version: playbook.version });
    expect(view.start.reasons).toEqual([START_REASONS.noNda]);
    // The list now shows it.
    expect(
      readable(byId((await pageOf(associate, urls.matters())).root, "matter-list")!),
    ).toContain("Lanternfish / Corvane NDA");
  });

  it("uploads the two documents with the add-document form, as multipart with the token", async () => {
    for (const file of baseWorld.files) {
      const document = baseWorld.documents.find((d) => d.label === file.label)!;
      const open = await pageOf(associate, urls.matter(matterId));
      const form = first(
        open.root,
        (el) => el.name === "form" && attr(el, "action") === urls.documents(matterId),
        "the add-document form",
      );
      expect(attr(form, "enctype")).toBe("multipart/form-data");
      const body = new FormData();
      for (const [name, value] of formFields(form, {
        set: {
          [FIELDS.title]: document.title,
          [FIELDS.kind]: document.kind,
          [FIELDS.statedDate]: document.statedDate ?? "",
        },
      }))
        body.set(name, value);
      body.set(FIELDS.file, new File([new Uint8Array(file.bytes)], file.file));
      const response = await associate.send("POST", urls.documents(matterId), { body });
      expect(response.status, file.file).toBe(303);
    }
    const view = w.services.matters.view(w.grant(w.principal(DEMO_USER_IDS.associate), matterId));
    expect(view.documents.map((d) => [d.label, d.kind, d.title])).toEqual([
      ["D1", "nda", "Mutual NDA"],
      ["D2", "amendment", "Amendment No. 1"],
    ]);
    expect(view.matter.status).toBe("ready");
    expect(view.start).toEqual({ ready: true, reasons: [] });
    // The page agrees: the start button works.
    const page = await pageOf(associate, urls.matter(matterId));
    const start = first(
      page.root,
      (el) => el.name === "form" && attr(el, "action") === urls.runs(matterId),
    );
    expect(
      hasAttr(
        first(start, (el) => el.name === "button"),
        "disabled",
      ),
    ).toBe(false);
  });

  it("starts the review with the start form and watches it with the script, as the page names it", async () => {
    const open = await pageOf(associate, urls.matter(matterId));
    const response = await submit(associate, open.root, urls.runs(matterId));
    expect(response.status).toBe(303);
    await hold.reached(1);

    const page = await pageOf(associate, urls.matter(matterId));
    const live = first(page.root, (el) => hasAttr(el, "data-status-url"));
    runStatusUrl = attr(live, "data-status-url")!;
    const answer = await associate.get(runStatusUrl);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toMatch(/^application\/json/);
    const payload = (await answer.json()) as ReturnType<typeof runStatusPayload>;
    expect(payload).toMatchObject({
      status: "extracting",
      label: labels.progressStageLabel("extract"),
      finished: false,
      progress: { stage: "extract", done: 0, total: 1 },
    });

    // The script, run over the page, asks for that URL and puts the route's answer on the page.
    const h = runScript(page.html);
    h.respondWith(() => Promise.resolve({ ok: true, json: () => Promise.resolve(payload) }));
    await h.advance(2000);
    expect(h.fetchCalls.map((c) => c.url)).toEqual([runStatusUrl]);
    const text = (role: string): string =>
      h.doc.querySelector(`[data-role="${role}"]`)!.textContent;
    expect(text("stage")).toBe(payload.label);
    expect(text("done")).toBe("0");
    expect(text("total")).toBe("1");

    // Other members may read the progress; a stranger to the matter may not.
    const outsider = await web.as(DEMO_USER_IDS.admin);
    expect((await outsider.get(runStatusUrl)).status).toBe(404);
    expect((await web.anonymous().get(runStatusUrl)).status).toBe(303);
  });

  it("reloads the page when the route says the review is finished, and then shows the findings", async () => {
    hold.open();
    await w.services.runs.idle();
    const answer = await associate.get(runStatusUrl);
    const payload = (await answer.json()) as ReturnType<typeof runStatusPayload>;
    expect(payload).toMatchObject({ status: "succeeded", finished: true });

    const stale = await pageOf(associate, urls.matter(matterId));
    // The page now says the review is done, so there is no longer a status URL to poll.
    expect(all(stale.root, (el) => hasAttr(el, "data-status-url"))).toHaveLength(0);
    const h = runScript(
      render(
        MatterPage({
          chrome: { userName: "x", csrfToken: IDS.csrf },
          view: {
            ...w.services.matters.view(w.grant(w.principal(DEMO_USER_IDS.associate), matterId)),
            activeRun: w.services.runs.get(
              w.grant(w.principal(DEMO_USER_IDS.associate), matterId),
              runStatusUrl.split("/")[4]!,
            ),
          },
          canDelete: false,
        }),
      ),
    );
    h.respondWith(() => Promise.resolve({ ok: true, json: () => Promise.resolve(payload) }));
    await h.advance(2000);
    expect(h.reloads).toBe(1);

    const run = w.services.matters.view(
      w.grant(w.principal(DEMO_USER_IDS.associate), matterId),
    ).currentRun!;
    const table = await pageOf(associate, urls.run(matterId, run.id));
    expect(all(table.root, (el) => el.name === "tr" && hasAttr(el, "data-issue-row"))).toHaveLength(
      8,
    );
  });

  it("signs out with the form in the page header, and the session is gone", async () => {
    const page = await pageOf(associate, urls.matters());
    const response = await submit(associate, page.root, urls.session(), {});
    // Two forms post to the session URL on this page: only the header's sign-out form exists.
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(urls.home());
    expect(await associate.whoami()).toMatchObject({ userId: null });
    expect((await associate.get(urls.matters())).status).toBe(303);
  });
});

// ---------------------------------------------------------------------------------------------
// What the services throw, as the shell answers it
// ---------------------------------------------------------------------------------------------

describe("the errors of the services, through the shell", () => {
  it("answers a second start while one runs with 409 and the id of the run in flight", async () => {
    const hold = gate();
    const w = makeWorld({ model: { ...WORKED_EXAMPLE, before: () => hold.pass() } });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const web = webOver(w);
    const client = await web.as(DEMO_USER_IDS.associate);
    try {
      const first = await client.json("POST", `/api/matters/${matterId}/runs`);
      expect(first.status).toBe(202);
      const started = (await first.json()) as { id: string; status: string };
      expect(started.status).toBe("queued");
      await hold.reached(1);
      const second = await client.json("POST", `/api/matters/${matterId}/runs`);
      expect(second.status).toBe(409);
      expect(await second.json()).toEqual({
        error: {
          kind: "active_run",
          message: "The matter already has a run in progress.",
          code: "active_run",
          activeRunId: started.id,
        },
      });
      // The same on the page route comes back as a page and not as JSON.
      const page = await client.post(`/matters/${matterId}/runs`);
      expect(page.status).toBe(409);
      expect(page.headers.get("content-type")).toMatch(/^text\/html/);
      expect(am.matterId).toBe(matterId);
    } finally {
      hold.open();
      await w.services.runs.idle();
    }
  });

  it("answers a start with nothing uploaded with 409 and the reasons the service gives", async () => {
    const w = makeWorld();
    const { matterId } = newMatter(w);
    const client = await webOver(w).as(DEMO_USER_IDS.associate);
    const response = await client.json("POST", `/api/matters/${matterId}/runs`);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        kind: "not_ready",
        message: "The matter is not ready for a review.",
        code: "not_ready",
        reasons: [START_REASONS.noNda],
      },
    });
  });

  it("answers a file that is not a document with 422, in words that do not repeat its name", async () => {
    const w = makeWorld();
    const { matterId } = newMatter(w);
    const client = await webOver(w).as(DEMO_USER_IDS.associate);
    const send = async (name: string, bytes: Uint8Array): Promise<Response> => {
      const body = new FormData();
      body.set("_csrf", await client.token());
      body.set(FIELDS.title, "Mutual NDA");
      body.set(FIELDS.kind, "nda");
      body.set(FIELDS.file, new File([new Uint8Array(bytes)], name));
      return client.send("POST", urls.documents(matterId), { body });
    };
    const fake = await send("secret-client-name.docx", new TextEncoder().encode("not a zip"));
    expect(fake.status).toBe(422);
    expect(await fake.text()).not.toContain("secret-client-name");
    const wrongType = await send("notes.pdf", new Uint8Array([1, 2, 3]));
    expect(wrongType.status).toBe(422);
    expect(w.services.matters.view(w.grant(w.associate, matterId)).documents).toEqual([]);
  });

  it("answers a memo that is not this matter's with the 404 of any missing page", async () => {
    const r = await reviewed();
    const client = await webOver(r.w).as(DEMO_USER_IDS.associate);
    const a = await client.get(`/matters/${r.matterId}/memos/memo_0000000000000000/file`);
    expect(a.status).toBe(404);
    const b = await client.get(`/matters/${r.matterId}/nothing-here`);
    expect(b.status).toBe(404);
  });
});

describe("a single-person demonstration", () => {
  it("lets the associate decide in the page and through the route, when both are told so", async () => {
    const r = await reviewed({ config: { relaxedSegregation: true } });
    const finding = durOf(r, r.am);
    // The service, the page's view of it and the route table all say the associate may decide.
    expect(finding.canDecide).toEqual({ allowed: true, reason: null });
    expect(r.w.services.matters.view(r.am).segregationRelaxed).toBe(true);
    const web = webOver(r.w, { relaxed: true });
    const associate = await web.as(DEMO_USER_IDS.associate);
    const path = urls.run(r.matterId, r.runId, finding.issue.findingId);
    const { root } = await pageOf(associate, path);
    expect(all(root, (el) => el.name === "form" && hasAttr(el, "data-decision-form"))).toHaveLength(
      1,
    );
    const response = await submit(
      associate,
      root,
      urls.review(r.matterId, finding.issue.findingId),
      { set: { decision: "accept" } },
    );
    expect(response.status).toBe(303);
    expect(durOf(r, r.am).reviews).toHaveLength(1);

    // A shell that does not know the mode refuses the same post, though the service would allow it.
    const strict = await webOver(r.w).as(DEMO_USER_IDS.associate);
    const refused = await strict.post(urls.review(r.matterId, finding.issue.findingId), {
      decision: "accept",
      findingContentSha256: finding.contentSha256,
    });
    expect(refused.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------------------------
// The words of the services are the words of the pages
// ---------------------------------------------------------------------------------------------

interface Observed {
  caseKey: string;
  r: Reviewed;
  view: MatterView;
  issues: IssueRow[];
  findings: FindingView[];
}

/** The dev case, or a variation on the base case, uploaded and reviewed through the real services. */
async function reviewCase(
  caseKey: string,
  twin: boolean,
  options: {
    model?: ModelOptions;
    support?: boolean;
    name?: string;
    /** Changes the bytes of a file before it is uploaded. */
    edit?: (label: string, bytes: Uint8Array) => Uint8Array;
  } = {},
): Promise<Observed> {
  const built = await buildCaseWorld(caseKey, { twin });
  const world =
    options.edit === undefined
      ? built
      : {
          ...built,
          files: built.files.map((f) => ({ ...f, bytes: options.edit!(f.label, f.bytes) })),
        };
  const w = makeWorld({ model: { world, ...options.model } });
  if (options.support === true) {
    const manifest = {
      ...WORKFLOWS["v2"]!.manifest,
      label: "v3-support",
      prompts: { extract: "extract.p1", analyze: "analyze.p1", support: "support.p1" },
    };
    w.repo.upsertWorkflowVersion({ manifest, sha256: hashOf(manifest) });
  }
  const summary = w.services.matters.create(w.associate, {
    name: `Synthetic ${caseKey}`,
    clientLegalName: world.manifest.clientLegalName,
    playbookVersionId: w.playbookVersionId,
    reviewerUserId: w.reviewer.userId,
  });
  const am = w.grant(w.associate, summary.id);
  await uploadCase(w, summary.id, world);
  const started = w.services.runs.start(am, {
    workflowLabel: options.support === true ? "v3-support" : "v2",
  });
  await w.services.runs.idle();
  const reviewerAm = w.grant(w.reviewer, summary.id);
  const issues = w.services.runs.issues(reviewerAm, started.id);
  return {
    caseKey: options.name ?? (twin ? `${caseKey}-twin` : caseKey),
    r: { w, matterId: summary.id, runId: started.id, am, reviewerAm },
    view: w.services.matters.view(am),
    issues,
    findings: issues.map((i) => w.services.runs.finding(reviewerAm, i.findingId)),
  };
}

/**
 * Answers that make the oracle model produce what the dataset does not: a quote that is not in
 * the paragraph, one that is in it twice, a passage labelled as a definition, and suggested
 * wording that is the playbook's own, adapted, or the model's.
 */
const QUOTE_VARIETY: ModelOptions = {
  answers: (() => {
    const answer = revisedAnswer(baseWorld);
    const [governing, superseded, supporting] = answer.evidence as [
      (typeof answer.evidence)[number],
      (typeof answer.evidence)[number],
      (typeof answer.evidence)[number],
    ];
    return {
      "dur-1": {
        ...answer,
        evidence: [
          { ...governing, quote: "is deleted in its entirety" },
          { ...superseded, quote: "words that are nowhere in this paragraph" },
          { ...supporting, role: "definition" as const },
        ],
        fallbackLanguage:
          "The obligations of each Receiving Party under this Agreement shall continue for three (3) years from the date of each disclosure of Confidential Information, except that obligations with respect to any trade secret shall continue for so long as it remains a trade secret under applicable law.",
      },
    };
  })(),
};
/** The amendment says its one sentence twice, so a quote of it occurs twice in the paragraph. */
const SAYS_IT_TWICE = (label: string, bytes: Uint8Array): Uint8Array => {
  if (label !== "D2") return bytes;
  const text = new TextDecoder().decode(bytes);
  const sentence = "Section 6.1 of the Agreement is deleted in its entirety.";
  expect(text).toContain(sentence);
  return new TextEncoder().encode(text.replace(sentence, `${sentence} ${sentence}`));
};
const GENERATED_FALLBACK: ModelOptions = {
  answers: {
    "dur-1": {
      ...revisedAnswer(baseWorld),
      fallbackLanguage: "Each party keeps the information secret for as long as it likes.",
    },
  },
};

/** The phrases a label function falls back to for a code it does not know, one word or more. */
const NO_WORDING = [
  labels.statusLabel("§"),
  labels.statusMeaning("§"),
  labels.severityLabel("§"),
  labels.categoryLabel("§"),
  labels.roleLabel("§"),
  labels.roleMeaning("§"),
  labels.escalationLabel("§"),
  labels.escalationMeaning("§"),
  labels.quoteCheckLabel("§"),
  labels.quoteCheckMeaning("§"),
  labels.supportCheckLabel("§"),
  labels.supportCheckMeaning("§"),
  labels.fallbackBasisLabel("§"),
  labels.checkLabel("§"),
  labels.checkOutcomeLabel("§"),
  labels.warningMeaning("§"),
  labels.runStatusMeaning("§"),
  labels.matterStatusMeaning("§"),
  labels.runErrorMeaning("§"),
];

describe("the words of the services are the words of the pages", () => {
  let observed: Observed[] = [];

  beforeAll(async () => {
    const { keys } = await loadFixtures();
    for (const key of keys.cases.filter((c) => c.split === "dev"))
      // A case with an injected paragraph has a twin, which is reviewed beside it.
      for (const twin of keys.twins.some((t) => t.twinOf === key.case) ? [false, true] : [false])
        observed.push(await reviewCase(key.case, twin));
    // The rest of the vocabulary: what the dataset's oracle never says.
    observed.push(
      await reviewCase("PAROL-D05", false, {
        name: "variety-quotes",
        model: QUOTE_VARIETY,
        edit: SAYS_IT_TWICE,
      }),
      await reviewCase("PAROL-D05", false, {
        name: "variety-generated",
        model: GENERATED_FALLBACK,
      }),
      await reviewCase("PAROL-D05", false, { name: "variety-supported", support: true }),
      await reviewCase("PAROL-D05", false, {
        name: "variety-unsupported",
        support: true,
        model: { supportVerdict: "not_supported" },
      }),
      await reviewCase("PAROL-D05", false, {
        name: "variety-insufficient",
        support: true,
        model: { supportVerdict: "insufficient" },
      }),
    );
  }, 180_000);

  const every = <T>(pick: (o: Observed) => T[]): T[] => observed.flatMap(pick);
  const known = (table: object, values: readonly unknown[], what: string): void => {
    for (const value of new Set(values))
      expect(Object.hasOwn(table, String(value)), `${what}: ${String(value)}`).toBe(true);
  };

  it("reviews every case of the dev split through the services", () => {
    expect(observed.slice(0, 16).map((o) => o.caseKey)).toEqual([
      "PAROL-D01",
      "PAROL-D02",
      "PAROL-D03",
      "PAROL-D04",
      "PAROL-D05",
      "PAROL-D06",
      "PAROL-D07",
      "PAROL-D08",
      "PAROL-D08-twin",
      "PAROL-D09",
      "PAROL-D10",
      "PAROL-D10-twin",
      "PAROL-D11",
      "PAROL-D12",
      "PAROL-D13",
      "PAROL-D14",
    ]);
    for (const o of observed) expect(o.issues, o.caseKey).toHaveLength(8);
  });

  it("gives a label to every code the services emitted for the findings", () => {
    const issues = every((o) => o.issues);
    const findings = every((o) => o.findings);
    known(
      labels.STATUS_LABEL,
      issues.map((i) => i.status),
      "status",
    );
    known(
      labels.SEVERITY_LABEL,
      issues.map((i) => i.severity),
      "severity",
    );
    known(
      labels.CATEGORY_LABEL,
      issues.map((i) => i.category),
      "category",
    );
    known(
      labels.ESCALATION_LABEL,
      issues.flatMap((i) => i.escalations.map((e) => e.code)),
      "escalation",
    );
    known(
      labels.ESCALATION_MEANING,
      issues.flatMap((i) => i.escalations.map((e) => e.code)),
      "escalation",
    );
    const evidence = findings.flatMap((f) => f.evidence);
    known(
      labels.ROLE_LABEL,
      evidence.map((e) => e.role),
      "evidence role",
    );
    known(
      labels.ROLE_MEANING,
      evidence.map((e) => e.role),
      "evidence role",
    );
    known(
      labels.QUOTE_CHECK_LABEL,
      evidence.map((e) => e.quoteCheck),
      "quote check",
    );
    known(
      labels.SUPPORT_CHECK_LABEL,
      evidence.map((e) => e.supportCheck),
      "support check",
    );
    known(
      labels.FALLBACK_BASIS_LABEL,
      findings.map((f) => f.fallbackBasis),
      "fallback basis",
    );
    const checks = findings.flatMap((f) => f.checks);
    known(
      labels.CHECK_LABEL,
      checks.map((c) => c.id),
      "check",
    );
    known(
      labels.CHECK_KIND_LABEL,
      checks.map((c) => c.kind),
      "check kind",
    );
    known(
      labels.CHECK_OUTCOME_LABEL,
      checks.map((c) => c.outcome),
      "check outcome",
    );
    for (const check of checks) expect(CHECK_IDS).toContain(check.id);
  });

  it("gives a label to every code the services emitted for the matters and the runs", () => {
    const views = every((o) => [o.view]);
    known(
      labels.MATTER_STATUS_LABEL,
      views.map((v) => v.matter.status),
      "matter status",
    );
    known(
      labels.MATTER_ROLE_LABEL,
      views.flatMap((v) => [v.matter.role, ...v.members.map((m) => m.role)]),
      "role",
    );
    known(
      labels.DOCUMENT_KIND_LABEL,
      views.flatMap((v) => v.documents.map((d) => d.kind)),
      "kind",
    );
    known(
      labels.RUN_STATUS_LABEL,
      views.flatMap((v) => v.runs.map((run) => run.status)),
      "run status",
    );
    known(
      labels.WARNING_LABEL,
      views.flatMap((v) => v.warnings.map((x) => x.code)),
      "warning",
    );
    known(
      labels.WARNING_MEANING,
      views.flatMap((v) => v.warnings.map((x) => x.code)),
      "warning",
    );
    const users = observed[0]!.r.w.services.matters.users();
    known(
      labels.GLOBAL_ROLE_LABEL,
      users.map((u) => u.globalRole),
      "global role",
    );
  });

  it("gives, for every case, the findings of the reference pipeline the evaluation harness measures", async () => {
    // The services run the stages in their own runner, over what the store holds. The evaluation
    // harness (and test/integration/pipeline.ts, which stands for it) runs the same stages in the
    // same order over the same documents. If the two ever differ, what is measured is not what
    // ships, so every field of every finding is compared, rule by rule.
    for (const o of observed.slice(0, 7)) {
      const twin = o.caseKey.endsWith("-twin");
      const world = await buildCaseWorld(o.caseKey.replace(/-twin$/, ""), { twin });
      const reference = await runWorkflow(world, { policy: "R2", checks: ["C1"] });
      // The reference names versions dv_d1, dv_d2; the store gave its own.
      const versionOf = new Map(
        o.view.documents.map((d) => [versionIdOf(d.label), d.versions[0]!.versionId]),
      );
      const spanOf = (spanId: string): string => {
        const [version, paragraph] = spanId.split(":") as [string, string];
        return `${versionOf.get(version) ?? version}:${paragraph}`;
      };
      expect(
        o.findings.map((f) => f.issue.ruleKey),
        o.caseKey,
      ).toEqual(world.playbook.rules.map((r) => r.key));
      for (const view of o.findings) {
        const ref = reference.results.get(view.issue.ruleKey)!.finding;
        const where = `${o.caseKey} ${ref.ruleKey}`;
        expect(view.issue.status, where).toBe(ref.status);
        expect(view.issue.verificationState, where).toBe(ref.verificationState);
        expect(view.issue.severity, where).toBe(ref.severity);
        expect(view.issue.escalations, where).toEqual(ref.escalations);
        expect(view.discrepancy, where).toBe(ref.discrepancy);
        expect(view.explanation, where).toBe(ref.explanation);
        expect(view.fallbackLanguage, where).toBe(ref.fallbackLanguage);
        expect(view.fallbackBasis, where).toBe(ref.fallbackBasis);
        expect(view.conflict, where).toBe(ref.conflict);
        expect(view.abstainReason, where).toBe(ref.abstainReason);
        expect(view.checks, where).toEqual(ref.checks);
        expect(
          view.evidence.map((e) => [
            e.spanId,
            e.quote,
            e.role,
            e.quoteCheck,
            e.supportCheck,
            e.offsets,
          ]),
          where,
        ).toEqual(
          ref.evidence.map((e) => [
            spanOf(e.spanId),
            e.quote,
            e.role,
            e.quoteCheck,
            e.supportCheck,
            e.offsets,
          ]),
        );
      }
    }
  });

  it("emitted enough kinds of finding that the checks above say something", () => {
    // The dataset's oracle and the variations on it between them exercise most of the vocabulary:
    // a floor, so that a change to the scripted model cannot quietly empty these checks.
    const issues = every((o) => o.issues);
    const evidence = every((o) => o.findings.flatMap((f) => f.evidence));
    const has = (values: Iterable<string>, ...wanted: string[]): void => {
      const got = new Set(values);
      for (const value of wanted) expect(got.has(value), value).toBe(true);
    };
    has(
      issues.map((i) => i.status),
      ...STATUSES,
    );
    has(
      issues.flatMap((i) => i.escalations.map((e) => e.code)),
      "conflicting_sources",
      "parties_mismatch",
      "playbook_escalation",
      "model_abstained",
      "quote_not_verified",
      "support_not_confirmed",
    );
    has(
      evidence.map((e) => e.role),
      "governing",
      "supporting",
      "superseded",
      "conflicting",
      "definition",
    );
    has(
      evidence.map((e) => e.quoteCheck),
      "verified",
      "not_found",
      "ambiguous",
    );
    has(
      evidence.map((e) => e.supportCheck),
      "not_run",
      "supported",
      "not_supported",
      "insufficient",
    );
    has(
      every((o) => o.findings.map((f) => f.fallbackBasis)),
      "none",
      "approved_verbatim",
      "generated",
    );
    has(
      every((o) => o.findings.flatMap((f) => f.checks.map((c) => c.id))),
      "support",
      "quote_exists",
    );
    has(
      every((o) => o.view.warnings.map((x) => x.code)),
      "instruction_like_text",
    );
  });

  it("renders every finding and every matter of the split with words for all of it", () => {
    for (const o of observed) {
      const watched = new Set<string>();
      const watch = <T extends object>(value: T): T => watchReads(value, watched);
      const actions = actionsOf(o.r);
      const chrome = chromeFor(o.r.reviewerAm.principal);
      const pages = [
        render(MatterPage({ chrome, view: watch(o.view), canDelete: false })),
        ...o.findings.map((finding) =>
          render(
            FindingPage({
              chrome,
              matterId: o.r.matterId,
              finding: watch(finding),
              matterName: o.view.matter.name,
            }),
          ),
        ),
        render(
          RunPage({
            chrome,
            matter: watch(o.view.matter),
            run: watch(o.view.currentRun!),
            issues: watch(o.issues),
            selected: watch(o.findings[0]!),
            warnings: watch(o.view.warnings),
            documents: watch(o.view.documents),
          }),
        ),
      ];
      for (const html of pages) {
        checkInvariants(html, { actions });
        for (const phrase of NO_WORDING)
          expect(html, `${o.caseKey}: the page fell back to "${phrase}"`).not.toContain(phrase);
      }
      expect([...watched], o.caseKey).toEqual([]);
    }
  });

  it("has wording for every way a run can end, and for every reason results can go stale", () => {
    // The same set, not a superset: wording for a kind nothing sets is wording nobody reads.
    expect(Object.keys(labels.RUN_ERROR_MEANING).sort()).toEqual([...RUN_ERROR_KINDS].sort());
    for (const reason of Object.values(INPUT_CHANGE_REASONS))
      expect(staleReasonPhrase(reason), `stale reason ${reason}`).not.toBe(staleReasonPhrase(null));
    // The sentence for a code nobody listed is the one general sentence and not an echo of the code.
    expect(staleReasonPhrase("an_unlisted_code")).toBe(staleReasonPhrase(null));
  });

  it.each([
    ["a rejected key", 401, "provider_auth"],
    ["a key that may not do this", 403, "provider_permission"],
    ["a model that is not there", 404, "provider_model"],
    ["an empty balance", 402, "provider_billing"],
  ])("tells the reader what to do when the provider gives %s", async (_name, status, kind) => {
    const w = makeWorld({
      model: {
        before: (call) => {
          if (call.kind === "extract") throw new ModelRequestError("words of the provider", status);
        },
      },
    });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, { workflowLabel: "v2" });
    await w.services.runs.idle();
    const failed = w.services.runs.get(am, run.id);
    expect(failed).toMatchObject({ status: "failed", errorKind: kind });
    const view = w.services.matters.view(am);
    const html = render(
      RunPage({
        chrome: chromeFor(am.principal),
        matter: view.matter,
        run: failed,
        issues: w.services.runs.issues(am, run.id),
        selected: null,
      }),
    );
    const root = checkInvariants(html, { actions: actionsOf({ w, am, matterId }) });
    const banner = first(root, (el) => hasClass(el, "banner-failed"));
    expect(readable(banner)).toContain(labels.runErrorMeaning(kind));
    expect(labels.RUN_ERROR_MEANING).toHaveProperty(kind);
    expect(html).not.toContain("words of the provider");
    // The matter page offers the resume that the banner points to.
    const matter = render(MatterPage({ chrome: chromeFor(am.principal), view, canDelete: false }));
    expect(formsTo(parseHtml(matter), urls.runResume(matterId, run.id))).toHaveLength(1);
  });

  it("is told about a restart the same way the script is told a run is over", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");
    const terminal = /var TERMINAL = \/(.*)\/;/.exec(script)?.[1];
    expect(terminal).toBeDefined();
    const pattern = new RegExp(terminal!);
    for (const status of RUN_STATUSES)
      expect(pattern.test(status), status).toBe(!labels.isActiveRun(status));
  });
});

// ---------------------------------------------------------------------------------------------
// The content security policy and what the pages use
// ---------------------------------------------------------------------------------------------

describe("the content security policy", () => {
  const policy = parseCsp(CONTENT_SECURITY_POLICY);
  const css = readFileSync(join(SCRIPT_PATH, "..", "parol.css"), "utf8");
  const js = readFileSync(SCRIPT_PATH, "utf8");
  let pages: { name: string; html: string }[] = [];

  beforeAll(async () => {
    // Every state of every page that the pages module has a fixture for, and the pages the
    // services' real output makes.
    pages = variants.map(([name, build]) => ({ name, html: build() }));
    const r = await reviewed();
    const view = r.w.services.matters.view(r.am);
    const chrome = chromeFor(r.reviewerAm.principal);
    const finding = durOf(r, r.reviewerAm);
    pages.push(
      { name: "matter", html: render(MatterPage({ chrome, view, canDelete: true })) },
      {
        name: "run",
        html: render(
          RunPage({
            chrome,
            matter: view.matter,
            run: view.currentRun!,
            issues: r.w.services.runs.issues(r.am, r.runId),
            selected: finding,
          }),
        ),
      },
      {
        name: "finding",
        html: render(
          FindingPage({ chrome, matterId: r.matterId, finding, matterName: "Synthetic" }),
        ),
      },
      {
        name: "error",
        html: render(
          ErrorPage({ chrome, status: 404, title: "Page not found", message: "No such page." }),
        ),
      },
    );
  });

  it("covers the pages of the module and the pages of the real services", () => {
    expect(pages.length).toBeGreaterThan(30);
  });

  it("lets every page load what it names and post where its forms go, and no page runs inline code", () => {
    const loaded = new Set<string>();
    for (const { name, html } of pages) {
      const { fetches, inline } = usesOf(parseHtml(html));
      expect(inline, name).toEqual([]);
      for (const use of fetches) {
        expect(allowed(policy, use), `${name}: ${use.directive} ${use.url}`).toBe(true);
        if (use.directive === "script-src" || use.directive === "style-src") loaded.add(use.url);
      }
    }
    // Every page has the one stylesheet and the one script the shell serves from /assets.
    expect([...loaded].sort()).toEqual([urls.asset("parol.css"), urls.asset("parol.js")]);
  });

  it("links nowhere but to paths of this site", () => {
    for (const { name, html } of pages) {
      for (const el of all(parseHtml(html))) {
        for (const attribute of ["href", "src", "action", "formaction", "data-status-url"]) {
          const value = attr(el, attribute);
          if (value === undefined || value === null) continue;
          expect(
            value.startsWith("#") ||
              (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")),
            `${name}: ${attribute}=${value}`,
          ).toBe(true);
        }
      }
    }
  });

  it("grants exactly what the pages, the script and the stylesheet use, and only to this origin", () => {
    const needed = new Set<string>();
    for (const { html } of pages)
      for (const use of usesOf(parseHtml(html)).fetches) needed.add(use.directive);
    // The script makes one request, to the status route the page names; the stylesheet is plain.
    if (/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/.test(js))
      needed.add("connect-src");
    if (/url\s*\(/.test(css)) needed.add("img-src");
    if (/@font-face/.test(css)) needed.add("font-src");
    if (/@import/.test(css)) needed.add("style-src");
    expect(new Set(grantingDirectives(policy))).toEqual(needed);
    for (const directive of grantingDirectives(policy))
      expect(policy.get(directive), directive).toEqual(["'self'"]);
    // Nothing else is allowed by default, and nobody may frame the pages or move their base.
    expect(policy.get("default-src")).toEqual(["'none'"]);
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'none'"]);
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe|\*|https?:|data:|blob:/);
  });

  it("asks of the script nothing that the policy would block", () => {
    expect(js).not.toMatch(/\beval\s*\(|new\s+Function\b|\bFunction\s*\(/);
    expect(js).not.toMatch(/set(Timeout|Interval)\s*\(\s*["'`]/);
    expect(js).not.toMatch(
      /setAttribute\(\s*["']style["']|\.cssText|\.innerHTML|outerHTML|insertAdjacentHTML|document\.write/,
    );
    expect(js).not.toMatch(/createElement\(\s*["'](script|style|iframe|img|link)["']/);
    expect(js).not.toMatch(/\bimport\s*\(|importScripts|new\s+Worker/);
    // It sends its request only to a path the page itself names, and checks that it is local.
    expect(js).toMatch(/sameOriginPath\(url\)/);
    expect(css).not.toMatch(/@import|expression\s*\(/);
  });
});

// ---------------------------------------------------------------------------------------------
// main.ts over the real services
// ---------------------------------------------------------------------------------------------

describe("main.ts started over the real services and the boot registration", () => {
  const roots: string[] = [];
  const servers: RunningServer[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  const env = (dataDir: string): Record<string, string> => ({
    PAROL_DEMO_IDENTITY: "1",
    PAROL_SCRIPTED: "1",
    PAROL_PORT: "0",
    PAROL_DATA_DIR: dataDir,
    PAROL_COOKIE_SECRET: SECRET,
  });

  it("listens on an ephemeral port on loopback, answers /healthz, registers what a run needs, and stops", async () => {
    const root = mkdtempSync(join(tmpdir(), "parol-layers-"));
    roots.push(root);
    const dataDir = join(root, "data");
    const logs: string[] = [];
    const notices: string[] = [];
    const server = await startServer(env(dataDir), {
      log: (line) => logs.push(line),
      notice: (line) => notices.push(line),
    });
    servers.push(server);
    expect(server.port).toBeGreaterThan(0);
    expect(server.settings).toMatchObject({
      demoIdentity: true,
      host: "127.0.0.1",
      scripted: true,
    });

    const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    expect(health.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
    // The stand-in model says where text would go, which is nowhere.
    expect(notices.join("\n")).toContain("Document text is sent to: a built-in stand-in model");

    // The boot registration put in the database what the services need to start a run: the demo
    // users, the approved demo playbook, the prompts and both workflow versions.
    const playbooks = server.repo.listPlaybookVersions();
    expect(playbooks.map((p) => [p.slug, p.version, p.status])).toEqual([
      ["parol-nda-recipient", "1.0.1", "approved"],
    ]);
    expect(server.repo.listRules(playbooks[0]!.id)).toHaveLength(8);
    expect(server.repo.getWorkflowVersionByLabel("v1")).toBeDefined();
    expect(server.repo.getWorkflowVersionByLabel("v2")).toBeDefined();
    for (const id of ["extract.p1", "analyze.p1", "support.p1"])
      expect(server.repo.getPromptVersion(id), id).toBeDefined();
    expect(server.repo.getUser(DEMO_USER_IDS.associate)).toBeDefined();

    // An unknown address is answered with the application's own page, banner and all.
    const missing = await fetch(`http://127.0.0.1:${server.port}/no-such-page`);
    expect(missing.status).toBe(404);
    const missingHtml = await missing.text();
    expect(missingHtml).toContain(DEMO_BANNER);
    expect(missingHtml).toContain("Error 404");

    // A post to the session route without the token the pages carry is refused, on the real socket.
    const refused = await fetch(`http://127.0.0.1:${server.port}${urls.session()}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ intent: "sign-in", userId: DEMO_USER_IDS.associate }),
    });
    expect(refused.status).toBe(403);

    await server.close();
    await expect(fetch(`http://127.0.0.1:${server.port}/healthz`)).rejects.toThrow();
  });

  it("starts again on the same data and changes nothing: the registration is idempotent", async () => {
    const root = mkdtempSync(join(tmpdir(), "parol-layers-"));
    roots.push(root);
    const dataDir = join(root, "data");
    const first = await startServer(env(dataDir), { log: () => {}, notice: () => {} });
    const before = first.repo.listPlaybookVersions().map((p) => p.id);
    const audit = first.repo.db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as {
      n: number;
    };
    await first.close();

    const logs: string[] = [];
    const second = await startServer(env(dataDir), {
      log: (line) => logs.push(line),
      notice: () => {},
    });
    servers.push(second);
    expect(second.repo.listPlaybookVersions().map((p) => p.id)).toEqual(before);
    const again = second.repo.db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as {
      n: number;
    };
    expect(again.n).toBe(audit.n);
    expect(logs.filter((l) => !l.startsWith("req="))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The keyword-hint change and the categories it was not about
// ---------------------------------------------------------------------------------------------

describe("the keyword hints of the dev split", () => {
  /**
   * Hints per category for D01, D03, D05, D06, D08, the twin of D08 and D12, counted on the tree
   * before topics existed. Only permitted-disclosures was meant to change, and it lost five hints:
   * the return clause of four documents and the survival clause of D05, each of which says
   * "copies required by law" about copies kept after a return, not about being compelled to
   * disclose. Every other category is as it was.
   */
  const BEFORE: Record<string, number[]> = {
    parties: [4, 3, 6, 5, 4, 4, 4],
    "ci-definition": [11, 8, 13, 10, 8, 8, 10],
    exclusions: [2, 2, 2, 2, 2, 2, 2],
    duration: [1, 1, 4, 1, 2, 2, 2],
    "return-destruction": [2, 1, 2, 2, 3, 3, 2],
    "governing-law": [4, 0, 4, 6, 3, 3, 4],
  };
  const PERMITTED_AFTER = [3, 2, 3, 3, 3, 2, 3];
  const PERMITTED_BEFORE = [3, 2, 4, 4, 4, 3, 4];
  // The cases that existed when the hints were counted. The later development cases have no count
  // from before topics, so a before and after comparison is only possible for these.
  const COUNTED_BEFORE = [
    "PAROL-D01",
    "PAROL-D03",
    "PAROL-D05",
    "PAROL-D06",
    "PAROL-D08",
    "PAROL-D12",
  ];

  it("are as many per category as before topics, except for the copies required by law", async () => {
    const { keys } = await loadFixtures();
    const counts: Record<string, number[]> = {};
    const lost: string[] = [];
    for (const key of keys.cases.filter((c) => COUNTED_BEFORE.includes(c.case))) {
      for (const twin of key.case === "PAROL-D08" ? [false, true] : [false]) {
        const world = await buildCaseWorld(key.case, { twin });
        for (const category of CATEGORY_IDS) {
          const spans = world.ingest.annotations.filter(
            (a) => a.kind === "keyword_hint" && a.category === category,
          );
          (counts[category] ??= []).push(spans.length);
        }
        // The spans that said "copies required by law" and no longer hint the permitted disclosures.
        for (const span of world.ingest.spans) {
          if (!/copies required by law/.test(span.text)) continue;
          const hinted = world.ingest.annotations
            .filter((a) => a.kind === "keyword_hint" && a.spanId === span.id)
            .map((a) => (a as { category: string }).category);
          expect(hinted, `${key.case} ${span.label}`).toContain("return-destruction");
          expect(hinted, `${key.case} ${span.label}`).not.toContain("permitted-disclosures");
          lost.push(`${key.case}${twin ? "-twin" : ""} ${span.label}`);
        }
      }
    }
    for (const [category, expected] of Object.entries(BEFORE))
      expect(counts[category], category).toEqual(expected);
    expect(counts["permitted-disclosures"]).toEqual(PERMITTED_AFTER);
    expect(PERMITTED_BEFORE.map((n, i) => n - PERMITTED_AFTER[i]!).reduce((a, b) => a + b, 0)).toBe(
      lost.length,
    );
    expect(lost).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------------------------
// The other forms of the matter page, as the services receive them
// ---------------------------------------------------------------------------------------------

describe("the forms of the matter page, filled in as a person would and given to the services", () => {
  const values = (pairs: [string, string][]): Record<string, string> => Object.fromEntries(pairs);

  it("settings, people, stated dates, versions, removal and deletion all reach a service that accepts them", async () => {
    const w = makeWorld({ model: WORKED_EXAMPLE });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const page = (): El =>
      parseHtml(
        render(
          MatterPage({
            chrome: chromeFor(am.principal),
            view: w.services.matters.view(am),
            users: w.services.matters.users(),
            canDelete: true,
          }),
        ),
      );
    const form = (root: El, action: string): El =>
      first(root, (el) => el.name === "form" && attr(el, "action") === action, action);
    const fill = (
      action: string,
      options: Parameters<typeof formFields>[1] = {},
    ): Record<string, string> => {
      const root = page();
      checkInvariants(
        render(
          MatterPage({
            chrome: chromeFor(am.principal),
            view: w.services.matters.view(am),
            users: w.services.matters.users(),
            canDelete: true,
          }),
        ),
        { actions: actionsOf({ w, am, matterId }) },
      );
      return values(formFields(form(root, action), options, root));
    };

    // Settings: what the form shows is what the matter holds, and a changed name is accepted.
    const settings = fill(urls.matterSettings(matterId));
    expect(settings[FIELDS.clientLegalName]).toBe(baseWorld.manifest.clientLegalName);
    expect(settings[FIELDS.playbookVersionId]).toBe(w.playbookVersionId);
    const renamed = fill(urls.matterSettings(matterId), {
      set: { [FIELDS.clientLegalName]: "Lanternfish Software, LLC" },
    });
    w.services.matters.update(am, {
      clientLegalName: renamed[FIELDS.clientLegalName]!,
      playbookVersionId: renamed[FIELDS.playbookVersionId]!,
    });
    expect(w.services.matters.view(am).matter.clientLegalName).toBe("Lanternfish Software, LLC");

    // People: the form offers the people who are not on the matter yet, with every role it can give.
    const root = page();
    const personForm = form(root, urls.members(matterId));
    const people = all(
      personForm,
      (el) => el.name === "option" && el.attrs.some((a) => a.name === "value"),
    );
    const offered = (name: string): string[] =>
      all(
        first(personForm, (el) => el.name === "select" && attr(el, "name") === name),
        (el) => el.name === "option",
      ).map((o) => attr(o, "value")!);
    expect(people.length).toBeGreaterThan(3);
    expect(offered(FIELDS.memberUserId).sort()).toEqual(
      [DEMO_USER_IDS.admin, DEMO_USER_IDS.legalEngineer].sort(),
    );
    const roles = offered(FIELDS.memberRole);
    expect(roles).toEqual(["associate", "reviewer", "viewer"]);
    const added = fill(urls.members(matterId), {
      set: { [FIELDS.memberUserId]: DEMO_USER_IDS.legalEngineer, [FIELDS.memberRole]: "viewer" },
    });
    w.services.matters.addMember(am, {
      userId: added[FIELDS.memberUserId]!,
      role: added[FIELDS.memberRole] as "viewer",
    });
    expect(w.services.matters.view(am).members.map((m) => m.role)).toContain("viewer");
    // Every role the form offers is one the service takes, for someone not yet on the matter.
    for (const role of roles) {
      const probe = makeWorld();
      const m = newMatter(probe);
      expect(() =>
        probe.services.matters.addMember(m.am, {
          userId: DEMO_USER_IDS.admin,
          role: role as "associate" | "reviewer" | "viewer",
        }),
      ).not.toThrow();
    }

    // Stated dates: the date field and its button belong to a form elsewhere in the page.
    const amendment = w.services.matters.view(am).documents[1]!;
    const versionId = amendment.versions[0]!.versionId;
    const dateAction = urls.statedDate(matterId, versionId);
    const dated = fill(dateAction, { set: { [FIELDS.statedDate]: "2026-03-04" } });
    expect(Object.keys(dated).sort()).toEqual(["_csrf", FIELDS.statedDate].sort());
    w.services.matters.setStatedDate(am, versionId, dated[FIELDS.statedDate] || null);
    expect(w.services.matters.view(am).documents[1]!.versions[0]!.statedDate).toBe("2026-03-04");
    const cleared = fill(dateAction, { set: { [FIELDS.statedDate]: "" } });
    w.services.matters.setStatedDate(am, versionId, cleared[FIELDS.statedDate] || null);
    expect(w.services.matters.view(am).documents[1]!.versions[0]!.statedDate).toBeNull();

    // A new version, and the choice between the two.
    const second = new TextEncoder().encode(
      new TextDecoder()
        .decode(baseWorld.files[1]!.bytes)
        .replace("entirety", "entirety, and no more"),
    );
    const uploaded = await w.services.matters.addVersion(am, amendment.documentId, {
      fileName: "amendment-two.txt",
      bytes: second,
      statedDate: "2026-09-16",
    });
    const rootAfter = page();
    const operative = formFields(
      form(rootAfter, urls.operative(matterId, amendment.documentId)),
      { set: { [FIELDS.versionId]: versionId } },
      rootAfter,
    );
    expect(operative.filter(([n]) => n === FIELDS.versionId)).toHaveLength(1);
    expect(
      all(rootAfter, (el) => el.name === "input" && attr(el, "name") === FIELDS.versionId),
    ).toHaveLength(3);
    w.services.matters.setOperative(am, amendment.documentId, posted(operative, FIELDS.versionId));
    expect(
      w.services.matters.view(am).documents[1]!.versions.find((v) => v.operative)?.versionId,
    ).toBe(versionId);
    expect(uploaded.versionId).not.toBe(versionId);

    // Removal and deletion are confirmed with a box whose value the services' callers must read.
    const removal = fill(urls.documentRemove(matterId, amendment.documentId), {
      set: { [FIELDS.confirm]: CONFIRM_VALUE },
    });
    expect(removal[FIELDS.confirm]).toBe(CONFIRM_VALUE);
    w.services.matters.removeDocument(am, amendment.documentId);
    expect(w.services.matters.view(am).documents.map((d) => d.label)).toEqual(["D1"]);

    const deletion = fill(urls.matterDelete(matterId), {
      set: { [FIELDS.confirm]: CONFIRM_VALUE },
    });
    expect(deletion[FIELDS.confirm]).toBe(CONFIRM_VALUE);
    await w.services.matters.delete(am);
    expect(w.services.matters.list(am.principal)).toEqual([]);
  });

  it("offers, for an empty matter, only the kinds of document the service takes first", async () => {
    // The service refuses an amendment when there is no NDA, so it must not be a choice.
    const probe = makeWorld();
    const { matterId, am } = newMatter(probe);
    const root = parseHtml(
      render(
        MatterPage({
          chrome: chromeFor(am.principal),
          view: probe.services.matters.view(am),
          canDelete: false,
        }),
      ),
    );
    const add = first(
      root,
      (el) => el.name === "form" && attr(el, "action") === urls.documents(matterId),
    );
    const kinds = all(
      first(add, (el) => el.name === "select" && attr(el, "name") === FIELDS.kind),
      (el) => el.name === "option",
    ).map((o) => attr(o, "value")!);
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      const w = makeWorld();
      const m = newMatter(w);
      const file = baseWorld.files[kind === "nda" ? 0 : 1]!;
      await expect(
        w.services.matters.addDocument(m.am, {
          title: "Document",
          kind: kind as "nda" | "amendment",
          fileName: file.file,
          bytes: file.bytes,
          statedDate: null,
        }),
        kind,
      ).resolves.toBeDefined();
    }
  });

  it("cancel and resume are forms of the matter page, and the services take what they post", async () => {
    // The first call of the first review fails as a provider outage would; the second review is
    // answered. The page offers Resume for the failed run, and Cancel for one in flight.
    const hold = gate();
    let calls = 0;
    const w = makeWorld({
      model: {
        ...WORKED_EXAMPLE,
        before: async () => {
          calls += 1;
          if (calls === 1) throw new ModelRequestError("no key", 401);
          await hold.pass();
        },
      },
    });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const page = (): El =>
      parseHtml(
        render(
          MatterPage({
            chrome: chromeFor(am.principal),
            view: w.services.matters.view(am),
            canDelete: false,
          }),
        ),
      );
    const run = w.services.runs.start(am, { workflowLabel: "v2" });
    await w.services.runs.idle();
    expect(w.services.runs.get(am, run.id).status).toBe("failed");

    const resumeRoot = page();
    const resume = first(
      resumeRoot,
      (el) => el.name === "form" && attr(el, "action") === urls.runResume(matterId, run.id),
      "the resume form",
    );
    expect(Object.fromEntries(formFields(resume, {}, resumeRoot))).toEqual({ _csrf: IDS.csrf });
    w.services.runs.resume(am, run.id);
    await hold.reached(1);
    expect(w.services.runs.get(am, run.id).status).not.toBe("failed");

    const cancelRoot = page();
    const cancel = first(
      cancelRoot,
      (el) => el.name === "form" && attr(el, "action") === urls.runCancel(matterId, run.id),
      "the cancel form",
    );
    expect(Object.fromEntries(formFields(cancel, {}, cancelRoot))).toEqual({ _csrf: IDS.csrf });
    w.services.runs.cancel(am, run.id);
    hold.open();
    await w.services.runs.idle();
    expect(w.services.runs.get(am, run.id).status).toBe("cancelled");
    // A cancelled run offers neither: the page and the service agree there is nothing to do.
    const after = page();
    expect(
      all(
        after,
        (el) =>
          el.name === "form" &&
          [urls.runResume(matterId, run.id), urls.runCancel(matterId, run.id)].includes(
            attr(el, "action") ?? "",
          ),
      ),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// What a person typed does not travel
// ---------------------------------------------------------------------------------------------

describe("text a person typed or uploaded, through the pages, the shell and the services", () => {
  const NAME = "QZXNAME-7731";
  const REASON = "QZXREASON-4417";
  const JUNK = "QZXJUNK-9021";
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? [entry.name, ...walk(join(dir, entry.name))] : [entry.name],
    );

  it("stays out of the access log, the service log, the audit trail, the file names and every error page", async () => {
    const w = makeWorld({ model: WORKED_EXAMPLE });
    const web = webOver(w);
    const associate = await web.as(DEMO_USER_IDS.associate);
    const reviewer = await web.as(DEMO_USER_IDS.reviewer);
    const errors: { status: number; body: string }[] = [];
    const record = async (response: Response): Promise<Response> => {
      if (response.status >= 400)
        errors.push({ status: response.status, body: await response.clone().text() });
      return response;
    };

    // A matter, typed in through the form: its name, its client and its documents' titles and files.
    const list = await pageOf(associate, urls.matters());
    const created = await submit(associate, list.root, urls.matters(), {
      set: {
        [FIELDS.name]: `${NAME} matter`,
        [FIELDS.clientLegalName]: baseWorld.manifest.clientLegalName,
        [FIELDS.reviewerUserId]: DEMO_USER_IDS.reviewer,
        [FIELDS.playbookVersionId]: w.playbookVersionId,
      },
    });
    const matterId = created.headers.get("location")!.slice("/matters/".length);
    for (const file of baseWorld.files) {
      const body = new FormData();
      body.set("_csrf", await associate.token());
      body.set(FIELDS.title, `${NAME} ${file.label}`);
      body.set(FIELDS.kind, file.label === "D1" ? "nda" : "amendment");
      body.set(FIELDS.file, new File([new Uint8Array(file.bytes)], `${NAME}-${file.file}`));
      expect((await associate.send("POST", urls.documents(matterId), { body })).status).toBe(303);
    }

    // Requests that go wrong, each carrying the marker where it could be copied from.
    const wrong = [
      associate.get(`/matters/${JUNK}`),
      associate.get(`/matters/${matterId}/runs/${JUNK}`),
      associate.get(`/matters/${matterId}/findings/${JUNK}`),
      associate.get(`/matters/${matterId}/runs/${JUNK}/status?x=${JUNK}`),
      associate.get(`/matters/${matterId}/memos/${JUNK}/file`),
      associate.post(`/matters/${matterId}/findings/${JUNK}/reviews`, { decision: JUNK }),
      associate.post(urls.matters(), { name: "", clientLegalName: JUNK }),
      associate.post(urls.matters(), { name: JUNK, clientLegalName: JUNK, reviewerUserId: JUNK }),
      associate.post(urls.matters(), {
        name: JUNK,
        clientLegalName: JUNK,
        playbookVersionId: JUNK,
      }),
      associate.post(urls.session(), { intent: JUNK, userId: JUNK }),
      associate.send("POST", urls.documents(matterId), {
        body: (() => {
          const body = new FormData();
          body.set("_csrf", "wrong");
          body.set(FIELDS.file, new File([new Uint8Array([1, 2, 3])], `${JUNK}.docx`));
          return body;
        })(),
      }),
      web.anonymous().get(`/assets/${JUNK}`),
    ];
    for (const response of wrong) await record(await response);
    // A file that is not a document, with the marker as its name, after the token is right.
    const notADocument = new FormData();
    notADocument.set("_csrf", await associate.token());
    notADocument.set(FIELDS.title, JUNK);
    notADocument.set(FIELDS.kind, "amendment");
    notADocument.set(FIELDS.file, new File([new TextEncoder().encode("%PDF")], `${JUNK}.docx`));
    await record(await associate.send("POST", urls.documents(matterId), { body: notADocument }));

    // A review, and a reason typed by the reviewing attorney.
    const am = w.grant(w.associate, matterId);
    const run = w.services.runs.start(am, { workflowLabel: "v2" });
    await w.services.runs.idle();
    const reviewerAm = w.grant(w.reviewer, matterId);
    const row = w.services.runs.issues(reviewerAm, run.id).find((i) => i.ruleKey === "dur-1")!;
    const open = await pageOf(reviewer, urls.finding(matterId, row.findingId));
    const decided = await submit(reviewer, open.root, urls.review(matterId, row.findingId), {
      set: { decision: "reject", reasonCode: "other", reason: `${REASON} the term is wrong` },
    });
    expect(decided.status).toBe(303);
    expect(w.services.runs.finding(reviewerAm, row.findingId).reviews[0]!.reason).toContain(REASON);

    // The rows hold what a person typed, because that is what the pages show back.
    expect(w.services.matters.view(am).matter.name).toContain(NAME);
    expect(errors.length).toBeGreaterThanOrEqual(12);
    expect(errors.every((e) => e.status >= 400 && e.status < 500)).toBe(true);
    for (const { status, body } of errors) {
      expect(body, `a ${status} page`).not.toContain(JUNK);
      expect(body, `a ${status} page`).not.toContain(NAME);
    }

    const everything = [
      ["the access log", web.logs.join("\n")],
      ["the service log", w.logs.join("\n")],
      ["the audit trail", JSON.stringify(w.repo.db.prepare("SELECT * FROM audit_events").all())],
      ["the names of stored files", walk(w.root).join("\n")],
    ] as const;
    expect(web.logs.length).toBeGreaterThan(10);
    for (const [where, text] of everything)
      for (const marker of [NAME, REASON, JUNK])
        expect(text, `${where} holds ${marker}`).not.toContain(marker);
  });
});

describe("a document uploaded twice", () => {
  it("is warned about in the upload, and a near duplicate sits on the page unused until the associate chooses it", async () => {
    const w = makeWorld({ model: WORKED_EXAMPLE });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const amendment = w.services.matters.view(am).documents[1]!;
    const file = baseWorld.files[1]!;

    // The same file again: nothing is stored, and the answer says so in the service's words.
    const same = await w.services.matters.addVersion(am, amendment.documentId, {
      fileName: file.file,
      bytes: file.bytes,
      statedDate: null,
    });
    expect(same.warnings.map((x) => x.code)).toContain("duplicate_document");
    expect(w.services.matters.view(am).documents[1]!.versions).toHaveLength(1);

    // The same words in a different file: stored, not in use, and the review stands.
    const near = await w.services.matters.addVersion(am, amendment.documentId, {
      fileName: file.file,
      bytes: new TextEncoder().encode(`${new TextDecoder().decode(file.bytes)}\n`),
      statedDate: null,
    });
    expect(near.warnings.map((x) => x.code)).toEqual(["near_duplicate_version"]);
    const view = w.services.matters.view(am);
    expect(view.start).toEqual({ ready: true, reasons: [] });
    expect(view.documents[1]!.versions.map((v) => v.operative)).toEqual([true, false]);
    expect(view.warnings.map((x) => [x.code, x.documentLabel])).toEqual([
      ["near_duplicate_version", "D2"],
    ]);

    const html = render(
      MatterPage({
        chrome: chromeFor(am.principal),
        view,
        users: w.services.matters.users(),
        canDelete: true,
      }),
    );
    const root = checkInvariants(html, { actions: actionsOf({ w, am, matterId }) });
    expect(readable(byId(root, "warnings")!)).toContain(
      labels.WARNING_LABEL.near_duplicate_version,
    );
    // Both versions are offered, the first is chosen, and the start button works.
    const radios = all(
      form_(root, urls.operative(matterId, amendment.documentId)),
      (el) => el.name === "input" && attr(el, "name") === FIELDS.versionId,
    );
    expect(radios.map((r) => hasAttr(r, "checked"))).toEqual([true, false]);
    expect(
      hasAttr(
        first(form_(root, urls.runs(matterId)), (el) => el.name === "button"),
        "disabled",
      ),
    ).toBe(false);
    // Choosing the copy is a step of the associate's own.
    w.services.matters.setOperative(am, amendment.documentId, near.versionId);
    expect(w.services.matters.view(am).documents[1]!.versions.map((v) => v.operative)).toEqual([
      false,
      true,
    ]);
  });
});

function form_(root: El, action: string): El {
  return first(root, (el) => el.name === "form" && attr(el, "action") === action, action);
}

// ---------------------------------------------------------------------------------------------
// What the pages offer is what the services will do
// ---------------------------------------------------------------------------------------------

interface Scene {
  w: World;
  matterId: string;
  am: AuthorizedMatter;
  reviewerAm: AuthorizedMatter;
  /** Lets a held model go on. */
  release?: () => void;
}

/** The matter in each state a page can be in. */
const SCENES: Record<string, () => Promise<Scene>> = {
  "no documents": async () => {
    const w = makeWorld();
    const { matterId, am } = newMatter(w);
    return { w, matterId, am, reviewerAm: w.grant(w.reviewer, matterId) };
  },
  "an NDA only": async () => {
    const w = makeWorld();
    const { matterId, am } = newMatter(w);
    const nda = baseWorld.files[0]!;
    await w.services.matters.addDocument(am, {
      title: "Mutual NDA",
      kind: "nda",
      fileName: nda.file,
      bytes: nda.bytes,
      statedDate: "2026-02-02",
    });
    return { w, matterId, am, reviewerAm: w.grant(w.reviewer, matterId) };
  },
  "ready to review": async () => {
    const w = makeWorld();
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    return { w, matterId, am, reviewerAm: w.grant(w.reviewer, matterId) };
  },
  "a review in flight": async () => {
    const hold = gate();
    const w = makeWorld({ model: { ...WORKED_EXAMPLE, before: () => hold.pass() } });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    w.services.runs.start(am, { workflowLabel: "v2" });
    await hold.reached(1);
    return { w, matterId, am, reviewerAm: w.grant(w.reviewer, matterId), release: hold.open };
  },
  "in review": async () => {
    const r = await reviewed();
    return { w: r.w, matterId: r.matterId, am: r.am, reviewerAm: r.reviewerAm };
  },
  "every finding decided": async () => {
    const r = await reviewed();
    decideEverything(r);
    return { w: r.w, matterId: r.matterId, am: r.am, reviewerAm: r.reviewerAm };
  },
  "memo exported": async () => {
    const r = await reviewed();
    decideEverything(r);
    await r.w.services.reviews.exportMemo(r.reviewerAm);
    return { w: r.w, matterId: r.matterId, am: r.am, reviewerAm: r.reviewerAm };
  },
  "results out of date": async () => {
    const r = await reviewed();
    const view = r.w.services.matters.view(r.am);
    r.w.services.matters.setStatedDate(
      r.am,
      view.documents[1]!.versions[0]!.versionId,
      "2026-09-16",
    );
    return { w: r.w, matterId: r.matterId, am: r.am, reviewerAm: r.reviewerAm };
  },
  "a failed review on the current documents": async () => failedScene(false),
  "a failed review whose documents changed": async () => failedScene(true),
};

async function failedScene(thenChange: boolean): Promise<Scene> {
  let calls = 0;
  const w = makeWorld({
    model: {
      before: () => {
        calls += 1;
        if (calls === 1) throw new ModelRequestError("no key", 401);
      },
    },
  });
  const { matterId, am } = newMatter(w);
  await uploadCase(w, matterId);
  w.services.runs.start(am, { workflowLabel: "v2" });
  await w.services.runs.idle();
  if (thenChange) {
    const view = w.services.matters.view(am);
    w.services.matters.setStatedDate(am, view.documents[1]!.versions[0]!.versionId, "2026-09-16");
  }
  return { w, matterId, am, reviewerAm: w.grant(w.reviewer, matterId) };
}

function decideEverything(r: Reviewed): void {
  for (const row of r.w.services.runs.issues(r.reviewerAm)) {
    const view = r.w.services.runs.finding(r.reviewerAm, row.findingId);
    const ok = view.issue.verificationState === "verified" && view.issue.status !== "undetermined";
    r.w.services.reviews.decide(r.reviewerAm, row.findingId, {
      decision: ok ? "accept" : "escalate",
      findingContentSha256: view.contentSha256,
      edits: null,
      reason: ok ? null : "The workflow could not settle this rule.",
    });
  }
}

/** Earlier ones change nothing the later ones rely on, so a page's forms can be taken in turn. */
const ORDER = [
  /\/findings\/[^/]+\/reviews$/,
  /\/findings\/[^/]+\/notes$/,
  /\/memos$/,
  /\/settings$/,
  /\/members$/,
  /\/stated-date$/,
  /\/operative$/,
  /\/versions$/,
  /\/documents$/,
  /\/runs$/,
  /\/resume$/,
  /\/cancel$/,
  /\/remove$/,
  /\/retention$/,
  /\/delete$/,
];
const rank = (action: string): number => {
  const at = ORDER.findIndex((pattern) => pattern.test(action));
  return at === -1 ? ORDER.length : at;
};

/** The submit buttons of a form, including those that belong to it through the `form` attribute. */
function submitters(root: El, form: El): El[] {
  const id = attr(form, "id");
  return all(
    root,
    (el) =>
      el.name === "button" &&
      (attr(el, "type") ?? "submit") === "submit" &&
      (all(form, (x) => x === el).length > 0 ||
        (id !== undefined && id !== null && attr(el, "form") === id)),
  );
}

/** Does what the form would do, with the service it goes to. Throws what the service throws. */
async function perform(scene: Scene, as: AuthorizedMatter, root: El, form: El): Promise<void> {
  const { w, matterId } = scene;
  const { matters, runs, reviews, feedback } = w.services;
  const action = attr(form, "action") ?? "";
  const fields = Object.fromEntries(formFields(form, {}, root));
  const id = (pattern: RegExp): string => decodeURIComponent(pattern.exec(action)?.[1] ?? "");
  const amendment = baseWorld.files[1]!;
  if (/\/settings$/.test(action)) {
    matters.update(as, {
      clientLegalName: fields[FIELDS.clientLegalName]!,
      ...(fields[FIELDS.playbookVersionId]
        ? { playbookVersionId: fields[FIELDS.playbookVersionId]! }
        : {}),
    });
  } else if (/\/members$/.test(action)) {
    matters.addMember(as, {
      userId: fields[FIELDS.memberUserId]!,
      role: fields[FIELDS.memberRole] as "reviewer",
    });
  } else if (/\/stated-date$/.test(action)) {
    matters.setStatedDate(
      as,
      id(/\/versions\/([^/]+)\/stated-date$/),
      fields[FIELDS.statedDate] || null,
    );
  } else if (/\/operative$/.test(action)) {
    const chosen = fields[FIELDS.versionId];
    const documentId = id(/\/documents\/([^/]+)\/operative$/);
    // Nothing chosen on the page is the person's to choose; take the newest version.
    const versions = matters.view(as).documents.find((d) => d.documentId === documentId)!.versions;
    matters.setOperative(as, documentId, chosen ?? versions[versions.length - 1]!.versionId);
  } else if (/\/versions$/.test(action)) {
    await matters.addVersion(as, id(/\/documents\/([^/]+)\/versions$/), {
      fileName: "next.txt",
      bytes: new TextEncoder().encode(
        new TextDecoder().decode(amendment.bytes).replace("entirety", "entirety, and no more"),
      ),
      statedDate: fields[FIELDS.statedDate] || null,
    });
  } else if (/\/documents$/.test(action)) {
    const kind = fields[FIELDS.kind] === "nda" ? "nda" : "amendment";
    const file = kind === "nda" ? baseWorld.files[0]! : amendment;
    await matters.addDocument(as, {
      title: kind === "nda" ? "Mutual NDA" : "Amendment No. 1",
      kind,
      fileName: file.file,
      bytes: file.bytes,
      statedDate: fields[FIELDS.statedDate] || null,
    });
  } else if (/\/runs$/.test(action)) {
    runs.start(as, { workflowLabel: "v2" });
    // A review that was held goes on, so that waiting for it ends.
    scene.release?.();
    await runs.idle();
  } else if (/\/resume$/.test(action)) {
    runs.resume(as, id(/\/runs\/([^/]+)\/resume$/));
    scene.release?.();
    await runs.idle();
  } else if (/\/cancel$/.test(action)) {
    runs.cancel(as, id(/\/runs\/([^/]+)\/cancel$/));
    scene.release?.();
    await runs.idle();
  } else if (/\/remove$/.test(action)) {
    matters.removeDocument(as, id(/\/documents\/([^/]+)\/remove$/));
  } else if (/\/retention$/.test(action)) {
    // The field is empty on the page: how long to keep the matter is the person's to type.
    matters.setRetention(as, Number(fields[FIELDS.retainDays] || "45"));
  } else if (/\/delete$/.test(action)) {
    await matters.delete(as);
  } else if (/\/memos$/.test(action)) {
    await reviews.exportMemo(as);
  } else if (/\/findings\/[^/]+\/reviews$/.test(action)) {
    const view = runs.finding(as, id(/\/findings\/([^/]+)\/reviews$/));
    const ok = view.issue.verificationState === "verified" && view.issue.status !== "undetermined";
    reviews.decide(as, view.issue.findingId, {
      decision: ok ? "accept" : "escalate",
      findingContentSha256: fields[FIELDS.findingContentSha256]!,
      edits: null,
      reason: ok ? null : "The workflow could not settle this rule.",
    });
  } else if (/\/findings\/[^/]+\/notes$/.test(action)) {
    // A note is the person's own words; the page offers an empty box, so the sweep writes some.
    feedback.addNote(as, id(/\/findings\/([^/]+)\/notes$/), {
      note: fields[FIELDS.note] || "A note from the sweep.",
    });
  } else if (action === urls.session()) {
    // Signing out is the shell's.
  } else {
    throw new Error(`the sweep does not know the form ${action.replace(matterId, ":matter")}`);
  }
}

describe("every action a page offers is one the services accept", () => {
  /** The pages one person sees of a scene, the matter's and the run's with a finding selected. */
  function pagesOf(scene: Scene, as: AuthorizedMatter, options: { delete: boolean }): El[] {
    const { w, matterId } = scene;
    const view = w.services.matters.view(as);
    const chrome = chromeFor(as.principal);
    const pages = [
      parseHtml(
        render(
          MatterPage({
            chrome,
            view,
            users: w.services.matters.users(),
            canDelete: options.delete,
          }),
        ),
      ),
    ];
    const run = view.currentRun ?? view.runs.find((r) => r.status === "succeeded");
    if (run !== undefined && run !== null) {
      const issues = w.services.runs.issues(as, run.id);
      for (const issue of issues)
        pages.push(
          parseHtml(
            render(
              RunPage({
                chrome,
                matter: view.matter,
                run,
                issues,
                selected: w.services.runs.finding(as, issue.findingId),
              }),
            ),
          ),
        );
    }
    expect(matterId).toBe(view.matter.id);
    return pages;
  }

  it.each(Object.keys(SCENES))(
    "when the matter is %s",
    async (name) => {
      const scene = await SCENES[name]!();
      const offered: string[] = [];
      const refused: string[] = [];
      try {
        for (const [who, as, deletes] of [
          ["the reviewing attorney", scene.reviewerAm, false],
          ["the associate", scene.am, true],
        ] as const) {
          const done = new Set<string>();
          // The forms of the first render, in an order in which each leaves the next ones valid. Each
          // is looked up again just before it is used, because the one before may have removed it.
          const first_ = pagesOf(scene, as, { delete: deletes });
          const actions = [
            ...new Set(
              first_
                .flatMap((root) => all(root, (el) => el.name === "form"))
                .map((f) => attr(f, "action") ?? ""),
            ),
          ].sort((a, b) => rank(a) - rank(b));
          for (const action of actions) {
            if (action === urls.session()) continue;
            const roots = pagesOf(scene, as, { delete: deletes });
            // Every finding has a form of its own; each is looked for on its own page.
            for (const root of roots) {
              const form = all(
                root,
                (el) => el.name === "form" && attr(el, "action") === action,
              )[0];
              if (form === undefined) continue;
              const buttons = submitters(root, form);
              // A form whose buttons are all disabled cannot be sent by a person.
              if (buttons.length > 0 && buttons.every((b) => hasAttr(b, "disabled"))) continue;
              const key = `${who}: ${action.replace(scene.matterId, ":matter")}`;
              if (done.has(key)) break;
              done.add(key);
              offered.push(key);
              try {
                await perform(scene, as, root, form);
              } catch (error) {
                refused.push(
                  `${key} -> ${(error as Error).name} ${(error as { code?: string }).code ?? ""}`,
                );
              }
              break;
            }
          }
        }
      } finally {
        scene.release?.();
        await scene.w.services.runs.idle();
      }
      expect(refused, `offered: ${offered.join("; ")}`).toEqual([]);
      expect(offered.length).toBeGreaterThan(0);
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------------------------
// The command that starts the server
// ---------------------------------------------------------------------------------------------

describe("the root scripts that start Parol", () => {
  const scripts = (
    JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    }
  ).scripts;

  it("tell tsx which tsconfig holds the JSX settings of the pages, because the root has none", () => {
    // Without it tsx compiles the pages for React and the first page to render fails with
    // "React is not defined". The tests do not see this, because vitest reads each file's own
    // tsconfig.
    for (const name of ["parol", "parol:seed"])
      expect(scripts[name], name).toContain("--tsconfig apps/parol/tsconfig.json");
  });

  it("render a page when run the way the server is run", () => {
    const probe = join(ROOT, "apps", "parol", "test", "integration", "render-probe.ts");
    const [, ...args] = scripts["parol"]!.replace("apps/parol/src/main.ts", probe).split(" ");
    const html = execFileSync("pnpm", ["exec", "tsx", ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      timeout: 60_000,
    });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("Page not found");
  }, 90_000);
});

// ---------------------------------------------------------------------------------------------
// A restart in the middle of a review
// ---------------------------------------------------------------------------------------------

describe("a review the server stopped in the middle of", () => {
  it("is marked at boot, is offered for resuming on the page, and the resumed review finishes", async () => {
    const hold = gate();
    const w = makeWorld({ model: { ...WORKED_EXAMPLE, before: () => hold.pass() } });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, { workflowLabel: "v2" });
    await hold.reached(1);

    // The process stops here. The next one opens the same database and files, marks what it finds
    // in flight, and builds its own services. (The first process's held call is never released.)
    const logs: string[] = [];
    expect(markInterruptedRuns(w.repo, (line) => logs.push(line))).toEqual([
      { matterId, runId: run.id },
    ]);
    const next = createServices({
      ...w.deps,
      generator: controlledModel(WORKED_EXAMPLE).generator,
    });

    const view = next.matters.view(am);
    expect(view.matter.status).toBe("ready");
    expect(view.activeRun).toBeNull();
    expect(view.runs[0]).toMatchObject({
      id: run.id,
      status: "failed",
      errorKind: "interrupted",
      current: true,
    });
    const page = parseHtml(
      render(MatterPage({ chrome: chromeFor(am.principal), view, canDelete: false })),
    );
    expect(readable(byId(page, "runs")!)).toContain(labels.runErrorMeaning("interrupted"));
    const resume = first(
      page,
      (el) => el.name === "form" && attr(el, "action") === urls.runResume(matterId, run.id),
      "the resume form",
    );
    expect(
      hasAttr(
        first(resume, (el) => el.name === "button"),
        "disabled",
      ),
    ).toBe(false);

    // The form's service call is accepted, and the review ends as one that was never stopped.
    next.runs.resume(am, run.id);
    await next.runs.idle();
    expect(next.runs.get(am, run.id)).toMatchObject({ status: "succeeded", findingCount: 8 });
    const dur = next.runs.issues(am, run.id).find((i) => i.ruleKey === "dur-1")!;
    expect(dur).toMatchObject({ status: "deviation", validity: "current" });
    expect(next.matters.view(am).matter.status).toBe("in_review");
    expect(logs.join("\n")).not.toContain("Lanternfish");
  });
});

describe("every choice the decision form offers is one the services take", () => {
  it("records each decision, each status and each way of labelling a passage, as the form posts them", async () => {
    const r = await reviewed();
    const finding = durOf(r, r.reviewerAm);
    const root = parseHtml(
      render(
        FindingPage({
          chrome: chromeFor(r.reviewerAm.principal),
          matterId: r.matterId,
          finding,
          matterName: "Synthetic",
        }),
      ),
    );
    const form = first(root, (el) => el.name === "form" && hasAttr(el, "data-decision-form"));
    const optionsOf = (name: string): string[] =>
      all(
        first(form, (el) => el.name === "select" && attr(el, "name") === name),
        (el) => el.name === "option",
      ).map((o) => attr(o, "value")!);
    const decisions = all(
      form,
      (el) => el.name === "input" && attr(el, "name") === FIELDS.decision,
    ).map((el) => attr(el, "value")!);
    expect(decisions).toEqual([...REVIEW_DECISIONS]);
    expect(optionsOf(FIELDS.status)).toEqual([...STATUSES]);
    // The reason code: a placeholder first, then the six codes in the order of REASON_CODES.
    expect(optionsOf(FIELDS.reasonCode)).toEqual(["", ...REASON_CODES]);
    const supporting = finding.evidence.find((e) => e.role === "supporting")!;
    expect(optionsOf(`evidenceRole:${supporting.evidenceId}`)).toEqual([...EVIDENCE_ROLES]);

    const decide = (fields: Record<string, string>) =>
      r.w.services.reviews.decide(
        r.reviewerAm,
        finding.issue.findingId,
        decisionFromForm(
          Object.fromEntries(formFields(form, { set: fields }, root)),
          r.w.services.runs.finding(r.reviewerAm, finding.issue.findingId),
        ),
      );
    for (const decision of ["accept", "reject", "escalate"])
      expect(
        decide({ decision, reasonCode: "other", reason: "A reason." }).reviews.find(
          (x) => x.validity === "current",
        ),
        decision,
      ).toMatchObject({ decision });
    for (const status of STATUSES.filter((s) => s !== finding.issue.status)) {
      const current = decide({
        decision: "edit",
        reasonCode: "wrong_status",
        reason: "Corrected.",
        status,
      }).reviews.find((x) => x.validity === "current");
      expect(current?.edits, status).toEqual({ status });
    }
    for (const role of EVIDENCE_ROLES.filter((x) => x !== supporting.role)) {
      const current = decide({
        decision: "edit",
        reasonCode: "wrong_evidence",
        reason: "Relabelled.",
        [`evidenceRole:${supporting.evidenceId}`]: role,
      }).reviews.find((x) => x.validity === "current");
      expect(current?.edits, role).toEqual({
        evidenceRoles: [{ evidenceId: supporting.evidenceId, role }],
      });
    }
    // The rule of the form, said on the page: an edit that changes nothing, and a reject or an
    // escalation with no reason, are refused by the store and not recorded.
    const before = r.w.services.runs.finding(r.reviewerAm, finding.issue.findingId).reviews.length;
    expect(() =>
      decide({ decision: "edit", reasonCode: "other", reason: "Nothing changed." }),
    ).toThrow(/edit/);
    expect(() => decide({ decision: "reject", reasonCode: "other", reason: "" })).toThrow(/reason/);
    expect(() => decide({ decision: "escalate", reason: "   " })).toThrow(/reason/);
    expect(r.w.services.runs.finding(r.reviewerAm, finding.issue.findingId).reviews).toHaveLength(
      before,
    );
  });
});
