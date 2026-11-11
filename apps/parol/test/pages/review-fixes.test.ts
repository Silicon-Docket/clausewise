import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeForAnchor } from "@clausewise/review";
import { describe, expect, it } from "vitest";
import {
  ErrorPage,
  FIELDS,
  FindingPage,
  MatterPage,
  MattersPage,
  MemosPage,
  NoticeBox,
  RunPage,
  SignInPage,
  normalizeNewlines,
  render,
} from "../../src/server/pages/index.js";
import { idPart } from "../../src/server/pages/components.js";
import { urls } from "../../src/server/urls.js";
import { confirmedRange, normalizeQuote } from "../../src/server/views/highlight.js";
import {
  MAX_MARKERS,
  markerOf,
  revealInvisible,
  revealToString,
} from "../../src/server/views/reveal.js";
import type { FindingView, MatterView } from "../../src/services/views.js";
import { FakeElement, event, runScript } from "./fake-dom.js";
import {
  all,
  attr,
  byId,
  byTag,
  classes,
  first,
  hasAttr,
  hasClass,
  parseHtml,
  readable,
  textOf,
  withClass,
  type El,
  type Node,
} from "./html.js";
import { checkInvariants } from "./invariants.js";
import { chrome, matterPage, paneOnly, runPage } from "./render.js";
import {
  IDS,
  buildChrome,
  buildEvidence,
  buildFindingView,
  buildIssueRows,
  buildMatterSummary,
  buildMatterView,
  buildMatterViewFor,
  buildMemo,
  buildPlaybooks,
  buildRunSummary,
  buildUsers,
  buildWarnings,
} from "./support.js";

