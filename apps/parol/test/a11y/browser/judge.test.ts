import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { SETTLE } from "./drive.js";
import {
  judgeMarks,
  judgeMotion,
  judgeReadingOrder,
  judgeReflow,
  judgeSame,
  judgeText,
  judgeWalk,
  unnamedInTree,
  type Candidate,
  type Mark,
  type Reflow,
  type StopReading,
  type TextSample,
  type Walk,
} from "./judge.js";
import { PAGE_GETS } from "../inventory.js";
import { openBrowser } from "./playwright.js";
import { COLOR_MATH, PRELUDE } from "./scripts.js";
import { targets } from "./targets.js";
import type { Ids } from "./world.js";

/**
 * The browser tests judge what a browser reports. These tests judge the judging: no browser and no
 * server, only readings made by hand. Each judgement is given a reading that is right, and then
 * readings that are wrong in one way each, and must say nothing to the first and name the fault in
 * the others. So a judgement that could not fail would fail here, on every machine, whether or not
 * Chromium is installed.
 */

// ---------------------------------------------------------------------------------------------
// The colour arithmetic that runs in the page, run here in Node
// ---------------------------------------------------------------------------------------------

type Rgba = [number, number, number, number];
const math = new Function(
  `${COLOR_MATH}; return { parseColor, over, luminance, contrast, hex };`,
)() as {
  parseColor: (css: string, fallback?: (css: string) => Rgba) => Rgba;
  over: (top: Rgba, bottom: Rgba) => Rgba;
  luminance: (c: Rgba) => number;
  contrast: (a: Rgba, b: Rgba) => number;
  hex: (c: Rgba) => string;
};

describe("the colour arithmetic of the page scripts", () => {
  const black: Rgba = [0, 0, 0, 1];
  const white: Rgba = [255, 255, 255, 1];

  it("gives 21 for black on white and 1 for a colour on itself", () => {
    expect(math.contrast(black, white)).toBeCloseTo(21, 5);
    expect(math.contrast(white, black)).toBeCloseTo(21, 5);
    expect(math.contrast([120, 90, 30, 1], [120, 90, 30, 1])).toBe(1);
  });

  it("sits on the right side of 4.5 for the two greys that WCAG's own examples use", () => {
    // #767676 on white is the lightest grey that reads at 4.5 (4.54); #777777 is just under (4.48).
    expect(math.contrast(math.parseColor("rgb(118, 118, 118)"), white)).toBeGreaterThanOrEqual(4.5);
    expect(math.contrast(math.parseColor("rgb(119, 119, 119)"), white)).toBeLessThan(4.5);
  });

  it("reads the forms of a colour that the browser reports, and asks for help with any other", () => {
    expect(math.parseColor("rgb(31, 74, 122)")).toEqual([31, 74, 122, 1]);
    expect(math.parseColor("rgba(31, 74, 122, 0.5)")).toEqual([31, 74, 122, 0.5]);
    expect(math.parseColor("rgb(31 74 122 / 25%)")).toEqual([31, 74, 122, 0.25]);
    expect(math.parseColor("color(srgb 1 0 0.5 / 0.5)")).toEqual([255, 0, 127.5, 0.5]);
    expect(math.parseColor("transparent")).toEqual([0, 0, 0, 0]);
    expect(math.parseColor("oklch(0.5 0.1 200)", () => [1, 2, 3, 1])).toEqual([1, 2, 3, 1]);
    expect(() => math.parseColor("oklch(0.5 0.1 200)")).toThrow();
  });

  it("lays a colour with alpha over what is behind it", () => {
    expect(math.over([0, 0, 0, 0.5], white)).toEqual([127.5, 127.5, 127.5, 1]);
    expect(math.over([10, 20, 30, 0], white)).toEqual([255, 255, 255, 1]);
    expect(math.over([10, 20, 30, 1], white)).toEqual([10, 20, 30, 1]);
    expect(math.hex([255, 0, 128, 1])).toBe("#ff0080");
  });
});

