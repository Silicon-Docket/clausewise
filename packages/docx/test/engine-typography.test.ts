import { describe, expect, it } from "vitest";
import { applyRedline } from "../src/index.js";
import { curlyQuotes, foldTypography, matchQuoteStyle, trimEdit } from "../src/minimize.js";
import { buildDocx, elements, para, run, views } from "./helpers.js";

const date = new Date("2026-03-01T12:00:00Z");

/** The text of every tracked deletion and insertion, read straight from the XML. */
async function changes(buf: Uint8Array): Promise<{ deleted: string[]; inserted: string[] }> {
  const text = (els: Element[]) => els.map((e) => e.textContent ?? "");
  return {
    deleted: text(await elements(buf, "del")),
    inserted: text(await elements(buf, "ins")),
  };
}

async function redline(paragraph: string, from: string, to: string) {
  const buf = await buildDocx(para(run(paragraph)));
  const start = paragraph.indexOf(from);
  expect(start).toBeGreaterThanOrEqual(0);
  const result = await applyRedline(
    buf,
    { edits: [{ paragraphId: "p:0", start, end: start + from.length, replacement: to }] },
    { date },
  );
  return { result, ...(await changes(result.buffer)) };
}

describe("a model that types straight quotes into a document with curly ones", () => {
  it("strikes only the words that changed, not the word that has an apostrophe", async () => {
    const { result, deleted, inserted } = await redline(
      "Not less than six (6) months\u2019 written notice is required.",
      "six (6) months\u2019 written notice",
      "three (3) months' written notice",
    );
    expect(result.edits).toEqual([{ applied: true }]);
    expect(deleted).toEqual(["six (6)"]);
    expect(inserted).toEqual(["three (3)"]);
    expect((await views(result.buffer, "accepted"))[0]).toBe(
      "Not less than three (3) months\u2019 written notice is required.",
    );
  });

  it("keeps the unchanged tail of a longer phrase instead of striking and retyping it", async () => {
    const { deleted, inserted } = await redline(
      "all liabilities arising out of any breach of Tenant\u2019s obligations",
      "liabilities arising out of any breach of Tenant\u2019s",
      "reasonable and proper losses arising out of any breach of Tenant's",
    );
    expect(deleted).toEqual(["liabilities"]);
    expect(inserted).toEqual(["reasonable and proper losses"]);
  });

  it("keeps the document's characters in the words it leaves alone, double quotes too", async () => {
    const { result, deleted, inserted } = await redline(
      "The \u201CServices\u201D are provided as is.",
      "\u201CServices\u201D are provided",
      '"Services" are supplied',
    );
    expect(deleted).toEqual(["provided"]);
    expect(inserted).toEqual(["supplied"]);
    expect((await views(result.buffer, "accepted"))[0]).toBe(
      "The \u201CServices\u201D are supplied as is.",
    );
  });

  it("refuses an edit that only changes the kind of quote", async () => {
    const { result } = await redline(
      "The Tenant\u2019s duties apply.",
      "Tenant\u2019s",
      "Tenant's",
    );
    expect(result.edits).toEqual([{ applied: false, reason: "the edit changes nothing" }]);
  });

  it("treats dashes and no-break spaces as the same as hyphens and spaces when trimming", async () => {
    const { deleted, inserted } = await redline(
      "A 30\u2013day\u00A0period applies.",
      "30\u2013day\u00A0period",
      "30-day period extended",
    );
    expect(deleted).toEqual([]);
    expect(inserted).toEqual([" extended"]);
  });
});

describe("inserted quotes take the style of the paragraph", () => {
  it("become curly in a paragraph that uses curly quotes", async () => {
    const { result } = await redline(
      "The Tenant\u2019s duties apply here.",
      "duties",
      `duties under the "Lease" and Landlord's 'quoted' rights`,
    );
    expect((await views(result.buffer, "accepted"))[0]).toBe(
      "The Tenant\u2019s duties under the \u201CLease\u201D and Landlord\u2019s \u2018quoted\u2019 rights apply here.",
    );
  });

  it("stay straight in a paragraph that has none", async () => {
    const { result } = await redline(
      "The Tenant's duties apply here.",
      "duties",
      `duties under the "Lease" and Landlord's rights`,
    );
    expect((await views(result.buffer, "accepted"))[0]).toBe(
      `The Tenant's duties under the "Lease" and Landlord's rights apply here.`,
    );
  });

  it.each([
    ["apostrophe after a letter", "Landlord's", "Landlord", "Landlord\u2019s"],
    ["apostrophe after a digit", "the 1990's", "the 1990", "the 1990\u2019s"],
    ["single quote at the start", "'a'", "", "\u2018a\u2019"],
    ["double quote at the start", '"a"', "", "\u201Ca\u201D"],
    ["double quote after a space", 'say "a"', "say", "say \u201Ca\u201D"],
    ["double quote after an opening bracket", '("a")', "", "(\u201Ca\u201D)"],
    ["double quote after punctuation closes", 'a."', "x", "a.\u201D"],
    [
      "double quote after an opening curly one opens a nested one",
      `\u201C"a"`,
      "",
      "\u201C\u201Ca\u201D",
    ],
  ])("%s", (_, inserted, before, expected) => {
    expect(curlyQuotes(inserted, before)).toBe(expected);
  });

  it("looks at the text before the insertion point to decide whether a quote opens", () => {
    const paragraph = "He said \u201Chello\u201D and left ";
    expect(matchQuoteStyle('"bye"', paragraph, paragraph.length)).toBe("\u201Cbye\u201D");
    expect(matchQuoteStyle('"bye"', paragraph, paragraph.length - 1)).toBe("\u201Dbye\u201D");
    expect(matchQuoteStyle("x", paragraph, 3)).toBe("x");
    expect(matchQuoteStyle("it's", "plain text", 0)).toBe("it's");
  });
});

describe("the comparison used to trim an edit", () => {
  it("folds quotes, dashes and special spaces one unit to one unit, so offsets stay valid", () => {
    const text = "\u2018a\u2019 \u201Cb\u201D \u2013 \u2212 x\u00A0y";
    expect(foldTypography(text)).toBe(`'a' "b" - - x y`);
    expect(foldTypography(text)).toHaveLength(text.length);
  });

  it("trims whole words on both ends and reports where the change starts", () => {
    expect(trimEdit("the term is three years", "the term is two years")).toEqual({
      offset: 12,
      removed: "three",
      inserted: "two",
    });
    expect(trimEdit("a b c", "a b c")).toEqual({ offset: 5, removed: "", inserted: "" });
    expect(trimEdit("Tenant\u2019s duty", "Tenant's obligation")).toEqual({
      offset: 9,
      removed: "duty",
      inserted: "obligation",
    });
  });
});
