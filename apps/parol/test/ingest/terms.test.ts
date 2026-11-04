import { describe, expect, it } from "vitest";
import { findDefinedTerms } from "../../src/ingest/terms.js";
import { containsWholeWord, matchView } from "../../src/ingest/view.js";
import { annotationsOn, ingestTexts } from "./support.js";

const defined = (text: string): string[] => findDefinedTerms(matchView(text));

describe("terms a span defines", () => {
  it.each<[string, string, string[]]>([
    ["a bracketed term", 'This Agreement (the "Agreement") is made today.', ["Agreement"]],
    [
      "a bracketed term with no article",
      'Between Corvane LLC ("Corvane") and others.',
      ["Corvane"],
    ],
    ["curly quotes", "(the \u201cReceiving Party\u201d) shall keep it.", ["Receiving Party"]],
    [
      "two terms in one span",
      'by a Party (the "Disclosing Party") to the other Party (the "Receiving Party") that',
      ["Disclosing Party", "Receiving Party"],
    ],
    [
      "each a and together the",
      '(each a "Party" and together the "Parties")',
      ["Party", "Parties"],
    ],
    [
      "or between two terms",
      '(the "Disclosing Party" or "Discloser")',
      ["Disclosing Party", "Discloser"],
    ],
    ["hereinafter", '(hereinafter the "Company")', ["Company"]],
    ["hereinafter referred to as", '(hereinafter referred to as "Company")', ["Company"]],
    [
      "hereinafter outside brackets",
      'Corvane Data Systems LLC, hereinafter "Corvane", agrees.',
      ["Corvane"],
    ],
    [
      "hereinafter called the",
      'Acme Inc., hereinafter called the "Supplier", agrees.',
      ["Supplier"],
    ],
    ["a comma inside the quotes", '(the "Company,") agrees', ["Company"]],
    [
      "a means definition",
      '"Confidential Information" means non-public information.',
      ["Confidential Information"],
    ],
    [
      "a means definition in curly quotes",
      "\u201cConfidential Information\u201d means non-public information.",
      ["Confidential Information"],
    ],
    ["shall mean", '"Affiliate" shall mean any entity that controls a Party.', ["Affiliate"]],
    ["will mean", '"Purpose" will mean the evaluation.', ["Purpose"]],
    ["has the meaning", '"Effective Date" has the meaning given above.', ["Effective Date"]],
    ["shall have the meaning", '"Losses" shall have the meaning set out in Section 9.', ["Losses"]],
    ["refers to", '"Affiliate" refers to a related company.', ["Affiliate"]],
    ["is defined as", '"Term" is defined as the period of two years.', ["Term"]],
    ["includes", '"Representatives" includes officers and advisers.', ["Representatives"]],
    ["a chain before means", '"Party" or "Parties" means a signatory.', ["Party", "Parties"]],
    ["is the", 'a party that receives it is the "Receiving Party".', ["Receiving Party"]],
    ["are the", 'The signatories are collectively the "Parties".', ["Parties"]],
    ["referred to as", 'the entity referred to as the "Supplier" in the Schedule', ["Supplier"]],
    [
      "a zero-width character inside the term",
      '"Confi\u200bdential Information" means non-public information.',
      ["Confidential Information"],
    ],
    [
      "a definition with a parenthesis before the verb",
      '"Business Day" (as defined below) means a weekday.',
      ["Business Day"],
    ],
  ])("finds %s", (_name, text, terms) => {
    expect(defined(text)).toEqual(terms);
  });

  it.each<[string, string]>([
    [
      "a quoted cross-reference in brackets",
      'The list is set out in the Schedule (see "Schedule 2").',
    ],
    ["a quoted reference after as defined in", '(as defined in the "Master Agreement")'],
    ["a quoted legend", 'Information marked "Confidential" at disclosure is protected.'],
    [
      "a quoted phrase being replaced",
      'amended by replacing "ten (10) business days" with "thirty (30) days".',
    ],
    [
      "a quoted term that is negated",
      '"Confidential Information" does not include public information.',
    ],
    [
      "a quoted sentence",
      'The notice must say "this notice is given under the Agreement and is binding on both parties" in full.',
    ],
    [
      "a single character",
      'the mark "A" means nothing here beyond that'.replace("means nothing", "nothing"),
    ],
    ["a number only", '(the "2026")'],
    ["no quotes at all", "Confidential Information means non-public information."],
    ["a stray quote", 'a 5" pipe and the Agreement means this'],
  ])("does not take %s for a definition", (_name, text) => {
    expect(defined(text)).toEqual([]);
  });

  it("ignores a stray quote and still finds the real term after it", () => {
    expect(
      defined('A 5" pipe is described, and "Confidential Information" means secrets.'),
    ).toEqual(["Confidential Information"]);
  });

  it("lists a repeated term once, in order of first appearance", () => {
    expect(defined('(the "Beta") and (the "Alpha") and again (the "Beta")')).toEqual([
      "Beta",
      "Alpha",
    ]);
  });

  it("stays fast on a paragraph of nothing but quoted pairs", () => {
    const start = Date.now();
    defined('"ab" '.repeat(300_000));
    defined('("ab") '.repeat(200_000));
    expect(Date.now() - start).toBeLessThan(5000);
  });
});

