import {
  judgeMarks,
  judgeMotion,
  judgeReflow,
  judgeSame,
  judgeText,
  judgeWalk,
  judgeReadingOrder,
  unnamedInTree,
  type Candidate,
  type Mark,
  type Motion,
  type Reflow,
  type Signature,
  type StopReading,
  type TextSample,
  type Walk,
} from "./judge.js";
import type { PwPage } from "./playwright.js";
import { PRELUDE } from "./scripts.js";

/**
 * Taking the readings: this is the only code that presses keys and runs the page scripts. Every
 * reading is then judged by `judge.ts`. A key press here is what a person's hand would do (`Tab`,
 * `Shift+Tab`); nothing clicks.
 */

/**
 * Loads the readers into the page. Run again after every navigation. With `script` false (a page
 * whose scripts are switched off) nothing is waited for: a page with its script off runs no frame
 * callback, and there is no script of the page to wait for either.
 */
export async function prepare(page: PwPage, script = true): Promise<void> {
  await page.evaluate(PRELUDE);
  if (!script) return;
  // The page's script may move focus and scroll (it scrolls a chosen quote into view, smoothly unless
  // motion is reduced). Wait until nothing has moved for a few frames, so a reading is not taken
  // while a scroll is still under way.
  await page.evaluate(SETTLE);
}

export const SETTLE = `new Promise((resolve) => {
  let last = "";
  let still = 0;
  let frames = 0;
  const boxes = () => [...document.querySelectorAll(".inspector, .table-scroll, .doc-text")];
  const tick = () => {
    const now = [scrollX, scrollY, ...boxes().map((b) => b.scrollTop + ":" + b.scrollLeft)].join(",");
    still = now === last ? still + 1 : 0;
    last = now;
    frames++;
    if (still >= 5 || frames >= 150) resolve(frames);
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})`;

export async function goto(page: PwPage, url: string, script = true): Promise<void> {
  await page.goto(url);
  await prepare(page, script);
}

const SLACK = 40;
const MOST_REPEATS = 6;

/**
 * Walks the page with Tab (or Shift+Tab), from the start of the document, and reads each stop. The
 * walk ends when focus leaves the document, when it comes round to a control it has seen, or at a
 * limit that only a trap can reach. A control that keeps focus for a few presses (a date field has
 * parts) counts once.
 */
export async function walk(
  page: PwPage,
  direction: "forward" | "backward" = "forward",
  script = true,
): Promise<Walk> {
  await prepare(page, script);
  const offered = await page.evaluate<Candidate[]>("window.__pw.tabbables()");
  const skipped = await page.evaluate<Walk["skipped"]>("window.__pw.skipped()");
  // Going back, the page's own order is met from its end.
  const expected = direction === "backward" ? [...offered].reverse() : offered;
  await page.evaluate("window.__pw.resetFocus()");
  const key = direction === "forward" ? "Tab" : "Shift+Tab";
  // A walk ends by itself: it leaves the page, comes round to a control it has seen, or stays on
  // one control for more than a few presses. The limit only stops a script that moves focus about
  // without end, and a date field takes several presses for its parts.
  const limit = expected.length * 4 + SLACK;
  const stops: StopReading[] = [];
  const seen = new Set<number>();
  let ended: Walk["ended"] = "limit";
  let last = -1;
  let repeats = 0;
  let presses = 0;
  let retried = false;
  while (presses < limit) {
    await page.keyboard.press(key);
    presses++;
    const reading = await page.evaluate<StopReading | { none: true }>("window.__pw.stop()");
    if (reading.none) {
      // Shift+Tab from the start of the document first goes out of the page, and the next press
      // comes back in at the last control. That first step is not the end of the walk.
      if (stops.length === 0 && !retried) {
        retried = true;
        continue;
      }
      ended = "left";
      break;
    }
    if (reading.id === last) {
      repeats++;
      if (repeats > MOST_REPEATS) break;
      continue;
    }
    repeats = 0;
    if (seen.has(reading.id)) {
      ended = "wrapped";
      break;
    }
    seen.add(reading.id);
    stops.push(reading);
    last = reading.id;
  }
  return { expected, skipped, stops, ended, presses };
}

export const textSamples = (page: PwPage): Promise<TextSample[]> =>
  page.evaluate<TextSample[]>("window.__pw.textSamples()");
export const signature = (page: PwPage): Promise<Signature> =>
  page.evaluate<Signature>("window.__pw.signature()");
export const marks = (page: PwPage): Promise<Mark[]> =>
  page.evaluate<Mark[]>("window.__pw.marks()");
