import { describe, expect, it } from "vitest";
import { urls } from "../../src/server/urls.js";
import { CONFIRM_VALUE, FIELDS } from "../../src/server/pages/forms.js";
import { RUN_ALREADY_ACTIVE } from "../../src/server/pages/matter.js";
import type { DocumentView } from "../../src/services/views.js";
import { checkInvariants } from "./invariants.js";
import {
  all,
  attr,
  byId,
  byTag,
  controls,
  first,
  forms,
  formsTo,
  hasAttr,
  hasClass,
  readable,
  section,
  withClass,
  type El,
} from "./html.js";
import { matterPage } from "./render.js";
import {
  IDS,
  SHAS,
  buildDocuments,
  buildMatterSummary,
  buildMatterView,
  buildMatterViewFor,
  buildMemo,
  buildNotReadyMatterView,
  buildRunSummary,
  buildRunningMatterView,
  buildStaleMatterView,
  buildUsers,
} from "./support.js";

const M = IDS.matter;
const page = (view = buildMatterView(), options = {}) => checkInvariants(matterPage(view, options));
const signOutOnly = (root: El): boolean =>
  forms(root).every((f) => attr(f, "action") === urls.session());

describe("MatterPage header", () => {
  const root = page();

  it("names the matter, its status, the client and the user's role", () => {
    expect(readable(first(root, (el) => el.name === "h1"))).toBe("Lanternfish / Corvane NDA");
    const meta = withClass(root, "matter-meta")[0]!;
    expect(readable(meta)).toContain("In review");
    expect(readable(meta)).toContain("Our client: Lanternfish Software, Inc.");
    expect(readable(meta)).toContain("Your role: Associate");
  });

  it("links back to the matters list", () => {
    const crumbs = first(root, (el) => hasClass(el, "crumbs"));
    expect(
      attr(
        first(crumbs, (el) => el.name === "a"),
        "href",
      ),
    ).toBe(urls.matters());
  });
});

