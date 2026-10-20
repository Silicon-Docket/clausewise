// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_CELLS, diffWords, tokenize, type DiffPart } from "../src/lib/diff.js";

const RSQUO = String.fromCodePoint(0x2019);
const NBSP = String.fromCodePoint(0xa0);
const E_ACUTE_COMBINING = "e" + String.fromCodePoint(0x301);

function before(parts: DiffPart[]): string {
  return parts
    .filter((p) => p.kind !== "insert")
    .map((p) => p.text)
    .join("");
}

function after(parts: DiffPart[]): string {
  return parts
    .filter((p) => p.kind !== "delete")
    .map((p) => p.text)
    .join("");
}

describe("tokenize", () => {
  it("keeps words whole and gives spaces and each punctuation mark a token of their own", () => {
    expect(tokenize("Fees: (3) days.")).toEqual([
      "Fees",
      ":",
      " ",
      "(",
      "3",
      ")",
      " ",
      "days",
      ".",
    ]);
  });

  it("treats a run of spaces as one token", () => {
    expect(tokenize("a   b")).toEqual(["a", "   ", "b"]);
  });

  it("keeps a letter with its combining accent in one word", () => {
    expect(tokenize(`caf${E_ACUTE_COMBINING} open`)).toEqual([
      `caf${E_ACUTE_COMBINING}`,
      " ",
      "open",
    ]);
  });

  it("gives nothing for an empty string", () => {
    expect(tokenize("")).toEqual([]);
  });
});

