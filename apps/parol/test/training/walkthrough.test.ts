import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { start, type RunningServer } from "../../src/main.js";
import { runSeed, type SeedReport } from "../../src/seed.js";
import { FIELDS } from "../../src/server/pages/forms.js";
import { WORKFLOW_FIELD } from "../../src/server/pages/matter.js";
import { urls } from "../../src/server/urls.js";
import { DEMO_USER_IDS } from "../../src/store/index.js";
import { TRAINING_STEPS, trainedUserIds } from "../../src/training/index.js";
import { all, attr, byId, byTag, readable, signature, withClass, type El } from "../pages/html.js";
import { Walker, unreachable, type Fetched } from "./walk-support.js";

/**
 * The acceptance test of the training exercise (package W2.8): a new user can do the exercise from
 * the quickstart alone. The server runs on a socket with the simulated reader, the data folder is
 * seeded with `--training`, and a script plays Alex (associate), Dana (reviewing attorney) and Lee
 * (the trainer) through the seven steps by following only the links and forms that the pages offer.
 * A link is found by the words it has on the page it is on, a form is read from the page and filled
 * in only in the fields it has, and every link followed and every button pressed is checked to be
 * a Tab stop with a name.
 *
 * What this does and does not show. It shows that the exercise can be done from the pages, by a
 * script. No person has done it and nobody has timed it, and the planted finding is the simulated
 * reader's script, a program and not a language model, so it measures nothing about any model.
 * Every document, party and person is synthetic.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const roots: string[] = [];
const servers: RunningServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Demo {
  server: RunningServer;
  seeded: SeedReport;
  matterId: string;
  walker(name: string): Walker;
}

async function boot(): Promise<Demo> {
  const root = mkdtempSync(join(tmpdir(), "parol-training-walk-"));
  roots.push(root);
  const env = {
    PAROL_DEMO_IDENTITY: "1",
    PAROL_SCRIPTED: "1",
    PAROL_PORT: "0",
    PAROL_DATA_DIR: join(root, "data"),
    PAROL_COOKIE_SECRET: "training-walkthrough-secret-0123456789abcdef",
  };
  const seeded = await runSeed(env, ["--training"], () => {});
  const server = await start(env, { log: () => {}, notice: () => {} });
  servers.push(server);
  expect(seeded.training, "the seed made the training matter").not.toBeNull();
  return {
    server,
    seeded,
    matterId: seeded.training!.matterId,
    walker: (name) => new Walker(`http://127.0.0.1:${server.port}`, name),
  };
}

async function idle(server: RunningServer, matterId: string): Promise<void> {
  for (let i = 0; i < 800; i++) {
    if (server.repo.getActiveRun(matterId) === undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the review did not finish");
}

/** The inspector of a finding, by the words of its row's link on the page of a review. */
const openFinding = (who: Walker, run: Fetched, title: string): Promise<Fetched> =>
  who.follow(run, title);

/** The form that posts a decision on the finding open on the page. */
const decisionForm = (who: Walker, pane: Fetched): El => {
  const found = who.formsWhere(pane, (action) => /\/findings\/[^/]+\/reviews$/.test(action));
  expect(found, `${who.name}: one decision form on ${pane.path}`).toHaveLength(1);
  return found[0] as El;
};

/** The row of the issue table for a rule, read as a reader reads it. */
function rowOf(page: Fetched, title: string): string {
  const row = byTag(page.root, "tr").find((tr) => readable(tr).includes(title));
  expect(row, `a row for "${title}" on ${page.path}`).toBeDefined();
  return readable(row as El);
}

/**
 * The markup of a finding's pane without its text: every section of the pane but the one that
 * quotes the playbook rule, which differs from rule to rule.
 */
