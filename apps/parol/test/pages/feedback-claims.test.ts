import { describe, expect, it } from "vitest";
import { all, hasAttr, parseHtml, readable, type Node } from "./html.js";
import { VARIANTS_FEEDBACK } from "./variants-feedback.js";

/**
 * What the capture of feedback does not say (package W2.6a). It stores what a person reports and
 * shows each person their own items with the count they belong to; it computes no measure, so no
 * page it adds states a rate, a median, a total across matters, or anything about adoption,
 * accuracy or time saved (the pilot page of the later package is where a measure is computed, with
 * its denominator). Every number a pane states is a count of things on the page or a mark out of
 * five.
 *
 * The check is over every fixture of the panes, so a sentence added to any state of any of them is
 * read.
 */

/**
 * The words of a page, each text node apart from the next, so that a word at the end of one element
 * is not run into the first word of the next and a pattern with a word boundary reads what a person
 * would.
 */
const words = (node: Node): string =>
  node.type === "text" ? node.text : node.children.map(words).join(" ");

const CLAIMS = [
  /%/,
  /\bpercent(age)?\b/i,
  /\bmedian\b/i,
  /\baverage\b/i,
  /\badoption\b/i,
  /\badopted\b/i,
  /\baccura(te|cy)\b/i,
  /\btime[- ]sav(ed|ing|ings)\b/i,
  /\bsaves? (you )?time\b/i,
  /\bper (matter|review|reviewer|user)\b/i,
];

describe("the panes of the capture of feedback", () => {
  it("state no rate, no median, no total and nothing about adoption, accuracy or time saved, in any state", () => {
    expect(VARIANTS_FEEDBACK.length).toBeGreaterThan(30);
    for (const [title, make] of VARIANTS_FEEDBACK) {
      // The text a person reads: the visible text of the page, which is not the markup.
      const text = words(parseHtml(make()));
      for (const claim of CLAIMS) expect(text, `${title}: ${String(claim)}`).not.toMatch(claim);
    }
  });

  it("give a number only as a mark out of five or as a count of the things beside it", () => {
    const seen = new Set<string>();
    for (const [, make] of VARIANTS_FEEDBACK) {
      const root = parseHtml(make());
      // The rating the person gave: its mark and its scale together.
      for (const m of readable(root).matchAll(/rated this matter (\d+)( of (\d+))?/g)) {
        expect(m[3], m[0]).toBe("5");
        seen.add("rating");
      }
      // The count in the issue table is of the notes a finding has, beside the word for them.
      for (const el of all(root, (x) => hasAttr(x, "data-note-count"))) {
        expect(readable(el)).toMatch(/^\d+ notes?$/);
        seen.add("count");
      }
    }
    // Both were there to check, so the loops above were not empty.
    expect([...seen].sort()).toEqual(["count", "rating"]);
  });
});
