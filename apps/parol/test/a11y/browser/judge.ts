/**
 * The judgements of the browser tests, as pure functions over readings that the page scripts
 * (`scripts.ts`) take. Nothing here needs a browser: `judge.test.ts` feeds each judgement a reading
 * that is right and one that is wrong, and shows that the wrong one is reported, so a judgement
 * that could never fail fails the build even on a machine with no Chromium.
 *
 * A judgement returns problems, each a sentence that names the control or the text, never the
 * document text of a matter (the pages these run on hold synthetic data only, and the sentences
 * carry a tag, a class and at most the first words of a label).
 */

export interface Candidate {
  id: number;
  tag: string;
  type: string | null;
  idAttr: string;
  cls: string;
  label: string;
  tabIndex: number;
  scroller: boolean;
  group: string | null;
  groupSize: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Ring {
  kind: "outline" | "shadow" | "none";
  style: string;
  width: number;
  offset: number;
  color: string | null;
  /** What lies behind the part of the ring that reads worst. */
  on?: string | null;
  ratio: number | null;
}

export interface StopReading {
  none: false;
  /** Focus is on a part the browser draws its own ring on (the calendar button of a date field). */
  native: boolean;
  id: number;
  tag: string;
  type: string | null;
  idAttr: string;
  cls: string;
  label: string;
  tabbable: boolean;
  onscreen: boolean;
  /** Everything of it that is in the window is under something drawn over it. */
  covered: boolean;
  /** Some of it is. */
  partly: boolean;
  /** It is taller than the window left under the sticky header, so some of it is out of view anyway. */
  oversize: boolean;
  coveredBy: string | null;
  left: number;
  top: number;
  right: number;
  bottom: number;
  ring: Ring;
}

export interface Walk {
  /** What the page offers, in document order. */
  expected: Candidate[];
  /** Controls that can be seen and clicked and that a tabindex below zero takes out of Tab order. */
  skipped: { tag: string; cls: string; label: string }[];
  /** What Tab reached, in the order it reached it. */
  stops: StopReading[];
  ended: "left" | "wrapped" | "limit";
  presses: number;
}

export interface TextSample {
  tag: string;
  cls: string;
  text: string;
  ratio: number;
  need: number;
  size: number;
  weight: number;
  fg: string;
  bg: string;
  disabled: boolean;
  /** The element that holds a background image behind the text, or the empty string. */
  image: string;
  opacity: number;
  count: number;
}

export interface Signature {
  texts: string[];
  controls: string[];
}

export interface Mark {
  tag: string;
  cls: string;
  seen: boolean;
  ink: string;
  behind: string;
}

export interface Reflow {
  scrollWidth: number;
  clientWidth: number;
  innerWidth: number;
  innerHeight: number;
  bodyScrollWidth: number;
  overflowing: string[];
  stickyBottom: number;
}

export interface Motion {
  running: number;
  timed: number;
  scrollBehavior: string;
}

export const RING_MIN = 3;
export const SPEC_TOLERANCE = 0.005;

/** How an element is named in a sentence: its tag, its first class, and the start of its label. */
export function nameOf(e: { tag: string; cls: string; label?: string; idAttr?: string }): string {
  const first = e.cls.trim().split(/\s+/)[0] ?? "";
  const label = e.label === undefined || e.label === "" ? "" : ` "${e.label.slice(0, 40)}"`;
  return `<${e.tag}${first === "" ? "" : `.${first}`}>${label}`;
}

/**
 * The problems of one Tab walk. Every control the page offers must be reached, in document order
 * and once; nothing else may take focus; each stop shows a ring of at least 3:1 and is neither off
 * the screen nor under something drawn over it; and the walk must end (a walk that never leaves is a
 * trap). With `forcedColors` the ring must be an outline, because that is all the browser keeps.
 */
export function judgeWalk(
  walk: Walk,
  options: { forcedColors?: boolean; skipLinkFirst?: boolean } = {},
): string[] {
  const problems: string[] = [];
  const expectedIds = new Set(walk.expected.map((c) => c.id));
  const reached = new Set(walk.stops.map((s) => s.id));

  if (walk.ended === "limit")
    problems.push(
      `Tab did not leave or return to the start within ${walk.presses} presses (a trap, or a loop)`,
    );

  for (const c of walk.expected)
    if (!reached.has(c.id)) problems.push(`not reached by Tab: ${nameOf(c)}`);
  for (const c of walk.skipped)
    problems.push(`not reached by Tab, which skips it (tabindex below zero): ${nameOf(c)}`);

  for (const s of walk.stops)
    if (!expectedIds.has(s.id))
      problems.push(`Tab stopped on something the page does not offer as a control: ${nameOf(s)}`);

  // The order: the stops that are controls, in the order reached, against the page's own order.
  const known = walk.stops.filter((s) => expectedIds.has(s.id));
  const order = walk.expected.filter((c) => reached.has(c.id));
  for (let i = 0; i < Math.min(known.length, order.length); i++) {
    if (known[i]!.id !== order[i]!.id) {
      problems.push(
        `Tab order differs from document order at stop ${i + 1}: Tab went to ${nameOf(known[i]!)} where the page has ${nameOf(order[i]!)}`,
      );
      break;
    }
  }

  if (options.skipLinkFirst === true) {
    const first = walk.stops[0];
    if (first === undefined || !first.cls.split(/\s+/).includes("skip-link"))
      problems.push("the first stop is not the skip link");
  }

  for (const s of walk.stops) {
    // On the browser's own calendar button the browser draws the ring, not the page.
    if (!s.native) {
      if (s.ring.kind === "none")
        problems.push(`no focus ring (outline ${s.ring.style}, no shadow): ${nameOf(s)}`);
      else if (options.forcedColors === true && s.ring.kind !== "outline")
        problems.push(`in forced colours the ring is not an outline: ${nameOf(s)}`);
      else if (s.ring.ratio !== null && s.ring.ratio + SPEC_TOLERANCE < RING_MIN)
        problems.push(
          `focus ring ${s.ring.color ?? ""} is ${s.ring.ratio}:1 against what is behind it${s.ring.on ? ` (${s.ring.on})` : ""}, under ${RING_MIN}:1: ${nameOf(s)}`,
        );
    }
    if (!s.onscreen) problems.push(`focus moved off the screen: ${nameOf(s)}`);
    else if (s.covered)
      problems.push(`focus is entirely under ${s.coveredBy ?? "another element"}: ${nameOf(s)}`);
    else if (s.partly && !s.oversize)
      problems.push(`focus is partly under ${s.coveredBy ?? "another element"}: ${nameOf(s)}`);
  }
  return problems;
}

/**
 * Whether the controls, in the order the page offers them, also run in reading order on the screen:
 * a control must not sit above the one before it unless it is in a column to the right, and two
 * controls on one row must not run right to left. Positions are those of the page before anything
 * was scrolled.
 */
export function judgeReadingOrder(expected: readonly Candidate[]): string[] {
  const problems: string[] = [];
  for (let i = 1; i < expected.length; i++) {
    const prev = expected[i - 1]!;
    const cur = expected[i]!;
    if (prev.cls.split(/\s+/).includes("skip-link") || cur.cls.split(/\s+/).includes("skip-link"))
      continue;
    const sameRow = cur.top < prev.bottom - 1 && cur.bottom > prev.top + 1;
    if (sameRow) {
      if (cur.right <= prev.left + 1)
        problems.push(
          `reading order: ${nameOf(cur)} comes after ${nameOf(prev)} in Tab order but sits to its left on the same row`,
        );
      continue;
    }
    const above = cur.bottom < prev.top - 1;
    if (above && !(cur.left >= prev.right - 2))
      problems.push(
        `reading order: ${nameOf(cur)} comes after ${nameOf(prev)} in Tab order but is drawn above it`,
      );
  }
  return problems;
}

/**
 * Text that is under its ratio. A disabled control is exempt, as WCAG exempts an inactive component.
 * A background image makes a ratio a guess; one is allowed only behind the scroll box of a table,
 * whose image is two strips in the page colour and an edge shadow beside the scroll buttons, and the
 * ratio there is taken over the page colour.
 */
export function judgeText(
  samples: readonly TextSample[],
  allowedImageHosts: readonly string[] = ["div.table-scroll"],
): string[] {
  const problems: string[] = [];
  for (const s of samples) {
    if (s.disabled) continue;
    if (s.image !== "" && !allowedImageHosts.includes(s.image))
      problems.push(
        `text over a background image (${s.image}), so its ratio is not known: ${nameOf(s)}`,
      );
    if (s.ratio + SPEC_TOLERANCE < s.need)
      problems.push(
        `text ${s.fg} on ${s.bg} is ${s.ratio}:1, under ${s.need}:1 (${s.size}px, weight ${s.weight}${s.count > 1 ? `, ${s.count} places` : ""}): ${nameOf(s)} "${s.text.slice(0, 30)}"`,
      );
  }
  return problems;
}

/** What one rendering of a page shows that another does not: text that is gone or new, controls likewise. */
export function judgeSame(a: Signature, b: Signature, what: string): string[] {
  const problems: string[] = [];
  const diff = (x: readonly string[], y: readonly string[]): string[] => {
    const set = new Set(y);
    return x.filter((item) => !set.has(item));
  };
  for (const t of diff(a.texts, b.texts))
    problems.push(`${what}: text only in the first: "${t.slice(0, 50)}"`);
  for (const t of diff(b.texts, a.texts))
    problems.push(`${what}: text only in the second: "${t.slice(0, 50)}"`);
  for (const t of diff(a.controls, b.controls))
    problems.push(`${what}: control only in the first: ${t.slice(0, 50)}`);
  for (const t of diff(b.controls, a.controls))
    problems.push(`${what}: control only in the second: ${t.slice(0, 50)}`);
  return problems;
}

/** The marks (shapes, bars) that can be told from their background in one rendering and not in another. */
export function judgeMarks(
  normal: readonly Mark[],
  other: readonly Mark[],
  what: string,
): string[] {
  const count = (marks: readonly Mark[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const mark of marks)
      if (mark.seen) m.set(`${mark.tag}.${mark.cls}`, (m.get(`${mark.tag}.${mark.cls}`) ?? 0) + 1);
    return m;
  };
  const before = count(normal);
  const after = count(other);
  const problems: string[] = [];
  for (const [key, n] of before) {
    const left = after.get(key) ?? 0;
    if (left < n)
      problems.push(`${what}: ${n - left} of ${n} marks <${key}> can no longer be seen`);
  }
  return problems;
}

/**
 * A page that scrolls sideways, or whose own parts reach past the edge, or whose sticky part fills
 * the screen. With a `maxStickyShare` of 0 nothing may be stuck to the top at all.
 */
export function judgeReflow(r: Reflow, options: { maxStickyShare?: number } = {}): string[] {
  const problems: string[] = [];
  if (r.scrollWidth > r.innerWidth + 1)
    problems.push(
      `the page scrolls sideways: it is ${r.scrollWidth}px wide in a ${r.innerWidth}px window`,
    );
  if (r.bodyScrollWidth > r.innerWidth + 1 && r.scrollWidth <= r.innerWidth + 1)
    problems.push(`the body is ${r.bodyScrollWidth}px wide in a ${r.innerWidth}px window`);
  for (const o of r.overflowing) problems.push(`reaches past the edge of the window: ${o}`);
  const share = options.maxStickyShare ?? 0.4;
  if (share === 0) {
    if (r.stickyBottom > 0)
      problems.push(
        `a part of the page is stuck to the top of the window (${Math.round(r.stickyBottom)}px tall) where nothing should be`,
      );
  } else if (r.stickyBottom > r.innerHeight * share)
    problems.push(
      `the sticky header is ${Math.round(r.stickyBottom)}px tall in a ${r.innerHeight}px window, over ${Math.round(share * 100)}% of it`,
    );
  return problems;
}

/** Reduced motion must leave no running animation and no timed transition. */
export function judgeMotion(m: Motion): string[] {
  const problems: string[] = [];
  if (m.running > 0) problems.push(`${m.running} animations are running under reduced motion`);
  if (m.timed > 0) problems.push(`${m.timed} elements still have a transition or animation time`);
  if (m.scrollBehavior === "smooth")
    problems.push("the page scrolls smoothly under reduced motion");
  return problems;
}

/** A name for every control in the browser's own accessibility tree: lines like `- button "Save"`, and `- button` with no name is the fault. */
export function unnamedInTree(snapshot: string): string[] {
  const NAMED_ROLES = [
    "button",
    "link",
    "textbox",
    "combobox",
    "checkbox",
    "radio",
    "searchbox",
    "spinbutton",
    "slider",
    "switch",
    "tab",
    "menuitem",
    "option",
    "listbox",
  ];
  const problems: string[] = [];
  for (const line of snapshot.split("\n")) {
    const m = /^\s*- ([a-z]+)(?: ("(?:[^"\\]|\\.)*"))?(.*)$/.exec(line);
    if (m === null) continue;
    const role = m[1]!;
    if (!NAMED_ROLES.includes(role)) continue;
    const name = m[2];
    if (name === undefined || name === '""')
      problems.push(`the accessibility tree has an unnamed ${role}`);
  }
  return problems;
}
