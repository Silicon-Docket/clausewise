import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  checkBackward,
  checkNames,
  checkReadingOrder,
  checkSkipLink,
  checkText,
  checkWalk,
  goto,
  judgeMarks,
  judgeMotion,
  judgeReflow,
  judgeSame,
  marks,
  motion,
  prepare,
  reflow,
  signature,
  textSamples,
  walk,
  type Scheme,
} from "./drive.js";
import { FIELDS } from "../../../src/server/pages/forms.js";
import { judgeText, judgeWalk } from "./judge.js";
import {
  browserNotice,
  openBrowser,
  type PwBrowser,
  type PwContext,
  type PwPage,
} from "./playwright.js";
import { targets, type Target } from "./targets.js";
import { bootWorld, type RoleName, type World } from "./world.js";

/**
 * Every page of the application, as every role that can see it, in a real browser.
 *
 * The real server is started on a free port (the same entry as `pnpm parol`, with the demo identity,
 * the scripted reader and a temporary data folder), the seed is run with all its options, and
 * Chromium is driven by Playwright. For each page of each role (`targets.ts`: a visitor, the
 * associate, the reviewing attorney, a viewer, the legal engineer and the administrator, 100 and
 * more pages in all, the refusal pages included) the file shows, by what the browser itself reports:
 *
 *  - the skip link is the first stop, shows itself, and leads to the first control of the page;
 *  - Tab reaches every control, once, in the order of the page and in reading order on the screen,
 *    ends, and does not trap; Shift+Tab goes back through the same controls;
 *  - every stop shows a ring of 3:1 or more against what is behind it, and is not under anything;
 *  - every control has a name in the browser's own accessibility tree;
 *  - text is 4.5:1 (3:1 when large) against the background it really has, in the light and the dark
 *    colour scheme, with every folded section opened;
 *  - the page does not scroll sideways at 640 CSS pixels (a 1280 pixel window at 200 percent) or at
 *    320, and at 320 the keyboard still works;
 *  - reduced motion and forced colours hide nothing and keep an outline on every stop;
 *  - with scripts off the page shows the same text and the same controls and the keyboard works;
 *  - Escape and Enter behave in forms;
 *  - and a stylesheet made worse is caught, so these checks can fail.
 *
 * What this cannot show, and so does not claim: a screen reader (nobody has used one on these pages),
 * any browser but Chromium, real browser zoom (200 percent is taken as a window half as wide, which
 * is the layout a browser gives at that zoom), touch, voice, text spacing, target size, the native
 * file dialog, the ring that the browser draws itself on a date field's calendar button, or the Word
 * memo. Where Playwright or Chromium cannot be loaded the file is skipped, and says so.
 */

vi.setConfig({ testTimeout: 600_000, hookTimeout: 120_000 });

const opened = await openBrowser();
browserNotice("audit.test.ts", opened);

const ROLES: readonly RoleName[] = [
  "visitor",
  "associate",
  "reviewer",
  "viewer",
  "legal engineer",
  "administrator",
];