function findingMarkup(pane: Fetched): string {
  const inspector = byId(pane.root, "inspector") as El;
  const sections = all(
    inspector,
    (el) =>
      el.name === "section" &&
      attr(el, "aria-labelledby") !== undefined &&
      !readable(byTag(el, "h3")[0] ?? el).startsWith("Playbook rule"),
  );
  expect(sections.length, `the sections of the pane on ${pane.path}`).toBeGreaterThan(3);
  return [byTag(inspector, "header")[0] as El, ...sections].map((el) => signature(el)).join(" | ");
}

/** The text of a progress table on a matter page, from the sentence to the last row. */
function progressOf(page: Fetched): string {
  const section = byId(page.root, "training-progress") as El;
  expect(section, `a training progress section on ${page.path}`).toBeDefined();
  return readable(section);
}

/** Every title of the issue table in order. */
const TITLES = [
  "Duration of confidentiality obligations",
  "Four standard exclusions",
  "Scope of Confidential Information",
  "Governing law and forum",
  "Disclosure to representatives",
  "Disclosure required by law",
  "Parties correctly identified",
  "Return or destruction of information",
] as const;
const PLANTED = "Disclosure to representatives";
const DUR = "Duration of confidentiality obligations";

const REASON = "The cited clause only defines a term and says nothing about representatives.";
const ESCALATION = "The amendment reverses an agreed term, so a partner should see it.";

