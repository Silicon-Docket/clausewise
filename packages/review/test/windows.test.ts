import type { Rule } from "@clausewise/playbook";
import { describe, expect, it } from "vitest";
import { estimateTokens, mergeWindowChecks, windowClauses } from "../src/windows.js";
import type { Clause, RuleCheck } from "../src/types.js";

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clause(id: string, text: string): Clause {
  return {
    id,
    number: undefined,
    heading: undefined,
    paragraphs: [{ id: `p:${id}`, text }],
    text,
  };
}

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: "term",
    title: "Duration of confidentiality obligations",
    severity: "high",
    required: true,
    standard: "Obligations end no more than three years after disclosure.",
    fallback: "Up to five years from the end of the agreement.",
    unacceptable: "Obligations that last forever.",
    guidance: "Replace perpetual wording with a fixed number of years.",
    ...overrides,
  };
}

function check(overrides: Partial<RuleCheck> = {}): RuleCheck {
  return {
    status: "not_applicable",
    clauseIds: [],
    explanation: "",
    comment: "",
    edit: null,
    suggestedClause: null,
    ...overrides,
  };
}

const edit = (clauseId: string, quote = "old", replacement = "new") => ({
  clauseId,
  quote,
  replacement,
});

const codePoints = (text: string): number => [...text].length;