describe.skipIf(!opened.ok)("the pages in a real browser", () => {
  let browser: PwBrowser;
  let world: World;
  let all: Target[];
  const cookies = new Map<RoleName, Awaited<ReturnType<World["cookiesFor"]>>>();

  beforeAll(async () => {
    if (!opened.ok) return;
    browser = opened.opened.browser;
    world = await bootWorld();
    all = targets(world.ids);
    for (const role of ROLES)
      if (role !== "visitor") cookies.set(role, await world.cookiesFor(role));
  });
  afterAll(async () => {
    if (!opened.ok) return;
    await browser.close();
    await world.close();
  });

  /** A context for a role: the cookies it signed in with, and the window and settings asked for. */
  async function contextFor(
    role: RoleName,
    options: Parameters<PwBrowser["newContext"]>[0] = {},
  ): Promise<PwContext> {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      ...options,
    });
    const held = cookies.get(role);
    if (held !== undefined) await context.addCookies(held);
    return context;
  }

  /**
   * Runs `check` on every page of every role, one browser page per role, and gathers what it
   * reports as `role / page: problem`. A test then expects the list to be empty, so a failure names
   * every page and every problem.
   */
  async function sweep(
    check: (page: PwPage, target: Target) => Promise<string[]>,
    options: {
      context?: Parameters<PwBrowser["newContext"]>[0];
      only?: (target: Target) => boolean;
      script?: boolean;
    } = {},
  ): Promise<string[]> {
    const found: string[] = [];
    for (const role of ROLES) {
      const context = await contextFor(role, options.context);
      const page = await context.newPage();
      for (const target of all.filter((t) => t.role === role)) {
        if (options.only !== undefined && !options.only(target)) continue;
        const response = await page.goto(world.base + target.path);
        if (response?.status() !== target.expect) {
          found.push(
            `${role} / ${target.name}: answered ${response?.status()}, not ${target.expect}`,
          );
          continue;
        }
        await prepare(page, options.script ?? true);
        for (const problem of await check(page, target))
          found.push(`${role} / ${target.name}: ${problem}`);
      }
      await context.close();
    }
    return found;
  }

  it("has a page for every role and the world is the one the tests expect", () => {
    expect(new Set(all.map((t) => t.role))).toEqual(new Set(ROLES));
    // More than the matter pages alone: the pages that name no matter, and the refusals.
    expect(all.length).toBeGreaterThan(100);
    expect(all.filter((t) => t.expect !== 200).length).toBeGreaterThan(20);
    expect(all.filter((t) => t.role === "visitor").map((t) => t.name)).toContain("sign-in");
  });

  it("answers each page with the status its role is owed, and a person with no part is told 'not found'", async () => {
    const found = await sweep(async () => []);
    expect(found).toEqual([]);
  });

  it("has a skip link that is the first stop, shows itself, and leads to the first control of the page", async () => {
    expect(await sweep((page) => checkSkipLink(page))).toEqual([]);
  });

  it("is reached by Tab control by control, in the order of the page, with a ring of 3:1 in both colour schemes, and Tab ends", async () => {
    const found = await sweep(async (page) => {
      const problems: string[] = [];
      for (const scheme of ["light", "dark"] as Scheme[]) {
        const { problems: p } = await checkWalk(page, scheme);
        problems.push(...p);
      }
      await page.emulateMedia({ colorScheme: "light" });
      return problems;
    });
    expect(found).toEqual([]);
  });

  it("is reached by Tab with every folded section open too, and the controls inside are as good", async () => {
    const found = await sweep(
      async (page) => {
        await page.evaluate(
          "document.querySelectorAll('details').forEach((d) => { d.open = true; })",
        );
        const { problems } = await checkWalk(page, "light");
        return problems;
      },
      { only: (t) => t.expect === 200 },
    );
    expect(found).toEqual([]);
  });

  it("is walked back by Shift+Tab through the same controls, and the screen shows them in reading order", async () => {
    const found = await sweep(async (page) => {
      const forward = await walk(page);
      return [...(await checkBackward(page, forward)), ...checkReadingOrder(forward)];
    });
    expect(found).toEqual([]);
  });

  it("gives every control a name in the browser's own accessibility tree", async () => {
    expect(await sweep((page) => checkNames(page))).toEqual([]);
  });

  it("keeps text at 4.5:1 (3:1 when large) on the background it really has, in the light and the dark scheme", async () => {
    const found = await sweep(async (page) => {
      const problems: string[] = [];
      for (const scheme of ["light", "dark"] as Scheme[]) {
        const closed = await checkText(page, scheme);
        problems.push(...closed);
        // Folded sections hold text too: open them and read again, and report only what is new.
        await page.evaluate(
          "document.querySelectorAll('details').forEach((d) => { d.open = true; })",
        );
        const known = new Set(closed.map((p) => p.replace(/^\[[^\]]*\] /, "")));
        for (const p of judgeText(await textSamples(page)))
          if (!known.has(p)) problems.push(`[${scheme}, folded sections open] ${p}`);
        await page.evaluate(
          "document.querySelectorAll('details').forEach((d) => { d.open = false; })",
        );
      }
      await page.emulateMedia({ colorScheme: "light" });
      return problems;
    });
    expect(found).toEqual([]);
  });

  it("measures the text of every page, so the test above is not looking at nothing", async () => {
    const counts: number[] = [];
    await sweep(async (page) => {
      counts.push((await textSamples(page)).length);
      return [];
    });
    expect(counts.length).toBe(all.length);
    expect(Math.min(...counts)).toBeGreaterThan(3);
  });

  it("does not scroll sideways at 200 percent (a window 640 pixels wide) or at 320, and at 320 the keyboard still works", async () => {
    const found: string[] = [];
    for (const [width, height, label] of [
      [640, 450, "200 percent zoom (640 wide)"],
      [320, 640, "320 wide"],
    ] as const) {
      const problems = await sweep(
        async (page) => {
          // At 320 nothing may stick to the top: the banner there is several lines tall and hides
          // what takes focus below it.
          const out = judgeReflow(await reflow(page), {
            maxStickyShare: width === 320 ? 0 : 0.4,
          }).map((p) => `[${label}] ${p}`);
          if (width === 320) {
            const { problems: p } = await checkWalk(page, "light");
            out.push(...p.map((q) => `[${label}] ${q}`));
          }
          return out;
        },
        { context: { viewport: { width, height } } },
      );
      found.push(...problems);
    }
    expect(found).toEqual([]);
  });

  it("stops every animation and hides nothing when the person asks for reduced motion", async () => {
    const found = await sweep(async (page) => {
      const before = await signature(page);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await prepare(page);
      const problems = [
        ...judgeMotion(await motion(page)),
        ...judgeSame(before, await signature(page), "reduced motion"),
      ];
      await page.emulateMedia({ reducedMotion: "no-preference" });
      return problems;
    });
    expect(found).toEqual([]);
  });

  it("hides nothing in forced colours, keeps every mark visible, and shows an outline on every stop", async () => {
    const found = await sweep(async (page) => {
      const before = await signature(page);
      const beforeMarks = await marks(page);
      await page.emulateMedia({ forcedColors: "active" });
      await prepare(page);
      const problems = [
        ...judgeSame(before, await signature(page), "forced colours"),
        ...judgeMarks(beforeMarks, await marks(page), "forced colours"),
        ...judgeWalk(await walk(page), { forcedColors: true, skipLinkFirst: true }).map(
          (p) => `[forced colours] ${p}`,
        ),
      ];
      await page.emulateMedia({ forcedColors: "none" });
      return problems;
    });
    expect(found).toEqual([]);
  });

  it("works with scripts switched off: the same text, the same controls, a skip link, and Tab through all of them", async () => {
    const withScript = new Map<string, Awaited<ReturnType<typeof signature>>>();
    await sweep(async (page, t) => {
      withScript.set(`${t.role}|${t.path}`, await signature(page));
      return [];
    });
    const found = await sweep(
      async (page, t) => {
        const expected = withScript.get(`${t.role}|${t.path}`);
        const problems: string[] = [];
        if (expected !== undefined)
          problems.push(...judgeSame(expected, await signature(page), "scripts off"));
        problems.push(...(await checkSkipLink(page, false)));
        const w = await walk(page, "forward", false);
        problems.push(...judgeWalk(w, { skipLinkFirst: true }).map((p) => `[scripts off] ${p}`));
        return problems;
      },
      { context: { javaScriptEnabled: false }, script: false },
    );
    expect(found).toEqual([]);
  });

  it("lets Escape leave what was typed alone, and Enter send nothing that is not complete", async () => {
    const context = await contextFor("associate");
    const page = await context.newPage();
    const problems: string[] = [];
    await goto(page, `${world.base}/matters`);
    await page.evaluate("window.__sentinel = 1");

    // The first text field of the new-matter form: type, Escape, and the text and focus are still there.
    const field = `document.querySelector('input[name="${FIELDS.name}"]')`;
    await page.evaluate(`${field}.focus()`);
    await page.keyboard.type("7");
    await page.keyboard.press("Escape");
    const kept = await page.evaluate<{ value: string; focused: boolean }>(
      `({ value: ${field}.value, focused: document.activeElement === ${field} })`,
    );
    if (kept.value !== "7") problems.push(`Escape changed what was typed: "${kept.value}"`);
    if (!kept.focused) problems.push("Escape took focus out of the field");
    await page.keyboard.press("Backspace");

    // Enter in a field of a form that is not complete does not send it: the page stays.
    await page.keyboard.press("Enter");
    const stayed = await page.evaluate<{ sentinel: boolean; url: string }>(
      "({ sentinel: window.__sentinel === 1, url: location.pathname })",
    );
    if (!stayed.sentinel || stayed.url !== "/matters")
      problems.push("Enter sent a new-matter form that has no name");

    // Enter in a note box starts a new line and sends nothing.
    const ids = world.ids.lanternfish;
    await goto(page, `${world.base}/matters/${ids.matterId}/runs/${ids.runId}`);
    await page.evaluate("window.__sentinel = 1");
    await page.evaluate("document.querySelector('textarea').focus()");
    await page.keyboard.type("a");
    await page.keyboard.press("Enter");
    await page.keyboard.type("b");
    const note = await page.evaluate<{ value: string; sentinel: boolean }>(
      "({ value: document.activeElement.value, sentinel: window.__sentinel === 1 })",
    );
    if (note.value !== "a\nb")
      problems.push(`Enter in a text box did not start a new line: ${JSON.stringify(note.value)}`);
    if (!note.sentinel) problems.push("Enter in a text box sent the form");

    // Escape in the list of keys closes it and leaves focus on its heading.
    await goto(page, `${world.base}/matters/${ids.matterId}/runs/${ids.runId}`);
    // The letter keys work only while focus is in the issue table (so that no key is taken from a
    // person who is typing elsewhere), and the table's own box is a stop of Tab.
    await page.evaluate("document.querySelector('[data-zone=issues]').focus()");
    await page.keyboard.type("?");
    const opened = await page.evaluate<boolean>(
      "[...document.querySelectorAll('details')].some((d) => d.open && /shortcut/i.test(d.textContent || ''))",
    );
    if (!opened) problems.push("? did not open the list of keys");
    await page.keyboard.press("Escape");
    const closed = await page.evaluate<boolean>(
      "![...document.querySelectorAll('details')].some((d) => d.open && /shortcut/i.test(d.textContent || ''))",
    );
    if (!closed) problems.push("Escape did not close the list of keys");
    await context.close();
    expect(problems).toEqual([]);
  });

  describe("the audit itself can fail", () => {
    /** The sign-in page with a stylesheet made worse in the way a change might make it. */
    async function worsened(css: string): Promise<{ page: PwPage; close: () => Promise<void> }> {
      // The pages forbid a style element that a script adds (their security policy allows files of
      // their own and nothing else), so the test context lifts that for itself.
      const context = await contextFor("visitor", { bypassCSP: true });
      const page = await context.newPage();
      await goto(page, `${world.base}/`);
      await page.evaluate(
        `(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s); })()`,
      );
      return { page, close: () => context.close() };
    }

    it("reports the page that has it as it is: nothing", async () => {
      const { page, close } = await worsened("");
      expect(await checkText(page, "light")).toEqual([]);
      expect((await checkWalk(page, "light")).problems).toEqual([]);
      await close();
    });

    it("reports text that has lost its contrast, in either scheme", async () => {
      const { page, close } = await worsened("p, .muted { color: #b0b0b0 !important; }");
      expect((await checkText(page, "light")).length).toBeGreaterThan(0);
      await close();
      const dark = await worsened("p, .muted { color: #444444 !important; }");
      expect((await checkText(dark.page, "dark")).length).toBeGreaterThan(0);
      await dark.close();
    });

    it("reports a control that shows no ring, and a ring that cannot be seen", async () => {
      const none = await worsened(
        ":focus-visible { outline: none !important; box-shadow: none !important; }",
      );
      expect((await checkWalk(none.page, "light")).problems.join("\n")).toContain("no focus ring");
      await none.close();
      const faint = await worsened(":focus-visible { outline-color: #f4f1e8 !important; }");
      expect((await checkWalk(faint.page, "light")).problems.join("\n")).toContain("under 3:1");
      await faint.close();
    });

    it("reports a stop that is covered, an order the screen turns round, and a page that scrolls sideways", async () => {
      const covered = await worsened("");
      await covered.page.evaluate(
        "(() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;inset:0;z-index:99;'; document.body.appendChild(d); })()",
      );
      expect((await checkWalk(covered.page, "light")).problems.join("\n")).toContain("under");
      await covered.close();
      const reordered = await worsened(
        "main ul { display: flex !important; flex-direction: column-reverse !important; }",
      );
      expect(checkReadingOrder(await walk(reordered.page)).length).toBeGreaterThan(0);
      await reordered.close();
      const wide = await worsened("main { min-width: 2400px; }");
      expect(judgeReflow(await reflow(wide.page)).join("\n")).toContain("scrolls sideways");
      await wide.close();
    });

    it("reports a control that Tab leaves out, and a trap", async () => {
      const left = await worsened("");
      await left.page.evaluate(
        "document.querySelector('main button').setAttribute('tabindex', '-1')",
      );
      expect((await checkWalk(left.page, "light")).problems.join("\n")).toContain("not reached");
      await left.close();
      const trap = await worsened("");
      await trap.page.evaluate(
        "document.addEventListener('keydown', (e) => { if (e.key === 'Tab' && e.target.tagName === 'BUTTON') e.preventDefault(); })",
      );
      const caught = judgeWalk(await walk(trap.page), { skipLinkFirst: true }).join("\n");
      expect(caught).toContain("Tab did not leave or return to the start");
      await trap.close();
    });
  });
});
