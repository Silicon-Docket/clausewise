import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { applyRedline, parseDocx, type DocxParagraph } from "@clausewise/docx";
import { describe, expect, it } from "vitest";
import { anchorEdit, normalizeForAnchor, type AnchorResult } from "../src/anchor.js";
import type { Clause, ProposedEdit } from "../src/types.js";

const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures");

/** A clause whose paragraphs get ids `p:<base>`, `p:<base + 1>`, and so on. */
function clauseOf(id: string, texts: string[], base = 0): Clause {
  return {
    id,
    number: undefined,
    heading: undefined,
    paragraphs: texts.map((text, i) => ({ id: `p:${base + i}`, text })),
    text: texts.join("\n"),
  };
}

// Never equal to a quote in these tests, so a replacement cannot trip the no-change check.
const REPLACEMENT = "REPLACEMENT TEXT";

const edit = (clauseId: string, quote: string, replacement = REPLACEMENT): ProposedEdit => ({
  clauseId,
  quote,
  replacement,
});

const INVISIBLE = /[\u200b\u200c\u200d\u2060\ufeff\u00ad]/g;

// Written separately from the implementation, with regular expressions where it uses a loop, so
// a mistake in one is unlikely to be repeated in the other.
function oracle(text: string): string {
  return text
    .replace(INVISIBLE, "")
    .replace(/[\u2018\u2019\u201a\u201b\u2039\u203a\u02bc\uff07]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u00ab\u00bb\uff02]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ");
}

const oracleQuote = (quote: string): string => oracle(quote).trim();

/** Overlapping occurrences, counted the slow and obvious way. */
function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) count++;
  return count;
}

const WORD_START = /^[\p{L}\p{N}\p{M}]/u;
const WORD_END = /[\p{L}\p{N}\p{M}]$/u;

// A character is at most two UTF-16 units, so two are enough to see whether an edge is a word
// character, and testing no more keeps each check constant in the length of the text.
const startsWord = (text: string): boolean => WORD_START.test(text.slice(0, 2));
const endsWord = (text: string): boolean => WORD_END.test(text.slice(-2));

/**
 * Where `needle` occurs in `haystack` without cutting a word: a side that begins or ends on a
 * letter, digit or combining mark must not touch another. `haystack` is normalized text, in which
 * the characters the guard skips over are already gone.
 */
function wholeWordPositions(haystack: string, needle: string): number[] {
  const places: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const end = at + needle.length;
    const cutsStart = startsWord(needle) && endsWord(haystack.slice(Math.max(0, at - 2), at));
    const cutsEnd = endsWord(needle) && startsWord(haystack.slice(end, end + 2));
    if (!cutsStart && !cutsEnd) places.push(at);
  }
  return places;
}

const wholeWordOccurrences = (haystack: string, needle: string): number =>
  wholeWordPositions(haystack, needle).length;

/** Whether [start, end) of `text` starts or ends inside a word, judged on the text as written. */
function cutsWordAt(text: string, start: number, end: number): boolean {
  const span = text.slice(start, end);
  const before = text.slice(0, start).replace(INVISIBLE, "");
  const after = text.slice(end).replace(INVISIBLE, "");
  return (startsWord(span) && endsWord(before)) || (endsWord(span) && startsWord(after));
}

function allParagraphs(clauses: Clause[]) {
  return clauses.flatMap((c) => c.paragraphs);
}

type Anchored = Extract<AnchorResult, { ok: true }>;

/**
 * Anchors an edit that must succeed and checks the invariants every success has to satisfy. The
 * replacement comes back as proposed unless the quote lost edge whitespace, which the caller says.
 */
function anchored(
  clauses: Clause[],
  proposed: ProposedEdit,
  replacement = proposed.replacement,
): Anchored {
  const result = anchorEdit(clauses, proposed);
  if (!result.ok) throw new Error(`expected an anchor, got: ${result.reason}`);
  const paragraph = allParagraphs(clauses).find((p) => p.id === result.paragraphId);
  expect(paragraph).toBeDefined();
  const text = paragraph?.text ?? "";
  expect(text.slice(result.start, result.end)).toBe(result.original);
  expect(oracle(result.original)).toBe(oracleQuote(proposed.quote));
  expect(result.replacement).toBe(replacement);
  return result;
}

function rejected(clauses: Clause[], proposed: ProposedEdit): string {
  const result = anchorEdit(clauses, proposed);
  if (result.ok) throw new Error(`expected a rejection, got an anchor on ${result.paragraphId}`);
  return result.reason;
}