describe("diffWords", () => {
  it("returns the text unchanged when both sides are the same", () => {
    expect(diffWords("The term is three years.", "The term is three years.")).toEqual({
      parts: [{ kind: "equal", text: "The term is three years." }],
      approximate: false,
    });
  });

  it("returns no parts for two empty strings", () => {
    expect(diffWords("", "")).toEqual({ parts: [], approximate: false });
  });

  it("shows text added to an empty string as one insertion", () => {
    expect(diffWords("", "A new clause.").parts).toEqual([
      { kind: "insert", text: "A new clause." },
    ]);
  });

  it("shows text replaced by nothing as one deletion", () => {
    expect(diffWords("A struck clause.", "").parts).toEqual([
      { kind: "delete", text: "A struck clause." },
    ]);
  });

  it("shows an insertion between unchanged words", () => {
    expect(diffWords("the term is three years", "the term is three (3) years").parts).toEqual([
      { kind: "equal", text: "the term is three " },
      { kind: "insert", text: "(3) " },
      { kind: "equal", text: "years" },
    ]);
  });

  it("shows a deletion between unchanged words", () => {
    expect(diffWords("the term is only three years", "the term is three years").parts).toEqual([
      { kind: "equal", text: "the term is " },
      { kind: "delete", text: "only " },
      { kind: "equal", text: "three years" },
    ]);
  });

  it("shows a replaced word as the removal and then the addition", () => {
    expect(diffWords("for three years", "for five years").parts).toEqual([
      { kind: "equal", text: "for " },
      { kind: "delete", text: "three" },
      { kind: "insert", text: "five" },
      { kind: "equal", text: " years" },
    ]);
  });

  it("shows a run of replaced words as one removal and one addition, not word by word", () => {
    expect(diffWords("alpha beta gamma delta", "one two three delta").parts).toEqual([
      { kind: "delete", text: "alpha beta gamma" },
      { kind: "insert", text: "one two three" },
      { kind: "equal", text: " delta" },
    ]);
  });

  it("keeps a shared word between two changes as unchanged text", () => {
    expect(diffWords("red fox jumps", "blue fox leaps").parts).toEqual([
      { kind: "delete", text: "red" },
      { kind: "insert", text: "blue" },
      { kind: "equal", text: " fox " },
      { kind: "delete", text: "jumps" },
      { kind: "insert", text: "leaps" },
    ]);
  });

  it("joins two changes that have only spaces between them", () => {
    // Without the join this would be: remove "agrees", add "agree", then the same for the noun.
    expect(diffWords("The Recipient agrees", "The Recipients agree").parts).toEqual([
      { kind: "equal", text: "The " },
      { kind: "delete", text: "Recipient agrees" },
      { kind: "insert", text: "Recipients agree" },
    ]);
  });

  it("shows a change of spacing as a change", () => {
    expect(diffWords("a  b", "a b").parts).toEqual([
      { kind: "equal", text: "a" },
      { kind: "delete", text: "  " },
      { kind: "insert", text: " " },
      { kind: "equal", text: "b" },
    ]);
  });

  it("tells a no-break space from an ordinary one", () => {
    const parts = diffWords(`10${NBSP}days`, "10 days").parts;
    expect(parts.some((p) => p.kind === "delete" && p.text === NBSP)).toBe(true);
    expect(parts.some((p) => p.kind === "insert" && p.text === " ")).toBe(true);
  });

  it("shows a changed punctuation mark and nothing else", () => {
    expect(diffWords("the term, however", "the term; however").parts).toEqual([
      { kind: "equal", text: "the term" },
      { kind: "delete", text: "," },
      { kind: "insert", text: ";" },
      { kind: "equal", text: " however" },
    ]);
  });

  it("never cuts a word in half", () => {
    const { parts } = diffWords("Notices go to the Recipient", "Notices go to the Recipients");
    expect(parts).toEqual([
      { kind: "equal", text: "Notices go to the " },
      { kind: "delete", text: "Recipient" },
      { kind: "insert", text: "Recipients" },
    ]);
  });

  it("compares curly and straight apostrophes as different characters", () => {
    const parts = diffWords("Party's duty", `Party${RSQUO}s duty`).parts;
    expect(parts).toContainEqual({ kind: "delete", text: "'" });
    expect(parts).toContainEqual({ kind: "insert", text: RSQUO });
  });

  it("rebuilds both texts exactly for a spread of random edits", () => {
    // A small vocabulary with spaces and punctuation, so that matches and mismatches both happen.
    const vocabulary = [
      "the",
      "term",
      "Recipient",
      "shall",
      ",",
      ".",
      "(",
      ")",
      "3",
      "  ",
      " ",
      "of",
    ];
    let seed = 12345;
    const next = (limit: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % limit;
    };
    const text = (): string => {
      const length = next(25);
      let out = "";
      for (let i = 0; i < length; i++) out += vocabulary[next(vocabulary.length)] ?? "";
      return out;
    };
    for (let round = 0; round < 300; round++) {
      const x = text();
      const y = text();
      const { parts } = diffWords(x, y);
      expect(before(parts)).toBe(x);
      expect(after(parts)).toBe(y);
      for (const [index, part] of parts.entries()) {
        expect(part.text).not.toBe("");
        const previous = parts[index - 1];
        if (previous !== undefined) {
          expect(previous.kind).not.toBe(part.kind);
          // A removal always comes before the addition it goes with.
          expect(previous.kind === "insert" && part.kind === "delete").toBe(false);
        }
      }
    }
  });

  it("falls back to one removal and one addition when the work limit is passed", () => {
    const result = diffWords("start A B C end", "start X Y Z end", { maxCells: 4 });
    expect(result.approximate).toBe(true);
    expect(result.parts).toEqual([
      { kind: "equal", text: "start " },
      { kind: "delete", text: "A B C" },
      { kind: "insert", text: "X Y Z" },
      { kind: "equal", text: " end" },
    ]);
  });

  it("stays exact when the limit is not passed", () => {
    expect(diffWords("start A B C end", "start X Y Z end").approximate).toBe(false);
  });

  it("stays fast and bounded for two long texts with nothing in common", () => {
    const left = Array.from({ length: 60_000 }, (_, i) => `left${i}`).join(" ");
    const right = Array.from({ length: 60_000 }, (_, i) => `right${i}`).join(" ");
    const started = performance.now();
    const result = diffWords(left, right);
    const elapsed = performance.now() - started;
    expect(result.approximate).toBe(true);
    expect(before(result.parts)).toBe(left);
    expect(after(result.parts)).toBe(right);
    expect(elapsed).toBeLessThan(3000);
  });

  it("stays exact and fast for a very long text with one word changed", () => {
    const words = Array.from({ length: 150_000 }, (_, i) => `w${i}`);
    const left = words.join(" ");
    const changed = [...words];
    changed[75_000] = "CHANGED";
    const right = changed.join(" ");
    const started = performance.now();
    const result = diffWords(left, right);
    const elapsed = performance.now() - started;
    expect(result.approximate).toBe(false);
    expect(result.parts.filter((p) => p.kind !== "equal")).toEqual([
      { kind: "delete", text: "w75000" },
      { kind: "insert", text: "CHANGED" },
    ]);
    expect(elapsed).toBeLessThan(3000);
  });

  it("uses a limit that lets an ordinary long paragraph be compared word by word", () => {
    const words = Array.from({ length: 700 }, (_, i) => `word${i}`);
    const changed = words.map((w, i) => (i % 7 === 0 ? `new${i}` : w));
    const result = diffWords(words.join(" "), changed.join(" "));
    expect(result.approximate).toBe(false);
    expect(DEFAULT_MAX_CELLS).toBeGreaterThan(1400 * 1400);
  });
});