describe("the strings that run in the page", () => {
  it("are valid scripts, so a typo in them fails here and not only where Chromium is installed", () => {
    expect(() => new Script(PRELUDE)).not.toThrow();
    expect(() => new Script(SETTLE)).not.toThrow();
    expect(PRELUDE).toContain("window.__pw = {");
    expect(PRELUDE).not.toContain("//COLOR_MATH_HERE");
    expect(PRELUDE).toContain("function contrast(");
  });

  it("change nothing on the page: the readers never write markup or text, and never click", () => {
    // The few scripts that touch the page say so: the colour probe adds and removes one element, and
    // the focus reset puts focus on the body. Nothing writes markup or text, or presses anything.
    expect(PRELUDE).not.toMatch(
      /innerHTML\s*=|outerHTML\s*=|textContent\s*=|\.click\(|dispatchEvent/,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Readings made by hand
// ---------------------------------------------------------------------------------------------

let nextId = 1;
const cand = (over: Partial<Candidate> = {}): Candidate => ({
  id: nextId++,
  tag: "button",
  type: null,
  idAttr: "",
  cls: "",
  label: "Save",
  tabIndex: 0,
  scroller: false,
  group: null,
  groupSize: 0,
  left: 0,
  top: 0,
  right: 100,
  bottom: 30,
  ...over,
});

const stopOf = (c: Candidate, over: Partial<StopReading> = {}): StopReading => ({
  none: false,
  native: false,
  id: c.id,
  tag: c.tag,
  type: c.type,
  idAttr: c.idAttr,
  cls: c.cls,
  label: c.label,
  tabbable: true,
  onscreen: true,
  covered: false,
  partly: false,
  oversize: false,
  coveredBy: null,
  left: c.left,
  top: c.top,
  right: c.right,
  bottom: c.bottom,
  ring: { kind: "outline", style: "solid", width: 3, offset: 2, color: "#1f4a7a", ratio: 8.5 },
  ...over,
});

const skip = (): Candidate => cand({ tag: "a", cls: "skip-link", label: "Skip to main content" });

/** A walk that is right: a skip link and three controls, each reached once, in order. */
function goodWalk(): { walk: Walk; items: Candidate[] } {
  const items = [
    skip(),
    cand({ label: "One", top: 10, bottom: 40 }),
    cand({ label: "Two", top: 50, bottom: 80 }),
    cand({ label: "Three", top: 90, bottom: 120 }),
  ];
  return {
    items,
    walk: {
      expected: items,
      skipped: [],
      stops: items.map((c) => stopOf(c)),
      ended: "left",
      presses: items.length + 1,
    },
  };
}

describe("the judgement of a Tab walk", () => {
  it("says nothing of a walk that is right", () => {
    expect(judgeWalk(goodWalk().walk, { skipLinkFirst: true })).toEqual([]);
  });

  it("names a control that Tab never reached", () => {
    const { walk, items } = goodWalk();
    walk.stops = walk.stops.filter((s) => s.id !== items[2]!.id);
    expect(judgeWalk(walk).join("\n")).toContain('not reached by Tab: <button> "Two"');
  });

  it("names a control that a tabindex below zero took out of the order", () => {
    const { walk } = goodWalk();
    walk.skipped = [{ tag: "a", cls: "", label: "Hidden from Tab" }];
    expect(judgeWalk(walk).join("\n")).toContain('tabindex below zero): <a> "Hidden from Tab"');
  });

  it("names a stop that the page does not offer, and an order that is not the page's", () => {
    const { walk } = goodWalk();
    const stranger = cand({ tag: "div", label: "Something focusable" });
    expect(judgeWalk({ ...walk, stops: [...walk.stops, stopOf(stranger)] }).join("\n")).toContain(
      "does not offer as a control",
    );
    const swapped = [walk.stops[0]!, walk.stops[2]!, walk.stops[1]!, walk.stops[3]!];
    expect(judgeWalk({ ...walk, stops: swapped }).join("\n")).toContain(
      "Tab order differs from document order at stop 2",
    );
  });

  it("names a walk that never ends, and a first stop that is not the skip link", () => {
    const { walk } = goodWalk();
    expect(judgeWalk({ ...walk, ended: "limit" }).join("\n")).toContain("did not leave or return");
    const withoutSkip = { ...walk, stops: walk.stops.slice(1), expected: walk.expected.slice(1) };
    expect(judgeWalk(withoutSkip, { skipLinkFirst: true }).join("\n")).toContain(
      "the first stop is not the skip link",
    );
  });

  it("names a stop with no ring, and a ring under 3:1 (3 itself is enough)", () => {
    const { walk } = goodWalk();
    const none = stopOf(walk.expected[1]!, {
      ring: { kind: "none", style: "none", width: 3, offset: 0, color: null, ratio: null },
    });
    expect(
      judgeWalk({ ...walk, stops: [walk.stops[0]!, none, walk.stops[2]!, walk.stops[3]!] }).join(
        "\n",
      ),
    ).toContain("no focus ring");
    const faint = (ratio: number): Walk => ({
      ...walk,
      stops: [
        walk.stops[0]!,
        stopOf(walk.expected[1]!, {
          ring: {
            kind: "outline",
            style: "solid",
            width: 3,
            offset: 2,
            color: "#aaaaaa",
            on: "div.x",
            ratio,
          },
        }),
        walk.stops[2]!,
        walk.stops[3]!,
      ],
    });
    expect(judgeWalk(faint(2.99)).join("\n")).toContain(
      "2.99:1 against what is behind it (div.x), under 3:1",
    );
    expect(judgeWalk(faint(3))).toEqual([]);
  });

  it("wants an outline in forced colours, where a shadow is taken away", () => {
    const { walk } = goodWalk();
    const shadow = stopOf(walk.expected[1]!, {
      ring: { kind: "shadow", style: "none", width: 3, offset: 0, color: "#1f4a7a", ratio: 8 },
    });
    const stops = [walk.stops[0]!, shadow, walk.stops[2]!, walk.stops[3]!];
    expect(judgeWalk({ ...walk, stops }, { forcedColors: true }).join("\n")).toContain(
      "not an outline",
    );
    expect(judgeWalk({ ...walk, stops })).toEqual([]);
  });

  it("leaves the ring on the browser's own calendar button to the browser", () => {
    const { walk } = goodWalk();
    const date = stopOf(walk.expected[1]!, {
      native: true,
      ring: { kind: "none", style: "none", width: 3, offset: 0, color: null, ratio: null },
    });
    const stops = [walk.stops[0]!, date, walk.stops[2]!, walk.stops[3]!];
    expect(judgeWalk({ ...walk, stops })).toEqual([]);
  });

  it("names a stop that is off the screen or under something, and allows a tall box to be partly under", () => {
    const { walk } = goodWalk();
    const stops = (over: Partial<StopReading>): StopReading[] => [
      walk.stops[0]!,
      stopOf(walk.expected[1]!, over),
      walk.stops[2]!,
      walk.stops[3]!,
    ];
    expect(judgeWalk({ ...walk, stops: stops({ onscreen: false }) }).join("\n")).toContain(
      "off the screen",
    );
    expect(
      judgeWalk({
        ...walk,
        stops: stops({ covered: true, partly: true, coveredBy: "div.demo-banner" }),
      }).join("\n"),
    ).toContain("entirely under div.demo-banner");
    expect(
      judgeWalk({ ...walk, stops: stops({ partly: true, coveredBy: "div.demo-banner" }) }).join(
        "\n",
      ),
    ).toContain("partly under div.demo-banner");
    expect(
      judgeWalk({
        ...walk,
        stops: stops({ partly: true, oversize: true, coveredBy: "div.demo-banner" }),
      }),
    ).toEqual([]);
    // A box taller than the window is excused only for being partly covered, never for all of it.
    expect(
      judgeWalk({
        ...walk,
        stops: stops({ covered: true, partly: true, oversize: true, coveredBy: "x" }),
      }).join("\n"),
    ).toContain("entirely under");
  });
});

describe("the judgement of reading order", () => {
  const at = (label: string, left: number, top: number, right: number, bottom: number): Candidate =>
    cand({ label, left, top, right, bottom });

  it("accepts rows read left to right, a column below, and a second column to the right that begins higher", () => {
    expect(
      judgeReadingOrder([
        at("a", 0, 0, 100, 30),
        at("b", 110, 2, 200, 28),
        at("c", 0, 60, 100, 90),
        at("right column", 400, 20, 500, 50),
        at("below everything", 0, 300, 100, 330),
      ]),
    ).toEqual([]);
  });

  it("names a control that is drawn above the one before it, and one that runs right to left on a row", () => {
    expect(
      judgeReadingOrder([at("lower", 0, 100, 100, 130), at("higher", 0, 10, 100, 40)]).join("\n"),
    ).toContain("is drawn above it");
    expect(
      judgeReadingOrder([at("right", 300, 0, 400, 30), at("left", 0, 0, 100, 30)]).join("\n"),
    ).toContain("sits to its left on the same row");
  });

  it("does not count the skip link, which is drawn off the page until it has focus", () => {
    expect(
      judgeReadingOrder([
        cand({ cls: "skip-link", top: -64, bottom: -20 }),
        at("a", 0, 0, 100, 30),
      ]),
    ).toEqual([]);
  });
});

const sample = (over: Partial<TextSample> = {}): TextSample => ({
  tag: "p",
  cls: "",
  text: "Words",
  ratio: 7,
  need: 4.5,
  size: 16,
  weight: 400,
  fg: "#1d1c1a",
  bg: "#fbf9f4",
  disabled: false,
  image: "",
  opacity: 1,
  count: 1,
  ...over,
});

describe("the judgement of text contrast", () => {
  it("says nothing of text that reads, and names text that does not", () => {
    expect(judgeText([sample()])).toEqual([]);
    expect(judgeText([sample({ ratio: 4.49 })]).join("\n")).toContain("4.49:1, under 4.5:1");
    expect(judgeText([sample({ ratio: 4.5 })])).toEqual([]);
  });

  it("holds large text to 3 and not to 4.5", () => {
    expect(judgeText([sample({ ratio: 3.2, need: 3, size: 24 })])).toEqual([]);
    expect(judgeText([sample({ ratio: 2.9, need: 3, size: 24 })]).join("\n")).toContain(
      "under 3:1",
    );
  });

  it("exempts a disabled control, and refuses a guess over a background image", () => {
    expect(judgeText([sample({ ratio: 1.5, disabled: true })])).toEqual([]);
    expect(judgeText([sample({ image: "div.hero" })]).join("\n")).toContain(
      "background image (div.hero)",
    );
    expect(judgeText([sample({ image: "div.table-scroll" })])).toEqual([]);
  });
});

describe("the other judgements", () => {
  it("compares what two renderings show, in both directions", () => {
    const a = { texts: ["Alpha", "Beta"], controls: ["a:Home", "button:Save"] };
    expect(
      judgeSame(a, { texts: ["Alpha", "Beta"], controls: ["a:Home", "button:Save"] }, "x"),
    ).toEqual([]);
    const lost = judgeSame(a, { texts: ["Alpha"], controls: ["a:Home"] }, "scripts off").join("\n");
    expect(lost).toContain('text only in the first: "Beta"');
    expect(lost).toContain("control only in the first: button:Save");
    expect(judgeSame({ texts: [], controls: [] }, a, "x").join("\n")).toContain(
      "only in the second",
    );
  });

  it("finds marks that can no longer be told from their background", () => {
    const mark = (seen: boolean): Mark => ({
      tag: "span",
      cls: "shape",
      seen,
      ink: "#000000",
      behind: "#ffffff",
    });
    expect(
      judgeMarks([mark(true), mark(true)], [mark(true), mark(true)], "forced colours"),
    ).toEqual([]);
    expect(
      judgeMarks([mark(true), mark(true)], [mark(true), mark(false)], "forced colours").join("\n"),
    ).toContain("1 of 2 marks <span.shape> can no longer be seen");
  });

  it("finds a page that scrolls sideways, a part that reaches past the edge, and a header that fills the window", () => {
    const ok: Reflow = {
      scrollWidth: 640,
      clientWidth: 640,
      innerWidth: 640,
      innerHeight: 450,
      bodyScrollWidth: 640,
      overflowing: [],
      stickyBottom: 34,
    };
    expect(judgeReflow(ok)).toEqual([]);
    expect(judgeReflow({ ...ok, scrollWidth: 861 }).join("\n")).toContain(
      "861px wide in a 640px window",
    );
    expect(judgeReflow({ ...ok, overflowing: ["table right=700"] }).join("\n")).toContain(
      "past the edge",
    );
    expect(judgeReflow({ ...ok, stickyBottom: 300 }).join("\n")).toContain("sticky header");
    // A window that allows nothing to stick to its top: any stuck part is named, and none is fine.
    expect(judgeReflow({ ...ok, stickyBottom: 34 }, { maxStickyShare: 0 }).join("\n")).toContain(
      "stuck to the top of the window (34px tall)",
    );
    expect(judgeReflow({ ...ok, stickyBottom: 0 }, { maxStickyShare: 0 })).toEqual([]);
  });

  it("finds animation that reduced motion should have stopped", () => {
    expect(judgeMotion({ running: 0, timed: 0, scrollBehavior: "auto" })).toEqual([]);
    expect(judgeMotion({ running: 2, timed: 0, scrollBehavior: "auto" }).join("\n")).toContain(
      "2 animations",
    );
    expect(judgeMotion({ running: 0, timed: 3, scrollBehavior: "auto" }).join("\n")).toContain(
      "3 elements",
    );
    expect(judgeMotion({ running: 0, timed: 0, scrollBehavior: "smooth" }).join("\n")).toContain(
      "smoothly",
    );
  });

  it("reads the browser's accessibility tree for controls with no name", () => {
    const tree = [
      '- link "Skip to main content":',
      "  - /url: #main",
      '- button "Save"',
      "- textbox",
      '- combobox "Role":',
      "- button",
      '- heading "Title" [level=1]',
    ].join("\n");
    expect(unnamedInTree(tree)).toEqual([
      "the accessibility tree has an unnamed textbox",
      "the accessibility tree has an unnamed button",
    ]);
    expect(unnamedInTree('- button "Save"\n- link "Home":')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The pages the sweep visits
// ---------------------------------------------------------------------------------------------

describe("the list of pages and roles", () => {
  const ids: Ids = {
    lanternfish: { matterId: "mat_1", runId: "run_1", findingId: "fnd_1" },
    training: { matterId: "mat_2" },
    exported: { matterId: "mat_3", runId: "run_3", findingId: "fnd_3", memoId: "mem_3" },
    baseline: { matterId: "mat_4" },
    empty: { matterId: "mat_5" },
    other: { matterId: "mat_6" },
    comparisonId: "cmp_0123456789abcdef",
  };
  const all = targets(ids);

  it("has every role, each page once, and a status for each", () => {
    expect(new Set(all.map((t) => t.role))).toEqual(
      new Set(["visitor", "associate", "reviewer", "viewer", "legal engineer", "administrator"]),
    );
    const keys = all.map((t) => `${t.role} ${t.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(all.every((t) => [200, 403, 404].includes(t.expect))).toBe(true);
  });

  it("gives the pages that name no matter to the global roles the tables name, and 403 to the rest", () => {
    const status = (role: string, path: string): number | undefined =>
      all.find((t) => t.role === role && t.path === path)?.expect;
    for (const path of ["/evaluations", "/pilot", "/training/key"]) {
      expect(status("associate", path)).toBe(403);
      expect(status("viewer", path)).toBe(403);
      expect(status("legal engineer", path)).toBe(200);
      expect(status("administrator", path)).toBe(200);
    }
    expect(status("legal engineer", "/audit")).toBe(403);
    expect(status("administrator", "/audit")).toBe(200);
  });

  it("has a page for every page route of the route inventory, in a role that is shown it, and in one that is refused", () => {
    // A page added to the application is added to PAGE_GETS (the inventory test says so); this makes
    // the browser sweep follow, so a new page is walked in a real browser too.
    const pattern = (template: string): RegExp =>
      new RegExp(`^${template.replace(/:[A-Za-z]+/g, "[^/?]+").replace(/\//g, "\\/")}(\\?.*)?$`);
    for (const route of PAGE_GETS) {
      const matches = all.filter((t) => pattern(route).test(t.path));
      expect(matches.length, `no target for ${route}`).toBeGreaterThan(0);
      expect(
        matches.some((t) => t.expect === 200),
        `${route} is never shown`,
      ).toBe(true);
    }
    // The pages that need a global role are also refused to someone without it.
    for (const route of ["/evaluations", "/pilot", "/audit", "/training/key"])
      expect(
        all.some((t) => t.path.startsWith(route) && t.expect === 403),
        route,
      ).toBe(true);
  });

  it("tells a person with no part in a matter that it is not found, for a matter that exists and for one that does not", () => {
    const other = all.find((t) => t.role === "associate" && t.path === "/matters/mat_6");
    const missing = all.find(
      (t) => t.role === "associate" && t.name === "a matter that does not exist",
    );
    expect(other?.expect).toBe(404);
    expect(missing?.expect).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------
// Finding Playwright
// ---------------------------------------------------------------------------------------------

describe("finding Playwright and Chromium without a dependency", () => {
  const folders: string[] = [];
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true });
  });

  /** A folder with a stand-in `playwright` package whose Chromium starts, or does not. */
  function standIn(starts: boolean): string {
    const root = mkdtempSync(join(tmpdir(), "parol-pw-"));
    folders.push(root);
    const dir = join(root, "playwright");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "playwright", version: "9.9.9", main: "index.js" }),
    );
    writeFileSync(
      join(dir, "index.js"),
      starts
        ? "exports.chromium = { launch: async () => ({ version: () => '1.2.3', close: async () => {} }) };"
        : "exports.chromium = { launch: async () => { throw new Error('no browser here'); } };",
    );
    return root;
  }

  it("takes the package from PLAYWRIGHT_MODULES_DIR first, and records the versions it ran with", async () => {
    process.env["PLAYWRIGHT_MODULES_DIR"] = standIn(true);
    const result = await openBrowser();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.opened.versions).toEqual({ playwright: "9.9.9", chromium: "1.2.3" });
    expect(result.opened.foundBy).toBe("PLAYWRIGHT_MODULES_DIR");
    await result.opened.browser.close();
  });

  it("says so, in a sentence, when the package is there and the browser will not start", async () => {
    process.env["PLAYWRIGHT_MODULES_DIR"] = standIn(false);
    const result = await openBrowser();
    expect(result).toEqual({ ok: false, reason: "Chromium could not be started by Playwright" });
  });
});