describe("anchorEdit: accepted quotes", () => {
  const cases: [name: string, text: string, quote: string, original: string][] = [
    [
      "an exact quote",
      "The term is three (3) years from the Effective Date.",
      "three (3) years",
      "three (3) years",
    ],
    [
      "a curly apostrophe in the document and a straight one in the quote",
      "Recipient\u2019s duties continue.",
      "Recipient's duties",
      "Recipient\u2019s duties",
    ],
    [
      "a straight apostrophe in the document and a curly one in the quote",
      "Recipient's duties continue.",
      "Recipient\u2019s duties",
      "Recipient's duties",
    ],
    [
      "curly double quotes in the document",
      "for the \u201cPurpose\u201d only",
      'the "Purpose" only',
      "the \u201cPurpose\u201d only",
    ],
    [
      "straight double quotes in the document and curly ones in the quote",
      'for the "Purpose" only',
      "the \u201cPurpose\u201d only",
      'the "Purpose" only',
    ],
    [
      "curly single quotes",
      "the \u2018Purpose\u2019 only",
      "the 'Purpose'",
      "the \u2018Purpose\u2019",
    ],
    [
      "a non-breaking space in the document",
      "within thirty\u00a0(30)\u00a0days of receipt",
      "thirty (30) days",
      "thirty\u00a0(30)\u00a0days",
    ],
    [
      "a non-breaking space in the quote",
      "within thirty (30) days of receipt",
      "thirty\u00a0(30)\u00a0days",
      "thirty (30) days",
    ],
    [
      "double spaces in the document, covered whole",
      "within ten  (10)   days of receipt",
      "ten (10) days",
      "ten  (10)   days",
    ],
    [
      "double spaces in the quote",
      "within ten (10) days of receipt",
      "ten  (10)   days",
      "ten (10) days",
    ],
    [
      "tabs, newlines and thin spaces",
      "one\ttwo\nthree\u2009four five",
      "one two three four",
      "one\ttwo\nthree\u2009four",
    ],
    [
      "an en dash in the document and a hyphen in the quote",
      "this non\u2013disclosure agreement",
      "non-disclosure agreement",
      "non\u2013disclosure agreement",
    ],
    [
      "an em dash in the document and a hyphen in the quote",
      "Term \u2014 five years",
      "Term - five years",
      "Term \u2014 five years",
    ],
    ["a minus sign in the document", "the value A\u2212B holds", "A-B", "A\u2212B"],
    [
      "a hyphen in the document and an en dash in the quote",
      "this non-disclosure agreement",
      "non\u2013disclosure agreement",
      "non-disclosure agreement",
    ],
    [
      "zero-width characters in the model's quote",
      "are perpetual and shall continue indefinitely",
      "perpe\u200btual and\u2060 shall\ufeff con\u200c\u200dtinue",
      "perpetual and shall continue",
    ],
    [
      "a zero-width character in the document",
      "are perpe\u200btual and shall continue",
      "perpetual and shall",
      "perpe\u200btual and shall",
    ],
    [
      "a soft hyphen in the document",
      "to co\u00adoperate fully with Discloser",
      "cooperate fully",
      "co\u00adoperate fully",
    ],
    [
      "a trailing space in the quote",
      "are perpetual and shall continue",
      "perpetual ",
      "perpetual",
    ],
    [
      "leading and trailing whitespace of every kind in the quote",
      "are perpetual and shall continue",
      "\n\u00a0 perpetual \t\u2009",
      "perpetual",
    ],
    [
      "a gap made of spaces around a zero-width character",
      "alpha \u200b \u00a0beta gamma",
      "alpha beta",
      "alpha \u200b \u00a0beta",
    ],
    ["the whole paragraph", "Entire text.", "Entire text.", "Entire text."],
    ["text after an astral character, counted in UTF-16 units", "\u{1F600} foo bar", "foo", "foo"],
    ["a single character", "x y z", "y", "y"],
  ];

  it.each(cases)("%s", (_name, text, quote, original) => {
    const result = anchored([clauseOf("c1", [text])], edit("c1", quote));
    expect(result.paragraphId).toBe("p:0");
    expect(result.original).toBe(original);
    expect(result.start).toBe(text.indexOf(original));
    expect(result.end).toBe(text.indexOf(original) + original.length);
  });

  it("stops at the last matched character, leaving a trailing zero-width character out", () => {
    const text = "foo\u200bbar\u200b baz";
    const clauses = [clauseOf("c1", [text])];
    expect(anchored(clauses, edit("c1", "foobar")).original).toBe("foo\u200bbar");
    expect(anchored(clauses, edit("c1", "foobar baz")).original).toBe(text);
    expect(anchored(clauses, edit("c1", "baz")).original).toBe("baz");
    const spaced = [clauseOf("c1", ["foo\u200b bar"])];
    expect(anchored(spaced, edit("c1", "foo")).original).toBe("foo");
  });

  it("returns the replacement exactly as proposed", () => {
    const replacement = " \u201cfor  three\u00a0(3)\u201d years\u200b\n ";
    const result = anchored([clauseOf("c1", ["a b c"])], edit("c1", "b", replacement));
    expect(result.replacement).toBe(replacement);
  });

  it("accepts an empty replacement, which deletes the quoted text", () => {
    const result = anchored(
      [clauseOf("c1", ["keep this, drop that"])],
      edit("c1", ", drop that", ""),
    );
    expect(result.original).toBe(", drop that");
    expect(result.replacement).toBe("");
  });

  it("does not match inside a longer word", () => {
    const reason = rejected([clauseOf("c1", ["three years"])], edit("c1", "ree y"));
    expect(reason).toMatch(/not found as whole words/);
  });
});

describe("anchorEdit: clauses with several paragraphs", () => {
  const a = "Recipient shall keep all Confidential Information secret.";
  const b = "The obligations in this clause survive for three (3) years.";
  const c = "Nothing here limits any other duty of the Recipient.";

  it("anchors a quote that is unique to the second paragraph and reports that paragraph", () => {
    const clauses = [clauseOf("c1", [a, b, c], 10)];
    const result = anchored(clauses, edit("c1", "survive for three (3) years"));
    expect(result.paragraphId).toBe("p:11");
    expect(result.start).toBe(b.indexOf("survive"));
  });

  it("reports the last paragraph when the quote is unique to it", () => {
    const result = anchored([clauseOf("c1", [a, b, c], 10)], edit("c1", "any other duty"));
    expect(result.paragraphId).toBe("p:12");
  });

  it("is ambiguous when the same text appears once in each paragraph", () => {
    const clauses = [clauseOf("c1", ["The Recipient agrees.", "The Recipient objects."])];
    const reason = rejected(clauses, edit("c1", "The Recipient"));
    expect(reason).toMatch(/ambiguous/);
    expect(reason).toContain("2 times");
  });

  it("counts occurrences across all paragraphs and within one", () => {
    const clauses = [clauseOf("c1", ["ab ab", "ab", "nothing"])];
    expect(rejected(clauses, edit("c1", "ab"))).toContain("3 times");
  });

  it("is ambiguous when the text appears twice in one paragraph", () => {
    const reason = rejected([clauseOf("c1", ["pay on time, pay on time"])], edit("c1", "pay"));
    expect(reason).toMatch(/ambiguous/);
    expect(reason).toContain("2 times");
  });

  it("counts overlapping occurrences", () => {
    const reason = rejected([clauseOf("c1", ["a - a - a"])], edit("c1", "a - a"));
    expect(reason).toContain("2 times");
  });

  it("counts occurrences that only match after normalization", () => {
    const clauses = [clauseOf("c1", ["Recipient\u2019s duty", "Recipient's  duty"])];
    expect(rejected(clauses, edit("c1", "Recipient's duty"))).toContain("2 times");
  });

  it("does not match a quote that spans two paragraphs", () => {
    const clauses = [
      clauseOf("c1", ["The duty falls on the Disclosing", "Party and nobody else."]),
    ];
    for (const quote of [
      "the Disclosing Party",
      "the Disclosing\nParty",
      "the Disclosing\n\nParty",
      "Disclosing\u00a0Party",
    ]) {
      const reason = rejected(clauses, edit("c1", quote));
      expect(reason).toMatch(/not found/);
      expect(reason).toMatch(/single paragraph/);
    }
  });

  it("does not search other clauses", () => {
    const clauses = [
      clauseOf("c1", ["First clause."]),
      clauseOf("c2", ["Unique wording here."], 1),
    ];
    expect(rejected(clauses, edit("c1", "Unique wording"))).toMatch(/not found/);
    expect(anchored(clauses, edit("c2", "Unique wording")).paragraphId).toBe("p:1");
  });
});