export const reflow = (page: PwPage): Promise<Reflow> =>
  page.evaluate<Reflow>("window.__pw.reflow()");
export const motion = (page: PwPage): Promise<Motion> =>
  page.evaluate<Motion>("window.__pw.motion()");

export interface Active {
  id: number;
  tag: string;
  idAttr: string;
  cls: string;
  label: string;
  hash: string;
  scrollY: number;
  value: string | null;
}
export const active = (page: PwPage): Promise<Active | null> =>
  page.evaluate<Active | null>("window.__pw.active()");

// ---------------------------------------------------------------------------------------------
// The checks of one page, as a list of problems
// ---------------------------------------------------------------------------------------------

export type Scheme = "light" | "dark";

/** Text contrast in a colour scheme. The page is left in that scheme. */
export async function checkText(page: PwPage, scheme: Scheme): Promise<string[]> {
  await page.emulateMedia({ colorScheme: scheme });
  await prepare(page);
  return judgeText(await textSamples(page)).map((p) => `[${scheme}] ${p}`);
}

/** The walk in one scheme: order, rings, covered or off-screen stops, traps. */
export async function checkWalk(
  page: PwPage,
  scheme: Scheme,
  options: { forcedColors?: boolean } = {},
): Promise<{ problems: string[]; walk: Walk }> {
  await page.emulateMedia({ colorScheme: scheme });
  const w = await walk(page);
  const problems = judgeWalk(w, { skipLinkFirst: true, ...options }).map((p) => `[${scheme}] ${p}`);
  return { problems, walk: w };
}

/** The backward walk must be the forward one reversed. */
export async function checkBackward(page: PwPage, forward: Walk): Promise<string[]> {
  const back = await walk(page, "backward");
  const problems = judgeWalk(back, {}).map((p) => `[backward] ${p}`);
  const f = forward.stops.map((s) => s.id);
  const b = back.stops.map((s) => s.id).reverse();
  // The radio group's stop can differ by direction; compare the others by position.
  const radio = new Set(back.expected.filter((c) => c.group !== null).map((c) => c.id));
  const fx = f.filter((id) => !radio.has(id));
  const bx = b.filter((id) => !radio.has(id));
  if (fx.length !== bx.length || fx.some((id, i) => id !== bx[i]))
    problems.push("[backward] Shift+Tab visits the controls in another order than Tab, reversed");
  return problems;
}

export const checkReadingOrder = (w: Walk): string[] => judgeReadingOrder(w.expected);

/** The names the browser's own accessibility tree gives, as problems. */
export async function checkNames(page: PwPage): Promise<string[]> {
  return unnamedInTree(await page.locator("body").ariaSnapshot());
}

/**
 * The skip link: it is the first stop, it shows itself, Enter on it puts focus in the main region
 * (and the address says so), and the next Tab is the first control inside the main region.
 */
export async function checkSkipLink(page: PwPage, script = true): Promise<string[]> {
  const problems: string[] = [];
  await prepare(page, script);
  await page.evaluate("window.__pw.resetFocus()");
  await page.keyboard.press("Tab");
  const first = await active(page);
  if (first === null || !first.cls.split(/\s+/).includes("skip-link")) {
    return ["the first Tab does not reach the skip link"];
  }
  const shown = await page.evaluate<StopReading>("window.__pw.stop()");
  if (!shown.onscreen) problems.push("the focused skip link is not on the screen");
  const target = await page.evaluate<number | null>("window.__pw.firstInMain()");
  await page.keyboard.press("Enter");
  const landed = await active(page);
  if (landed === null || landed.idAttr !== "main" || !landed.hash.endsWith("#main"))
    problems.push(
      `Enter on the skip link leaves focus on ${landed === null ? "nothing" : `<${landed.tag}${landed.idAttr === "" ? "" : `#${landed.idAttr}`}>`} (address ${landed?.hash ?? ""}), not on the main region`,
    );
  await page.keyboard.press("Tab");
  const next = await active(page);
  if (target === null) {
    if (
      next !== null &&
      (await page.evaluate<boolean>(
        "document.getElementById('main').contains(document.activeElement)",
      ))
    )
      problems.push("the main region holds nothing Tab can reach, yet Tab stopped inside it");
  } else if (next === null || next.id !== target) {
    problems.push(
      `after the skip link the next Tab goes to ${next === null ? "nothing" : `<${next.tag}> "${next.label}"`}, not to the first control in the main region`,
    );
  }
  return problems;
}

export { judgeMarks, judgeMotion, judgeReflow, judgeSame };
