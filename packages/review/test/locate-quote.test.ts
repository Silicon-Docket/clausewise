import { describe, expect, it } from "vitest";
import { anchorEdit, locateQuote } from "../src/anchor.js";
import type { Clause } from "../src/types.js";

const text =
  "The obligations of each Receiving Party shall continue for two (2) years from the date of each disclosure.";

describe("locateQuote", () => {
  it("returns offsets into the original text for a unique quote", () => {
    const quote = "continue for two (2) years";
    const at = locateQuote(text, quote);
    expect(at.found).toBe("one");
    if (at.found !== "one") return;
    expect(text.slice(at.start, at.end)).toBe(quote);
    expect(at.original).toBe(quote);
  });

  it("applies the same normalization as anchorEdit: typographic quotes, dashes, spacing", () => {
    const source = "The Recipient’s duty is “strict” – and   permanent.";
    const at = locateQuote(source, `Recipient's duty is "strict" - and permanent.`);
    expect(at.found).toBe("one");
    if (at.found === "one") expect(at.start).toBe(4);
  });

  it("reports the count and the first occurrence for a repeated quote", () => {
    const at = locateQuote("a term. A term again. The term ends.", "term");
    expect(at).toMatchObject({ found: "many", count: 3, start: 2 });
  });

  it("does not match inside a longer word, and says so", () => {
    expect(locateQuote("the determination stands", "term")).toEqual({
      found: "none",
      onlyInsideWords: true,
    });
  });

  it("does not match a spliced quote or an empty one", () => {
    expect(locateQuote(text, "shall continue ... disclosure")).toEqual({
      found: "none",
      onlyInsideWords: false,
    });
    expect(locateQuote(text, "   ")).toEqual({ found: "none", onlyInsideWords: false });
  });

  it("agrees with anchorEdit on whether a quote can be found once", () => {
    const clause: Clause = {
      id: "c1",
      number: undefined,
      heading: undefined,
      paragraphs: [{ id: "p:0", text }],
      text,
    };
    for (const quote of ["two (2) years", "disclosure.", "shall", "years from the", "each"]) {
      const anchored = anchorEdit([clause], { clauseId: "c1", quote, replacement: "X" });
      const located = locateQuote(text, quote);
      expect(located.found === "one").toBe(anchored.ok);
      if (anchored.ok && located.found === "one") {
        expect([located.start, located.end]).toEqual([anchored.start, anchored.end]);
      }
    }
  });
});
