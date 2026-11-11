import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SHAPES } from "../../src/server/pages/components.js";
import { all, classes, parseHtml } from "./html.js";
import { variants } from "./variants.js";

const CSS_PATH = join(import.meta.dirname, "../../public/parol.css");
const css = readFileSync(CSS_PATH, "utf8");

// ---------------------------------------------------------------------------------------------
// WCAG 2.x contrast
// ---------------------------------------------------------------------------------------------

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of a #rrggbb colour, as WCAG defines it. */
export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (m === null) throw new Error(`not a #rrggbb colour: ${hex}`);
  const [r, g, b] = [1, 2, 3].map((i) => channel(Number.parseInt(m[i] as string, 16)));
  return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
}

/** The contrast ratio of two colours, from 1 (the same) to 21 (black on white). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("the contrast arithmetic", () => {
  it("gives 21 for black on white and 1 for a colour on itself", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrast("#3b82f6", "#3b82f6")).toBe(1);
  });

  it("matches published values", () => {
    // #767676 on white is the lightest grey that passes AA for body text.
    expect(contrast("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
    expect(contrast("#777777", "#ffffff")).toBeLessThan(4.5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(contrast("#ff0000", "#ffffff")).toBeCloseTo(4.0, 1);
    expect(contrast("#0000ff", "#ffffff")).toBeCloseTo(8.59, 2);
  });

  it("weights green most and blue least", () => {
    expect(luminance("#00ff00")).toBeCloseTo(0.7152, 4);
    expect(luminance("#ff0000")).toBeCloseTo(0.2126, 4);
    expect(luminance("#0000ff")).toBeCloseTo(0.0722, 4);
    expect(luminance("#ffffff")).toBeCloseTo(1, 6);
    expect(luminance("#000000")).toBe(0);
  });

  it("is symmetric", () => {
    expect(contrast("#1f4a7a", "#fbf9f4")).toBe(contrast("#fbf9f4", "#1f4a7a"));
  });

  it("refuses something that is not a colour", () => {
    expect(() => luminance("red")).toThrow();
    expect(() => luminance("#fff")).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// Tokens in both themes
// ---------------------------------------------------------------------------------------------

type Tokens = Record<string, string>;

function declarations(block: string): Tokens {
  const out: Tokens = {};
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
    out[m[1] as string] = (m[2] as string).trim();
  return out;
}

function themes(): { light: Tokens; dark: Tokens } {
  const marker = "@media (prefers-color-scheme: dark)";
  const at = css.indexOf(marker);
  expect(at, "a dark theme exists").toBeGreaterThan(-1);
  const lightBlock = /:root\s*\{([^}]*)\}/.exec(css.slice(0, at))?.[1] ?? "";
  const darkBlock = /:root\s*\{([^}]*)\}/.exec(css.slice(at))?.[1] ?? "";
  return { light: declarations(lightBlock), dark: declarations(darkBlock) };
}

const isColour = (v: string): boolean => /^#[0-9a-f]{6}$/i.test(v);

describe("colour tokens", () => {
  const { light, dark } = themes();

  it("are defined for light and dark, with the same names", () => {
    const names = (t: Tokens) =>
      Object.keys(t)
        .filter((k) => isColour(t[k] as string))
        .sort();
    expect(names(light).length).toBeGreaterThan(25);
    expect(names(dark)).toEqual(names(light));
  });

  it("differ between themes for the surfaces and the ink", () => {
    for (const name of ["--paper", "--surface", "--ink", "--muted", "--accent"]) {
      expect(dark[name], name).not.toBe(light[name]);
    }
    expect(luminance(light["--paper"] as string)).toBeGreaterThan(
      luminance(light["--ink"] as string),
    );
    expect(luminance(dark["--paper"] as string)).toBeLessThan(luminance(dark["--ink"] as string));
  });

  it("declare both schemes to the browser", () => {
    expect(css).toMatch(/color-scheme:\s*light dark/);
  });
});

/** The pairs listed in the stylesheet's comment: foreground token, background token, minimum. */
const PAIRS: [string, string, number][] = [
  ["--ink", "--paper", 7],
  ["--ink", "--surface", 4.5],
  ["--ink", "--field", 4.5],
  ["--muted", "--paper", 4.5],
  ["--muted", "--surface", 4.5],
  ["--muted", "--select", 4.5],
  ["--muted", "--neutral-bg", 4.5],
  ["--ink", "--select", 4.5],
  ["--accent", "--paper", 4.5],
  ["--accent", "--surface", 4.5],
  ["--accent", "--select", 4.5],
  ["--accent", "--warn-bg", 4.5],
  ["--accent-ink", "--accent", 4.5],
  ["--banner-ink", "--banner-bg", 7],
  ["--mark-ink", "--mark-bg", 4.5],
  ["--danger-ink", "--danger-bg", 4.5],
  ["--ok-ink", "--ok-bg", 4.5],
  ["--bad-ink", "--bad-bg", 4.5],
  ["--warn-ink", "--warn-bg", 4.5],
  ["--info-ink", "--info-bg", 4.5],
  ["--neutral-ink", "--neutral-bg", 4.5],
  ["--ok-ink", "--paper", 4.5],
  ["--bad-ink", "--paper", 4.5],
  ["--bad-ink", "--surface", 4.5],
  ["--ok-ink", "--surface", 4.5],
  ["--edge", "--paper", 3],
  ["--edge", "--field", 3],
  ["--focus", "--paper", 3],
  ["--focus", "--surface", 3],
  // The ring on the backgrounds a control can have: the chosen row, and the notices and banners that
  // hold links and buttons.
  ["--focus", "--select", 3],
  ["--focus", "--ok-bg", 3],
  ["--focus", "--bad-bg", 3],
  ["--focus", "--info-bg", 3],
  ["--focus", "--warn-bg", 3],
  ["--focus", "--neutral-bg", 3],
  // A link in a notice is the accent on the notice's own ground.
  ["--accent", "--ok-bg", 4.5],
  ["--accent", "--bad-bg", 4.5],
  ["--accent", "--info-bg", 4.5],
  ["--ok-edge", "--paper", 3],
  ["--bad-edge", "--paper", 3],
  ["--warn-edge", "--paper", 3],
  ["--info-edge", "--paper", 3],
];