// ---------------------------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("keeps one token per three characters for Latin text, accents included", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(2);
    expect(estimateTokens("x".repeat(300))).toBe(100);
    expect(estimateTokens("x".repeat(301))).toBe(101);
    expect(estimateTokens("\u00e9\u00fc\u00f1".repeat(100))).toBe(100);
    expect(estimateTokens("Gesch\u00e4ftsgeheimnisse und \u00c4nderungen")).toBe(
      Math.ceil("Gesch\u00e4ftsgeheimnisse und \u00c4nderungen".length / 3),
    );
  });

  it("puts the line between the Latin blocks and everything after them at U+0250", () => {
    expect(estimateTokens("\u024f".repeat(3))).toBe(1);
    expect(estimateTokens("\u0250".repeat(3))).toBe(3);
    // Romanian and Czech letters live in the Latin extended blocks below the line.
    expect(estimateTokens("\u0219\u021b\u010d")).toBe(1);
  });

  it.each([
    ["Chinese", "\u4fdd\u5bc6\u4fe1\u606f\u7684\u62ab\u9732\u65b9"],
    ["Japanese", "\u79d8\u5bc6\u4fdd\u6301\u5951\u7d04\u66f8"],
    ["Korean", "\ube44\ubc00\uc720\uc9c0\uacc4\uc57d"],
    [
      "Cyrillic",
      "\u041a\u043e\u043d\u0444\u0438\u0434\u0435\u043d\u0446\u0438\u0430\u043b\u044c\u043d\u043e\u0441\u0442\u044c",
    ],
    [
      "Greek",
      "\u03b5\u03bc\u03c0\u03b9\u03c3\u03c4\u03b5\u03c5\u03c4\u03b9\u03ba\u03cc\u03c4\u03b7\u03c4\u03b1",
    ],
    [
      "Arabic",
      "\u0627\u0644\u0633\u0631\u064a\u0629\u0627\u0644\u062a\u062c\u0627\u0631\u064a\u0629",
    ],
    ["Hebrew", "\u05e1\u05d5\u05d3\u05d9\u05d5\u05ea\u05e2\u05e1\u05e7\u05d9\u05ea"],
    [
      "Devanagari",
      "\u0917\u094b\u092a\u0928\u0940\u092f\u0924\u093e\u0905\u0928\u0941\u092c\u0902\u0927",
    ],
    ["Thai", "\u0e04\u0e27\u0e32\u0e21\u0e25\u0e31\u0e1a\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25"],
  ])("counts every character of %s text as a token", (_script, sample) => {
    expect(estimateTokens(sample)).toBe(codePoints(sample));
    expect(estimateTokens(sample.repeat(50))).toBe(codePoints(sample) * 50);
  });

  it("counts an emoji once, not once per UTF-16 unit, and each part of a sequence", () => {
    const smile = "\ud83d\ude00";
    expect(smile).toHaveLength(2);
    expect(estimateTokens(smile)).toBe(1);
    expect(estimateTokens(smile.repeat(50))).toBe(50);
    // A family emoji is three people joined by two zero width joiners: five code points.
    const family = "\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67";
    expect(estimateTokens(family)).toBe(5);
    // A flag is two regional indicators.
    expect(estimateTokens("\ud83c\uddea\ud83c\uddfa")).toBe(2);
  });

  it("adds the parts of mixed text: whole tokens for the wide, a third for the rest", () => {
    // Nine narrow characters round up to three tokens and the three wide ones add three.
    expect(estimateTokens("Term \u5951\u7d04\u66f8 end")).toBe(3 + 3);
    // Narrow characters are pooled before they round up, so a lone letter between two wide
    // characters does not cost a whole token of its own.
    expect(estimateTokens("\u5951a\u7d04b\u66f8c")).toBe(3 + 1);
    expect(estimateTokens("\u5951 ".repeat(30))).toBe(30 + 10);
  });

  it("counts a surrogate without its partner as one wide character", () => {
    expect(estimateTokens("\ud83d")).toBe(1);
    expect(estimateTokens("\ude00")).toBe(1);
    expect(estimateTokens("\ud83dx")).toBe(1 + 1);
    expect(estimateTokens("\ude00\ud83d")).toBe(2);
    expect(estimateTokens("\ud83d\ud83d\ude00")).toBe(2);
  });

  it("never estimates fewer tokens than one per wide character, or a quarter per Latin one", () => {
    const random = seeded(7);
    const alphabet = [
      "a",
      " ",
      "7",
      ".",
      "\u00e9",
      "\u4e2d",
      "\u0416",
      "\u03a9",
      "\u05d0",
      "\u0627",
      "\u0e01",
      "\ud83d\ude00",
      "\u200d",
      "\ud83d",
    ];
    for (let round = 0; round < 300; round++) {
      const text = Array.from(
        { length: Math.floor(random() * 80) },
        () => alphabet[Math.floor(random() * alphabet.length)] ?? "",
      ).join("");
      const wide = [...text].filter((c) => (c.codePointAt(0) ?? 0) >= 0x250).length;
      const narrow = codePoints(text) - wide;
      const estimate = estimateTokens(text);
      expect(estimate).toBeGreaterThanOrEqual(wide + Math.ceil(narrow / 4));
      expect(estimate).toBe(wide + Math.ceil(narrow / 3));
    }
  });

  it("does not shrink when text is added", () => {
    const random = seeded(11);
    const pieces = ["a", "\u4e2d", "\ud83d\ude00", " ", "\u0416", "\ud83d"];
    let text = "";
    let previous = 0;
    for (let i = 0; i < 400; i++) {
      text += pieces[Math.floor(random() * pieces.length)] ?? "";
      const tokens = estimateTokens(text);
      expect(tokens).toBeGreaterThanOrEqual(previous);
      previous = tokens;
    }
  });

  it("is fast for a million characters", () => {
    const text = "Recipient shall \u5951\u7d04 \ud83d\ude00 ".repeat(50_000);
    const started = performance.now();
    estimateTokens(text);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------------------------
// windowClauses with text that is not Latin
// ---------------------------------------------------------------------------------------------

describe("windowClauses with text in other scripts", () => {
  // A hundred clauses, each as long in characters as the other language's.
  const latin = Array.from({ length: 100 }, (_, i) => clause(`c${i + 1}`, "x".repeat(90)));
  const japanese = Array.from({ length: 100 }, (_, i) => clause(`c${i + 1}`, "\u5951".repeat(90)));
  const args = { maxTokens: 2000, reservedTokens: 500, overlap: 0 };

  it("needs more windows for the same number of characters", () => {
    const latinWindows = windowClauses(latin, args);
    const japaneseWindows = windowClauses(japanese, args);
    expect(japaneseWindows.length).toBeGreaterThan(latinWindows.length * 2);
  });

  it("keeps the text of a window within the budget even at one real token per character", () => {
    const budget = args.maxTokens - args.reservedTokens;
    for (const window of windowClauses(japanese, args)) {
      if (window.length === 1) continue;
      expect(window.reduce((total, c) => total + codePoints(c.text), 0)).toBeLessThanOrEqual(
        budget,
      );
    }
  });
});

// ---------------------------------------------------------------------------------------------
// mergeWindowChecks
// ---------------------------------------------------------------------------------------------

describe("mergeWindowChecks takes the wording and the edit from one check", () => {
  const required = rule({ required: true });
  const optional = rule({ required: false });

  it("does not put a later window's edit under an earlier window's comment", () => {
    // Window 1 decided that no single edit does the job. Window 3, which cannot see clause 2.1,
    // proposes one for its own clause.
    const early = check({
      status: "deviation",
      clauseIds: ["c2"],
      explanation: "Clause 2.1 sets a perpetual term and 9.1 does too, both must change.",
      comment: "Change both 2.1 and 9.1 together.",
      edit: null,
    });
    const late = check({
      status: "deviation",
      clauseIds: ["c9"],
      explanation: "Clause 9.1 is perpetual.",
      comment: "Make 9.1 a fixed term.",
      edit: edit("c9", "perpetual 9", "fixed 9"),
    });
    const merged = mergeWindowChecks(required, [early, check({ status: "missing" }), late]);
    expect(merged.status).toBe("deviation");
    expect({ explanation: merged.explanation, comment: merged.comment, edit: merged.edit }).toEqual(
      { explanation: late.explanation, comment: late.comment, edit: late.edit },
    );
    // The report still names both clauses, in window order.
    expect(merged.clauseIds).toEqual(["c2", "c9"]);
  });

  it("takes the first deviation that has an edit, then its wording", () => {
    const merged = mergeWindowChecks(required, [
      check({ status: "deviation", explanation: "a", comment: "A", clauseIds: ["c1"] }),
      check({
        status: "deviation",
        explanation: "b",
        comment: "B",
        clauseIds: ["c4"],
        edit: edit("c4", "b1", "b2"),
      }),
      check({
        status: "deviation",
        explanation: "c",
        comment: "C",
        clauseIds: ["c8"],
        edit: edit("c8", "c1", "c2"),
      }),
    ]);
    expect(merged).toMatchObject({
      explanation: "b",
      comment: "B",
      edit: edit("c4", "b1", "b2"),
      clauseIds: ["c1", "c4", "c8"],
    });
  });

  it("takes the first deviation, and no edit, when none proposes one", () => {
    const merged = mergeWindowChecks(required, [
      check({ status: "compliant", explanation: "ok", clauseIds: ["c1"] }),
      check({ status: "deviation", explanation: "first", comment: "A", clauseIds: ["c2"] }),
      check({ status: "deviation", explanation: "second", comment: "B", clauseIds: ["c3"] }),
    ]);
    expect(merged).toMatchObject({ explanation: "first", comment: "A", edit: null });
  });

  it("keeps an empty comment that goes with the edit", () => {
    const merged = mergeWindowChecks(required, [
      check({ status: "deviation", explanation: "x", comment: "from the first" }),
      check({ status: "deviation", explanation: "y", comment: "", edit: edit("c2") }),
    ]);
    expect(merged).toMatchObject({ explanation: "y", comment: "", edit: edit("c2") });
  });

  it("does not use an edit from a check that is not a deviation", () => {
    const merged = mergeWindowChecks(required, [
      check({ status: "deviation", explanation: "dev", edit: null }),
      check({ status: "compliant", explanation: "fine", edit: edit("c3") }),
    ]);
    expect(merged).toMatchObject({ explanation: "dev", edit: null });
  });

  it("takes a missing clause's suggested wording and its explanation from the same check", () => {
    const merged = mergeWindowChecks(required, [
      check({ status: "missing", explanation: "no wording here", comment: "A", clauseIds: [] }),
      check({
        status: "missing",
        explanation: "with wording",
        comment: "B",
        suggestedClause: "The clause to add.",
      }),
      check({
        status: "missing",
        explanation: "with other wording",
        comment: "C",
        suggestedClause: "Another clause.",
      }),
    ]);
    expect(merged).toMatchObject({
      status: "missing",
      explanation: "with wording",
      comment: "B",
      suggestedClause: "The clause to add.",
      clauseIds: [],
    });
  });

  it("does not lend a not_applicable window's wording to a missing clause", () => {
    const merged = mergeWindowChecks(required, [
      check({ status: "missing", explanation: "gap", comment: "Add one." }),
      check({ status: "not_applicable", explanation: "n/a", suggestedClause: "Stray wording." }),
    ]);
    expect(merged).toMatchObject({
      status: "missing",
      explanation: "gap",
      comment: "Add one.",
      suggestedClause: null,
    });
  });

  it("still gives wording when every window said not_applicable for a required rule", () => {
    const merged = mergeWindowChecks(required, [
      check({ status: "not_applicable", explanation: "a" }),
      check({ status: "not_applicable", explanation: "b", suggestedClause: "Wording." }),
    ]);
    expect(merged).toMatchObject({
      status: "missing",
      explanation: "b",
      suggestedClause: "Wording.",
    });
  });

  it("never mixes the wording of different checks, whatever the windows said", () => {
    const random = seeded(2024);
    const statuses = ["deviation", "compliant", "missing", "not_applicable"] as const;
    for (let round = 0; round < 400; round++) {
      const checks = Array.from({ length: 1 + Math.floor(random() * 5) }, (_, i) =>
        check({
          status: statuses[Math.floor(random() * statuses.length)] ?? "missing",
          clauseIds: random() < 0.6 ? [`c${i + 1}`] : [],
          explanation: `explanation ${i}`,
          comment: random() < 0.7 ? `comment ${i}` : "",
          edit: random() < 0.5 ? edit(`c${i + 1}`, `q${i}`, `r${i}`) : null,
          suggestedClause: random() < 0.5 ? `clause ${i}` : null,
        }),
      );
      const merged = mergeWindowChecks(rule({ required: random() < 0.5 }), checks);
      const source = checks.find((c) => c.explanation === merged.explanation);
      expect(source, "the explanation is some check's own").toBeDefined();
      if (merged.status === "deviation") {
        expect(merged.comment).toBe(source?.comment);
        expect(merged.edit).toEqual(source?.edit);
        expect(source?.status).toBe("deviation");
      }
      if (merged.status === "missing") {
        expect(merged.comment).toBe(source?.comment);
        if (merged.suggestedClause !== null) {
          expect(merged.suggestedClause).toBe(source?.suggestedClause);
        }
      }
    }
  });

  it("passes a single check through", () => {
    const only = check({
      status: "deviation",
      clauseIds: ["c4"],
      explanation: "Perpetual.",
      comment: "Change clause 3.1.",
      edit: edit("c4"),
      suggestedClause: "ignored",
    });
    expect(mergeWindowChecks(required, [only])).toEqual({ ...only, suggestedClause: null });
    expect(
      mergeWindowChecks(optional, [check({ status: "not_applicable", explanation: "n" })]),
    ).toMatchObject({ status: "not_applicable", explanation: "n", suggestedClause: null });
  });
});