describe("anchorEdit: rejected edits", () => {
  const text = "Recipient's obligations are perpetual and shall continue indefinitely.";
  const clauses = [clauseOf("c1", [text])];

  it.each([
    ["a hallucinated word", "perpetual and shall continue forever"],
    ["a one-character near miss", "perpetuel and shall continue"],
    ["a one-character near miss at the end", "continue indefinitelx"],
    ["a case difference", "Perpetual and shall continue"],
    ["an upper-case quote", "PERPETUAL"],
    ["a missing word", "perpetual shall continue"],
    ["an extra word", "perpetual and then shall continue"],
    ["reordered words", "shall continue perpetual and"],
    ["a missing space", "perpetualand shall"],
    ["an added space", "perpe tual and shall"],
    ["different punctuation", "indefinitely,"],
    ["a different apostrophe-like mark", "Recipient`s obligations"],
    ["a different dash-like mark", "perpetual \u2192 and shall"],
    ["a paraphrase", "obligations last forever"],
    ["a quote longer than the paragraph", `${text} And a further sentence.`],
  ])("rejects %s", (_name, quote) => {
    expect(rejected(clauses, edit("c1", quote))).toMatch(/not found within a single paragraph/);
  });

  it.each([
    ["an empty quote", ""],
    ["a whitespace-only quote", " \t\n"],
    ["a quote of non-breaking and thin spaces", "\u00a0\u2009 \u3000"],
    ["a quote of zero-width characters", "\u200b\u2060\ufeff"],
  ])("rejects %s", (_name, quote) => {
    expect(rejected(clauses, edit("c1", quote))).toMatch(/empty/);
  });

  it("rejects an unknown clause", () => {
    expect(rejected(clauses, edit("c9", "perpetual"))).toMatch(/clause/);
    expect(rejected([], edit("c1", "perpetual"))).toMatch(/clause/);
  });

  it("rejects a quote equal to its replacement", () => {
    expect(rejected(clauses, edit("c1", "perpetual", "perpetual"))).toMatch(/identical/);
  });

  it.each([
    ["curly against straight quotes", "Recipient's obligations", "Recipient\u2019s obligations"],
    ["a hyphen against an en dash", "non-disclosure", "non\u2013disclosure"],
    ["collapsed whitespace", "perpetual and", "perpetual  and"],
    ["surrounding whitespace", "perpetual", " perpetual\u00a0"],
    ["zero-width characters", "perpetual", "perpe\u200btual"],
  ])("rejects a replacement that differs only by %s", (_name, quote, replacement) => {
    const clause = [clauseOf("c1", [`${quote} and shall continue`])];
    expect(rejected(clause, edit("c1", quote, replacement))).toMatch(/identical/);
  });

  it("checks the clause before the quote", () => {
    expect(rejected(clauses, edit("c9", "", ""))).toMatch(/clause/);
  });

  it("does not match across a lone surrogate boundary", () => {
    const emoji = [clauseOf("c1", ["a\u{1F600}b"])];
    expect(rejected(emoji, edit("c1", "\ud83d"))).toMatch(/not found/);
    expect(rejected(emoji, edit("c1", "\ude00b"))).toMatch(/not found/);
    expect(rejected(emoji, edit("c1", "a\ud83d"))).toMatch(/not found/);
  });

  it("still anchors whole astral characters", () => {
    const emoji = [clauseOf("c1", ["a\u{1F600}b"])];
    const result = anchored(emoji, edit("c1", "\u{1F600}b"));
    expect([result.start, result.end]).toEqual([1, 4]);
  });

  it("anchors a lone surrogate in the document where it really occurs", () => {
    const lone = [clauseOf("c1", ["x\ud83dy and \u{1F600}"])];
    const result = anchored(lone, edit("c1", "\ud83dy"));
    expect([result.start, result.end]).toEqual([1, 3]);
  });

  it("never puts the quote, the document text or the clause id in a reason", () => {
    const secret = "Zanzibar indemnity of 4,711,000 euro";
    const doc = [clauseOf("c1", [`${secret} and ${secret}`])];
    const reasons = [
      rejected(doc, edit("c1", secret)),
      rejected(doc, edit("c1", `${secret} plus a hallucinated tail`)),
      rejected(doc, edit("c1", "")),
      rejected(doc, edit("c1", secret, secret)),
      rejected(doc, edit(secret, secret)),
    ];
    for (const reason of reasons) {
      expect(reason).not.toMatch(/zanzibar|indemnity|4,711|euro/i);
    }
  });

  it("does not modify its inputs", () => {
    const doc = [clauseOf("c1", ["one  two", "three"])];
    const before = JSON.stringify(doc);
    anchorEdit(doc, edit("c1", "one two"));
    anchorEdit(doc, edit("c1", "missing"));
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe("anchorEdit: word boundaries", () => {
  const WHOLE_WORDS = /not found as whole words within a single paragraph of the clause/;

  it.each([
    ["starts inside a word", "The term is three years.", "ree years"],
    ["ends inside a word", "The term is three years.", "term is thr"],
    ["lies wholly inside a word", "The term is three years.", "ree"],
    ["is one letter of a word", "The term is three years.", "r"],
    ["is the first letters of a word", "The term is three years.", "thr"],
    ["is the last letters of a word", "The term is three years.", "ears"],
    ["starts inside a word and ends on a full stop", "The term is three years.", "ars."],
    ["ends inside the word after a hyphen", "this non-disclosure agreement", "non-disc"],
    ["starts inside the word before a hyphen", "this non-disclosure agreement", "on-disclosure"],
    ["is a word plus the first letter of the next", "pay the fee now", "the f"],
    ["is trimmed of a trailing space and then ends inside a word", "threes years", "three "],
    ["is trimmed of a leading space and then starts inside a word", "ethree years", " three"],
  ])("rejects a quote that %s", (_name, text, quote) => {
    expect(rejected([clauseOf("c1", [text])], edit("c1", quote))).toMatch(WHOLE_WORDS);
  });

  it.each([
    ["a whole word in the middle of a paragraph", "The term is three years.", "three"],
    ["the first word of a paragraph", "three years", "three"],
    ["the last word of a paragraph", "for three years", "years"],
    ["a paragraph of one word", "three", "three"],
    ["several whole words before a full stop", "The term is three years.", "three years"],
    ["a word before a comma", "one, two", "one"],
    ["a word inside brackets", "a (three) b", "three"],
    ["a word between non-breaking spaces", "the\u00a0three\u00a0years", "three"],
    ["a word between a newline and a tab", "the\nthree\tyears", "three"],
    ["a word after a trimmed leading space", "the three years", " three"],
    ["a word before a trimmed trailing space", "the three years", "three "],
  ])("anchors %s", (_name, text, quote) => {
    const result = anchored([clauseOf("c1", [text])], edit("c1", quote));
    expect(result.original).toBe(quote.trim());
    expect(result.start).toBe(text.indexOf(quote.trim()));
  });

  describe("a side that starts or ends on punctuation", () => {
    const clauses = [clauseOf("c1", ["foo(bar)baz"])];

    it.each([
      ["on both sides", "(bar)"],
      ["at the start", "(bar"],
      ["at the end", "bar)"],
      ["alone", ")"],
    ])("is not constrained %s", (_name, quote) => {
      expect(anchored(clauses, edit("c1", quote)).original).toBe(quote);
    });

    it.each([
      ["starts on punctuation but ends inside a word", "(ba"],
      ["ends on punctuation but starts inside a word", "ar)"],
    ])("still constrains the other side of a quote that %s", (_name, quote) => {
      expect(rejected(clauses, edit("c1", quote))).toMatch(WHOLE_WORDS);
    });

    it("anchors the words that the punctuation separates", () => {
      expect(anchored(clauses, edit("c1", "foo")).original).toBe("foo");
      expect(anchored(clauses, edit("c1", "bar")).original).toBe("bar");
      expect(anchored(clauses, edit("c1", "baz")).original).toBe("baz");
    });
  });

  describe("apostrophes", () => {
    it.each([
      ["straight", "'"],
      ["curly", "\u2019"],
      ["left curly", "\u2018"],
      ["modifier letter", "\u02bc"],
      ["fullwidth", "\uff07"],
    ])("ends a word whichever way it is written: %s", (_name, mark) => {
      const text = `Recipient${mark}s duties continue.`;
      const clauses = [clauseOf("c1", [text])];
      expect(anchored(clauses, edit("c1", "Recipient")).original).toBe("Recipient");
      expect(anchored(clauses, edit("c1", "Recipient's duties")).original).toBe(
        `Recipient${mark}s duties`,
      );
      expect(anchored(clauses, edit("c1", "'s duties")).original).toBe(`${mark}s duties`);
      expect(rejected(clauses, edit("c1", "ecipient"))).toMatch(WHOLE_WORDS);
      expect(rejected(clauses, edit("c1", "Recipient's dut"))).toMatch(WHOLE_WORDS);
    });

    it("lets a quote end on the apostrophe of a plural possessive", () => {
      const result = anchored(
        [clauseOf("c1", ["the Recipients' duties"])],
        edit("c1", "Recipients'"),
      );
      expect(result.original).toBe("Recipients'");
    });
  });

  describe("hyphens", () => {
    it.each(["-", "\u2010", "\u2011", "\u2013", "\u2014", "\u2212"])(
      "end a word, so a quote may stop at one: %j",
      (hyphen) => {
        const text = `this non${hyphen}disclosure agreement`;
        const clauses = [clauseOf("c1", [text])];
        expect(anchored(clauses, edit("c1", "non")).original).toBe("non");
        expect(anchored(clauses, edit("c1", "disclosure")).original).toBe("disclosure");
        expect(anchored(clauses, edit("c1", "non-disclosure")).original).toBe(
          `non${hyphen}disclosure`,
        );
        expect(anchored(clauses, edit("c1", "non-")).original).toBe(`non${hyphen}`);
        expect(rejected(clauses, edit("c1", "non-disc"))).toMatch(WHOLE_WORDS);
        expect(rejected(clauses, edit("c1", "on-disclosure"))).toMatch(WHOLE_WORDS);
      },
    );
  });

  describe("zero-width characters and soft hyphens", () => {
    it("do not separate two words, because normalization deletes them", () => {
      const joined = [clauseOf("c1", ["foo\u200bbar baz"])];
      expect(rejected(joined, edit("c1", "foo"))).toMatch(WHOLE_WORDS);
      expect(rejected(joined, edit("c1", "bar"))).toMatch(WHOLE_WORDS);
      expect(anchored(joined, edit("c1", "foobar")).original).toBe("foo\u200bbar");

      const soft = [clauseOf("c1", ["to co\u00adoperate fully"])];
      expect(rejected(soft, edit("c1", "co"))).toMatch(WHOLE_WORDS);
      expect(rejected(soft, edit("c1", "operate"))).toMatch(WHOLE_WORDS);
      expect(anchored(soft, edit("c1", "cooperate")).original).toBe("co\u00adoperate");

      const many = [clauseOf("c1", ["ab\u200b\u200c\u200d\u2060\ufeff\u00adcd ef"])];
      expect(rejected(many, edit("c1", "ab"))).toMatch(WHOLE_WORDS);
      expect(rejected(many, edit("c1", "cd"))).toMatch(WHOLE_WORDS);
      expect(anchored(many, edit("c1", "abcd")).original).toBe(
        "ab\u200b\u200c\u200d\u2060\ufeff\u00adcd",
      );
    });

    it.each([
      ["a space after the invisible character", "foo\u200b bar", "foo"],
      ["a space before the invisible character", "foo \u200bbar", "bar"],
      ["several invisible characters before a space", "foo\u200b\u200c\u00ad bar", "foo"],
      ["punctuation after the invisible character", "(\u200bfoo\u200b)", "foo"],
      ["the start of the paragraph", "\u200bfoo bar", "foo"],
      ["the end of the paragraph", "bar foo\u200b", "foo"],
      ["a soft hyphen at both ends of the paragraph", "\u00adfoo\u00ad", "foo"],
    ])("let a word be found past them: %s", (_name, text, quote) => {
      const result = anchored([clauseOf("c1", [text])], edit("c1", quote));
      expect(result.original).toBe(quote);
    });

    it("are skipped in time linear in their number", () => {
      const text = `a${"\u200b".repeat(200_000)}b c`;
      const started = performance.now();
      expect(rejected([clauseOf("c1", [text])], edit("c1", "a"))).toMatch(WHOLE_WORDS);
      expect(rejected([clauseOf("c1", [text])], edit("c1", "b"))).toMatch(WHOLE_WORDS);
      expect(anchored([clauseOf("c1", [text])], edit("c1", "ab")).start).toBe(0);
      expect(performance.now() - started).toBeLessThan(1000);
    });
  });

  describe("letters that are not Basic Latin", () => {
    it.each([
      ["precomposed accented Latin", "un caf\u00e9 au lait", "caf\u00e9"],
      ["accented Latin at the start of a word", "une \u00e9tude de cas", "\u00e9tude"],
      ["Greek", "\u03b1\u03b2\u03b3 \u03b4\u03b5\u03b6 \u03b7", "\u03b4\u03b5\u03b6"],
      [
        "Greek with accents",
        "\u03ba\u03b1\u03bb\u03b7\u03bc\u03ad\u03c1\u03b1 \u03ba\u03cc\u03c3\u03bc\u03b5",
        "\u03ba\u03cc\u03c3\u03bc\u03b5",
      ],
      [
        "Cyrillic",
        "\u0434\u043e\u0433\u043e\u0432\u043e\u0440 \u0441\u0442\u043e\u0440\u043e\u043d",
        "\u0441\u0442\u043e\u0440\u043e\u043d",
      ],
      ["a decomposed accent kept with its letter", "cafe\u0301 au lait", "cafe\u0301"],
      [
        "a run of Han characters between spaces",
        "\u5951\u7d04\u66f8 \u7b2c\u4e00\u6761",
        "\u5951\u7d04\u66f8",
      ],
    ])("anchors a whole word of %s", (_name, text, quote) => {
      const result = anchored([clauseOf("c1", [text])], edit("c1", quote));
      expect(result.original).toBe(quote);
    });

    it.each([
      ["ends before an accented letter", "un caf\u00e9 au lait", "caf"],
      ["starts on an accented letter inside a word", "un caf\u00e9 au lait", "\u00e9 au"],
      ["ends before a letter that follows an accented one", "un na\u00efve avis", "na"],
      ["starts after an accented letter inside a word", "un na\u00efve avis", "ve avis"],
      ["ends inside a Greek word", "\u03b1\u03b2\u03b3 \u03b4\u03b5\u03b6", "\u03b1\u03b2"],
      [
        "starts inside a Greek word",
        "\u03b1\u03b2\u03b3 \u03b4\u03b5\u03b6",
        "\u03b2\u03b3 \u03b4",
      ],
      ["ends inside a Cyrillic word", "\u0434\u043e\u0433 \u0441\u0442", "\u0434\u043e"],
      ["ends before a combining accent", "cafe\u0301 au lait", "cafe"],
      ["starts on a combining accent", "cafe\u0301 au lait", "\u0301 au"],
      [
        "is part of a run of Han characters",
        "\u5951\u7d04\u66f8 \u7b2c\u4e00\u6761",
        "\u5951\u7d04",
      ],
    ])("rejects a quote that %s", (_name, text, quote) => {
      expect(rejected([clauseOf("c1", [text])], edit("c1", quote))).toMatch(WHOLE_WORDS);
    });

    it("reads letters outside the Basic Multilingual Plane as letters", () => {
      const next = [clauseOf("c1", ["a\u{1D400} b"])];
      expect(rejected(next, edit("c1", "a"))).toMatch(WHOLE_WORDS);
      const previous = [clauseOf("c1", ["\u{1D400}b c"])];
      expect(rejected(previous, edit("c1", "b"))).toMatch(WHOLE_WORDS);

      const pair = [clauseOf("c1", ["k \u{1D400}\u{1D401} z"])];
      expect(anchored(pair, edit("c1", "\u{1D400}\u{1D401}")).original).toBe("\u{1D400}\u{1D401}");
      expect(rejected(pair, edit("c1", "k \u{1D400}"))).toMatch(WHOLE_WORDS);
      expect(rejected(pair, edit("c1", "\u{1D401} z"))).toMatch(WHOLE_WORDS);
    });

    it("does not treat an emoji beside a letter as part of the word", () => {
      const clauses = [clauseOf("c1", ["a\u{1F600}b"])];
      expect(anchored(clauses, edit("c1", "a")).original).toBe("a");
      expect(anchored(clauses, edit("c1", "b")).original).toBe("b");
    });
  });

  describe("digits", () => {
    it.each([
      ["a whole number-letter run", "within 30days of", "30days"],
      ["a bracketed number before letters", "within (30)days of", "(30)"],
      ["letters after a bracketed number", "within (30)days of", "days"],
      ["a whole number", "pay 12345 now", "12345"],
      ["a whole ordinal", "the 2nd party", "2nd"],
      ["a number before a full stop", "see clause 12.", "12"],
    ])("anchors %s", (_name, text, quote) => {
      expect(anchored([clauseOf("c1", [text])], edit("c1", quote)).original).toBe(quote);
    });

    it.each([
      ["the digits of a number-letter run", "within 30days of", "30"],
      ["the letters after a number", "within 30days of", "days"],
      ["letters before digits", "see abc123 here", "abc"],
      ["digits after letters", "see abc123 here", "123"],
      ["digits inside a number", "pay 12345 now", "234"],
      ["a letter before a superscript digit", "area in m\u00b2 only", "m"],
      ["a digit inside an Arabic-Indic number", "\u0663\u0660 days", "\u0663"],
    ])("rejects %s", (_name, text, quote) => {
      expect(rejected([clauseOf("c1", [text])], edit("c1", quote))).toMatch(WHOLE_WORDS);
    });
  });

  describe("paragraph edges", () => {
    it("treats the ends of a paragraph as boundaries and does not look at its neighbours", () => {
      const clauses = [clauseOf("c1", ["abc", "def"])];
      expect(anchored(clauses, edit("c1", "abc")).paragraphId).toBe("p:0");
      expect(anchored(clauses, edit("c1", "def")).paragraphId).toBe("p:1");
    });

    it("does not join the end of one paragraph to the start of the next", () => {
      const clauses = [clauseOf("c1", ["thr", "ee years"])];
      expect(rejected(clauses, edit("c1", "three"))).toMatch(/not found/);
    });
  });

  describe("ambiguity", () => {
    it("counts only the occurrences that are whole words", () => {
      const text = "for or morning";
      expect(occurrences(text, "or")).toBe(3);
      const result = anchored([clauseOf("c1", [text])], edit("c1", "or"));
      expect([result.start, result.end]).toEqual([4, 6]);
    });

    it("counts them across the paragraphs of a clause", () => {
      const clauses = [clauseOf("c1", ["for", "or", "morning", "a worker"], 3)];
      expect(anchored(clauses, edit("c1", "or")).paragraphId).toBe("p:4");
    });

    it("is ambiguous when more than one occurrence is a whole word", () => {
      const reason = rejected([clauseOf("c1", ["or then or for"])], edit("c1", "or"));
      expect(reason).toMatch(/ambiguous/);
      expect(reason).toContain("2 times");
    });

    it("is not ambiguous when every occurrence sits inside a longer word", () => {
      const reason = rejected([clauseOf("c1", ["for morning order"])], edit("c1", "or"));
      expect(reason).toMatch(WHOLE_WORDS);
      expect(reason).not.toMatch(/ambiguous/);
    });
  });

  describe("reasons", () => {
    it("say whole words only when the text was found inside other words", () => {
      const clauses = [clauseOf("c1", ["Zanzibars apply"])];
      expect(rejected(clauses, edit("c1", "Zanzibar"))).toMatch(WHOLE_WORDS);
      expect(rejected(clauses, edit("c1", "Zanzibaz"))).not.toMatch(/whole words/);
    });

    it("never repeat the quote, the document text or the clause id", () => {
      const secret = "Zanzibar";
      const clauses = [clauseOf(secret, [`${secret}s indemnity`])];
      const reason = rejected(clauses, edit(secret, secret));
      expect(reason).toMatch(WHOLE_WORDS);
      expect(reason).not.toMatch(/zanzibar|indemnity/i);
    });
  });
});

describe("anchorEdit: replacement whitespace", () => {
  const text = "The term is perpetual and shall continue.";
  const clauses = [clauseOf("c1", [text])];

  function anchoredReplacement(quote: string, replacement: string): string {
    const result = anchorEdit(clauses, edit("c1", quote, replacement));
    if (!result.ok) throw new Error(`expected an anchor, got: ${result.reason}`);
    expect(result.original).toBe("perpetual");
    return result.replacement;
  }

  it.each([
    ["a trailing space on both", "perpetual ", "limited ", "limited"],
    ["a leading space on both", " perpetual", " limited", "limited"],
    ["a space at both ends of both", " perpetual ", " limited ", "limited"],
    [
      "a quote that lost only its end, so the replacement keeps its start",
      "perpetual ",
      " limited ",
      " limited",
    ],
    [
      "a quote that lost only its start, so the replacement keeps its end",
      " perpetual",
      " limited ",
      "limited ",
    ],
    [
      "a quote with no edge whitespace, so nothing is trimmed",
      "perpetual",
      " limited ",
      " limited ",
    ],
    [
      "a quote with a trailing space and a replacement without one",
      "perpetual ",
      "limited",
      "limited",
    ],
    [
      "a quote with a leading space and a replacement without one",
      " perpetual",
      "limited",
      "limited",
    ],
    ["a run of spaces", "perpetual   ", "limited      ", "limited"],
    [
      "whitespace of every kind",
      "\n\u00a0perpetual\t\u2009",
      "\u3000\u2003limited\r\n\u00a0",
      "limited",
    ],
    ["only the edges, leaving the inside as proposed", "perpetual ", "a  b\nc ", "a  b\nc"],
    ["a replacement that is only whitespace, which deletes the span", "perpetual ", "  ", ""],
    ["an empty replacement", "perpetual ", "", ""],
    [
      "a zero-width character at the edge of the replacement, which is not whitespace",
      "perpetual ",
      "a  b\u200b\u00a0 ",
      "a  b\u200b",
    ],
    [
      "a zero-width character after the leading whitespace of the replacement",
      " perpetual",
      " \u200blimited",
      "\u200blimited",
    ],
    [
      "a zero-width character at the edge of the quote, which is not whitespace",
      "\u200bperpetual",
      " limited",
      " limited",
    ],
    [
      "zero-width characters among the quote's edge whitespace",
      "\u200b perpetual",
      " limited",
      "limited",
    ],
  ])("with %s", (_name, quote, replacement, expected) => {
    expect(anchoredReplacement(quote, replacement)).toBe(expected);
  });

  it("leaves a single space where the quote's space stays in the document", () => {
    const result = anchorEdit(clauses, edit("c1", "perpetual ", "limited "));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = text.slice(0, result.start) + result.replacement + text.slice(result.end);
    expect(after).toBe("The term is limited and shall continue.");
  });

  it("does not trim a replacement for whitespace that only the replacement has", () => {
    const result = anchored(clauses, edit("c1", "perpetual", "  limited  "), "  limited  ");
    expect(result.replacement).toBe("  limited  ");
  });

  it("still compares the trimmed forms when deciding that nothing changes", () => {
    expect(rejected(clauses, edit("c1", "perpetual ", " perpetual"))).toMatch(/identical/);
    expect(rejected(clauses, edit("c1", " perpetual", "perpetual "))).toMatch(/identical/);
    expect(rejected(clauses, edit("c1", "perpetual", " perpetual   "))).toMatch(/identical/);
    expect(rejected(clauses, edit("c1", "perpetual   ", "perpetual"))).toMatch(/identical/);
  });
});

describe("normalizeForAnchor", () => {
  it("applies the fixed table", () => {
    const cases: [string, string][] = [
      ["a \t\n\v\f\r\u0085\u00a0\u1680\u2000\u2009\u200a\u2028\u2029\u202f\u205f\u3000b", "a b"],
      ["\u2018\u2019\u201a\u201b\u2039\u203a\u02bc\uff07", "''''''''"],
      ["\u201c\u201d\u201e\u201f\u00ab\u00bb\uff02", '"""""""'],
      ["\u2010\u2011\u2012\u2013\u2014\u2015\u2212", "-------"],
      ["a\u200bb\u200cc\u200dd\u2060e\ufefff\u00adg", "abcdefg"],
      ["Mixed CASE stays", "Mixed CASE stays"],
      ["`backtick` \u00b4acute\u00b4", "`backtick` \u00b4acute\u00b4"],
      ["a \u200b b", "a b"],
      ["", ""],
      ["  x  ", " x "],
    ];
    for (const [input, expected] of cases) expect(normalizeForAnchor(input)).toBe(expected);
  });

  it("is idempotent", () => {
    const text = "\u201cA\u00a0  b\u2014c\u201d \u200b d";
    expect(normalizeForAnchor(normalizeForAnchor(text))).toBe(normalizeForAnchor(text));
  });

  it("handles text longer than its internal chunk size", () => {
    const text = "ab \u2019 ".repeat(20_000);
    expect(normalizeForAnchor(text)).toBe(oracle(text));
  });
});

// A seeded generator so a failure can be replayed.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("anchorEdit: properties over random clauses", () => {
  // A small vocabulary on purpose, so substrings repeat and both outcomes are common. Words that
  // contain one another ("the", "then", "other", "or", "for") make hits inside longer words common
  // too, and a few carry characters that normalization deletes.
  const WORDS = [
    "the",
    "then",
    "other",
    "Recipient\u2019s",
    "Recipient's",
    "shall",
    "\u201cConfidential",
    "Information\u201d",
    "non\u2013disclosure",
    "non-disclosure",
    "party",
    "agree",
    "term",
    "years",
    "year",
    "of",
    "or",
    "for",
    "order",
    "a",
    "and",
    "(30)",
    "30days",
    "days",
    "x2y",
    "obligations",
    "\u2018Purpose\u2019",
    "\u2014",
    "caf\u00e9",
    "\u03b1\u03b2\u03b3",
    "\u03b2\u03b3",
    "per\u200bpetual",
    "co\u00adoperate",
  ];
  const GAPS = [" ", " ", " ", "  ", "\u00a0", " \u00a0", "\t", "\u2009"];
  const CASES = 4000;
  // Characters a span never starts or ends on: whitespace and the ones normalization deletes.
  const NOT_SOLID = /[\s\u200b-\u200d\u2060\ufeff\u00ad]/;

  it("anchors whole-word spans exactly, never anchors one that cuts a word, and counts whole words only", () => {
    const rand = mulberry32(0xc1a05e);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
    const between = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));

    const tally = { exact: 0, ambiguous: 0, rejectedInWord: 0, movedElsewhere: 0 };
    const started = performance.now();

    for (let n = 0; n < CASES; n++) {
      const wordSpans: [number, number][][] = [];
      const texts = Array.from({ length: between(1, 3) }, () => {
        let text = "";
        const spans: [number, number][] = [];
        for (let w = between(3, 14); w > 0; w--) {
          const word = pick(WORDS);
          spans.push([text.length, text.length + word.length]);
          text += word + (w > 1 ? pick(GAPS) : "");
        }
        wordSpans.push(spans);
        return text;
      });
      const clause = clauseOf("c1", texts, 5);

      const target = between(0, texts.length - 1);
      const text = texts[target]!;
      const spans = wordSpans[target]!;
      // Half the picks run from the start of one word to the end of another, and half from any
      // character to any later one, which usually cuts a word. Words are made of BMP characters
      // only, so code points and UTF-16 units agree here.
      const byWords = rand() < 0.5;
      let first: number;
      let last: number;
      if (byWords) {
        const from = between(0, spans.length - 1);
        first = spans[from]![0];
        last = spans[between(from, spans.length - 1)]![1] - 1;
      } else {
        const solid = [...text].flatMap((ch, i) => (NOT_SOLID.test(ch) ? [] : [i]));
        first = solid[between(0, solid.length - 1)]!;
        const tail = solid.filter((i) => i >= first);
        last = tail[between(0, tail.length - 1)]!;
      }
      const picked = text.slice(first, last + 1);
      const cut = between(0, picked.length);

      const variants = [
        picked,
        oracleQuote(picked),
        ` ${picked}\u00a0`,
        `${picked.slice(0, cut)}\u200b${picked.slice(cut)}`,
      ];
      const quote = pick(variants);
      const wanted = oracleQuote(picked);
      expect(oracleQuote(quote)).toBe(wanted);

      const raw = texts.reduce((sum, t) => sum + occurrences(oracle(t), wanted), 0);
      const total = texts.reduce((sum, t) => sum + wholeWordOccurrences(oracle(t), wanted), 0);
      const pickedCuts = cutsWordAt(text, first, last + 1);
      expect(raw).toBeGreaterThanOrEqual(1);
      expect(total).toBeLessThanOrEqual(raw);
      if (!pickedCuts) expect(total).toBeGreaterThanOrEqual(1);
      if (byWords) expect(pickedCuts).toBe(false);

      const result = anchorEdit([clause], edit("c1", quote));
      if (total === 0) {
        tally.rejectedInWord++;
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toMatch(/whole words/);
      } else if (total === 1) {
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        const where = Number(result.paragraphId.slice(2)) - 5;
        const anchoredText = texts[where]!;
        expect(anchoredText.slice(result.start, result.end)).toBe(result.original);
        expect(oracle(result.original)).toBe(wanted);
        expect(cutsWordAt(anchoredText, result.start, result.end)).toBe(false);
        if (pickedCuts) {
          tally.movedElsewhere++;
          expect([where, result.start, result.end]).not.toEqual([target, first, last + 1]);
        } else {
          tally.exact++;
          expect(result).toEqual({
            ok: true,
            paragraphId: `p:${5 + target}`,
            start: first,
            end: last + 1,
            original: picked,
            replacement: REPLACEMENT,
          });
        }
      } else {
        tally.ambiguous++;
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toMatch(/ambiguous/);
          expect(result.reason).toContain(`${total} times`);
        }
      }
    }

    expect(performance.now() - started).toBeLessThan(3000);
    expect(tally.exact).toBeGreaterThan(1000);
    expect(tally.ambiguous).toBeGreaterThan(200);
    expect(tally.rejectedInWord).toBeGreaterThan(1000);
    expect(tally.movedElsewhere).toBeGreaterThan(5);
  });

  it("agrees with the oracle for quotes cut anywhere, including inside a gap", () => {
    const rand = mulberry32(42);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
    for (let n = 0; n < 1500; n++) {
      let text = "";
      for (let w = 1 + Math.floor(rand() * 12); w > 0; w--) text += pick(WORDS) + pick(GAPS);
      const from = Math.floor(rand() * text.length);
      const quote = text.slice(from, from + 1 + Math.floor(rand() * 30));
      const wanted = oracleQuote(quote);
      const result = anchorEdit([clauseOf("c1", [text])], edit("c1", quote));
      if (wanted === "") {
        expect(result.ok).toBe(false);
        continue;
      }
      expect(occurrences(oracle(text), wanted)).toBeGreaterThanOrEqual(1);
      const total = wholeWordOccurrences(oracle(text), wanted);
      if (total !== 1) {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toMatch(total === 0 ? /whole words/ : /ambiguous/);
        continue;
      }
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(text.slice(result.start, result.end)).toBe(result.original);
        expect(oracle(result.original)).toBe(wanted);
        expect(result.original).toBe(result.original.trim());
        expect(cutsWordAt(text, result.start, result.end)).toBe(false);
      }
    }
  });

  it("agrees with the oracle for every substring of a text with hyphens, apostrophes and digits", () => {
    const text =
      "Recipient's non-disclosure duty: three (3) years, 30days or 2nd-tier co-operate cooperate caf\u00e9 \u03b1\u03b2\u03b3 The Recipient's duty: three years.";
    const clauses = [clauseOf("c1", [text])];
    // Single spaces and no deleted characters, so offsets in the normalized text are offsets in
    // the document.
    const flat = oracle(text);
    expect(flat).toBe(text);

    let anchoredCount = 0;
    let inWordCount = 0;
    let ambiguousCount = 0;
    for (let i = 0; i < text.length; i++) {
      for (let j = i + 1; j <= text.length; j++) {
        const quote = text.slice(i, j);
        const wanted = oracleQuote(quote);
        if (wanted === "") continue;
        const places = wholeWordPositions(flat, wanted);
        const result = anchorEdit(clauses, edit("c1", quote));
        if (places.length === 0) {
          inWordCount++;
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.reason).toMatch(/whole words/);
        } else if (places.length === 1) {
          anchoredCount++;
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect([result.start, result.end]).toEqual([places[0], places[0]! + wanted.length]);
            expect(cutsWordAt(text, result.start, result.end)).toBe(false);
          }
        } else {
          ambiguousCount++;
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.reason).toContain(`${places.length} times`);
        }
      }
    }
    expect(inWordCount).toBeGreaterThan(1000);
    expect(anchoredCount).toBeGreaterThan(500);
    expect(ambiguousCount).toBeGreaterThan(50);
  });
});

