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

// Written separately from the implementation, with regular expressions where it uses a loop, so
// a mistake in one is unlikely to be repeated in the other.
function oracle(text: string): string {
  return text
    .replace(/[\u200b\u200c\u200d\u2060\ufeff\u00ad]/g, "")
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\s+/g, " ");
}

const oracleQuote = (quote: string): string => oracle(quote).trim();

/** Overlapping occurrences, counted the slow and obvious way. */
function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) count++;
  return count;
}

function allParagraphs(clauses: Clause[]) {
  return clauses.flatMap((c) => c.paragraphs);
}

type Anchored = Extract<AnchorResult, { ok: true }>;

/** Anchors an edit that must succeed and checks the invariants every success has to satisfy. */
function anchored(clauses: Clause[], proposed: ProposedEdit): Anchored {
  const result = anchorEdit(clauses, proposed);
  if (!result.ok) throw new Error(`expected an anchor, got: ${result.reason}`);
  const paragraph = allParagraphs(clauses).find((p) => p.id === result.paragraphId);
  expect(paragraph).toBeDefined();
  const text = paragraph?.text ?? "";
  expect(text.slice(result.start, result.end)).toBe(result.original);
  expect(oracle(result.original)).toBe(oracleQuote(proposed.quote));
  expect(result.replacement).toBe(proposed.replacement);
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
    ["a single character", "xyz", "y", "y"],
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
    expect(anchored(clauses, edit("c1", "foo")).original).toBe("foo");
    expect(anchored(clauses, edit("c1", "bar")).original).toBe("bar");
    expect(anchored(clauses, edit("c1", "foobar")).original).toBe("foo\u200bbar");
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

  it("matches inside a longer word, because matching is by substring and not by word", () => {
    const result = anchored([clauseOf("c1", ["three years"])], edit("c1", "ree y"));
    expect(result.original).toBe("ree y");
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
    const reason = rejected([clauseOf("c1", ["aaa"])], edit("c1", "aa"));
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
  // A small vocabulary on purpose, so substrings repeat and both outcomes are common.
  const WORDS = [
    "the",
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
    "of",
    "a",
    "and",
    "(30)",
    "days",
    "obligations",
    "\u2018Purpose\u2019",
    "\u2014",
  ];
  const GAPS = [" ", " ", " ", "  ", "\u00a0", " \u00a0", "\t", "\u2009"];
  const CASES = 3000;

  it("anchors the exact substring when it occurs once and reports ambiguity otherwise", () => {
    const rand = mulberry32(0xc1a05e);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
    const between = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));

    let unique = 0;
    let ambiguous = 0;
    const started = performance.now();

    for (let n = 0; n < CASES; n++) {
      const texts = Array.from({ length: between(1, 3) }, () => {
        let text = "";
        for (let w = between(3, 14); w > 0; w--) text += pick(WORDS) + (w > 1 ? pick(GAPS) : "");
        return text;
      });
      const clause = clauseOf("c1", texts, 5);

      const target = between(0, texts.length - 1);
      const text = texts[target]!;
      // Words are made of BMP characters only, so code points and UTF-16 units agree here.
      const solid = [...text].flatMap((ch, i) => (/\s/.test(ch) ? [] : [i]));
      const first = solid[between(0, solid.length - 1)]!;
      const tail = solid.filter((i) => i >= first);
      const last = tail[between(0, tail.length - 1)]!;
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

      const total = texts.reduce((sum, t) => sum + occurrences(oracle(t), wanted), 0);
      expect(total).toBeGreaterThanOrEqual(1);

      const result = anchorEdit([clause], edit("c1", quote));
      if (total === 1) {
        unique++;
        expect(result).toEqual({
          ok: true,
          paragraphId: `p:${5 + target}`,
          start: first,
          end: last + 1,
          original: picked,
          replacement: REPLACEMENT,
        });
      } else {
        ambiguous++;
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toMatch(/ambiguous/);
          expect(result.reason).toContain(`${total} times`);
        }
      }
    }

    expect(performance.now() - started).toBeLessThan(2000);
    expect(unique).toBeGreaterThan(300);
    expect(ambiguous).toBeGreaterThan(300);
  });

  it("agrees with the oracle for quotes cut anywhere, including inside a gap", () => {
    const rand = mulberry32(42);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
    for (let n = 0; n < 1000; n++) {
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
      const total = occurrences(oracle(text), wanted);
      expect(total).toBeGreaterThanOrEqual(1);
      if (total > 1) {
        expect(result.ok).toBe(false);
        continue;
      }
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(text.slice(result.start, result.end)).toBe(result.original);
        expect(oracle(result.original)).toBe(wanted);
        expect(result.original).toBe(result.original.trim());
      }
    }
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
    const text = "a".repeat(20_000);
    const started = performance.now();
    expect(rejected([clauseOf("c1", [text])], edit("c1", "a".repeat(5_000)))).toMatch(/ambiguous/);
    expect(rejected([clauseOf("c1", [text])], edit("c1", `${"a".repeat(5_000)}b`))).toMatch(
      /not found/,
    );
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

  async function redline(name: string, quote: string, replacement: string) {
    const { buf, paragraphs } = await loadFixture(name);
    const clauses = clausesOfParagraphs(paragraphs);
    const clause = clauses.find((c) => c.text.startsWith("3.1 "));
    expect(clause).toBeDefined();
    const anchor = anchored(clauses, edit(clause?.id ?? "", quote, replacement));
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

  it.each(["nda-aggressive", "nda-balanced", "saas-vendor-friendly"])(
    "anchors a slice of every paragraph of %s and the engine accepts all of them",
    async (name) => {
      const { buf, paragraphs } = await loadFixture(name);
      const clauses = clausesOfParagraphs(paragraphs);
      const edits: { paragraphId: string; start: number; end: number; replacement: string }[] = [];
      for (const clause of clauses) {
        // Curled and spaced differently from the document, as a model might copy it.
        const text = clause.text;
        if (text.length < 24) continue;
        const slice = text.slice(5, 24).replace(/'/g, "\u2019").replace(/ /g, "  ");
        const wanted = oracleQuote(slice);
        const total = occurrences(oracle(text), wanted);
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