describe("MatterPage documents (screen S1)", () => {
  const root = page();

  it("shows one card per document with its label, title and kind", () => {
    const cards = byTag(root, "article").filter((a) => hasClass(a, "document"));
    expect(cards).toHaveLength(2);
    expect(readable(first(cards[0]!, (el) => el.name === "h3"))).toBe("D1 Mutual NDA");
    expect(readable(cards[0]!)).toContain("NDA");
    expect(readable(first(cards[1]!, (el) => el.name === "h3"))).toBe("D2 Amendment No. 1");
    expect(readable(cards[1]!)).toContain("Amendment");
  });

  it("shows the file type, size and a short hash, with the whole hash on hover", () => {
    const text = readable(section(root, "documents"));
    expect(text).toContain("DOCX, 14 KB");
    expect(text).toContain("TXT, 2.1 KB");
    const hash = first(root, (el) => el.name === "code" && readable(el) === SHAS.nda.slice(0, 8));
    expect(attr(hash, "title")).toBe(SHAS.nda);
  });

  it("gives every version an operative radio, checked for the operative one", () => {
    const radios = controls(root, FIELDS.versionId);
    expect(radios).toHaveLength(2);
    for (const radio of radios) {
      expect(attr(radio, "type")).toBe("radio");
      expect(hasAttr(radio, "checked")).toBe(true);
    }
    expect(radios.map((r) => attr(r, "value"))).toEqual([IDS.ndaV1, IDS.amendmentV1]);
  });

  it("puts each document's radios in one form that posts to that document's operative URL", () => {
    for (const [docId, versionId] of [
      [IDS.nda, IDS.ndaV1],
      [IDS.amendment, IDS.amendmentV1],
    ] as const) {
      const form = formsTo(root, urls.operative(M, docId))[0]!;
      const radio = controls(form, FIELDS.versionId)[0]!;
      expect(attr(radio, "value")).toBe(versionId);
    }
  });

  it("lets a version be made operative when a document has two versions", () => {
    const docs: DocumentView[] = buildDocuments();
    const nda = docs[0]!;
    nda.versions = [
      { ...nda.versions[0]!, operative: false },
      {
        ...nda.versions[0]!,
        versionId: "dv_d1v2",
        versionNo: 2,
        operative: true,
        statedDate: null,
      },
    ];
    const r = page(buildMatterView({ documents: docs }));
    const form = formsTo(r, urls.operative(M, IDS.nda))[0]!;
    const radios = controls(form, FIELDS.versionId);
    expect(radios.map((x) => hasAttr(x, "checked"))).toEqual([false, true]);
    expect(radios.map((x) => attr(x, "value"))).toEqual([IDS.ndaV1, "dv_d1v2"]);
    // Only one radio group per document, so only one version can be chosen.
    expect(new Set(radios.map((x) => attr(x, "name"))).size).toBe(1);
  });

  it("edits a stated date in place through a form that follows the table", () => {
    const dateInputs = controls(root, FIELDS.statedDate).filter((c) => hasAttr(c, "form"));
    expect(dateInputs.map((i) => attr(i, "value"))).toEqual(["2026-02-02", "2026-09-15"]);
    for (const [input, versionId] of [
      [dateInputs[0]!, IDS.ndaV1],
      [dateInputs[1]!, IDS.amendmentV1],
    ] as const) {
      const form = byId(root, attr(input, "form")!)!;
      expect(form.name).toBe("form");
      expect(attr(form, "action")).toBe(urls.statedDate(M, versionId));
      // A form cannot be inside another form.
      const outer = forms(root).filter((f) => f !== form && all(f, (e) => e === form).length > 0);
      expect(outer).toHaveLength(0);
    }
    const saves = byTag(root, "button").filter((b) => readable(b) === "Save date");
    expect(saves).toHaveLength(2);
    expect(saves.map((b) => attr(b, "form"))).toEqual(dateInputs.map((i) => attr(i, "form")));
  });

  it("has no form inside another form", () => {
    for (const form of forms(root)) {
      expect(forms(form).filter((f) => f !== form)).toHaveLength(0);
    }
  });

  it("offers a new version upload per document, as multipart with a file and a stated date", () => {
    const form = formsTo(root, urls.versions(M, IDS.nda))[0]!;
    expect(attr(form, "enctype")).toBe("multipart/form-data");
    const file = controls(form, FIELDS.file)[0]!;
    expect(attr(file, "type")).toBe("file");
    expect(attr(file, "accept")).toBe(".docx,.txt");
    expect(hasAttr(file, "required")).toBe(true);
    expect(controls(form, FIELDS.statedDate)).toHaveLength(1);
  });

  it("offers removal behind a confirmation checkbox", () => {
    const form = formsTo(root, urls.documentRemove(M, IDS.amendment))[0]!;
    const box = controls(form, FIELDS.confirm)[0]!;
    expect(attr(box, "type")).toBe("checkbox");
    expect(attr(box, "value")).toBe(CONFIRM_VALUE);
    expect(hasAttr(box, "required")).toBe(true);
    expect(readable(form)).toContain("D2");
    const details = all(
      root,
      (el) => el.name === "details" && all(el, (c) => c === form).length > 0,
    );
    expect(details).toHaveLength(1);
  });

  it("offers removal for the last document only, and tells the others what has to go first", () => {
    // The service refuses to take a document out while a later one stands, so a form for it
    // would only ever fail.
    expect(formsTo(root, urls.documentRemove(M, IDS.nda))).toHaveLength(0);
    expect(formsTo(root, urls.documentRemove(M, IDS.amendment))).toHaveLength(1);
    const card = all(root, (el) => el.name === "article" && hasClass(el, "document"))[0]!;
    expect(readable(card)).toContain("To remove D1, remove the documents after it first.");
    const single = page(buildMatterView({ documents: buildDocuments().slice(0, 1) }));
    expect(formsTo(single, urls.documentRemove(M, IDS.nda))).toHaveLength(1);
  });
});

