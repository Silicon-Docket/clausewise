import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FIXTURE_FILES } from "../../../src/demo/matters.js";
import { active, checkText, goto, prepare } from "./drive.js";
import {
  browserNotice,
  openBrowser,
  type PwBrowser,
  type PwContext,
  type PwPage,
} from "./playwright.js";
import { bootWorld, DISPLAY_NAMES, type RoleName, type World } from "./world.js";

/**
 * The main tasks of the application done with the keyboard alone, in a real browser, on a real
 * server (the demo identity, the scripted reader, synthetic data). A person's hands are Tab and
 * Shift+Tab, Enter, Space, Escape, the arrow keys, letters and typed text, and nothing else: no
 * click, no fill, no tick, no pointer (`script.test.ts` reads this file as text and fails on any
 * such call). The one allowed exception is the file input, whose native dialog cannot be driven
 * headless; each use says so beside it.
 *
 * Every flow writes what it pressed and what happened to a transcript, which is printed when the file
 * ends (and appended to the file named by FLOW_LOG_FILE when that is set), so the keys of each page
 * can be read by a person who was not there. Each step waits for a condition (an address, a text, a
 * place of focus) and never for a fixed time.
 *
 * What this does not show: that a person who cannot see the screen can do these things (no screen
 * reader was used), the file dialog, any browser but Chromium, or the cancel and resume of a review.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

const opened = await openBrowser();
browserNotice("flows.test.ts", opened);

// ---------------------------------------------------------------------------------------------
// The transcript, and a pair of hands
// ---------------------------------------------------------------------------------------------

const transcript: string[] = [];
/** What the text of the pages that showed a notice failed on, in either colour scheme. */
const noticeProblems: string[] = [];
const record = (line: string): void => {
  transcript.push(line);
};

/** The visible words of the first notice of the page: what the page said happened. */
const NOTICE = `(() => {
  const el = document.querySelector('main [role="status"], main [role="alert"]');
  return el ? el.textContent.replace(/\\s+/g, ' ').trim() : null;
})()`;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits until an expression is true in the page, by asking again and again (a condition, never a
 * fixed time). Playwright's own wait runs its test through a string evaluation that the pages'
 * security policy forbids, so this asks with `evaluate`, which the policy does not touch, and
 * tolerates the moments when the page is being replaced.
 */
async function until(
  page: PwPage,
  expression: string,
  what: string,
  limit = 30_000,
): Promise<void> {
  const end = Date.now() + limit;
  let last = "";
  while (Date.now() < end) {
    try {
      if (await page.evaluate<boolean>(`Boolean(${expression})`)) return;
    } catch (error) {
      last = error instanceof Error ? error.message.slice(0, 80) : "an error";
    }
    await pause(40);
  }
  throw new Error(`timed out waiting for ${what}${last === "" ? "" : ` (last error: ${last})`}`);
}

class Hands {
  private run: { key: string; n: number } | null = null;

  constructor(
    readonly page: PwPage,
    private readonly where: string,
  ) {}

  private flush(): void {
    if (this.run === null) return;
    record(`  ${this.where}: pressed ${this.run.key}${this.run.n > 1 ? ` x${this.run.n}` : ""}`);
    this.run = null;
  }