describe("contrast of the colour pairs, in both themes", () => {
  const { light, dark } = themes();
  for (const [name, tokens] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    for (const [fg, bg, min] of PAIRS) {
      it(`${name}: ${fg} on ${bg} is at least ${min}`, () => {
        const ratio = contrast(tokens[fg] as string, tokens[bg] as string);
        expect(ratio, `${fg} ${tokens[fg]} on ${bg} ${tokens[bg]}`).toBeGreaterThanOrEqual(min);
      });
    }
  }

  it("the stylesheet's comment lists the pairs it was checked against", () => {
    const comment = /^\/\*([\s\S]*?)\*\//.exec(css)?.[1] ?? "";
    expect(comment).toContain("Contrast pairs checked");
    for (const phrase of [
      "ink on paper",
      "accent-ink on accent",
      "banner-ink on banner-bg",
      "mark-ink on mark-bg",
      "focus on paper",
      "focus on select, ok-bg, bad-bg, info-bg, warn-bg and neutral-bg",
      "accent on ok-bg, bad-bg and info-bg",
      "skip link, focused",
    ]) {
      expect(comment, phrase).toContain(phrase);
    }
  });

  /**
   * Every rule that sets both a colour and a background from tokens, read from the stylesheet
   * itself, so a new rule cannot pair two tokens that were never checked.
   */
  it("every rule that sets a text colour and a background from tokens passes 4.5 in both themes", () => {
    const rules = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)];
    let checked = 0;
    for (const rule of rules) {
      const selector = (rule[1] as string).trim();
      const body = rule[2] as string;
      if (selector.startsWith(":root") || selector.includes("%")) continue;
      const fg = /(?:^|[;\s])color:\s*var\((--[\w-]+)\)/.exec(body)?.[1];
      const bg = /background(?:-color)?:\s*var\((--[\w-]+)\)/.exec(body)?.[1];
      if (fg === undefined || bg === undefined) continue;
      checked += 1;
      for (const [name, tokens] of [
        ["light", light],
        ["dark", dark],
      ] as const) {
        const ratio = contrast(tokens[fg] as string, tokens[bg] as string);
        expect(ratio, `${selector} (${name}): ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------------------------
// What the stylesheet must contain
// ---------------------------------------------------------------------------------------------

describe("the stylesheet", () => {
  it("uses system fonts only and loads nothing from elsewhere", () => {
    expect(css).not.toMatch(/@import/);
    expect(css).not.toMatch(/@font-face/);
    expect(css).not.toMatch(/url\(/);
    expect(css).not.toMatch(/https?:\/\//);
    expect(css).toMatch(/--sans:\s*system-ui/);
    expect(css).toMatch(/--serif:[^;]*Georgia/);
    expect(css).toMatch(/--mono:\s*ui-monospace/);
  });

  it("sets document text and quotes in the serif and the interface in the sans", () => {
    expect(css).toMatch(/body\s*\{[^}]*font-family:\s*var\(--sans\)/);
    expect(css).toMatch(/\.doc-text\s*\{[^}]*font-family:\s*var\(--serif\)/);
    expect(css).toMatch(/\.brand\s*\{[^}]*font-family:\s*var\(--serif\)/);
  });

  it("keeps preserved white space and long words inside document text", () => {
    const rule = /\.doc-text\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("white-space: pre-wrap");
    expect(rule).toContain("overflow-wrap: anywhere");
  });

  it("shows keyboard focus clearly", () => {
    const rule = /:focus-visible\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    const width = /outline:\s*(\d+)px solid var\(--focus\)/.exec(rule)?.[1];
    expect(Number(width)).toBeGreaterThanOrEqual(2);
    // The only thing that may lose its outline is the page body after a skip link moves focus there.
    const removed = [...css.matchAll(/([^{}]+)\{[^}]*outline:\s*(?:none|0)\b[^}]*\}/g)].map((m) =>
      (m[1] as string).trim(),
    );
    expect(removed).toEqual([".page:focus"]);
  });

  it("respects reduced motion", () => {
    const block =
      /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(block).toContain("animation: none");
    expect(block).toContain("transition: none");
    expect(block).toContain("scroll-behavior: auto");
  });

  it("lets a table scroll inside its own box, and stacks the inspector on a phone", () => {
    expect(/\.table-scroll\s*\{([^}]*)\}/.exec(css)?.[1]).toContain("overflow-x: auto");
    expect(/\.table-scroll\s*\{([^}]*)\}/.exec(css)?.[1]).toContain("max-width: 100%");
    expect(css).toMatch(/\.run-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(css).toMatch(/@media \(min-width: 70rem\)\s*\{[^}]*\.run-layout/);
    expect(css).toMatch(/@media \(max-width: 40rem\)/);
  });

  it("makes every inline element a bidi isolate", () => {
    const rule = /(a,\s*strong[^{]*)\{([^}]*)\}/.exec(css);
    expect(rule?.[2]).toContain("unicode-bidi: isolate");
  });

  it("hides what is hidden, and has a screen-reader-only class", () => {
    expect(css).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
    expect(css).toMatch(/\.sr-only\s*\{[^}]*clip-path/);
  });

  it("draws a disabled button as dashed as well as dimmer", () => {
    expect(/\.button\[disabled\]\s*\{([^}]*)\}/.exec(css)?.[1]).toContain("border-style: dashed");
  });

  it("copes with forced colours", () => {
    expect(css).toContain("@media (forced-colors: active)");
  });

  it("has no em dash or en dash", () => {
    expect(css).not.toMatch(/[\u2013\u2014]/);
  });

  it("has no inline-script-style leftovers: no !important except where it is needed", () => {
    const important = [...css.matchAll(/!important/g)].length;
    // [hidden] and the reduced-motion block.
    expect(important).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------------------------
// Colour only through tokens, the focus ring, the skip link, hover
// ---------------------------------------------------------------------------------------------

/** The body of the first rule whose selector is exactly `selector`, or "" when there is none. */
function ruleBody(selector: string): string {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of bare.matchAll(/([^{}@]+)\{([^{}]*)\}/g))
    if ((rule[1] as string).trim() === selector) return rule[2] as string;
  return "";
}

/** The value of a declaration in a rule body, or undefined. */
function property(body: string, name: string): string | undefined {
  return new RegExp(`(?:^|[;\\s])${name}:\\s*([^;]+)`).exec(body)?.[1]?.trim();
}

/** `var(--x)` as a token name, or undefined when the value is anything else. */
function tokenIn(value: string | undefined): string | undefined {
  return value === undefined ? undefined : /^var\((--[\w-]+)\)$/.exec(value)?.[1];
}

const NAMED_COLOURS = [
  "white",
  "black",
  "red",
  "green",
  "blue",
  "gray",
  "grey",
  "silver",
  "yellow",
  "orange",
  "purple",
  "navy",
  "teal",
  "maroon",
  "lime",
  "aqua",
  "fuchsia",
  "olive",
] as const;

/** The stylesheet with its comments and its blocks of token definitions taken out. */
const withoutTokens = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/:root\s*\{[^}]*\}/g, "");

/**
 * The colours a stylesheet writes out where it should name a token: a hex colour, a colour
 * function, or the name of a colour in the value of a declaration. The values `currentColor` and
 * `transparent` and the system colours of the forced-colours block are not colours chosen by the
 * stylesheet, so they are not found.
 */
function colourLiterals(text: string): string[] {
  const rest = withoutTokens(text);
  const found = [
    ...rest.matchAll(/#[0-9a-fA-F]{3,8}\b/g),
    ...rest.matchAll(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix|color)\([^)]*\)/g),
    ...rest.matchAll(new RegExp(`:[^;{}]*\\b(${NAMED_COLOURS.join("|")})\\b`, "g")),
  ];
  return found.map((m) => m[1] ?? m[0]);
}

describe("colour comes only from the tokens", () => {
  it("has no colour written out outside the token blocks", () => {
    expect(colourLiterals(css)).toEqual([]);
  });

  it("finds a colour written out in a rule, in any of its forms, and none in a token block", () => {
    expect(colourLiterals(".a { color: #123456; }")).toEqual(["#123456"]);
    expect(colourLiterals(".a { background: rgb(1, 2, 3); }")).toEqual(["rgb(1, 2, 3)"]);
    expect(colourLiterals(".a { border: 1px solid white; }")).toEqual(["white"]);
    expect(colourLiterals(":root { --paper: #ffffff; } .a { color: var(--paper); }")).toEqual([]);
    expect(
      colourLiterals(
        ".a { color: CanvasText; border-color: currentColor; background: transparent; }",
      ),
    ).toEqual([]);
  });

  it("names, in every var(), a token that is defined", () => {
    const { light, dark } = themes();
    const used = new Set(
      [...withoutTokens(css).matchAll(/var\((--[\w-]+)/g)].map((m) => m[1] as string),
    );
    expect(used.size).toBeGreaterThan(20);
    for (const name of used) {
      expect(light[name], `${name} is defined`).toBeDefined();
      // The fonts are defined once; every colour is defined again for the dark theme.
      if (isColour(light[name] as string))
        expect(dark[name], `${name} in the dark theme`).toBeDefined();
    }
  });
});

describe("the focus ring and the skip link", () => {
  const { light, dark } = themes();
  const rule = ruleBody(".skip-link:focus");

  it("has a rule of its own for the skip link when it has focus", () => {
    expect(rule).not.toBe("");
  });

  for (const [name, tokens] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    describe(name, () => {
      const colour = (token: string | undefined, fallback: string): string => {
        const value = tokens[token ?? fallback];
        expect(value, `${token ?? fallback} is a token`).toBeDefined();
        return value as string;
      };
      // What the link looks like focused: the declarations of `.skip-link:focus`, else those of
      // `.skip-link`, else the ring that every focused control gets.
      const base = ruleBody(".skip-link");
      const fill = colour(
        tokenIn(property(rule, "background")) ?? tokenIn(property(base, "background")),
        "--accent",
      );
      const text = colour(
        tokenIn(property(rule, "color")) ?? tokenIn(property(base, "color")),
        "--accent-ink",
      );
      const border = /border:\s*\d+px solid var\((--[\w-]+)\)/.exec(rule)?.[1];
      // The ring: the colour the rule gives it (in `outline` or `outline-color`), else the one every
      // focused control gets. Where it lies: an offset below minus its width puts it inside the
      // box, where it is seen against the fill; otherwise it is outside, against what is behind.
      const ringWidth = Number(/(\d+)px/.exec(property(rule, "outline") ?? "")?.[1] ?? 3);
      const ringOffset = Number(
        /^(-?\d+)px$/.exec(property(rule, "outline-offset") ?? "")?.[1] ?? 2,
      );
      const ring = colour(
        tokenIn(property(rule, "outline-color")) ??
          tokenIn(property(rule, "outline")?.replace(/^\d+px solid /, "")) ??
          tokenIn(property(ruleBody(":focus-visible"), "outline")?.replace(/^\d+px solid /, "")),
        "--focus",
      );
      const ringInside = ringOffset + ringWidth <= 0;
      const banner = tokens["--banner-bg"] as string;
      const paper = tokens["--paper"] as string;

      it("sets the focused link's fill off from the banner it floats over (3 or more)", () => {
        expect(contrast(fill, banner)).toBeGreaterThanOrEqual(3);
      });

      it("sets the link off from the page where it hangs below the banner: its fill or its border (3 or more)", () => {
        const edge = border === undefined ? 1 : contrast(colour(border, "--ink"), paper);
        expect(Math.max(contrast(fill, paper), edge)).toBeGreaterThanOrEqual(3);
      });

      it("shows its ring where the ring is drawn (3 or more)", () => {
        if (ringInside) {
          // Inside the box the ring is seen against the fill, whatever the link floats over.
          expect(contrast(ring, fill)).toBeGreaterThanOrEqual(3);
        } else {
          // Outside the box it is seen against the banner and against the page, as it floats over both.
          expect(contrast(ring, banner)).toBeGreaterThanOrEqual(3);
          expect(contrast(ring, paper)).toBeGreaterThanOrEqual(3);
        }
      });

      it("draws the ring inside the box, clear of the border, so it needs no second background", () => {
        expect(ringInside).toBe(true);
        // A gap between the border and the ring, so that they read as two things.
        expect(ringOffset + ringWidth).toBeLessThan(-2);
      });

      it("reads its own text on its own fill (4.5 or more)", () => {
        expect(contrast(text, fill)).toBeGreaterThanOrEqual(4.5);
      });
    });
  }

  it("keeps the ring a focused control gets from :focus-visible on every other element", () => {
    const ring = ruleBody(":focus-visible");
    expect(ring).toContain("outline: 3px solid var(--focus)");
    expect(ring).toContain("outline-offset");
  });
});

// What a hover may change: how the thing is coloured, bordered or underlined, and the pointer. A
// hover that moved, showed or hid something would leave a keyboard user without it.
const HOVER_MAY_SET =
  /^(color|background|background-color|border|border-color|border-style|border-width|text-decoration|text-decoration-\w+|box-shadow|cursor)$/;

/** Every `selector: property` in a rule with `:hover` that sets something a hover may not set. */
function hoverRevealing(text: string): string[] {
  const out: string[] = [];
  const bare = text.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of bare.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const selector = (rule[1] as string).trim();
    if (!selector.includes(":hover")) continue;
    for (const m of (rule[2] as string).matchAll(/([a-z-]+)\s*:/g))
      if (!HOVER_MAY_SET.test(m[1] as string)) out.push(`${selector}: ${m[1]}`);
  }
  return out;
}

describe("hover only decorates", () => {
  it("sets, in every rule with :hover, only colour, background, border, text decoration, shadow or cursor", () => {
    expect([...css.matchAll(/:hover/g)].length).toBeGreaterThan(0);
    expect(hoverRevealing(css)).toEqual([]);
  });

  it("finds a hover that shows, hides or moves something", () => {
    expect(hoverRevealing(".a:hover { display: block; }")).toEqual([".a:hover: display"]);
    expect(hoverRevealing(".a:hover { color: red; opacity: 1; }")).toEqual([".a:hover: opacity"]);
    expect(hoverRevealing(".a:hover { transform: none; }")).toEqual([".a:hover: transform"]);
    expect(
      hoverRevealing(".a:hover { border-color: red; text-decoration-thickness: 2px; }"),
    ).toEqual([]);
    expect(hoverRevealing(".a { display: block; }")).toEqual([]);
  });
});

describe("the sentence that says what to do, and the link to where", () => {
  it("has a rule for .todo and for .notice-jump, so the sentence stands out and the link is set apart", () => {
    expect(ruleBody(".todo")).toContain("font-weight");
    expect(ruleBody(".notice-jump")).toContain("margin-left");
  });
});

// ---------------------------------------------------------------------------------------------
// The order of the page is the order of the document, and nothing is hidden but left to the keyboard
// ---------------------------------------------------------------------------------------------

/** The text without its comments. */
const bare = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "");

/** The text without the block that starts at `opener`, braces balanced; the text itself when there is none. */
function withoutBlock(text: string, opener: string): string {
  const start = text.indexOf(opener);
  if (start === -1) return text;
  let depth = 0;
  for (let at = text.indexOf("{", start); at < text.length; at += 1) {
    if (text[at] === "{") depth += 1;
    if (text[at] === "}") depth -= 1;
    if (depth === 0) return text.slice(0, start) + text.slice(at + 1);
  }
  throw new Error(`${opener} is not closed`);
}

/** Every `selector { body }` of the text, nested blocks of a media query included, in file order. */
function allRules(text: string): { selector: string; body: string }[] {
  return [...bare(text).matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: (m[1] as string).replace(/\s+/g, " ").trim(),
    body: m[2] as string,
  }));
}

/** The selectors of the rules that set `name` to a value for which `wanted` is true. */
const settingTo = (text: string, name: string, wanted: (value: string) => boolean): string[] =>
  allRules(text)
    .filter(({ body }) => {
      const value = property(body, name);
      return value !== undefined && wanted(value);
    })
    .map(({ selector }) => selector);

describe("a keyboard user meets the page in the order the document has it", () => {
  it("never reorders: no order, no reversed row or column, no dense grid, no float", () => {
    expect(settingTo(css, "order", () => true)).toEqual([]);
    expect(settingTo(css, "flex-direction", (v) => v.includes("reverse"))).toEqual([]);
    expect(settingTo(css, "flex-flow", (v) => v.includes("reverse"))).toEqual([]);
    expect(settingTo(css, "grid-auto-flow", (v) => v.includes("dense"))).toEqual([]);
    expect(settingTo(css, "float", () => true)).toEqual([]);
    expect(settingTo(css, "direction", () => true)).toEqual([]);
    expect(settingTo(css, "writing-mode", () => true)).toEqual([]);
  });

  it("places a grid item in only one rule, whose item follows what it sits beside in the document", () => {
    // The hint of a choice sits in the second column, under the label that precedes it.
    for (const name of ["grid-column", "grid-row", "grid-area"])
      expect(
        settingTo(css, name, () => true),
        name,
      ).toEqual(name === "grid-column" ? [".choice .hint"] : []);
  });

  it("takes an element out of the flow only for the skip link and the text for screen readers", () => {
    expect(settingTo(css, "position", (v) => v === "absolute" || v === "fixed").sort()).toEqual([
      ".skip-link",
      ".sr-only",
    ]);
    // A sticky part stays where it is in the document and in the tab order.
    expect(settingTo(css, "position", (v) => v === "sticky").sort()).toEqual([
      ".demo-banner",
      ".inspector",
    ]);
  });

  it("scrolls a focused control clear of the sticky banner and the sticky inspector", () => {
    const html = /(?:^|\n)html\s*\{([^}]*)\}/.exec(bare(css))?.[1] ?? "";
    const padding = /scroll-padding-top:\s*([\d.]+)rem/.exec(html)?.[1];
    expect(padding, "html sets scroll-padding-top in rem").toBeDefined();
    const tops = allRules(css)
      .filter(({ body }) => property(body, "position") === "sticky")
      .map(({ body }) => /(?:^|[;\s])top:\s*([\d.]+)(?:rem)?\s*(?:;|$)/.exec(body)?.[1]);
    expect(tops).toHaveLength(2);
    expect(tops.every((top) => top !== undefined)).toBe(true);
    // The inspector is the lower of the two: the banner sits at the top, the inspector under it.
    expect(Number(padding)).toBeGreaterThanOrEqual(Math.max(...tops.map(Number)));
  });
});

// What the browser audit (test/a11y/browser) found in the stylesheet, held here as well, so that it
// stays fixed on a machine that has no browser. Each of these was a measured fault in Chromium.
describe("what a real browser found wrong, kept fixed", () => {
  it("leaves more room between the filters than the reach of the focus ring", () => {
    // The ring is 3px wide and starts 2px out. A gap of 5px or less puts it on the filled filter
    // beside it, where it was 1.9 to 1 against the fill.
    const ring = ruleBody(":focus-visible");
    const reach =
      Number(/outline:\s*(\d+)px/.exec(ring)?.[1]) +
      Number(/outline-offset:\s*(\d+)px/.exec(ring)?.[1]);
    expect(reach).toBe(5);
    const gap = /gap:\s*([\d.]+)rem/.exec(ruleBody(".filters ul"))?.[1];
    expect(gap, "the filters have a gap in rem").toBeDefined();
    expect(Number(gap) * 16).toBeGreaterThan(reach);
  });

  it("makes every box that scrolls the containing block of what is positioned inside it", () => {
    // Text for screen readers is positioned. In a scrolling box that is not itself positioned it
    // lay outside the box, and a wide table made the whole page scroll sideways at 640 pixels.
    const rules = allRules(css);
    const scrolling = rules
      .filter(({ body }) => /(?:^|[;\s])overflow(?:-[xy])?:\s*(?:auto|scroll)\b/.test(body))
      .map(({ selector }) => selector);
    expect(scrolling.length).toBeGreaterThan(2);
    for (const selector of scrolling) {
      const positioned = rules.some(
        ({ selector: other, body }) =>
          other === selector &&
          /^(?:relative|absolute|sticky|fixed)$/.test(property(body, "position") ?? ""),
      );
      expect(positioned, `${selector} scrolls and is not positioned`).toBe(true);
    }
  });

  it("does not stick the demo banner to the top of a narrow screen", () => {
    // On a 320 pixel screen it is three lines tall, and Chromium puts the start of a tall focused
    // box under it. A sticky banner stays where the wide screens have it.
    const narrow =
      /@media \(max-width: 40rem\) \{\s*\.demo-banner \{\s*position: static;\s*\}\s*\}/;
    expect(narrow.test(bare(css))).toBe(true);
    expect(property(ruleBody(".demo-banner"), "position")).toBe("sticky");
  });
});

describe("nothing is hidden from the eye and left to the keyboard", () => {
  // The print sheet drops the skip link and the buttons: they do nothing on paper.
  const screen = withoutBlock(css, "@media print");

  it("hides with display none only what is hidden for everyone: the hidden attribute and a hint", () => {
    expect(settingTo(screen, "display", (v) => v.startsWith("none")).sort()).toEqual([
      ".scroll-hint",
      "[hidden]",
    ]);
  });

  it("makes nothing invisible or unclickable by style", () => {
    expect(settingTo(screen, "visibility", () => true)).toEqual([]);
    expect(settingTo(screen, "opacity", () => true)).toEqual([]);
    expect(settingTo(screen, "pointer-events", () => true)).toEqual([]);
    expect(settingTo(screen, "user-select", (v) => v === "none")).toEqual([]);
  });

  it("finds a stylesheet that does, so the pins above can fail", () => {
    const planted = ".a { display: none; } .b { order: 2; } .c { visibility: hidden; }";
    expect(settingTo(planted, "display", (v) => v.startsWith("none"))).toEqual([".a"]);
    expect(settingTo(planted, "order", () => true)).toEqual([".b"]);
    expect(settingTo(planted, "visibility", () => true)).toEqual([".c"]);
    expect(
      withoutBlock("@media print { .a { display: none; } } .b { color: red; }", "@media print"),
    ).toBe(" .b { color: red; }");
  });

  it("sets the print sheet apart: the rules it hides are in a block of their own", () => {
    expect(css).toContain("@media print");
    expect(settingTo(css, "display", (v) => v.startsWith("none")).length).toBeGreaterThan(
      settingTo(screen, "display", (v) => v.startsWith("none")).length,
    );
  });
});

describe("status meaning never rests on colour alone", () => {
  it("defines every shape the components can draw, each looking different", () => {
    const looks = new Map<string, string>();
    for (const shape of SHAPES) {
      const rule = new RegExp(`\\.shape-${shape}\\s*\\{([^}]*)\\}`).exec(css)?.[1];
      expect(rule, `.shape-${shape}`).toBeDefined();
      const look = (rule as string).replace(/\s+/g, " ").trim();
      expect(looks.has(look), `${shape} looks like ${looks.get(look)}`).toBe(false);
      looks.set(look, shape);
    }
    // A circle with no rule of its own still has the base .shape square, so check explicitly.
    expect(looks.size).toBe(SHAPES.length);
  });

  it("has a base .shape rule that gives every shape a size and a fill", () => {
    const rule = /\.shape\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("width");
    expect(rule).toContain("height");
    expect(rule).toContain("currentColor");
  });

  it("has a rule for every tone a chip can have", () => {
    for (const tone of ["ok", "bad", "warn", "info", "neutral"]) {
      const rule = new RegExp(`\\.tone-${tone}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
      expect(rule, tone).toContain(`var(--${tone}-bg)`);
      expect(rule, tone).toContain(`var(--${tone}-ink)`);
      expect(rule, tone).toContain("border-color");
    }
  });

  it("draws severity as one to three bars that are filled or hollow", () => {
    expect(css).toMatch(/\.level i\.on\s*\{[^}]*background:\s*currentColor/);
    expect(css).toMatch(/\.level i\.off\s*\{[^}]*background:\s*transparent/);
    for (const n of [1, 2, 3]) expect(css).toContain(`.level i:nth-child(${n})`);
  });

  it("every shape and tone the pages use is one the stylesheet knows", () => {
    const seenShapes = new Set<string>();
    const seenTones = new Set<string>();
    for (const [, make] of variants) {
      const root = parseHtml(make());
      for (const el of all(root, (e) => classes(e).includes("shape"))) {
        for (const c of classes(el)) if (c.startsWith("shape-")) seenShapes.add(c.slice(6));
      }
      for (const el of all(root))
        for (const c of classes(el)) if (c.startsWith("tone-")) seenTones.add(c.slice(5));
    }
    expect([...seenShapes].sort()).toEqual([...SHAPES].sort());
    expect([...seenTones].sort()).toEqual(["bad", "info", "neutral", "ok", "warn"]);
  });
});