describe("MatterPage add-a-document form", () => {
  it("posts title, kind, stated date and file to the documents URL", () => {
    const root = page(buildMatterView({ documents: [] }));
    const form = formsTo(root, urls.documents(M))[0]!;
    expect(attr(form, "enctype")).toBe("multipart/form-data");
    for (const name of [FIELDS.title, FIELDS.kind, FIELDS.statedDate, FIELDS.file]) {
      expect(controls(form, name), name).toHaveLength(1);
    }
    // The NDA comes first: the service refuses an amendment on a matter that has none.
    const kinds = byTag(controls(form, FIELDS.kind)[0]!, "option").map((o) => attr(o, "value"));
    expect(kinds).toEqual(["nda"]);
  });

  it("offers only amendments once the matter has an NDA", () => {
    const docs = buildDocuments().slice(0, 1);
    const root = page(buildMatterView({ documents: docs }));
    const form = formsTo(root, urls.documents(M))[0]!;
    const kinds = byTag(controls(form, FIELDS.kind)[0]!, "option").map((o) => attr(o, "value"));
    expect(kinds).toEqual(["amendment"]);
  });

  it("offers no form when the matter is full, and says why", () => {
    const docs = buildDocuments();
    docs.push({
      ...docs[1]!,
      documentId: "doc_d3",
      label: "D3",
      title: "Amendment No. 2",
      versions: [{ ...docs[1]!.versions[0]!, versionId: "dv_d3v1" }],
    });
    const root = page(buildMatterView({ documents: docs }));
    expect(formsTo(root, urls.documents(M))).toHaveLength(0);
    expect(readable(root)).toContain("one NDA and up to two amendments");
  });

  it("says so when there are no documents yet", () => {
    const root = page(buildMatterView({ documents: [] }));
    expect(readable(section(root, "documents"))).toContain("No documents yet");
  });
});

describe("MatterPage warnings", () => {
  it("explains an instruction-like paragraph in plain words, and names where it is", () => {
    const root = page();
    const warnings = section(root, "warnings");
    // The page must not promise what Parol cannot show: that a model ignored the paragraph.
    expect(readable(warnings)).toContain(
      "This paragraph reads like an instruction to software. The review gives it to the model as document text, and Parol cannot show that a model ignored it.",
    );
    expect(readable(warnings)).not.toContain("cannot change anything");
    expect(readable(warnings)).toContain("D1-p22 in Mutual NDA (D1)");
    expect(readable(warnings)).toContain("Reads like an instruction to software");
  });

  it("explains each other warning kind", () => {
    const root = page(
      buildMatterView({
        warnings: [
          {
            code: "duplicate_document",
            documentLabel: "D2",
            spanLabel: null,
            detail: "same text as D1",
          },
          { code: "near_duplicate_version", documentLabel: "D1", spanLabel: null, detail: "" },
          {
            code: "unreviewed_content",
            documentLabel: "D1",
            spanLabel: null,
            detail: "2 footnotes, 1 comment",
          },
          { code: "no_reviewable_text", documentLabel: null, spanLabel: null, detail: "" },
        ],
      }),
    );
    const text = readable(section(root, "warnings"));
    expect(text).toContain("same text as another document");
    expect(text).toContain("almost the same as the version before it");
    expect(text).toContain("footnotes, headers, hidden text or comments");
    expect(text).toContain("no text that can be reviewed");
    expect(text).toContain("Amendment No. 1 (D2)");
    expect(text).toContain("Detail: 2 footnotes, 1 comment");
  });

  it("is absent when there is nothing to warn about", () => {
    const root = page(buildMatterView({ warnings: [] }));
    expect(all(root, (el) => attr(el, "id") === "warnings")).toHaveLength(0);
  });
});