  /** What a person would write down: the page and what was done, in order. */
  note(text: string): void {
    this.flush();
    record(`  ${this.where}: ${text}`);
  }

  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key);
    if (this.run?.key === key) this.run.n++;
    else {
      this.flush();
      this.run = { key, n: 1 };
    }
  }

  async type(text: string): Promise<void> {
    this.flush();
    await this.page.keyboard.type(text);
    record(`  ${this.where}: typed "${text}"`);
  }

  /** One Tab, after which focus must be on the control named; written down with its name. */
  async tabOnce(expected: string): Promise<void> {
    await this.page.keyboard.press("Tab");
    const label = await this.here();
    this.flush();
    record(`  ${this.where}: pressed Tab, focus is on "${label}"`);
    expect(label).toBe(expected);
  }

  async here(): Promise<string> {
    return (await active(this.page))?.label ?? "(nothing)";
  }

  /** Presses Tab (Shift+Tab with `back`) until the control in focus is the one named; fails if it is not met. */
  async tabTo(
    name: string | RegExp,
    options: { back?: boolean; max?: number } = {},
  ): Promise<number> {
    const key = options.back === true ? "Shift+Tab" : "Tab";
    const seen: string[] = [];
    for (let n = 1; n <= (options.max ?? 160); n++) {
      await this.page.keyboard.press(key);
      const label = await this.here();
      seen.push(label);
      const hit = typeof name === "string" ? label === name : name.test(label);
      if (hit) {
        this.flush();
        record(`  ${this.where}: pressed ${key} x${n}, focus is on "${label}"`);
        return n;
      }
    }
    throw new Error(
      `${key} did not reach ${String(name)} on ${this.where}; it passed ${seen.slice(0, 12).join(" | ")} ...`,
    );
  }

  /**
   * Presses Enter and waits for the page that follows to finish loading (a link, or a form that was
   * sent), then loads the readers into it. A mark is left on the old page and the wait is for it
   * to be gone, so the wait cannot be satisfied by the page that is being left.
   */
  async activate(expected?: RegExp): Promise<void> {
    await this.page.evaluate("window.__navMark = 1");
    await this.press("Enter");
    await until(
      this.page,
      "window.__navMark !== 1 && document.readyState === 'complete'",
      "the next page",
    );
    await prepare(this.page);
    if (expected !== undefined) expect(this.page.url()).toMatch(expected);
  }

  async waitFor(condition: string, what: string): Promise<void> {
    await until(this.page, condition, what);
    this.flush();
    record(`  ${this.where}: saw ${what}`);
  }

  async notice(): Promise<string | null> {
    return this.page.evaluate<string | null>(NOTICE);
  }

  /** Waits until the page shows a notice matching `pattern`, and returns its words. */
  async seeNotice(pattern: RegExp): Promise<string> {
    await until(
      this.page,
      `(() => { const t = ${NOTICE}; return t !== null && new RegExp(${JSON.stringify(pattern.source)}, ${JSON.stringify(pattern.flags)}).test(t); })()`,
      `a notice like ${String(pattern)}`,
    );
    const text = (await this.notice()) ?? "";
    this.flush();
    record(`  ${this.where}: the page says "${text}"`);
    // The notice is on the page now: read the text of the page, notice included, in both colour schemes.
    for (const scheme of ["light", "dark"] as const)
      for (const problem of await checkText(this.page, scheme))
        noticeProblems.push(`${this.where}, ${scheme}: ${problem}`);
    await this.page.emulateMedia({ colorScheme: "light" });
    return text;
  }
}