describe("every class the pages use has a style, or is a hook with a reason", () => {
  /** Classes that carry meaning for the script or the tests and need no rule of their own. */
  const HOOKS = new Set([
    "chip-text", // inherits the chip's text style
    "doc-label", // styled through .document-head
    "rule-key", // a code element, styled as code
    "row-link", // styled
    "inline-form", // styled
    "page", // styled
    "page-wide", // styled
    "inspector-empty", // styled
    "is-selected", // styled
    "is-current", // styled
    "is-stale", // styled
    "on", // .level i.on
    "off", // .level i.off
    "long", // .doc-text.long
    "quote", // mark.quote
    "quoted", // a quoted block, styled as .doc-text
    "reason", // .doc-text.reason
    "suggestion", // .doc-text.suggestion
    "stack", // styled
    "unknown", // a fallback class for a code the page does not know, deliberately unstyled
    "role-supporting", // the default border
    "role-definition", // the default border
    "role-superseded", // styled through .is-superseded
    "role-unknown", // the default border
    "severity-high", // styled through .chip-severity
    "severity-medium", // styled through .chip-severity
    "severity-low", // styled through .chip-severity
    "severity-unknown", // styled through .chip-severity
    "hash", // styled
    "empty", // styled
    "count", // styled
    "filter", // styled
    "level", // styled
    "keys-help", // a hook for the script; the disclosure styles it
    "shape", // styled
    "disclosure", // styled
    "disclosure-danger", // styled
    "banner-stale", // styled through .banner
    "superseded-text", // the del element carries the strike
    "choices", // a fieldset, styled as fieldset
    "edits", // a fieldset, styled as fieldset
    "roles", // a fieldset, styled as fieldset
  ]);

  it("lists no class without a rule", () => {
    const used = new Set<string>();
    for (const [, make] of variants) {
      for (const el of all(parseHtml(make()))) for (const c of classes(el)) used.add(c);
    }
    const missing = [...used].filter(
      (c) => !HOOKS.has(c) && !new RegExp(`\\.${c.replace(/[-]/g, "\\-")}(?![\\w-])`).test(css),
    );
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(60);
  });

  it("every named hook is really used, so the list stays honest", () => {
    const used = new Set<string>();
    for (const [, make] of variants) {
      for (const el of all(parseHtml(make()))) for (const c of classes(el)) used.add(c);
    }
    const unused = [...HOOKS].filter((c) => !used.has(c));
    // A few exist only for states the sweep does not reach.
    expect(
      unused.filter(
        (c) =>
          ![
            "role-unknown",
            "severity-unknown",
            "unknown",
            "severity-low",
            "severity-medium",
          ].includes(c),
      ),
    ).toEqual([]);
  });
});