describe("MatterPage settings", () => {
  it("lets the associate change the client name and playbook", () => {
    const root = page();
    const form = formsTo(root, urls.matterSettings(M))[0]!;
    const client = controls(form, FIELDS.clientLegalName)[0]!;
    expect(attr(client, "value")).toBe("Lanternfish Software, Inc.");
    const select = controls(form, FIELDS.playbookVersionId)[0]!;
    const selected = byTag(select, "option").filter((o) => hasAttr(o, "selected"));
    expect(selected.map((o) => attr(o, "value"))).toEqual([IDS.playbookVersion]);
    expect(readable(form)).toContain("makes earlier results out of date");
  });

  it("asks for a playbook when none is pinned", () => {
    const root = page(buildMatterView({ matter: buildMatterSummary({ playbook: null }) }));
    const select = controls(
      formsTo(root, urls.matterSettings(M))[0]!,
      FIELDS.playbookVersionId,
    )[0]!;
    const options = byTag(select, "option");
    expect(readable(options[0]!)).toBe("Choose a playbook");
    expect(options.some((o) => hasAttr(o, "selected"))).toBe(false);
  });

  it("is read only for a reviewer", () => {
    const root = page(buildMatterViewFor("reviewer"), { canDelete: false });
    expect(formsTo(root, urls.matterSettings(M))).toHaveLength(0);
    expect(readable(section(root, "settings"))).toContain("Lanternfish Software, Inc.");
    expect(readable(section(root, "settings"))).toContain("parol-nda-recipient 1.0.0");
  });
});

describe("MatterPage start button", () => {
  it("shows where text goes, from the generator's disclosure", () => {
    const root = page();
    expect(readable(section(root, "start"))).toContain(
      "Where document text is sent. Text will be sent to: Anthropic API (api.anthropic.com).",
    );
  });

  it("is enabled when the matter is ready", () => {
    const root = page();
    const form = formsTo(root, urls.runs(M))[0]!;
    const button = first(form, (el) => el.name === "button");
    expect(readable(button)).toBe("Re-run review");
    expect(hasAttr(button, "disabled")).toBe(false);
    const fresh = page(buildMatterView({ runs: [], currentRun: null }));
    const button2 = first(formsTo(fresh, urls.runs(M))[0]!, (el) => el.name === "button");
    expect(readable(button2)).toBe("Start review");
    expect(hasAttr(button2, "disabled")).toBe(false);
  });

  it("is disabled with every reason listed when the matter is not ready", () => {
    const root = page(buildNotReadyMatterView());
    const button = first(formsTo(root, urls.runs(M))[0]!, (el) => el.name === "button");
    expect(hasAttr(button, "disabled")).toBe(true);
    const reasons = byId(root, "start-reasons")!;
    expect(attr(button, "aria-describedby")).toBe("start-reasons");
    expect(byTag(reasons, "li").map((li) => readable(li))).toEqual([
      "Add the NDA",
      "Choose which version of the NDA is operative",
      "Choose an approved playbook",
    ]);
  });

  it("is disabled, with a reason, while a review is running", () => {
    const root = page(buildRunningMatterView());
    const button = first(formsTo(root, urls.runs(M))[0]!, (el) => el.name === "button");
    expect(hasAttr(button, "disabled")).toBe(true);
    expect(byTag(byId(root, "start-reasons")!, "li").map((li) => readable(li))).toEqual([
      RUN_ALREADY_ACTIVE,
    ]);
  });

  it("does not list the reason twice when the service already gives it", () => {
    const running = buildRunningMatterView();
    const root = page({
      ...running,
      start: { ready: false, reasons: [RUN_ALREADY_ACTIVE] },
    });
    expect(byTag(byId(root, "start-reasons")!, "li").map((li) => readable(li))).toEqual([
      RUN_ALREADY_ACTIVE,
    ]);
  });

  it("is disabled with a fixed reason when the service gives none", () => {
    const root = page(buildMatterView({ start: { ready: false, reasons: [] } }));
    const button = first(formsTo(root, urls.runs(M))[0]!, (el) => el.name === "button");
    expect(hasAttr(button, "disabled")).toBe(true);
    expect(readable(byId(root, "start-reasons")!)).toContain(
      "The matter is not ready for a review",
    );
  });

  it("is not offered to a reviewer, who is told who can start one", () => {
    const root = page(buildMatterViewFor("reviewer"), { canDelete: false });
    expect(formsTo(root, urls.runs(M))).toHaveLength(0);
    expect(readable(section(root, "start"))).toContain(
      "Only the associate on the matter can start a review",
    );
  });
});