describe.skipIf(!opened.ok)("the main tasks, by keyboard alone, in a real browser", () => {
  let browser: PwBrowser;
  let world: World;
  const contexts: PwContext[] = [];

  async function as(role: RoleName): Promise<PwPage> {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      acceptDownloads: true,
    });
    contexts.push(context);
    if (role !== "visitor") await context.addCookies(await world.cookiesFor(role));
    return context.newPage();
  }

  beforeAll(async () => {
    if (!opened.ok) return;
    browser = opened.opened.browser;
    world = await bootWorld();
    record(
      `Keyboard flows. Playwright ${opened.opened.versions.playwright}, Chromium ${opened.opened.versions.chromium}. Synthetic data, scripted reader.`,
    );
  });
  afterAll(async () => {
    if (!opened.ok) return;
    for (const context of contexts) await context.close();
    await browser.close();
    await world.close();
    const text = transcript.join("\n");
    process.stderr.write(`\n${text}\n`);
    const file = process.env["FLOW_LOG_FILE"];
    if (file !== undefined && file !== "") writeFileSync(file, `${text}\n`);
  });

  // -------------------------------------------------------------------------------------------
  // F1 to F3: a visitor reads, then signs in
  // -------------------------------------------------------------------------------------------

  it("F1 a visitor: skip link, quickstart, help and its topics, then sign-in, all by keyboard", async () => {
    const page = await as("visitor");
    const hands = new Hands(page, "sign-in page");
    record("F1 A visitor, no sign-in yet");
    await goto(page, `${world.base}/`);
    await page.evaluate("window.__pw.resetFocus()");

    await hands.tabOnce("Skip to main content");
    await hands.press("Enter");
    await hands.waitFor(
      "document.activeElement && document.activeElement.id === 'main'",
      "focus on the main region",
    );
    // The first stop in the main region is the link to the quickstart.
    await hands.tabOnce("Read the quickstart");
    await hands.activate(/\/quickstart$/);
    const quick = new Hands(page, "quickstart page");
    await quick.tabOnce("Skip to main content");
    await quick.tabTo("Before you start");
    await quick.press("Enter");
    await quick.waitFor(
      "location.hash.length > 1",
      `the address now ends ${await page.evaluate<string>("location.hash")}`,
    );
    const afterJump = await active(page);
    quick.note(
      `after the jump link focus is on ${afterJump === null ? "the page" : `"${afterJump.label}"`}`,
    );
    await quick.press("Tab");
    quick.note(`the next Tab went to "${await quick.here()}"`);
    await quick.tabTo("help page");
    await quick.activate(/\/help$/);

    const help = new Hands(page, "help page");
    await help.tabTo("Keyboard");
    await help.press("Enter");
    await help.waitFor(
      "location.hash === '#keyboard' || location.hash.length > 1",
      "the topic's address",
    );
    await help.press("Tab");
    help.note(`the next Tab went to "${await help.here()}"`);
    await help.tabTo("Back to the quickstart");
    await help.activate(/\/quickstart$/);

    // The navigation: a visitor who asks for Matters is sent to sign in.
    const nav = new Hands(page, "quickstart page");
    await nav.tabTo("Matters", { max: 12 });
    await nav.activate(/\/$/);
    const signIn = new Hands(page, "sign-in page");
    expect(await page.evaluate<string>("document.querySelector('h1').textContent")).toMatch(
      /Choose a demo identity/,
    );
    signIn.note("a visitor who asked for Matters is shown the sign-in page");

    await signIn.tabTo(/^Alex Ruiz \(associate\)/);
    await signIn.activate(/\/matters$/);
    await signIn.waitFor(
      "document.body.textContent.includes('Alex Ruiz (associate)')",
      "the person's name in the header",
    );

    // The matters page: Tab to a matter's link and open it.
    const matters = new Hands(page, "matters page");
    await matters.tabTo("Lanternfish / Corvane NDA");
    await matters.activate(new RegExp(`/matters/${world.ids.lanternfish.matterId}$`));
    matters.note("the matter page opened");
    expect(await page.evaluate<string>("document.querySelector('h1').textContent")).toBe(
      "Lanternfish / Corvane NDA",
    );

    // Sign out by keyboard, and sign in as someone else.
    const out = new Hands(page, "matter page");
    await out.tabTo("Sign out");
    await out.activate(/\/$/);
    const again = new Hands(page, "sign-in page");
    await again.tabTo(/^Dana Whitfield/);
    await again.activate(/\/matters$/);
    again.note("signed in again as the reviewing attorney");
  });

  // -------------------------------------------------------------------------------------------
  // F2 to F11: one matter, from nothing to a rated memo, by two people
  // -------------------------------------------------------------------------------------------

  let matterUrl = "";

  it("F2 the associate makes a matter and adds the two documents, by keyboard", async () => {
    const page = await as("associate");
    record("F2 The associate (Alex Ruiz) makes a matter");
    await goto(page, `${world.base}/matters`);
    const form = new Hands(page, "matters page, new matter");
    await form.tabTo("Matter name");
    await form.type("Keyboard flow matter");
    await form.tabOnce("Our client");
    await form.type("Lanternfish Software, Inc.");
    await form.tabOnce("Reviewing attorney");
    await form.type("Dana");
    await form.tabOnce("Playbook");
    await form.type("Parol");
    await form.tabTo("Create matter");
    await form.activate(/\/matters\/mat_[0-9a-f]+(\?.*)?$/);
    matterUrl = `${world.base}${new URL(page.url()).pathname}`;
    await form.seeNotice(/matter was created/i);

    const docs = new Hands(page, "matter page, add a document");
    for (const doc of [
      { title: "Mutual NDA", kind: "NDA", date: "02022026", file: "parol-d05-nda.docx" },
      {
        title: "Amendment No. 1",
        kind: "Amendment",
        date: "09152026",
        file: "parol-d05-amendment-1.txt",
      },
    ]) {
      await goto(page, matterUrl);
      await page.evaluate("window.__pw.resetFocus()");
      await docs.tabTo("Document title");
      await docs.type(doc.title);
      await docs.tabOnce("Kind");
      await docs.type(doc.kind);
      await docs.tabOnce("Stated date");
      await docs.type(doc.date);
      await docs.press("Tab");
      // The file input is the one thing a keyboard cannot finish headless. The file dialog
      // opens on Enter or Space and cannot be driven here, so the file is attached by call.
      await page.setInputFiles(
        'form[action$="/documents"] input[type=file]',
        join(import.meta.dirname, "..", "..", "..", "..", "..", ...FIXTURE_FILES, doc.file),
      );
      docs.note(`attached ${doc.file} (the file dialog cannot be driven headless)`);
      await docs.tabTo("Add document");
      await docs.activate(/\/matters\/mat_[0-9a-f]+/);
      await docs.seeNotice(/document was added/i);
    }
    expect(await page.evaluate<string>("document.body.textContent")).toContain("Amendment No. 1");
  });

  it("F3 the associate times the work: start the timer, then stop it, by keyboard", async () => {
    const page = await as("associate");
    record("F3 The timer on the matter page");
    await goto(page, matterUrl);
    const hands = new Hands(page, "matter page, time on this matter");
    await hands.tabTo("Start timer");
    await hands.activate(/\/matters\/mat_[0-9a-f]+/);
    await hands.seeNotice(/timer|started|running/i);
    await hands.tabTo(/^Stop timer/);
    await hands.activate(/\/matters\/mat_[0-9a-f]+/);
    await hands.seeNotice(/stopped|timer|session/i);
  });

  it("F4 the reviewing attorney records the reference list before any review, by keyboard", async () => {
    const page = await as("reviewer");
    record("F4 The reviewing attorney (Dana Whitfield) records the reference list");
    await goto(page, matterUrl);
    const hands = new Hands(page, "matter page, reference list");
    const labels = await page.evaluate<string[]>(
      "[...document.querySelectorAll('select')].map((s) => window.__pw.label(s)).filter((l) => /severity|reference|issue/i.test(l))",
    );
    expect(labels.length, "the reference list has a severity choice for each rule").toBeGreaterThan(
      2,
    );
    // The first severity choice of the reference list.
    await hands.tabTo(labels[0]!);
    await hands.type("High");
    await hands.press("Tab");
    await hands.type("Medium");
    await hands.tabTo(/^Save (the )?reference list/i);
    await hands.activate(/\/matters\/mat_[0-9a-f]+/);
    await hands.seeNotice(/reference/i);
  });

  it("F5 the associate starts a review, by keyboard, and opens the issue table", async () => {
    const page = await as("associate");
    record("F5 The associate starts a review");
    await goto(page, matterUrl);
    const hands = new Hands(page, "matter page, start a review");
    await hands.tabTo("Workflow version");
    await hands.type("v2");
    await hands.tabOnce("Start review");
    await hands.activate(/\/matters\/mat_[0-9a-f]+/);
    await hands.seeNotice(/review has started/i);
    // The review runs (a script of a reader, no model); the matter page offers the table when it is done.
    for (let tries = 0; tries < 120; tries++) {
      await goto(page, matterUrl);
      const ready = await page.evaluate<boolean>(
        "[...document.querySelectorAll('a')].some((a) => /Open the issue table/.test(a.textContent))",
      );
      if (ready) break;
      await pause(500);
    }
    await hands.tabTo("Open the issue table");
    await hands.activate(/\/runs\/run_[0-9a-f]+$/);
    hands.note("the issue table (review page) opened");
  });

  it("F6 the issue table: j, k, Enter, then ? and Escape, and focus in the inspector", async () => {
    const page = await as("associate");
    record("F6 The issue table (the associate)");
    await goto(page, matterUrl);
    const here = await page.evaluate<string>(
      "[...document.querySelectorAll('a')].find((a) => /Open the issue table/.test(a.textContent)).href",
    );
    await goto(page, here);
    const hands = new Hands(page, "review page, issue table");
    await hands.tabTo("Issue table");
    await hands.press("j");
    await hands.press("k");
    await hands.press("j");
    hands.note(`focus is on "${await hands.here()}"`);
    await hands.activate(/\?finding=fnd_[0-9a-f]+/);
    await hands.waitFor(
      "document.activeElement && document.activeElement.id === 'inspector'",
      "focus on the evidence inspector",
    );

    // Back to the table, ask for the list of keys, and close it with Escape.
    await hands.tabTo("Back to the issue table");
    await hands.press("Enter");
    expect(await hands.here()).toBe("Issue table");
    await hands.press("?");
    await hands.waitFor(
      "[...document.querySelectorAll('details')].some((d) => d.open && /shortcut/i.test(d.textContent))",
      "the list of keys opened, with focus on its heading",
    );
    expect(await hands.here()).toMatch(/Keyboard shortcuts/);
    await hands.press("Escape");
    await hands.waitFor(
      "![...document.querySelectorAll('details')].some((d) => d.open && /shortcut/i.test(d.textContent))",
      "the list of keys closed by Escape",
    );
  });

  let firstFindingUrl = "";

  it("F7 the reviewing attorney: a refused decision, the way to the reason, a reason code, then saved", async () => {
    const page = await as("reviewer");
    record("F7 The reviewing attorney decides: reject needs a reason and a reason code");
    await goto(page, matterUrl);
    const to = await page.evaluate<string>(
      "[...document.querySelectorAll('a')].find((a) => /Open the issue table/.test(a.textContent)).href",
    );
    await goto(page, to);
    const hands = new Hands(page, "review page");
    await hands.tabTo("Issue table");
    await hands.press("j");
    await hands.activate(/\?finding=fnd_[0-9a-f]+/);
    firstFindingUrl = page.url();
    await hands.tabTo("Go to the decision");
    await hands.press("Enter");
    // Reject by arrow keys from the first choice: Accept, Edit, Reject.
    await hands.tabTo("Accept");
    await hands.press("ArrowDown");
    await hands.press("ArrowDown");
    expect(await hands.here()).toBe("Reject");
    await hands.tabTo("Save decision");
    await hands.activate(/\/findings\/fnd_[0-9a-f]+\/reviews$|\/runs\//);
    const refusal = await hands.seeNotice(/reason/i);
    expect(refusal).toMatch(/Give a reason/);
    // The refused page is a new page, with focus at its start. The skip link leads to the main
    // region, and the first control in it is the notice's own link to the field it is about.
    await hands.tabOnce("Skip to main content");
    await hands.press("Enter");
    await hands.tabOnce("Go to the reason");
    await hands.press("Enter");
    await hands.waitFor(
      "document.activeElement && document.activeElement.tagName === 'TEXTAREA'",
      "focus in the reason box",
    );
    await hands.type("The clause does not match the playbook wording.");
    await hands.tabOnce("Reason code");
    await hands.type("Wrong");
    await hands.tabTo("Save decision");
    await hands.activate(/\/runs\/|\/findings\//);
    await hands.seeNotice(/decision was saved/i);
  });

  it("F8 the reviewing attorney adds a note to a finding, and reports a missed issue, by keyboard", async () => {
    const page = await as("reviewer");
    record("F8 A note and a missed-issue report");
    await goto(page, firstFindingUrl);
    const note = new Hands(page, "finding, notes");
    await note.tabTo("Your note");
    await note.type("Check this clause against the amendment.");
    await note.tabTo("Add note");
    await note.activate(/./);
    await note.seeNotice(/note/i);

    const missed = new Hands(page, "review page, missed issue");
    await goto(page, firstFindingUrl);
    await missed.tabTo("Report a missed issue");
    await missed.press("Enter");
    await missed.tabTo("Rule");
    await missed.type("Not covered");
    await missed.tabOnce("Location");
    await missed.type("Amendment section 2");
    await missed.tabOnce("Note");
    await missed.type("The amendment changes the term and nothing flags it.");
    await missed.tabTo("Report missed issue");
    await missed.activate(/./);
    await missed.seeNotice(/missed|reported|saved/i);
  });

  it("F9 the reviewing attorney decides every other finding, with a few keys each, and exports the memo", async () => {
    const page = await as("reviewer");
    record("F9 Deciding the rest, then the memo");
    await goto(page, firstFindingUrl);
    const hands = new Hands(page, "review page, deciding");
    const rows = await page.evaluate<number>(
      "document.querySelectorAll('[data-issue-table] tbody tr').length",
    );
    expect(rows).toBeGreaterThan(5);
    let decided = 1;
    for (let k = 1; k < rows; k++) {
      // Focus is on the inspector of a finding that is decided. Four keys open the next one:
      // Tab (to Back to the issue table), Enter (focus is on the table), j, Enter.
      const was = new URL(page.url()).searchParams.get("finding");
      expect(await hands.here()).toBe("Evidence inspector");
      await hands.tabOnce("Back to the issue table");
      await hands.press("Enter");
      expect(await hands.here()).toBe("Issue table");
      await hands.press("j");
      await hands.activate(/\?finding=fnd_[0-9a-f]+/);
      expect(new URL(page.url()).searchParams.get("finding")).not.toBe(was);
      await hands.waitFor(
        "document.activeElement && document.activeElement.id === 'inspector'",
        "the next finding open, focus on its inspector (4 keys)",
      );
      // Then the decision: the link to it, the first choice (Accept), Space, and on to Save decision.
      await hands.tabTo("Go to the decision");
      await hands.press("Enter");
      await hands.tabOnce("Accept");
      await hands.press("Space");
      await hands.tabTo("Save decision");
      await hands.activate(/./);
      await hands.seeNotice(/decision was saved/i);
      decided++;
    }
    expect(decided).toBe(rows);
    await goto(page, `${matterUrl}/memos`);
    const memo = new Hands(page, "memos page");
    await memo.tabTo("Export memo");
    await memo.activate(/\/memos/);
    await memo.seeNotice(/memo was exported/i);
    // The memo is a link: Enter downloads it.
    await memo.tabTo(/\.docx$/);
    const download = page.waitForEvent("download", { timeout: 30_000 });
    await memo.press("Enter");
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.docx$/);
    memo.note(`the download began: ${file.suggestedFilename()}`);
  });

  it("F10 the reviewing attorney rates the matter by keyboard: the scale, a comment, save", async () => {
    const page = await as("reviewer");
    record("F10 The rating");
    await goto(page, `${matterUrl}/memos`);
    const hands = new Hands(page, "memos page, rating");
    await hands.tabTo("1 Strongly disagree");
    await hands.press("ArrowRight");
    await hands.press("ArrowRight");
    await hands.press("ArrowRight");
    hands.note(`the scale stands on "${await hands.here()}"`);
    await hands.press("Tab");
    await hands.type("Clear, and quick to check against the text.");
    await hands.tabTo("Save rating");
    await hands.activate(/./);
    await hands.seeNotice(/rating|rated|thank/i);
  });

  it("F11 the associate deletes the matter by keyboard: open the section, tick the box, press the button", async () => {
    const page = await as("associate");
    record("F11 Deleting the matter");
    await goto(page, matterUrl);
    const hands = new Hands(page, "matter page, delete");
    await hands.tabTo("Delete this matter");
    await hands.press("Enter");
    await hands.waitFor(
      "[...document.querySelectorAll('details')].some((d) => d.open && /Delete this matter/.test(d.textContent))",
      "the section opened",
    );
    await hands.tabTo("I want to delete this matter and everything in it");
    await hands.press("Space");
    await hands.tabTo("Delete matter");
    await hands.activate(/\/matters(\?.*)?$/);
    await hands.seeNotice(/deleted/i);
  });

  // -------------------------------------------------------------------------------------------
  // The pages for the other roles
  // -------------------------------------------------------------------------------------------

  it("F12 the legal engineer: the pilot page in both scopes, the calendar, the roster, the CSV", async () => {
    const page = await as("legal engineer");
    record("F12 The legal engineer (Lee Okafor): pilot measures");
    await goto(page, `${world.base}/pilot`);
    const hands = new Hands(page, "pilot page, pilot scope");
    await hands.tabTo("Synthetic scope, a demonstration");
    await hands.activate(/scope=synthetic/);
    expect(await page.evaluate<string>("document.body.textContent")).toMatch(
      /Demonstration data|demonstration/i,
    );
    hands.note("the demonstration scope opened");
    const synth = new Hands(page, "pilot page, synthetic scope");
    await synth.tabTo("Pilot scope");
    await synth.activate(/\/pilot$/);

    const cal = new Hands(page, "pilot page, calendar");
    await cal.tabTo("First day of the pilot");
    await cal.type("10202026");
    await cal.tabTo(/Save the start date/);
    await cal.activate(/\/pilot/);
    await cal.seeNotice(/start date|calendar|saved/i);

    const roster = new Hands(page, "pilot page, roster");
    await roster.tabTo("Lee Okafor (legal engineer)");
    await roster.press("Space");
    await roster.tabTo("Save who was trained");
    await roster.activate(/\/pilot/);
    await roster.seeNotice(/trained|saved|participants/i);

    const csv = new Hands(page, "pilot page, CSV");
    await goto(page, `${world.base}/pilot`);
    await csv.tabTo(/CSV/i);
    const download = page.waitForEvent("download", { timeout: 30_000 });
    await csv.press("Enter");
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.csv$/);
    csv.note(`the download began: ${file.suggestedFilename()}`);
  });

  it("F13 the legal engineer: the evaluation list, one comparison, back by the breadcrumb", async () => {
    const page = await as("legal engineer");
    record("F13 The legal engineer: evaluations");
    await goto(page, `${world.base}/evaluations`);
    const list = new Hands(page, "evaluations page");
    await list.tabTo(/^cmp_/);
    await list.activate(/comparison=cmp_/);
    const one = new Hands(page, "one comparison");
    expect(await page.evaluate<string>("document.querySelector('h1').textContent")).toMatch(
      /Compare workflow versions/,
    );
    const stops = await one.tabTo("Evaluations", { max: 20 });
    one.note(`${stops} Tab presses reached the breadcrumb`);
    await one.activate(/\/evaluations$/);
    // Every control of the comparison can be reached, to its end, without a trap.
    await goto(page, `${world.base}/evaluations?comparison=${world.ids.comparisonId}`);
    let n = 0;
    for (; n < 200; n++) {
      await one.press("Tab");
      if ((await active(page)) === null) break;
    }
    one.note(`Tab went through the whole comparison page in ${n} presses and then left it`);
    expect(n).toBeLessThan(200);
  });

  it("F14 the administrator: the audit page by keyboard (it has no control of its own), then sign out", async () => {
    const page = await as("administrator");
    record("F14 The administrator (Sam Patel): the audit check");
    await goto(page, `${world.base}/audit`);
    const hands = new Hands(page, "audit page");
    await hands.tabOnce("Skip to main content");
    await hands.press("Enter");
    await hands.waitFor(
      "document.activeElement && document.activeElement.id === 'main'",
      "focus on the main region",
    );
    let n = 0;
    for (; n < 60; n++) {
      await hands.press("Tab");
      if ((await hands.here()) === "Sign out") break;
    }
    hands.note(
      `the page has no control of its own: after the main region Tab reached "Sign out" in ${n + 1} presses`,
    );
    expect(await page.evaluate<string>("document.querySelector('h1').textContent")).toBe(
      "Audit log check",
    );
    await hands.activate(/\/$/);
    hands.note("Sign out by Enter: back at the sign-in page");
  });

  it("F15 the viewer starts the training matter from the quickstart by keyboard, with a reviewer and a trainer chosen", async () => {
    const page = await as("viewer");
    record("F15 The quickstart, signed in as a person who has no training matter yet (Vic Okoye)");
    await goto(page, `${world.base}/quickstart`);
    const hands = new Hands(page, "quickstart page, training form");
    await hands.tabTo("Reviewing attorney");
    await hands.type("Dana");
    await hands.press("Tab");
    hands.note(`the next control is "${await hands.here()}"`);
    await hands.tabTo("Start the training matter");
    await hands.activate(/\/matters\/mat_[0-9a-f]+/);
    await hands.seeNotice(/training/i);
    hands.note(
      `the page is "${await page.evaluate<string>("document.querySelector('h1').textContent")}"`,
    );
    // Started once: asking again opens the same matter and does not make a second one.
    await goto(page, `${world.base}/quickstart`);
    const again = new Hands(page, "quickstart page, a second time");
    await again.tabTo("Open the training matter");
    await again.activate(/\/matters\/mat_[0-9a-f]+/);
    expect(await page.evaluate<string>("document.querySelector('h1').textContent")).toMatch(
      /Training/,
    );
  });

  it("shows every notice, the refusal among them, in text that reads in both colour schemes", () => {
    expect(noticeProblems).toEqual([]);
  });

  it("names the people it signed in as, so the transcript can be read", () => {
    record(`People: ${Object.values(DISPLAY_NAMES).join("; ")}.`);
    expect(transcript.length).toBeGreaterThan(20);
  });
});
