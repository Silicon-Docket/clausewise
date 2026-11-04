import { describe, expect, it } from "vitest";
import { splitByOffsets, type Offsets, type Segment } from "../../src/server/views/highlight.js";

const join = (segments: Segment[]): string => segments.map((s) => s.text).join("");
/** No lone half of a surrogate pair. (String.prototype.isWellFormed needs a newer library target.) */
const wellFormed = (text: string): boolean =>
  !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);
const marked = (segments: Segment[]): string[] =>
  segments.filter((s) => s.highlighted).map((s) => s.text);

describe("splitByOffsets", () => {
  const text = "The obligations continue for two (2) years from disclosure.";

  it("highlights exactly the quote at its offsets", () => {
    const start = text.indexOf("two (2) years");
    const segments = splitByOffsets(text, { start, end: start + "two (2) years".length });
    expect(segments).toEqual([
      { text: "The obligations continue for ", highlighted: false },
      { text: "two (2) years", highlighted: true },
      { text: " from disclosure.", highlighted: false },
    ]);
  });

  it("returns the whole text as one plain segment when there is nothing to highlight", () => {
    expect(splitByOffsets(text, null)).toEqual([{ text, highlighted: false }]);
    expect(splitByOffsets(text, undefined)).toEqual([{ text, highlighted: false }]);
    expect(splitByOffsets(text, [])).toEqual([{ text, highlighted: false }]);
  });

  it("returns no segments for empty text, however many offsets are given", () => {
    expect(splitByOffsets("", { start: 0, end: 5 })).toEqual([]);
  });

  it("does not produce empty segments at the edges", () => {
    const whole = splitByOffsets("abc", { start: 0, end: 3 });
    expect(whole).toEqual([{ text: "abc", highlighted: true }]);
    const head = splitByOffsets("abc", { start: 0, end: 1 });
    expect(head.map((s) => s.text)).toEqual(["a", "bc"]);
  });

  it("clamps a range that overhangs the text instead of reading past it", () => {
    expect(splitByOffsets("abcdef", { start: 4, end: 99 })).toEqual([
      { text: "abcd", highlighted: false },
      { text: "ef", highlighted: true },
    ]);
    expect(splitByOffsets("abcdef", { start: -5, end: 2 })).toEqual([
      { text: "ab", highlighted: true },
      { text: "cdef", highlighted: false },
    ]);
  });

  it.each<[string, unknown]>([
    ["reversed", { start: 4, end: 2 }],
    ["empty", { start: 3, end: 3 }],
    ["wholly after the text", { start: 10, end: 12 }],
    ["wholly before the text", { start: -4, end: -1 }],
    ["not whole numbers", { start: 0.5, end: 3 }],
    ["not finite", { start: 0, end: Number.POSITIVE_INFINITY }],
    ["NaN", { start: Number.NaN, end: 3 }],
    ["strings", { start: "0", end: "3" }],
    ["missing fields", {}],
    ["not an object", 7],
  ])("rejects an offset pair that is %s", (_name, bad) => {
    expect(splitByOffsets("abcdef", bad as Offsets)).toEqual([
      { text: "abcdef", highlighted: false },
    ]);
  });

  it("ignores a bad pair and still uses a good one beside it", () => {
    const segments = splitByOffsets("abcdef", [
      { start: 5, end: 1 },
      { start: 1, end: 3 },
      { start: Number.NaN, end: 4 },
    ]);
    expect(marked(segments)).toEqual(["bc"]);
  });

  it("merges overlapping and touching ranges into one highlighted segment", () => {
    expect(
      marked(
        splitByOffsets("abcdefgh", [
          { start: 1, end: 4 },
          { start: 3, end: 6 },
        ]),
      ),
    ).toEqual(["bcdef"]);
    expect(
      marked(
        splitByOffsets("abcdefgh", [
          { start: 1, end: 3 },
          { start: 3, end: 5 },
        ]),
      ),
    ).toEqual(["bcde"]);
    expect(
      marked(
        splitByOffsets("abcdefgh", [
          { start: 0, end: 8 },
          { start: 2, end: 3 },
        ]),
      ),
    ).toEqual(["abcdefgh"]);
  });

  it("keeps disjoint ranges apart and in text order whatever order they arrive in", () => {
    const segments = splitByOffsets("abcdefgh", [
      { start: 6, end: 8 },
      { start: 0, end: 2 },
    ]);
    expect(marked(segments)).toEqual(["ab", "gh"]);
    expect(segments.map((s) => s.text)).toEqual(["ab", "cdef", "gh"]);
  });

  it("never splits a surrogate pair", () => {
    // U+1F600 is two code units. An offset between them would print two replacement characters.
    const emoji = "a\u{1F600}b";
    expect(emoji.length).toBe(4);
    const middleStart = splitByOffsets(emoji, { start: 2, end: 4 });
    expect(marked(middleStart)).toEqual(["\u{1F600}b"]);
    const middleEnd = splitByOffsets(emoji, { start: 0, end: 2 });
    expect(marked(middleEnd)).toEqual(["a\u{1F600}"]);
    for (const segments of [middleStart, middleEnd]) {
      expect(join(segments)).toBe(emoji);
      for (const s of segments) expect(wellFormed(s.text)).toBe(true);
    }
  });

  it("highlights a quote made only of a surrogate pair", () => {
    const emoji = "x\u{1F600}y";
    expect(marked(splitByOffsets(emoji, { start: 1, end: 3 }))).toEqual(["\u{1F600}"]);
  });

  it("does not trust an offset object that carries extra or inherited fields", () => {
    const hostile = Object.create({ start: 0, end: 3 }) as Offsets;
    expect(splitByOffsets("abcdef", hostile)).toEqual([{ text: "abcdef", highlighted: false }]);
  });

  it("handles a very long paragraph", () => {
    const big = "a".repeat(100_000) + "QUOTE" + "b".repeat(100_000);
    const segments = splitByOffsets(big, { start: 100_000, end: 100_005 });
    expect(marked(segments)).toEqual(["QUOTE"]);
    expect(join(segments)).toBe(big);
  });

  describe("properties, over many generated inputs", () => {
    // A small seeded generator so a failure can be reproduced.
    let seed = 20261104;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    const alphabet = ["a", "b", " ", "\u{1F600}", "\u{10348}", "é", "\n", "\u202e", "x"];
    const wild = [-3, -1, 0, 1, 2, 3, 5, 8, 13, 40, 0.5, Number.NaN, Number.POSITIVE_INFINITY];

    it("joins back to the text, has no empty segment and no adjacent highlights", () => {
      for (let i = 0; i < 3000; i += 1) {
        const length = Math.floor(next() * 12);
        const text = Array.from({ length }, () => pick(alphabet)).join("");
        const count = Math.floor(next() * 4);
        const offsets = Array.from({ length: count }, () => ({
          start: pick(wild),
          end: pick(wild),
        }));
        const segments = splitByOffsets(text, offsets);
        expect(join(segments)).toBe(text);
        for (const [index, s] of segments.entries()) {
          expect(s.text.length).toBeGreaterThan(0);
          const before = segments[index - 1];
          if (before !== undefined && s.highlighted) expect(before.highlighted).toBe(false);
          // The text is made of whole characters, so every segment must be too.
          expect(wellFormed(s.text)).toBe(true);
        }
      }
    });

    it("highlights only text that a valid range covers", () => {
      for (let i = 0; i < 3000; i += 1) {
        const length = 1 + Math.floor(next() * 10);
        const text = Array.from({ length }, () => pick(alphabet)).join("");
        const start = Math.floor(next() * (text.length + 2)) - 1;
        const end = start + Math.floor(next() * 6) - 1;
        const segments = splitByOffsets(text, { start, end });
        const covered = marked(segments).join("");
        if (end <= start || start >= text.length || end <= 0) {
          expect(covered).toBe("");
        } else {
          // Never more than the requested range plus the two characters a pair can add.
          expect(covered.length).toBeLessThanOrEqual(
            Math.min(text.length, end) - Math.max(0, start) + 2,
          );
          expect(covered).not.toBe("");
        }
      }
    });
  });
});