describe("MatterPage running review", () => {
  const root = page(buildRunningMatterView());
  const live = withClass(root, "progress-box")[0]!;

  it("shows progress in a polite live region", () => {
    expect(attr(live, "role")).toBe("status");
    expect(attr(live, "aria-live")).toBe("polite");
    expect(readable(live)).toContain("Analyzing rules: 3 of 8");
    const bar = first(live, (el) => el.name === "progress");
    expect(attr(bar, "value")).toBe("3");
    expect(attr(bar, "max")).toBe("8");
    expect(attr(bar, "aria-label")).toBe("Review progress");
  });

  it("names the status route the script polls", () => {
    expect(attr(live, "data-status-url")).toBe(`/matters/${IDS.matter}/runs/${IDS.run}/status`);
    expect(attr(live, "data-run-status")).toBe("analyzing");
  });

  it("has an indeterminate bar before progress is known", () => {
    const queued = buildRunSummary({ status: "queued", progress: null, finishedAt: null });
    const r = page(buildMatterView({ activeRun: queued, currentRun: null, runs: [queued] }));
    const bar = first(r, (el) => el.name === "progress");
    expect(hasAttr(bar, "value")).toBe(false);
    expect(readable(withClass(r, "progress-box")[0]!)).toContain("Queued");
  });

  it("lets the associate cancel it", () => {
    expect(formsTo(root, urls.runCancel(M, IDS.run)).length).toBeGreaterThan(0);
  });
});

describe("MatterPage stale banner", () => {
  const view = buildStaleMatterView();

  it("says results are out of date, gives the reason, and offers a re-run", () => {
    const root = page(view);
    const banner = withClass(root, "banner-stale")[0]!;
    expect(readable(banner)).toContain("Results are out of date");
    expect(readable(banner)).toContain(
      "Amendment No. 1 has a new version that the last review did not read.",
    );
    const form = first(banner, (el) => el.name === "form");
    expect(attr(form, "action")).toBe(urls.runs(M));
    expect(readable(first(form, (el) => el.name === "button"))).toBe("Re-run review");
  });

  it("offers no re-run button in the banner when the matter cannot start", () => {
    const root = page({
      ...view,
      start: { ready: false, reasons: ["Choose an approved playbook"] },
    });
    const banner = withClass(root, "banner-stale")[0]!;
    expect(byTag(banner, "form")).toHaveLength(0);
    expect(readable(banner)).toContain("can be run again once everything needed is in place");
  });

  it("does not show the banner when results are current", () => {
    expect(withClass(page(), "banner-stale")).toHaveLength(0);
  });

  it("does not offer a re-run to a reviewer", () => {
    const root = page(
      { ...view, matter: { ...view.matter, role: "reviewer" } },
      { canDelete: false },
    );
    expect(byTag(withClass(root, "banner-stale")[0]!, "form")).toHaveLength(0);
  });
});