describe("anchorEdit: performance", () => {
  it("handles a very long paragraph without slowing down", () => {
    const sentence = "Recipient\u2019s  obligations shall\u00a0continue for the Term. ";
    const text = sentence.repeat(20_000) + "The unique closing words end here.";
    const started = performance.now();
    const result = anchored([clauseOf("c1", [text])], edit("c1", "unique closing words"));
    expect(result.end - result.start).toBe("unique closing words".length);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("copes with repetitive text and a long quote", () => {
    const text = "a ".repeat(10_000);
    const quote = "a ".repeat(2_500);
    const started = performance.now();
    expect(rejected([clauseOf("c1", [text])], edit("c1", quote))).toMatch(/ambiguous/);
    expect(rejected([clauseOf("c1", [text])], edit("c1", `${quote}b`))).toMatch(/not found/);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("copes with thousands of hits that all cut a word", () => {
    const text = "a".repeat(20_000);
    const started = performance.now();
    const reason = rejected([clauseOf("c1", [text])], edit("c1", "a".repeat(5_000)));
    expect(reason).toMatch(/not found as whole words/);
    expect(rejected([clauseOf("c1", [text])], edit("c1", "a"))).toMatch(/whole words/);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("serves many rules over a document of thousands of paragraphs", () => {
    const clauses = Array.from({ length: 5_000 }, (_, i) =>
      clauseOf(`c${i + 1}`, [`${i}.1 Clause number ${i} says something specific, token${i}x.`], i),
    );
    const started = performance.now();
    for (let rule = 0; rule < 500; rule++) {
      const i = rule * 9;
      const result = anchored(clauses, edit(`c${i + 1}`, `token${i}x`));
      expect(result.paragraphId).toBe(`p:${i}`);
    }
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

async function loadFixture(
  name: string,
): Promise<{ buf: Uint8Array; paragraphs: DocxParagraph[] }> {
  const buf = new Uint8Array(await readFile(join(fixtures, `${name}.docx`)));
  return { buf, paragraphs: (await parseDocx(buf)).paragraphs };
}

/** One clause per paragraph, which is enough to exercise the anchor against real documents. */
function clausesOfParagraphs(paragraphs: DocxParagraph[]): Clause[] {
  return paragraphs.map((p, i) => ({
    id: `c${i + 1}`,
    number: undefined,
    heading: undefined,
    paragraphs: [{ id: p.id, text: p.text }],
    text: p.text,
  }));
}

describe("anchorEdit with the docx engine", () => {
  const date = new Date("2026-03-01T12:00:00Z");

  async function redline(
    name: string,
    quote: string,
    replacement: string,
    expectedReplacement = replacement,
  ) {
    const { buf, paragraphs } = await loadFixture(name);
    const clauses = clausesOfParagraphs(paragraphs);
    const clause = clauses.find((c) => c.text.startsWith("3.1 "));
    expect(clause).toBeDefined();
    const anchor = anchored(
      clauses,
      edit(clause?.id ?? "", quote, replacement),
      expectedReplacement,
    );
    const original = paragraphs.find((p) => p.id === anchor.paragraphId)?.text ?? "";
    const result = await applyRedline(
      buf,
      {
        edits: [
          {
            paragraphId: anchor.paragraphId,
            start: anchor.start,
            end: anchor.end,
            replacement: anchor.replacement,
          },
        ],
      },
      { date },
    );
    const after = (await parseDocx(result.buffer)).paragraphs;
    return { anchor, original, paragraphs, result, after };
  }

  it("writes the anchored edit into the 3.1 paragraph of the aggressive NDA", async () => {
    const replacement = "limited to three (3) years from the Effective Date";
    const { anchor, original, paragraphs, result, after } = await redline(
      "nda-aggressive",
      "perpetual and shall continue indefinitely",
      replacement,
    );

    expect(anchor.original).toBe("perpetual and shall continue indefinitely");
    expect(result.edits).toEqual([{ applied: true }]);
    expect(after).toHaveLength(paragraphs.length);
    for (const [i, p] of after.entries()) {
      const expected =
        p.id === anchor.paragraphId
          ? original.slice(0, anchor.start) + replacement + original.slice(anchor.end)
          : paragraphs[i]?.text;
      expect(p.text).toBe(expected);
    }
    expect(after.find((p) => p.id === anchor.paragraphId)?.text).toBe(
      "3.1 Recipient's obligations under this Agreement are limited to three (3) years from the Effective Date, whether or not the parties proceed with any transaction.",
    );
  });

  it("lands on the right span when the model quotes a curly apostrophe against an ASCII one", async () => {
    const replacement =
      "Recipient's obligations under this Agreement end three (3) years after disclosure";
    const { anchor, original, paragraphs, result, after } = await redline(
      "nda-aggressive",
      "Recipient\u2019s obligations under this Agreement are perpetual and shall continue indefinitely",
      replacement,
    );

    expect(original).toContain("Recipient's");
    expect(original).not.toContain("\u2019");
    expect(anchor.start).toBe(original.indexOf("Recipient's"));
    expect(anchor.original).toBe(
      "Recipient's obligations under this Agreement are perpetual and shall continue indefinitely",
    );
    expect(result.edits).toEqual([{ applied: true }]);

    const text = after.find((p) => p.id === anchor.paragraphId)?.text ?? "";
    expect(text).toBe(
      "3.1 " + replacement + ", whether or not the parties proceed with any transaction.",
    );
    expect(after.filter((p) => p.id !== anchor.paragraphId).map((p) => p.text)).toEqual(
      paragraphs.filter((p) => p.id !== anchor.paragraphId).map((p) => p.text),
    );
  });

  it("keeps a curly replacement exactly as the model wrote it", async () => {
    const replacement = "limited to the \u201cTerm\u201d";
    const { anchor, original, after } = await redline(
      "nda-aggressive",
      "perpetual and shall continue indefinitely",
      replacement,
    );
    expect(after.find((p) => p.id === anchor.paragraphId)?.text).toBe(
      original.slice(0, anchor.start) + replacement + original.slice(anchor.end),
    );
  });

  it("refuses to anchor a near-miss quote against the same document", async () => {
    const { paragraphs } = await loadFixture("nda-aggressive");
    const clauses = clausesOfParagraphs(paragraphs);
    const clause = clauses.find((c) => c.text.startsWith("3.1 "));
    const reason = rejected(
      clauses,
      edit(clause?.id ?? "", "perpetual and shall continue indefinitly", "limited"),
    );
    expect(reason).toMatch(/not found/);
  });

  it("refuses a quote that starts or ends inside a word of the real document", async () => {
    const { paragraphs } = await loadFixture("nda-aggressive");
    const clauses = clausesOfParagraphs(paragraphs);
    const clause = clauses.find((c) => c.text.startsWith("3.1 "));
    for (const quote of ["etual and shall", "perpetual and sha", "ntinue indefinit"]) {
      const reason = rejected(clauses, edit(clause?.id ?? "", quote, "limited"));
      expect(reason).toMatch(/whole words/);
    }
  });

  it.each([
    ["a trailing space", "perpetual ", "limited "],
    ["a leading space", " perpetual", " limited"],
    ["a space at both ends", " perpetual ", " limited "],
  ])(
    "writes no doubled space when the model quotes %s and keeps it",
    async (_name, quote, proposed) => {
      const { anchor, after } = await redline("nda-aggressive", quote, proposed, "limited");
      expect(anchor.original).toBe("perpetual");
      expect(after.find((p) => p.id === anchor.paragraphId)?.text).toBe(
        "3.1 Recipient's obligations under this Agreement are limited and shall continue indefinitely, whether or not the parties proceed with any transaction.",
      );
    },
  );

  it.each(["nda-aggressive", "nda-balanced", "saas-vendor-friendly"])(
    "anchors a run of whole words from every paragraph of %s and the engine accepts all of them",
    async (name) => {
      const { buf, paragraphs } = await loadFixture(name);
      const clauses = clausesOfParagraphs(paragraphs);
      const edits: { paragraphId: string; start: number; end: number; replacement: string }[] = [];
      for (const clause of clauses) {
        // Whole words, curled and spaced differently from the document, as a model might copy them.
        const text = clause.text;
        const words = [...text.matchAll(/\S+/g)];
        const from = words[1];
        const to = words[3];
        if (!from || !to) continue;
        const slice = text
          .slice(from.index, to.index + to[0].length)
          .replace(/'/g, "\u2019")
          .replace(/ /g, "  ");
        const wanted = oracleQuote(slice);
        const total = wholeWordOccurrences(oracle(text), wanted);
        const result = anchorEdit(clauses, edit(clause.id, slice));
        if (total > 1) {
          expect(result.ok).toBe(false);
          continue;
        }
        const anchor = anchored(clauses, edit(clause.id, slice));
        edits.push({
          paragraphId: anchor.paragraphId,
          start: anchor.start,
          end: anchor.end,
          replacement: anchor.replacement,
        });
      }
      expect(edits.length).toBeGreaterThan(5);

      const result = await applyRedline(buf, { edits }, { date });
      expect(result.edits.every((o) => o.applied)).toBe(true);
      const after = (await parseDocx(result.buffer)).paragraphs;
      const byId = new Map(edits.map((e) => [e.paragraphId, e]));
      for (const [i, p] of after.entries()) {
        const before = paragraphs[i]?.text ?? "";
        const e = byId.get(p.id);
        expect(p.text).toBe(
          e ? before.slice(0, e.start) + e.replacement + before.slice(e.end) : before,
        );
      }
    },
  );
});