describe("the training exercise, walked through the pages", () => {
  it("can be done from the quickstart alone, step by step, and finishes with the rejected finding in the memo", async () => {
    const demo = await boot();
    const { server, matterId } = demo;
    const visitor = demo.walker("visitor");
    const alex = demo.walker("Alex");
    const dana = demo.walker("Dana");
    await alex.signIn(DEMO_USER_IDS.associate);
    await dana.signIn(DEMO_USER_IDS.reviewer);

    // --- 1. A visitor reads the quickstart: the ten steps and the seven, the way to sign in, no key.
    const visited = await visitor.get(urls.quickstart());
    expect(visited.response.status).toBe(200);
    expect(byTag(withClass(visited.root, "quickstart-steps")[0] as El, "li")).toHaveLength(10);
    expect(byTag(withClass(visited.root, "training-steps")[0] as El, "li")).toHaveLength(7);
    expect(visited.text).toContain("Sign in first.");
    visitor.link(visited, "Choose a demo identity");
    for (const step of TRAINING_STEPS)
      expect(visited.text.toLowerCase()).not.toContain(step.key.toLowerCase());

    // --- 2. Alex follows the quickstart to the matter. Step 1: the intake is as the step says.
    const quickstart = await alex.get(urls.quickstart());
    const opened = await alex.follow(quickstart, "Open the training matter");
    expect(opened.path).toBe(urls.matter(matterId));
    const intake = opened.root;
    expect(readable(byTag(intake, "h1")[0] as El)).toBe(
      "Training: Lanternfish / Corvane NDA (T01)",
    );
    // The two documents with their stated dates, both operative.
    const dates = all(
      intake,
      (el) =>
        el.name === "input" &&
        attr(el, "name") === FIELDS.statedDate &&
        (attr(el, "form") ?? "").startsWith("date-form-"),
    );
    expect(dates.map((el) => attr(el, "value"))).toEqual(["2026-02-02", "2026-09-15"]);
    expect(withClass(intake, "chip").filter((c) => readable(c) === "Operative")).toHaveLength(2);
    expect(opened.text).toContain("Mutual NDA (training T01)");
    expect(opened.text).toContain("Amendment No. 1 (training T01)");
    // The playbook version, and the line that says where document text is sent.
    expect(opened.text).toContain(`Parol NDA (Recipient) ${demo.seeded.playbook.version}`);
    expect(TRAINING_STEPS[0]!.key).toContain(`playbook ${demo.seeded.playbook.version}`);
    const destination = readable(withClass(intake, "destination")[0] as El);
    expect(destination).toContain("Where document text is sent");
    expect(destination).toContain("simulated reader");
    expect(destination).toContain("not a language model");
    expect(destination).toContain("nothing is sent anywhere");
    // The banner of the training matter, and the progress: step 1 is set up, none of five done.
    const banner = readable(withClass(intake, "banner-training")[0] as El);
    expect(banner).toContain("simulated reader, a program with a script, not a language model");
    expect(progressOf(opened)).toContain("0 of those 5 are done");
    expect(progressOf(opened)).toContain("Step 1: Check the intakeSet up for you");

    // --- 3. Step 2: the warning on the NDA, at its paragraph.
    expect(opened.text).toContain("Reads like an instruction to software");
    expect(opened.text).toContain("D1-p1 in Mutual NDA (training T01) (D1)");

    // --- 4. Step 3: a review with workflow v2, from the form the page offers.
    const startForm = alex.formsWhere(opened, (a) => a === urls.runs(matterId))[0] as El;
    const picker = alex
      .controlsOf(opened, startForm)
      .find((el) => attr(el, "name") === WORKFLOW_FIELD) as El;
    expect(byTag(picker, "option").map((o) => attr(o, "value"))).toContain("v2");
    const started = await alex.submit(opened, startForm, "Start review", {
      [WORKFLOW_FIELD]: "v2",
    });
    expect(started.status).toBe(303);
    await idle(server, matterId);
    const afterStart = await alex.get(urls.matter(matterId));
    expect(progressOf(afterStart)).toContain("1 of those 5 are done");
    const run = await alex.follow(afterStart, "Open the issue table");
    expect(run.path).toMatch(new RegExp(`^${urls.matter(matterId)}/runs/[^/?]+$`));
    const runId = run.path.split("/").at(-1)!;
    expect(server.repo.getRun(matterId, runId)?.manifest.workflow.label).toBe("v2");
    // The review page carries the short banner, and says what read the documents.
    expect(readable(withClass(run.root, "banner-training")[0] as El)).toContain(
      "The simulated reader, a program with a script and not a language model",
    );
    // DUR-1: the amendment governs, and Section 6.1 is marked superseded.
    const durPane = await openFinding(alex, run, DUR);
    const durText = readable(byId(durPane.root, "inspector") as El);
    expect(durText).toMatch(
      /Amendment No\. 1 \(training T01\) \(v1\), Section 2, paragraph 3\s*Governing/,
    );
    expect(durText).toMatch(/Section 6\.1, paragraph 20\s*Superseded/);

    // --- 5. Dana, the reviewing attorney, reads the findings. The planted one and DEF-1 cite one passage.
    const danaMatter = await dana.get(urls.matter(matterId));
    const danaRun = await dana.follow(danaMatter, "Open the issue table");
    expect(danaRun.path).toBe(run.path);
    const panes = new Map<string, Fetched>();
    for (const title of TITLES) panes.set(title, await openFinding(dana, danaRun, title));
    const planted = readable(byId(panes.get(PLANTED)!.root, "inspector") as El);
    const scope = readable(
      byId(panes.get("Scope of Confidential Information")!.root, "inspector") as El,
    );
    // The places the pane names, each once (the pane says a place in its list and again beside its checks).
    const sectionOf = (text: string): string[] => [
      ...new Set([...text.matchAll(/\(v1\), (Section [\d.]+, paragraph \d+)/g)].map((m) => m[1]!)),
    ];
    expect(sectionOf(planted)).toEqual(["Section 1.2, paragraph 6"]);
    expect(sectionOf(scope)).toEqual(["Section 1.2, paragraph 6"]);
    expect(planted).toMatch(
      /Section 1\.2, paragraph 6\s*Governing\s*Quote found\s*Support not checked/,
    );
    // It looks like any other finding: the markup of its pane, apart from the playbook rule it
    // quotes (a rule may have a fallback and another not), is the markup of DEF-1's.
    expect(findingMarkup(panes.get(PLANTED)!)).toBe(
      findingMarkup(panes.get("Scope of Confidential Information")!),
    );
    expect(rowOf(danaRun, PLANTED)).toContain("Compliant");
    expect(rowOf(danaRun, PLANTED)).toContain("Not decided");

    // Dana rejects it with a reason and a reason code, through the form the pane offers.
    const rejectPane = panes.get(PLANTED)!;
    const rejected = await dana.submit(
      rejectPane,
      decisionForm(dana, rejectPane),
      "Save decision",
      { [FIELDS.decision]: "reject", [FIELDS.reason]: REASON },
      { [FIELDS.reasonCode]: "wrong_evidence" },
    );
    expect(rejected.status).toBe(303);
    const afterReject = await dana.get(run.path);
    expect(rowOf(afterReject, PLANTED)).toContain("Rejected");
    expect(progressOf(await alex.get(urls.matter(matterId)))).toContain("2 of those 5 are done");

    // --- 6. Step 5: Dana escalates DUR-1, with a reason.
    const escalatePane = await openFinding(dana, afterReject, DUR);
    const escalated = await dana.submit(
      escalatePane,
      decisionForm(dana, escalatePane),
      "Save decision",
      {
        [FIELDS.decision]: "escalate",
        [FIELDS.reason]: ESCALATION,
      },
    );
    expect(escalated.status).toBe(303);
    expect(rowOf(await dana.get(run.path), DUR)).toContain("Escalated");
    const afterEscalate = await alex.get(urls.matter(matterId));
    expect(progressOf(afterEscalate)).toContain("3 of those 5 are done");

    // --- 7. Step 6: Alex changes the stated date of the amendment, from the matter page.
    const dateForms = alex.formsWhere(afterEscalate, (a) => a.endsWith("/stated-date"));
    expect(dateForms).toHaveLength(2);
    const amendmentForm = dateForms[1] as El;
    const dated = await alex.submit(afterEscalate, amendmentForm, "Save date", {
      [FIELDS.statedDate]: "2026-10-01",
    });
    expect(dated.status).toBe(303);
    const stale = await alex.get(urls.matter(matterId));
    expect(stale.text).toContain("Results are out of date");
    expect(progressOf(stale)).toContain("4 of those 5 are done");
    const danaStale = await dana.get(run.path);
    for (const title of TITLES) expect(rowOf(danaStale, title), title).toContain("Out of date");
    // The memo cannot be exported: the button is there, disabled, with its reason.
    const danaStaleMatter = await dana.get(urls.matter(matterId));
    const exportForm = dana.formTo(danaStaleMatter, urls.memos(matterId));
    const exportButton = dana.button(danaStaleMatter, exportForm, "Export memo");
    expect(attr(exportButton, "disabled")).not.toBeUndefined();
    expect(danaStaleMatter.text).toContain(
      "The results are out of date. Run the review again first.",
    );

    // --- 8. Step 7: run again with v2 from "Run the review again", decide all eight, export.
    // Two forms post to the runs address: the banner's, which posts no workflow, and the section's.
    const rerunForms = alex
      .formsWhere(stale, (a) => a === urls.runs(matterId))
      .filter((f) => alex.controlsOf(stale, f).some((el) => attr(el, "name") === WORKFLOW_FIELD));
    expect(rerunForms).toHaveLength(1);
    expect(stale.text).toContain("Run the review again");
    const again = await alex.submit(stale, rerunForms[0] as El, "Re-run review", {
      [WORKFLOW_FIELD]: "v2",
    });
    expect(again.status).toBe(303);
    await idle(server, matterId);
    const runs = server.repo.listRunsForMatter(matterId);
    expect(runs).toHaveLength(2);
    const second = runs[0]!;
    expect(second.manifest.workflow.label).toBe("v2");
    expect(second.id).not.toBe(runId);

    const danaAgain = await dana.get(urls.matter(matterId));
    const secondRun = await dana.follow(danaAgain, "Open the issue table");
    expect(secondRun.path.endsWith(second.id)).toBe(true);
    expect(
      byTag(secondRun.root, "tr").filter((tr) => readable(tr).includes("Not decided")),
    ).toHaveLength(8);
    expect(rowOf(secondRun, PLANTED)).toContain("Compliant");
    for (const title of TITLES) {
      const pane = await openFinding(dana, secondRun, title);
      const form = decisionForm(dana, pane);
      if (title === PLANTED)
        await dana.submit(
          pane,
          form,
          "Save decision",
          { [FIELDS.decision]: "reject", [FIELDS.reason]: REASON },
          { [FIELDS.reasonCode]: "wrong_evidence" },
        );
      else if (title === DUR)
        await dana.submit(pane, form, "Save decision", {
          [FIELDS.decision]: "escalate",
          [FIELDS.reason]: ESCALATION,
        });
      else await dana.submit(pane, form, "Save decision", { [FIELDS.decision]: "accept" });
    }
    const decided = await dana.get(secondRun.path);
    for (const title of TITLES) expect(rowOf(decided, title), title).not.toContain("Not decided");

    const readyMatter = await dana.get(urls.matter(matterId));
    const memoForm = dana.formTo(readyMatter, urls.memos(matterId));
    expect(attr(dana.button(readyMatter, memoForm, "Export memo"), "disabled")).toBeUndefined();
    const exported = await dana.submit(readyMatter, memoForm, "Export memo");
    expect(exported.status).toBe(303);
    const withMemo = await dana.get(urls.matter(matterId));
    const memoLinks = all(
      withMemo.root,
      (el) =>
        el.name === "a" && /^\/matters\/[^/]+\/memos\/[^/]+\/file$/.test(attr(el, "href") ?? ""),
    );
    expect(memoLinks).toHaveLength(1);
    const memoHref = attr(memoLinks[0] as El, "href") as string;
    dana.link(withMemo, readable(memoLinks[0] as El));
    const zip = await JSZip.loadAsync(await dana.file(memoHref));
    const memoText = (await zip.file("word/document.xml")!.async("string"))
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
    const appendix = memoText.indexOf("Appendix A. Considered and rejected");
    expect(appendix, "the memo has Appendix A").toBeGreaterThan(-1);
    expect(
      memoText.indexOf(PLANTED, appendix),
      "the rejected finding follows Appendix A",
    ).toBeGreaterThan(appendix);

    // Every checkable step is done, out of five, and the creator is the one the hint lists.
    const finished = await alex.get(urls.matter(matterId));
    expect(progressOf(finished)).toContain("5 of those 5 are done");
    expect(progressOf(finished)).toContain(
      "The memo of a new review (workflow version v2) holds your rejected finding.",
    );
    expect(trainedUserIds(server.repo)).toEqual([DEMO_USER_IDS.associate]);

    // --- 9. The keyboard: everything the walk followed or pressed or filled in was reachable by Tab
    // and had a name. The walk used enough of the pages for that to mean something.
    for (const who of [alex, dana, visitor]) {
      expect(unreachable(who.used), `${who.name} used something Tab does not reach`).toEqual([]);
    }
    expect(alex.used.length).toBeGreaterThan(8);
    expect(dana.used.length).toBeGreaterThan(30);
    // Every field the walk sent was offered by the page it was sent from. The reason code of a
    // rejection (package W2.6a) is a control of the decision form, filled in like any other: a
    // form that lacked it would put its name here.
    expect(dana.unoffered).toEqual([]);
    expect(alex.unoffered).toEqual([]);

    // --- No page a trainee was shown holds a trainer's answer, and the words of the plant are only
    // where the design puts them.
    for (const who of [visitor, alex, dana]) {
      for (const page of who.pages) {
        const text = page.text.toLowerCase();
        for (const step of TRAINING_STEPS)
          expect(text, `${who.name} ${page.path}: the answer to step ${step.n}`).not.toContain(
            step.key.toLowerCase(),
          );
        const isMatter = /^\/matters\/[^/?]+$/.test(page.path);
        const isRun = /^\/matters\/[^/?]+\/runs\/[^/?]+/.test(page.path);
        if (page.path === urls.quickstart() || page.path === urls.help() || isMatter) {
          expect(text, `${who.name} ${page.path}`).not.toContain("disclosure to representatives");
          expect(text, `${who.name} ${page.path}`).not.toContain("pds-1");
        }
        if (isRun) {
          const outside = byTag(page.root, "main")
            .map((main) => {
              const clone = readable(main);
              const banner = withClass(main, "banner-training")[0];
              return banner === undefined ? clone : clone.replace(readable(banner), "");
            })
            .join(" ")
            .toLowerCase();
          for (const word of ["planted", "deliberately", "on purpose"])
            expect(outside, `${who.name} ${page.path}: "${word}" outside the banner`).not.toContain(
              word,
            );
        }
      }
    }
  });

  it("plants the same finding under v1, where DUR-1 reads Compliant and step 3 is not done, on a second training matter started from the quickstart", async () => {
    const demo = await boot();
    const { server } = demo;
    const lee = demo.walker("Lee");
    const dana = demo.walker("Dana");
    await lee.signIn(DEMO_USER_IDS.legalEngineer);
    await dana.signIn(DEMO_USER_IDS.reviewer);

    // Lee is the trainer of Alex's matter, a viewer of it. He makes a training matter of his own.
    const quickstart = await lee.get(urls.quickstart());
    // He has no training matter of his own yet (the step's own words are on the page, a link is not).
    expect(
      all(quickstart.root, (el) => el.name === "a" && readable(el) === "Open the training matter"),
    ).toHaveLength(0);
    const startForm = lee.formTo(quickstart, urls.training());
    const made = await lee.submit(quickstart, startForm, "Start the training matter", {
      [FIELDS.reviewerUserId]: DEMO_USER_IDS.reviewer,
    });
    expect(made.status).toBe(303);
    const matter = await lee.get(made.headers.get("location") as string);
    const leesMatterId = matter.path.split("?")[0]!;
    expect(leesMatterId).toMatch(/^\/matters\/[^/]+$/);
    const matterId = leesMatterId.split("/").at(-1)!;
    expect(matterId).not.toBe(demo.matterId);

    const form = lee.formsWhere(matter, (a) => a === urls.runs(matterId))[0] as El;
    const picker = lee
      .controlsOf(matter, form)
      .find((el) => attr(el, "name") === WORKFLOW_FIELD) as El;
    // The picker starts on v1, which is the default; the exercise says v2, and this review takes v1.
    expect(byTag(picker, "option").find((o) => attr(o, "selected") !== undefined)).toBeDefined();
    const started = await lee.submit(matter, form, "Start review", { [WORKFLOW_FIELD]: "v1" });
    expect(started.status).toBe(303);
    await idle(server, matterId);

    const after = await lee.get(leesMatterId);
    expect(progressOf(after)).toContain("0 of those 5 are done");
    expect(progressOf(after)).toContain("Start a review with workflow version v2.");

    const danaMatter = await dana.get(leesMatterId);
    const run = await dana.follow(danaMatter, "Open the issue table");
    expect(rowOf(run, DUR)).toContain("Compliant");
    const pane = await openFinding(dana, run, PLANTED);
    expect(readable(byId(pane.root, "inspector") as El)).toMatch(
      /Section 1\.2, paragraph 6\s*Governing\s*Quote found\s*Support not checked/,
    );
    expect(rowOf(run, PLANTED)).toContain("Compliant");
    expect(unreachable(lee.used)).toEqual([]);
    expect(trainedUserIds(server.repo)).toEqual([]);
  });

  it("gives the trainer the same progress as the trainee and no power over the matter, and the key only to the trainer roles", async () => {
    const demo = await boot();
    const { server, matterId } = demo;
    const alex = demo.walker("Alex");
    const dana = demo.walker("Dana");
    const lee = demo.walker("Lee");
    const sam = demo.walker("Sam");
    const stranger = demo.walker("Stranger");
    await alex.signIn(DEMO_USER_IDS.associate);
    await dana.signIn(DEMO_USER_IDS.reviewer);
    await lee.signIn(DEMO_USER_IDS.legalEngineer);
    await sam.signIn(DEMO_USER_IDS.admin);

    const alexStart = await alex.get(urls.matter(matterId));
    const started = await alex.submit(
      alexStart,
      alex.formsWhere(alexStart, (a) => a === urls.runs(matterId))[0] as El,
      "Start review",
      { [WORKFLOW_FIELD]: "v2" },
    );
    expect(started.status).toBe(303);
    await idle(server, matterId);

    // Lee sees the same progress as Alex, and the matter page tells him he is a viewer.
    const alexView = await alex.get(urls.matter(matterId));
    const leeView = await lee.get(urls.matter(matterId));
    expect(leeView.response.status).toBe(200);
    expect(progressOf(leeView)).toBe(progressOf(alexView));
    expect(leeView.text).toContain("Your role: Viewer");
    // He is offered no decision form on a finding, and a decision posted to the address Dana's page
    // gives is refused with 403 (he is a member, so he is told, unlike a stranger).
    const leeRun = await lee.follow(leeView, "Open the issue table");
    const leePane = await openFinding(lee, leeRun, PLANTED);
    expect(lee.formsWhere(leePane, (a) => /\/reviews$/.test(a))).toHaveLength(0);
    const danaMatter = await dana.get(urls.matter(matterId));
    const danaPane = await openFinding(
      dana,
      await dana.follow(danaMatter, "Open the issue table"),
      PLANTED,
    );
    const danaForm = decisionForm(dana, danaPane);
    const refused = await lee.post(attr(danaForm, "action") as string, {
      ...dana.defaults(danaPane, danaForm),
      [FIELDS.decision]: "accept",
    });
    expect(refused.status).toBe(403);
    expect(
      server.repo
        .listAuditEvents({ matterId, limit: 1000 })
        .some((e) => e.action === "review.decide"),
    ).toBe(false);

    // The administrator is not a member: the matter is not found, as a matter that does not exist is not found.
    const samView = await sam.get(urls.matter(matterId));
    const missing = await sam.get(urls.matter("mat_0000000000000000"));
    expect(samView.response.status).toBe(404);
    expect(missing.response.status).toBe(404);
    expect(samView.text).toBe(missing.text);
    expect(samView.html).not.toContain(PLANTED);

    // The key: the trainer roles are shown the way to it on the quickstart and may open it; a
    // member is shown no link and is refused.
    const leeQuickstart = await lee.get(urls.quickstart());
    const key = await lee.follow(leeQuickstart, "Trainer's key");
    expect(key.path).toBe(urls.trainerKey());
    expect(key.response.status).toBe(200);
    for (const step of TRAINING_STEPS) expect(key.text).toContain(step.key);
    const samKey = await sam.get(urls.trainerKey());
    expect(samKey.response.status).toBe(200);
    for (const member of [alex, dana]) {
      const quick = await member.get(urls.quickstart());
      expect(all(quick.root, (el) => attr(el, "href") === urls.trainerKey())).toHaveLength(0);
      const refusedKey = await member.get(urls.trainerKey());
      expect(refusedKey.response.status, member.name).toBe(403);
      for (const step of TRAINING_STEPS)
        expect(refusedKey.text.toLowerCase()).not.toContain(step.key.toLowerCase());
    }
    const visitorKey = await stranger.get(urls.trainerKey());
    expect(visitorKey.response.status).toBe(303);
    expect(visitorKey.response.headers.get("location")).toBe("/");
  });
});