describe("MatterPage reviews and memos", () => {
  it("lists the reviews with a link to open the issue table", () => {
    const root = page();
    const open = first(root, (el) => el.name === "a" && readable(el) === "Open the issue table");
    expect(attr(open, "href")).toBe(urls.run(M, IDS.run));
    const table = byTag(section(root, "runs"), "table")[0]!;
    expect(readable(table)).toContain("Finished");
    expect(readable(table)).toContain("Current");
    expect(readable(table)).toContain("8 findings");
    expect(readable(table)).toContain("parol-nda-recipient 1.0.0");
    expect(readable(table)).toContain("test-model-2026-10");
  });

  it("marks a finished review whose inputs changed as out of date", () => {
    const old = buildRunSummary({ current: false });
    const root = page(buildMatterView({ runs: [old], currentRun: null }));
    expect(readable(byTag(section(root, "runs"), "table")[0]!)).toContain("Out of date");
  });

  it("offers Resume for a failed review on the matter's current inputs and says what went wrong", () => {
    const failed = buildRunSummary({ status: "failed", errorKind: "interrupted", current: true });
    const root = page(buildMatterView({ runs: [failed], currentRun: null }));
    const form = formsTo(root, urls.runResume(M, IDS.run))[0]!;
    expect(readable(first(form, (el) => el.name === "button"))).toBe("Resume");
    expect(readable(section(root, "runs"))).toContain(
      "The server stopped while the review was running",
    );
  });

  it("offers no Resume for a failed review whose inputs changed, which the service would refuse", () => {
    const failed = buildRunSummary({ status: "failed", errorKind: "interrupted", current: false });
    const root = page(buildMatterView({ runs: [failed], currentRun: null }));
    expect(formsTo(root, urls.runResume(M, IDS.run))).toHaveLength(0);
    expect(readable(section(root, "runs"))).toContain("Out of date, start a new review");
  });

  it("counts the findings of a review that was superseded, and says none yet only when there are none", () => {
    // Found in a real browser walk-through: after a new amendment version the stale review showed
    // "None yet" in the Findings column although it held eight findings.
    const superseded = buildRunSummary({ status: "superseded", current: false, findingCount: 8 });
    const running = buildRunSummary({
      id: "run_running",
      status: "analyzing",
      current: false,
      findingCount: 0,
    });
    const root = page(buildMatterView({ runs: [running, superseded], currentRun: null }));
    const cells = all(
      first(section(root, "runs"), (el) => el.name === "tbody"),
      (el) => el.name === "tr",
    ).map((row) => readable(row));
    expect(cells[0]).toContain("None yet");
    expect(cells[1]).toContain("8 findings");
    expect(cells[1]).not.toContain("None yet");
  });

  it("says so when no review has run", () => {
    const root = page(buildMatterView({ runs: [], currentRun: null }));
    expect(readable(section(root, "runs"))).toContain("No review has been run yet");
  });

  it("lists memos with a download link, status and fingerprint", () => {
    const memo = buildMemo();
    const old = buildMemo({ memoId: "memo_old", status: "superseded", fileName: "old.docx" });
    const root = page(buildMatterViewFor("reviewer", { memos: [memo, old] }), { canDelete: false });
    const table = byTag(section(root, "memos"), "table")[0]!;
    const link = first(table, (el) => el.name === "a" && readable(el) === memo.fileName);
    expect(attr(link, "href")).toBe(urls.memoFile(M, memo.memoId));
    expect(readable(table)).toContain("Current");
    expect(readable(table)).toContain("Superseded");
    expect(readable(table)).toContain("D. Whitfield");
    expect(readable(table)).toContain(SHAS.memo.slice(0, 12));
  });

  it("offers the export button to the reviewer once every finding has a decision", () => {
    const root = page(
      buildMatterViewFor("reviewer", {
        matter: buildMatterSummary({ status: "review_complete", role: "reviewer" }),
      }),
      { canDelete: false },
    );
    const form = formsTo(root, urls.memos(M))[0]!;
    const button = first(form, (el) => el.name === "button");
    expect(readable(button)).toBe("Export memo");
    expect(hasAttr(button, "disabled")).toBe(false);
  });

  it("does not offer export to an associate or a viewer, and says who can", () => {
    for (const role of ["associate", "viewer"] as const) {
      const root = page(buildMatterViewFor(role), { canDelete: false });
      expect(formsTo(root, urls.memos(M)), role).toHaveLength(0);
      expect(readable(section(root, "memos"))).toContain(
        "Only the reviewing attorney can export a memo",
      );
    }
  });

  it("lets an associate export when one person may prepare and review", () => {
    const root = page(buildMatterViewFor("associate", { segregationRelaxed: true }), {
      canDelete: false,
    });
    expect(formsTo(root, urls.memos(M))).toHaveLength(1);
  });

  it("disables export, with the reason beside it, when there is nothing to export", () => {
    const stale = buildStaleMatterView();
    const root = page(
      { ...stale, matter: { ...stale.matter, role: "reviewer" } },
      { canDelete: false },
    );
    const form = formsTo(root, urls.memos(M))[0]!;
    const button = first(form, (el) => el.name === "button");
    expect(hasAttr(button, "disabled")).toBe(true);
    // A matter made stale by a new document says so, and not that no review exists.
    expect(readable(byId(root, attr(button, "aria-describedby")!)!)).toContain(
      "The results are out of date",
    );
    const draft = buildMatterViewFor("reviewer", {
      matter: buildMatterSummary({ status: "ready", role: "reviewer" }),
    });
    const root2 = page(draft, { canDelete: false });
    const b2 = first(formsTo(root2, urls.memos(M))[0]!, (el) => el.name === "button");
    expect(hasAttr(b2, "disabled")).toBe(true);
    expect(readable(root2)).toContain("The review is not ready to export yet");
  });
});