describe("whole-word matching", () => {
  it.each<[string, string, boolean]>([
    ["The Receiving Party shall", "Receiving Party", true],
    ["the Receiving Party's duty", "Receiving Party", true],
    ["(the Receiving Party)", "Receiving Party", true],
    ["Receiving Party", "Receiving Party", true],
    ["the Receiving Partys", "Receiving Party", false],
    ["Parties", "Party", false],
    ["Partyline", "Party", false],
    ["Counterparty", "Party", false],
    ["the receiving party", "Receiving Party", false],
    ["RECEIVING PARTY", "Receiving Party", false],
    ["Party_1", "Party", false],
    ["Party2", "Party", false],
    ["the Party and a Party", "Party", true],
    ["Partying then the Party", "Party", true],
    ["\u00e9Party", "Party", false],
    ["\u{1d49c}Party", "Party", false],
  ])("%j contains %j: %s", (text, term, expected) => {
    expect(containsWholeWord(text, term)).toBe(expected);
  });
});

describe("defines_term and uses_term annotations", () => {
  const nda = `1. DEFINITIONS

1.1 "Confidential Information" means non-public information disclosed by a Party (the "Disclosing Party") to the other Party (the "Receiving Party").

2. OBLIGATIONS

2.1 The Receiving Party shall protect Confidential Information.

2.2 Nothing in this Agreement restricts any publicly known fact.`;

  const amendment = `AMENDMENT NO. 1

1. The Receiving Party's obligations are extended by one year.

2. The Disclosing Party may waive this Amendment in writing.`;

  it("records the terms a span defines and does not call that span a use of them", () => {
    const out = ingestTexts(nda);
    expect(annotationsOn(out, "D1-p1", "defines_term")).toEqual([
      { kind: "defines_term", spanId: "dv_d1:p1", term: "Confidential Information" },
      { kind: "defines_term", spanId: "dv_d1:p1", term: "Disclosing Party" },
      { kind: "defines_term", spanId: "dv_d1:p1", term: "Receiving Party" },
    ]);
    expect(annotationsOn(out, "D1-p1", "uses_term")).toEqual([]);
  });

  it("records a use in every other span that holds the term as a word", () => {
    const out = ingestTexts(nda);
    expect(annotationsOn(out, "D1-p3", "uses_term")).toEqual([
      { kind: "uses_term", spanId: "dv_d1:p3", term: "Confidential Information" },
      { kind: "uses_term", spanId: "dv_d1:p3", term: "Receiving Party" },
    ]);
    expect(annotationsOn(out, "D1-p4", "uses_term")).toEqual([]);
  });

  it("matches a term defined in the NDA when it is used in an amendment", () => {
    const out = ingestTexts(nda, amendment);
    expect(annotationsOn(out, "D2-p1", "uses_term")).toEqual([
      { kind: "uses_term", spanId: "dv_d2:p1", term: "Receiving Party" },
    ]);
    expect(annotationsOn(out, "D2-p2", "uses_term")).toEqual([
      { kind: "uses_term", spanId: "dv_d2:p2", term: "Disclosing Party" },
    ]);
    // A term defined in an amendment is linked back to the NDA the same way.
    const reverse = ingestTexts(
      "1. The Supplier shall deliver the Goods.",
      '1. The goods (the "Goods") are listed.',
    );
    expect(annotationsOn(reverse, "D1-p0", "uses_term")).toEqual([
      { kind: "uses_term", spanId: "dv_d1:p0", term: "Goods" },
    ]);
  });

  it("is case sensitive, as a defined term is a proper name", () => {
    const out = ingestTexts(
      '(the "Party") text. The party and the Party and PARTY here.',
      "A party only.",
    );
    expect(annotationsOn(out, "D1-p0", "defines_term")).toHaveLength(1);
    expect(annotationsOn(out, "D2-p0", "uses_term")).toEqual([]);
  });

  it("does not take a longer word for a use", () => {
    const out = ingestTexts('(the "Party") signs.', "Parties and Counterparty and Partyline.");
    expect(annotationsOn(out, "D2-p0", "uses_term")).toEqual([]);
  });

  it("lets a span define one term and use another", () => {
    const out = ingestTexts('(the "Alpha") is described first.\n\n("Beta") follows the Alpha.');
    const terms = out.annotations.filter(
      (a) => a.kind === "defines_term" || a.kind === "uses_term",
    );
    expect(terms).toEqual([
      { kind: "defines_term", spanId: "dv_d1:p0", term: "Alpha" },
      { kind: "defines_term", spanId: "dv_d1:p1", term: "Beta" },
      { kind: "uses_term", spanId: "dv_d1:p1", term: "Alpha" },
    ]);
  });

  it("annotates a term defined twice as a definition in both places", () => {
    const out = ingestTexts(
      '(the "Fee") is one thing.',
      '(the "Fee") is another.\n\nThe Fee is payable.',
    );
    expect(annotationsOn(out, "D1-p0", "defines_term")).toHaveLength(1);
    expect(annotationsOn(out, "D2-p0", "defines_term")).toHaveLength(1);
    expect(annotationsOn(out, "D2-p1", "uses_term")).toHaveLength(1);
  });

  it("matches through zero-width characters, curly quotes and no-break spaces", () => {
    const out = ingestTexts(
      "\u201cReceiving\u00a0Party\u201d means the recipient.",
      "The Receiv\u200bing Party agrees.",
    );
    expect(annotationsOn(out, "D2-p0", "uses_term")).toEqual([
      { kind: "uses_term", spanId: "dv_d2:p0", term: "Receiving Party" },
    ]);
  });

  it("keeps the number of distinct terms in a run bounded, across spans", () => {
    const spans = Array.from({ length: 30 }, (_, s) =>
      Array.from({ length: 40 }, (_, t) => `(the "Term${s}x${t}")`).join(" "),
    );
    const out = ingestTexts(spans.join("\n\n"));
    const defined = new Set(
      out.annotations
        .filter((a) => a.kind === "defines_term")
        .map((a) => (a as { term: string }).term),
    );
    expect(defined.size).toBe(500);
  });

  it("is not confused by a term named like a property of every object", () => {
    const out = ingestTexts(
      '(the "constructor") and ("toString") are defined.',
      "The constructor and toString apply.",
    );
    expect(
      annotationsOn(out, "D2-p0", "uses_term").map((a) => (a as { term: string }).term),
    ).toEqual(["constructor", "toString"]);
  });

  it("keeps the number of distinct terms bounded", () => {
    const many = Array.from({ length: 700 }, (_, i) => `(the "Term${i}")`).join(" ");
    const out = ingestTexts(`Definitions: ${many}`);
    const defines = out.annotations.filter((a) => a.kind === "defines_term");
    expect(defines.length).toBeLessThanOrEqual(50);
    expect(defines.length).toBeGreaterThan(0);
  });
});

describe("a long run of punctuation between quotes", () => {
  it.each([".", ",", ";", ":"])("is linear for a run of %j", (mark) => {
    const text = `This Agreement is made between A and B (the "${mark.repeat(200_000)}x") and so on for twenty characters.`;
    const start = Date.now();
    expect(defined(text)).toEqual([]);
    // The reproduction took 27 s at this size when the run was stripped with a quadratic regex.
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it("is linear when the run sits after a real term", () => {
    const text = `(the "Company${".".repeat(200_000)}x") and (the "Party,") agrees`;
    const start = Date.now();
    expect(defined(text)).toEqual(["Party"]);
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it("is linear through the whole pipeline for a text file and a Word file", () => {
    const body = `This Agreement is made between A and B (the "${".".repeat(150_000)}x") and so on for twenty characters.`;
    const start = Date.now();
    const out = ingestTexts(body);
    expect(out.spans).toHaveLength(1);
    expect(Date.now() - start).toBeLessThan(3000);
  });
});