/** The stylesheet without its comments, so a rule's selector is only its selector. */
const css = readFileSync(join(import.meta.dirname, "../../public/parol.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The declarations of the first rule whose selector list contains `selector` exactly. */
function ruleFor(selector: string, source = css): string | undefined {
  for (const m of source.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const selectors = (m[1] as string).split(",").map((s) => s.trim());
    if (selectors.includes(selector)) return m[2] as string;
  }
  return undefined;
}

const evidenceWith = (over: Partial<Parameters<typeof buildEvidence>[0]>) =>
  buildEvidence({
    id: "ev_x",
    spanId: "dv_d1v1:p1",
    location: "Mutual NDA (v1), Section 1, paragraph 1",
    quote: "shall continue for two (2) years",
    role: "governing",
    spanText: "The obligations shall continue for two (2) years.",
    ...over,
  });

const withEvidence = (...evidence: ReturnType<typeof buildEvidence>[]): FindingView =>
  buildFindingView({ evidence });

const passageOf = (finding: FindingView): El => {
  const root = parseHtml(paneOnly(finding));
  return first(root, (el) => hasClass(el, "passage"), "passage");
};

// ---------------------------------------------------------------------------------------------
// 1. The matter page must not scroll sideways on a phone
// ---------------------------------------------------------------------------------------------

/** Removes every minmax(...) group, however nested, so what is left is the bare track list. */
function withoutMinmax(value: string): string {
  let out = "";
  for (let i = 0; i < value.length;) {
    if (value.startsWith("minmax(", i)) {
      let depth = 0;
      let j = i + "minmax".length;
      for (; j < value.length; j += 1) {
        if (value[j] === "(") depth += 1;
        if (value[j] === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      i = j + 1;
    } else {
      out += value[i];
      i += 1;
    }
  }
  return out;
}

describe("finding 1: a grid cannot be wider than the screen because of a table inside it", () => {
  it("gives the documents list one column that may shrink below its content", () => {
    expect(ruleFor(".documents")).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(ruleFor(".document")).toMatch(/min-width:\s*0/);
  });

  it("never sizes a grid column to its content: every flexible track is minmax(0, ...) or a length", () => {
    const grids: string[] = [];
    for (const m of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      const body = m[2] as string;
      if (!/display:\s*grid/.test(body)) continue;
      const selector = (m[1] as string).trim();
      const columns = /grid-template-columns:\s*([^;]+);/.exec(body)?.[1];
      expect(columns, `${selector} declares its columns`).toBeDefined();
      // `auto-fill` and `auto-fit` only say how many columns there are, not how wide each is.
      const bare = withoutMinmax(columns as string).replace(/auto-(fill|fit)/g, "");
      expect(bare, `${selector}: ${columns}`).not.toMatch(/\bfr\b|\bauto\b/);
      grids.push(selector);
    }
    expect(grids.length).toBeGreaterThan(8);
  });

  it("keeps every list of passages, warnings and documents in such a grid", () => {
    for (const selector of [".documents", ".passages", ".warning-list"]) {
      expect(ruleFor(selector), selector).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 2. A "Quote found" chip must be earned
// ---------------------------------------------------------------------------------------------

describe("finding 2: the quote chip and the highlight agree with the text shown", () => {
  const chipsOf = (p: El): string =>
    readable(first(p, (el) => hasClass(el, "chips"), "the chips of a passage"));

  it("does not say the quote was found when the paragraph text is missing, and prints the quote", () => {
    const p = passageOf(
      withEvidence(
        evidenceWith({ spanText: "", offsets: { start: 4, end: 20 }, quoteCheck: "verified" }),
      ),
    );
    expect(chipsOf(p)).not.toContain("Quote found");
    expect(chipsOf(p)).toContain("Position not confirmed");
    expect(readable(first(p, (el) => hasClass(el, "quoted")))).toBe(
      "shall continue for two (2) years",
    );
    expect(withClass(p, "quote")).toHaveLength(0);
  });

  it("falls back to the plain quote when the offsets lie outside the paragraph", () => {
    const p = passageOf(
      withEvidence(
        evidenceWith({
          spanText: "A paragraph of 22 chars",
          offsets: { start: 500, end: 520 },
        }),
      ),
    );
    expect(withClass(p, "quote")).toHaveLength(0);
    expect(chipsOf(p)).not.toContain("Quote found");
    expect(readable(first(p, (el) => hasClass(el, "quoted")))).toContain("shall continue");
    expect(readable(first(p, (el) => hasClass(el, "passage-note")))).toContain("does not match");
  });

  it("does not highlight words other than the quote when the offsets are wrong but in range", () => {
    const spanText = `${"x".repeat(50)}Other words here and then the quote: shall continue for two (2) years.`;
    const p = passageOf(withEvidence(evidenceWith({ spanText, offsets: { start: 50, end: 62 } })));
    expect(withClass(p, "quote")).toHaveLength(0);
    expect(chipsOf(p)).not.toContain("Quote found");
    expect(readable(first(p, (el) => hasClass(el, "quoted")))).toBe(
      "shall continue for two (2) years",
    );
  });

  it("still highlights a right range, and says the quote was found", () => {
    const p = passageOf(withEvidence(evidenceWith({})));
    const marks = withClass(p, "quote");
    expect(marks).toHaveLength(1);
    expect(readable(marks[0]!)).toBe("shall continue for two (2) years");
    expect(chipsOf(p)).toContain("Quote found");
  });

  it("accepts a range that differs from the quote only as the verifier's normalization allows", () => {
    // The verifier folds typographic quotes, drops zero-width characters and collapses white
    // space, so the text at the offsets is not always the quote letter for letter.
    const spanText = "Each party\u2019s  duty\u200b   shall\ncontinue.";
    const quote = "party's duty shall continue";
    const start = spanText.indexOf("party");
    const range = { start, end: spanText.length - 1 };
    expect(confirmedRange(spanText, range, quote)).toEqual(range);
    const p = passageOf(withEvidence(evidenceWith({ spanText, quote, offsets: range })));
    expect(withClass(p, "quote")).toHaveLength(1);
    expect(chipsOf(p)).toContain("Quote found");
  });

  it("keeps the old behaviour for a verified quote whose offsets were not recorded", () => {
    const p = passageOf(withEvidence(evidenceWith({ offsets: null })));
    expect(chipsOf(p)).toContain("Quote found");
    expect(readable(first(p, (el) => hasClass(el, "passage-note")))).toContain("not recorded");
    expect(withClass(p, "quote")).toHaveLength(0);
  });

  it("agrees with the verifier's own normalization", () => {
    const samples = [
      "Plain words",
      "  leading and   inner\t\nspaces  ",
      "curly \u2018single\u2019 and \u201cdouble\u201d marks",
      "dashes \u2010 \u2011 \u2012 \u2013 \u2014 \u2015 \u2212",
      "zero\u200bwidth\u200c\u200d\u2060\ufeffand\u00adsoft hyphen",
      "no-break\u00a0space and \u3000 ideographic",
      "emoji \u{1F600} stays",
    ];
    for (const sample of samples) {
      const expected = normalizeForAnchor(sample);
      // The verifier trims one edge space from a quote; the helper does the same.
      expect(normalizeQuote(sample), JSON.stringify(sample)).toBe(
        expected.replace(/^ /, "").replace(/ $/, ""),
      );
    }
  });

  it("refuses an empty quote and a range of white space", () => {
    expect(confirmedRange("a   b", { start: 1, end: 4 }, "   ")).toBeNull();
    expect(confirmedRange("abc", { start: 0, end: 3 }, "")).toBeNull();
    expect(confirmedRange("abc", null, "abc")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Invisible characters are shown, but a hostile run cannot make the page huge
// ---------------------------------------------------------------------------------------------

describe("finding 3: runs of invisible characters collapse into one marker", () => {
  it("collapses a run of one character into a single piece with a count", () => {
    const pieces = revealInvisible(`a${"\u200b".repeat(100_000)}b`);
    expect(pieces).toHaveLength(3);
    expect(pieces[1]).toMatchObject({
      kind: "invisible",
      marker: "[U+200B x 100000]",
      name: "zero-width space",
      count: 100_000,
    });
  });

  it("keeps a single character as it was, and different characters apart", () => {
    expect(revealInvisible("\u200b")).toEqual([
      { kind: "invisible", marker: "[U+200B]", name: "zero-width space" },
    ]);
    const pieces = revealInvisible("\u200b\u200b\u200c");
    expect(pieces.map((p) => (p.kind === "invisible" ? p.marker : p.text))).toEqual([
      "[U+200B x 2]",
      "[U+200C]",
    ]);
    expect(markerOf(0x200b, 2)).toBe("[U+200B x 2]");
    expect(markerOf(0x200b, 1)).toBe("[U+200B]");
  });

  it("does not merge across visible text", () => {
    const markers = revealInvisible("\u200ba\u200b").filter((p) => p.kind === "invisible");
    expect(markers).toHaveLength(2);
  });

  it("bounds the number of markers when the characters alternate", () => {
    const pieces = revealInvisible("a\u200b".repeat(50_000));
    const markers = pieces.filter((p) => p.kind === "invisible");
    expect(markers.length).toBeLessThanOrEqual(MAX_MARKERS + 1);
    const last = markers[markers.length - 1]!;
    expect(last.kind === "invisible" && last.marker).toMatch(
      /^\[\+\d+ more invisible characters\]$/,
    );
    // Nothing is lost silently: the omitted characters are counted.
    const counted = markers.reduce((n, p) => n + (p.kind === "invisible" ? (p.count ?? 1) : 0), 0);
    expect(counted).toBe(50_000);
  });

  it("prints a run as text for a title or an option", () => {
    expect(revealToString("a\u200b\u200bb\u202ec")).toBe("a[U+200B x 2]b[U+202E]c");
    expect(revealToString("plain")).toBe("plain");
  });

  it("keeps the inspector small when a hostile document is full of zero-width characters", () => {
    const quote = "shall continue for two (2) years";
    const zw = "\u200b".repeat(100_000);
    const finding = withEvidence(evidenceWith({ spanText: `${zw}${quote}${zw}`, quote }));
    const started = Date.now();
    const html = paneOnly(finding);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(html.length).toBeLessThan(120_000);
    expect(withClass(parseHtml(html), "invisible").length).toBeLessThan(10);
    expect(html).toContain("[U+200B x 100000]");
  });
});

// ---------------------------------------------------------------------------------------------
// 4. The Flags column is not clipped on a laptop
// ---------------------------------------------------------------------------------------------

describe("finding 4: the issue table fits beside the inspector, or the inspector goes below", () => {
  it("no longer forces a width on the table or on the flags column", () => {
    expect(ruleFor(".issue-table") ?? "").not.toMatch(/min-width/);
    expect(ruleFor(".chip-list") ?? "").not.toMatch(/min-width/);
  });

  it("lets a chip wrap between words inside any table", () => {
    expect(ruleFor(".data-table .chip")).toMatch(/white-space:\s*normal/);
    expect(ruleFor(".data-table .chip-text")).toMatch(/white-space:\s*normal/);
  });

  it("puts the inspector beside the table only where the table's minimum width fits", () => {
    const block = /@media \(min-width: (\d+(?:\.\d+)?)rem\)\s*\{\s*\.run-layout\s*\{([^}]*)\}/.exec(
      css,
    );
    expect(block, "a media query that holds .run-layout").not.toBeNull();
    const breakpoint = Number(block![1]);
    const columns = /grid-template-columns:\s*minmax\((\d+(?:\.\d+)?)rem,/.exec(
      block![2] as string,
    );
    expect(columns, "the table column has a minimum").not.toBeNull();
    const tableMin = Number(columns![1]);
    // The table needs about 38.5rem. The column, the gap (1.5rem), the page padding (2rem) and an
    // inspector of at least 20rem must all fit at the breakpoint.
    expect(tableMin).toBeGreaterThanOrEqual(38.5);
    expect(breakpoint).toBeGreaterThanOrEqual(tableMin + 1.5 + 2 + 20);
  });

  it("stacks the run layout below that breakpoint", () => {
    expect(ruleFor(".run-layout")).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. A keyboard user can reach the inspector
// ---------------------------------------------------------------------------------------------

describe("finding 5: the inspector is one jump away from the table", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      ...buildIssueRows()[1]!,
      findingId: `f_many_${i}`,
      ruleKey: `rule-${String(i).padStart(3, "0")}`,
    }));

  it("links to the inspector before the table, without the script", () => {
    const html = runPage({ issues: many(500), selected: buildFindingView() });
    const root = checkInvariants(html);
    const links = all(root, (el) => el.name === "a" && attr(el, "href") === "#inspector");
    expect(links).toHaveLength(1);
    expect(readable(links[0]!)).toBe("Go to the evidence inspector");
    // The link comes before the first row link, so it is one tab stop from the start of the table.
    expect(html.indexOf('href="#inspector"')).toBeLessThan(html.indexOf("data-row-link"));
    const aside = byId(root, "inspector")!;
    expect(aside.name).toBe("aside");
    expect(attr(aside, "tabindex")).toBe("0");
  });

  it("leads from the inspector back to the table, which can take focus", () => {
    const root = parseHtml(runPage());
    const aside = byId(root, "inspector")!;
    const back = all(aside, (el) => el.name === "a" && attr(el, "href") === "#issue-table");
    expect(back).toHaveLength(1);
    expect(readable(back[0]!)).toBe("Back to the issue table");
    const box = byId(root, "issue-table")!;
    expect(attr(box, "tabindex")).toBe("0");
    expect(hasClass(box, "table-scroll")).toBe(true);
  });

  it("offers no back link when nothing is selected", () => {
    const root = parseHtml(runPage({ selected: null }));
    expect(all(root, (el) => el.name === "a" && attr(el, "href") === "#issue-table")).toHaveLength(
      0,
    );
  });

  it("moves focus to the inspector when the page opens on a chosen finding", () => {
    const h = runScript(runPage());
    const aside = h.doc.querySelector("[data-inspector]")!;
    expect(aside.calls.focus).toBe(1);
    expect(h.doc.activeElement === aside).toBe(true);
  });

  it("does not take focus when no finding is chosen", () => {
    const h = runScript(runPage({ selected: null }));
    expect(h.doc.activeElement === h.doc.body).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// 6. Browsers post line breaks as CRLF
// ---------------------------------------------------------------------------------------------

/** What a browser puts in the form body for a textarea: every line break becomes CRLF. */
const posted = (value: string): string => value.replace(/\r\n|\r|\n/g, "\r\n");

/** A textarea's value as the browser reads it back: the first newline after the tag is dropped. */
function textareaValue(el: El): string {
  const raw = el.children.map((c: Node) => (c.type === "text" ? c.text : "")).join("");
  return raw.startsWith("\n") ? raw.slice(1) : raw;
}

describe("finding 6: a posted text field is normalised before it is compared", () => {
  const finding = buildFindingView({
    discrepancy: "first\nsecond",
    fallbackLanguage: "line one\nline two\n\nline four",
  });

  it("is needed: an untouched field comes back different from the stored text", () => {
    const root = parseHtml(paneOnly(finding));
    const discrepancy = all(
      root,
      (el) => el.name === "textarea" && attr(el, "name") === FIELDS.discrepancy,
    )[0]!;
    expect(textareaValue(discrepancy)).toBe(finding.discrepancy);
    expect(posted(textareaValue(discrepancy))).not.toBe(finding.discrepancy);
  });

  it("is undone by normalizeNewlines, for every kind of line break", () => {
    const root = parseHtml(paneOnly(finding));
    const fallback = all(
      root,
      (el) => el.name === "textarea" && attr(el, "name") === FIELDS.fallbackLanguage,
    )[0]!;
    expect(normalizeNewlines(posted(textareaValue(fallback)))).toBe(finding.fallbackLanguage);
    expect(normalizeNewlines("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
    expect(normalizeNewlines("\r\n\r\n")).toBe("\n\n");
    expect(normalizeNewlines("plain")).toBe("plain");
    expect(normalizeNewlines("")).toBe("");
  });

  it("is documented where the textareas are", () => {
    const source = readFileSync(
      join(import.meta.dirname, "../../src/server/pages/finding.tsx"),
      "utf8",
    );
    expect(source).toContain("normalizeNewlines");
  });
});

// ---------------------------------------------------------------------------------------------
// 7. Long words stay inside their boxes
// ---------------------------------------------------------------------------------------------

describe("finding 7: long unbroken text wraps instead of widening the page", () => {
  it("lets every element wrap anywhere by default", () => {
    expect(ruleFor("body")).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("keeps words whole in tables, which scroll inside their own box", () => {
    expect(ruleFor(".data-table")).toMatch(/overflow-wrap:\s*normal/);
  });

  it("resets the wrap rule nowhere else", () => {
    const resets: string[] = [];
    for (const m of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      if (/overflow-wrap:\s*(normal|break-word)/.test(m[2] as string))
        resets.push((m[1] as string).trim());
    }
    expect(resets).toEqual([".data-table"]);
  });
});

// ---------------------------------------------------------------------------------------------
// 8. A superseded passage is struck through wherever the quote is printed
// ---------------------------------------------------------------------------------------------

describe("finding 8: the quoted text of a superseded passage is struck through", () => {
  const cases: [string, Partial<Parameters<typeof buildEvidence>[0]>][] = [
    [
      "ambiguous",
      {
        quoteCheck: "ambiguous",
        offsets: null,
        quote: "the Receiving Party",
        spanText: "the Receiving Party and the Receiving Party",
      },
    ],
    ["verified without offsets", { quoteCheck: "verified", offsets: null }],
    [
      "verified with offsets that do not fit",
      { quoteCheck: "verified", offsets: { start: 500, end: 520 } },
    ],
  ];
  for (const [name, over] of cases) {
    it(`strikes the quoted block when the quote is ${name}`, () => {
      const p = passageOf(withEvidence(evidenceWith({ role: "superseded", ...over })));
      const quoted = first(p, (el) => hasClass(el, "quoted"));
      expect(byTag(quoted, "del")).toHaveLength(1);
      expect(readable(byTag(quoted, "del")[0]!)).toBe(readable(quoted));
    });
  }

  it("leaves the quoted block of a passage that still applies alone", () => {
    const p = passageOf(
      withEvidence(evidenceWith({ role: "governing", quoteCheck: "ambiguous", offsets: null })),
    );
    expect(
      byTag(
        first(p, (el) => hasClass(el, "quoted")),
        "del",
      ),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// 9. Export is not offered while decisions are pending
// ---------------------------------------------------------------------------------------------

describe("finding 9: the export button follows the matter's readiness", () => {
  const button = (view: MatterView): El => {
    const root = parseHtml(matterPage(view, { canDelete: false }));
    const form = all(
      root,
      (el) => el.name === "form" && attr(el, "action") === urls.memos(IDS.matter),
    )[0]!;
    return first(form, (el) => el.name === "button");
  };
  const reviewer = (status: Parameters<typeof buildMatterSummary>[0] = {}) =>
    buildMatterViewFor("reviewer", {
      matter: buildMatterSummary({ role: "reviewer", ...status }),
    });

  it("disables it, with the reason, while findings are still being decided", () => {
    const view = reviewer({ status: "in_review" });
    const b = button(view);
    expect(hasAttr(b, "disabled")).toBe(true);
    const root = parseHtml(matterPage(view, { canDelete: false }));
    expect(readable(byId(root, attr(b, "aria-describedby")!)!)).toContain("decision");
  });

  it("enables it when every finding has a decision, and after an export", () => {
    for (const status of ["review_complete", "exported"] as const) {
      expect(hasAttr(button(reviewer({ status })), "disabled"), status).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 10. Letter shortcuts act only inside the issue table
// ---------------------------------------------------------------------------------------------

describe("finding 10: j, k and ? act only while focus is in the issue table", () => {
  const key = (h: ReturnType<typeof runScript>, k: string, target: FakeElement) => {
    const e = event("keydown", target, { key: k });
    target.dispatch(e);
    return e;
  };

  it("leaves j alone on a page with no issue table", () => {
    const h = runScript(matterPage(buildMatterView()));
    const link = h.doc.querySelector("a")!;
    expect(key(h, "j", link).defaultPrevented).toBe(false);
    expect(key(h, "k", h.doc.body).defaultPrevented).toBe(false);
  });

  it("leaves j alone on the run page while focus is outside the table", () => {
    const h = runScript(runPage({ selected: null }));
    const outside = h.doc.querySelector(".filter")!;
    const e = key(h, "j", outside);
    expect(e.defaultPrevented).toBe(false);
    expect(h.doc.querySelectorAll("tr.is-current")).toHaveLength(0);
    expect(key(h, "j", h.doc.body).defaultPrevented).toBe(false);
    expect(key(h, "?", h.doc.body).defaultPrevented).toBe(false);
  });

  it("moves between rows while a row link has focus", () => {
    const h = runScript(runPage({ selected: null }));
    const links = h.doc.querySelectorAll("[data-row-link]");
    links[0]!.focus();
    // From the row that has focus, j goes to the next one. (This once expected the first j to stay
    // on row 0, which is what a real browser showed was wrong: Tab to a row, press j, nothing moved.)
    // Compared by identity: a failed comparison of two page elements would print the whole page.
    expect(key(h, "j", links[0]!).defaultPrevented).toBe(true);
    expect(h.doc.activeElement === links[1]).toBe(true);
    expect(key(h, "j", links[1]!).defaultPrevented).toBe(true);
    expect(h.doc.activeElement === links[2]).toBe(true);
  });

  it("starts from the table's own box, which is where the back link lands", () => {
    const h = runScript(runPage({ selected: null }));
    const box = h.doc.querySelector('[data-zone="issues"]')!;
    expect(key(h, "j", box).defaultPrevented).toBe(true);
    expect(h.doc.activeElement === h.doc.querySelectorAll("[data-row-link]")[0]).toBe(true);
  });

  it("still lets Escape close the key list from anywhere", () => {
    const h = runScript(runPage({ selected: null }));
    const links = h.doc.querySelectorAll("[data-row-link]");
    const help = h.doc.querySelector("[data-keys-help]")!;
    key(h, "j", links[0]!);
    key(h, "?", links[0]!);
    expect(help.open).toBe(true);
    key(h, "Escape", h.doc.body);
    expect(help.open).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// 11. A notice says what kind it is in words and a shape
// ---------------------------------------------------------------------------------------------

describe("finding 11: notices do not rely on colour", () => {
  const kinds = ["success", "info", "error"] as const;
  const boxOf = (kind: (typeof kinds)[number]): El =>
    first(parseHtml(render(NoticeBox({ notice: { kind, text: "The text." } }))), (el) =>
      hasClass(el, "notice"),
    );

  it("starts each notice with a chip: a label and a shape", () => {
    const labels = new Set<string>();
    const shapes = new Set<string>();
    for (const kind of kinds) {
      const chip = first(boxOf(kind), (el) => hasClass(el, "chip"), `a chip in the ${kind} notice`);
      const label = readable(chip);
      expect(label.length).toBeGreaterThan(0);
      labels.add(label);
      const shape = first(chip, (el) => hasClass(el, "shape"));
      shapes.add(classes(shape).find((c) => c.startsWith("shape-")) as string);
      expect(readable(boxOf(kind))).toBe(`${label} The text.`);
    }
    expect(labels.size).toBe(3);
    expect(shapes.size).toBe(3);
  });

  it("names the kinds in plain words", () => {
    expect(readable(boxOf("success"))).toMatch(/^Done /);
    expect(readable(boxOf("error"))).toMatch(/^Problem /);
    expect(readable(boxOf("info"))).toMatch(/^Note /);
  });

  it("treats a kind it does not know as a plain note", () => {
    const html = render(NoticeBox({ notice: { kind: "oops" as "info", text: "The text." } }));
    const box = first(parseHtml(html), (el) => hasClass(el, "notice"));
    expect(classes(box)).toEqual(["notice", "notice-info"]);
    expect(attr(box, "role")).toBe("status");
  });
});

// ---------------------------------------------------------------------------------------------
// 12. Props that a route could get wrong
// ---------------------------------------------------------------------------------------------

describe("finding 12: props are checked before they are used", () => {
  it("(a) turns a filter the page does not know into 'all'", () => {
    const props = {
      chrome,
      matter: buildMatterSummary(),
      run: buildRunSummary(),
      issues: buildIssueRows(),
      selected: buildFindingView(),
      warnings: buildWarnings(),
      documents: [],
    };
    const base = render(RunPage(props));
    for (const bad of ["bogus", "__proto__", "constructor", "toString", "hasOwnProperty", ""]) {
      const html = render(RunPage({ ...props, filter: bad as "all" }));
      expect(html, bad).toBe(base);
    }
  });

  it("(b) sends 'back' only to a path on this site", () => {
    const back = (backHref: string): string | null | undefined => {
      const root = parseHtml(
        render(
          ErrorPage({
            chrome,
            status: 404,
            title: "Not found",
            message: "No. Go back.",
            todo: "Go back.",
            backHref,
          }),
        ),
      );
      return attr(
        first(root, (el) => el.name === "a" && hasClass(el, "button")),
        "href",
      );
    };
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "//evil.example/x",
      "https://evil.example/x",
      "/\\evil.example",
      " /matters",
      "/matters\n",
      "matters",
      "",
      "data:text/html,x",
    ]) {
      expect(back(bad), JSON.stringify(bad)).toBe(urls.matters());
    }
    expect(back("/matters/m_1")).toBe("/matters/m_1");
    expect(back(`/matters/m_1/runs/r_1?finding=f_1&filter=open`)).toBe(
      "/matters/m_1/runs/r_1?finding=f_1&filter=open",
    );
  });

  it("(c) counts a stale decision on a current finding as not decided", () => {
    const rows = buildIssueRows();
    const row = rows.find((r) => r.ruleKey === "dur-1")!;
    row.review = {
      decision: "accept",
      reviewerName: "D. Whitfield",
      at: "2026-11-03T15:10:00Z",
      validity: "stale",
    };
    const html = runPage({ issues: rows, selected: null });
    const root = checkInvariants(html);
    const tr = first(
      root,
      (el) => el.name === "tr" && textOf(el).includes("Duration of confidentiality"),
    );
    expect(readable(tr)).not.toContain("Accepted");
    expect(readable(tr)).toContain("Out of date");
    // 8 findings, 2 decided and current in the fixture, so 6 are open; the stale one is among them.
    expect(readable(root)).toContain("6 open");
    const open = first(root, (el) => el.name === "a" && textOf(el).startsWith("Open"));
    expect(readable(open)).toBe("Open 6");
  });

  it("(c) shows the same in the inspector header", () => {
    const finding = buildFindingView();
    finding.issue.review = {
      decision: "accept",
      reviewerName: "D. Whitfield",
      at: "2026-11-03T15:10:00Z",
      validity: "stale",
    };
    const head = first(parseHtml(paneOnly(finding)), (el) => hasClass(el, "pane-head"));
    expect(readable(head)).not.toContain("Accepted");
    expect(readable(head)).toContain("Out of date");
  });

  it("(d) gives different ids different DOM ids, and leaves ordinary ids alone", () => {
    expect(idPart("a.b")).not.toBe(idPart("a_b"));
    expect(idPart("a b")).not.toBe(idPart("a-b"));
    expect(idPart("ev_dur1_a")).toBe("ev_dur1_a");
    expect(idPart("dv_d1v1")).toBe("dv_d1v1");
    expect(idPart("m_lanternfish01")).toBe("m_lanternfish01");
    const seen = new Map<string, string>();
    for (const raw of [
      "a.b",
      "a_b",
      "a-b",
      "a b",
      "a/b",
      "a:b",
      "\u00e9",
      "e",
      "u-",
      "u-2e",
      "",
      "A.B",
    ]) {
      const out = idPart(raw);
      expect(out, raw).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(seen.has(out), `${raw} and ${seen.get(out)} both give ${out}`).toBe(false);
      seen.set(out, raw);
    }
  });

  it("(d) keeps every DOM id in the inspector unique when two evidence ids differ by one character", () => {
    const finding = withEvidence(
      evidenceWith({ id: "a.b", spanId: "s1" }),
      evidenceWith({ id: "a_b", spanId: "s2", role: "supporting" }),
    );
    const root = checkInvariants(paneOnly(finding), { fragment: true });
    const selects = all(
      root,
      (el) => el.name === "select" && /^evidenceRole:/.test(attr(el, "name") ?? ""),
    );
    expect(selects).toHaveLength(2);
    expect(attr(selects[0]!, "id")).not.toBe(attr(selects[1]!, "id"));
  });
});

// ---------------------------------------------------------------------------------------------
// 13. Names typed by people show their invisible characters, like document text
// ---------------------------------------------------------------------------------------------

const BIDI = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
const NAME = "Lanternfish \u202eSoftware, Inc.\u202c \u200bLtd";

/** Every place a raw invisible character reached the page, apart from fields meant for editing. */
function leaks(html: string): string[] {
  const found: string[] = [];
  const visit = (node: Node, path: string): void => {
    if (node.type === "text") {
      if (BIDI.test(node.text)) found.push(`${path}: ${JSON.stringify(node.text.slice(0, 40))}`);
      return;
    }
    if (node.name === "textarea") return;
    for (const a of node.attrs) {
      if (a.name === "value" && node.name === "input") continue;
      if (a.value !== null && BIDI.test(a.value)) found.push(`${path} @${a.name}`);
    }
    for (const child of node.children) visit(child, `${path}>${node.name}`);
  };
  visit(parseHtml(html), "");
  return found;
}

describe("finding 13: person-typed names print invisible characters as markers", () => {
  it("does so on the matter page, for the associate and the reviewer", () => {
    for (const role of ["associate", "reviewer"] as const) {
      const base = buildMatterViewFor(role);
      const documents = base.documents.map((d) => ({
        ...d,
        title: NAME,
        versions: d.versions.map((v) => ({ ...v, uploadedByName: NAME })),
      }));
      const run = buildRunSummary({ startedByName: NAME });
      const active = buildRunSummary({
        status: "analyzing",
        startedByName: NAME,
        progress: { stage: "analyze", done: 1, total: 8 },
        finishedAt: null,
      });
      const view: MatterView = {
        ...base,
        matter: { ...base.matter, name: NAME, clientLegalName: NAME },
        documents,
        members: base.members.map((m) => ({ ...m, displayName: NAME })),
        runs: [run, active],
        currentRun: run,
        activeRun: active,
        staleReason: "Stale.",
        memos: [buildMemo({ exportedByName: NAME, fileName: `${NAME}.docx` })],
        warnings: [{ ...buildWarnings()[0]!, detail: NAME }],
        playbooks: buildPlaybooks().map((p) => ({ ...p, name: NAME })),
      };
      const html = render(
        MatterPage({
          chrome: buildChrome({ userName: NAME }),
          view,
          users: buildUsers().map((u) => ({ ...u, displayName: NAME })),
          canDelete: true,
        }),
      );
      expect(leaks(html), role).toEqual([]);
      expect(html).toContain("[U+202E]");
      expect(html).toContain("[U+200B]");
      checkInvariants(html);
    }
  });

  it("does so in the title, the crumbs and the sign-out row", () => {
    const view = buildMatterView({ matter: buildMatterSummary({ name: NAME }) });
    const html = render(
      MatterPage({ chrome: buildChrome({ userName: NAME }), view, canDelete: false }),
    );
    const root = parseHtml(html);
    const title = readable(byTag(root, "title")[0]!);
    expect(title).toBe(`${revealToString(NAME)} | Parol`);
    expect(title).toContain("[U+202E]");
    expect(readable(first(root, (el) => hasClass(el, "whoami")))).toContain("[U+202E]");
    expect(leaks(html)).toEqual([]);
  });

  it("does so on the run page, the finding page, the matters list, the memos page and the sign-in page", () => {
    const run = buildRunSummary({ startedByName: NAME, workflowLabel: NAME });
    const runHtml = render(
      RunPage({
        chrome: buildChrome({ userName: NAME }),
        matter: buildMatterSummary({ name: NAME, clientLegalName: NAME }),
        run,
        issues: buildIssueRows().map((r) => ({ ...r, ruleTitle: NAME })),
        selected: null,
      }),
    );
    expect(leaks(runHtml), "run").toEqual([]);

    const findingHtml = render(
      FindingPage({
        chrome: buildChrome({ userName: NAME }),
        matterId: IDS.matter,
        matterName: NAME,
        finding: buildFindingView(),
      }),
    );
    expect(leaks(findingHtml), "finding").toEqual([]);

    const mattersHtml = render(
      MattersPage({
        chrome: buildChrome({ userName: NAME }),
        matters: [buildMatterSummary({ name: NAME, clientLegalName: NAME })],
        playbooks: buildPlaybooks().map((p) => ({ ...p, name: NAME })),
        users: buildUsers().map((u) => ({ ...u, displayName: NAME })),
      }),
    );
    expect(leaks(mattersHtml), "matters").toEqual([]);

    const memosHtml = render(
      MemosPage({
        chrome: buildChrome({ userName: NAME }),
        matter: buildMatterSummary({ name: NAME }),
        memos: [buildMemo({ exportedByName: NAME, fileName: `${NAME}.docx` })],
        canExport: true,
        exportBlockedReason: null,
      }),
    );
    expect(leaks(memosHtml), "memos").toEqual([]);

    const signInHtml = render(
      SignInPage({
        chrome: buildChrome({ userName: null }),
        users: buildUsers().map((u) => ({ ...u, displayName: NAME })),
      }),
    );
    expect(leaks(signInHtml), "sign in").toEqual([]);
  });

  it("keeps the exact value in the field a person edits", () => {
    const view = buildMatterViewFor("associate", {
      matter: buildMatterSummary({ clientLegalName: NAME }),
    });
    const html = matterPage(view);
    const input = first(
      parseHtml(html),
      (el) => el.name === "input" && attr(el, "name") === FIELDS.clientLegalName,
    );
    expect(attr(input, "value")).toBe(NAME);
  });
});