describe("MatterPage people and deletion", () => {
  it("lists members with their roles and explains segregation", () => {
    const root = page();
    const text = readable(section(root, "people"));
    expect(text).toContain("A. Ruiz");
    expect(text).toContain("Reviewing attorney");
    expect(text).toContain("different person from the associate");
    const relaxed = page(buildMatterView({ segregationRelaxed: true }));
    expect(readable(section(relaxed, "people"))).toContain(
      "One person may both prepare and review",
    );
  });

  it("offers to add only people who are not yet members, with reviewer preselected", () => {
    const root = page();
    const form = formsTo(root, urls.members(M))[0]!;
    const people = byTag(controls(form, FIELDS.memberUserId)[0]!, "option").map((o) =>
      attr(o, "value"),
    );
    expect(people).toEqual(["u_okafor", "u_lindqvist"]);
    const roles = byTag(controls(form, FIELDS.memberRole)[0]!, "option");
    expect(roles.filter((o) => hasAttr(o, "selected")).map((o) => attr(o, "value"))).toEqual([
      "reviewer",
    ]);
  });

  it("hides the add form without a user list, and from non-associates", () => {
    expect(formsTo(page(buildMatterView(), { users: false }), urls.members(M))).toHaveLength(0);
    expect(
      formsTo(page(buildMatterViewFor("reviewer"), { canDelete: false }), urls.members(M)),
    ).toHaveLength(0);
    expect(buildUsers().length).toBeGreaterThan(2);
  });

  it("offers deletion only when the route says the user may, behind a confirmation", () => {
    const withDelete = page(buildMatterView(), { canDelete: true });
    const form = formsTo(withDelete, urls.matterDelete(M))[0]!;
    expect(attr(controls(form, FIELDS.confirm)[0]!, "value")).toBe(CONFIRM_VALUE);
    expect(hasAttr(controls(form, FIELDS.confirm)[0]!, "required")).toBe(true);
    const without = page(buildMatterView(), { canDelete: false });
    expect(formsTo(without, urls.matterDelete(M))).toHaveLength(0);
  });
});

describe("MatterPage for a viewer", () => {
  it("has no form to change anything, only the sign-out form", () => {
    const root = page(buildMatterViewFor("viewer"), { canDelete: false });
    expect(signOutOnly(root)).toBe(true);
    expect(byTag(root, "textarea")).toHaveLength(0);
    expect(all(root, (el) => el.name === "input" && attr(el, "type") === "file")).toHaveLength(0);
  });

  it("still shows documents, warnings, reviews and memos", () => {
    const root = page(buildMatterViewFor("viewer", { memos: [buildMemo()] }), { canDelete: false });
    expect(byTag(root, "article").filter((a) => hasClass(a, "document"))).toHaveLength(2);
    expect(readable(root)).toContain("reads like an instruction to software");
    expect(readable(root)).toContain(buildMemo().fileName);
    expect(readable(root)).toContain("Operative");
  });
});

describe("MatterPage for a reviewer", () => {
  it("cannot upload or change documents", () => {
    const root = page(buildMatterViewFor("reviewer"), { canDelete: false });
    expect(controls(root, FIELDS.versionId)).toHaveLength(0);
    expect(all(root, (el) => el.name === "input" && attr(el, "type") === "file")).toHaveLength(0);
    expect(readable(section(root, "documents"))).toContain("DOCX, 14 KB");
  });
});
