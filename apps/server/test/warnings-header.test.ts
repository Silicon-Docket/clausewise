import { describe, expect, it } from "vitest";
import { MAX_WARNINGS_HEADER_CHARS, warningsHeaderValue } from "../src/routes/export.js";

const encode = (list: string[]): string => encodeURIComponent(JSON.stringify(list));
const decode = (value: string | undefined): string[] =>
  JSON.parse(decodeURIComponent(value ?? "")) as string[];
const notice = (count: number): string =>
  `${count} more ${count === 1 ? "warning was" : "warnings were"} left out because there was no room for ${count === 1 ? "it" : "them"} here.`;

// A warning with everything that is awkward in a header: quotes, a newline, accents, a character
// outside the basic plane, and a lone half of a surrogate pair.
const AWKWARD = 'He said "stop"\nCaf\u00e9 \u{1F600} lone:\ud800 100% sure; a=b, c';

describe("the value of the X-Clausewise-Warnings header", () => {
  it("is nothing when there is nothing to say", () => {
    expect(warningsHeaderValue([])).toBeUndefined();
  });

  it("is the whole list as percent-encoded JSON when it fits, whatever the warnings say", () => {
    const list = ["The first.", AWKWARD, ""];
    const value = warningsHeaderValue(list);
    expect(value).toBe(encode(list));
    // Plain ASCII with nothing a header cannot hold: no space, no control character, no non-ASCII.
    expect(value).toMatch(/^[\x21-\x7e]+$/);
    // The lone surrogate is escaped by JSON, so the round trip keeps it as it was.
    expect(decode(value)).toEqual(list);
  });

  it("is exactly at the limit when the list just fits", () => {
    // Find a text whose encoded list is the limit exactly: each x adds one character.
    const base = encode([""]).length;
    const exact = ["x".repeat(MAX_WARNINGS_HEADER_CHARS - base)];
    expect(warningsHeaderValue(exact)).toBe(encode(exact));
    expect(warningsHeaderValue(exact)?.length).toBe(MAX_WARNINGS_HEADER_CHARS);
    // One character more and it is left out.
    const over = ["x".repeat(MAX_WARNINGS_HEADER_CHARS - base + 1)];
    expect(decode(warningsHeaderValue(over))).toEqual([notice(1)]);
  });

  it("drops whole warnings from the end and says how many, as many as it must and no more", () => {
    // Warnings of different lengths and contents, 3 to 120 of them.
    for (const count of [3, 8, 20, 61, 120]) {
      const list = Array.from(
        { length: count },
        (_, i) => `Warning ${i}: ${(i % 2 === 0 ? AWKWARD : "plain words, ").repeat(1 + (i % 7))}`,
      );
      if (encode(list).length <= MAX_WARNINGS_HEADER_CHARS) continue;
      const value = warningsHeaderValue(list);
      expect(value, `${count} warnings`).toMatch(/^[\x21-\x7e]+$/);
      expect(value?.length).toBeLessThanOrEqual(MAX_WARNINGS_HEADER_CHARS);

      const shown = decode(value);
      const kept = shown.slice(0, -1);
      // Whole warnings, from the start, unchanged.
      expect(kept, `${count} warnings`).toEqual(list.slice(0, kept.length));
      expect(shown.at(-1)).toBe(notice(count - kept.length));
      expect(kept.length).toBeLessThan(count);
      // Not one fewer than it had to: keeping the next warning as well would not have fit.
      if (kept.length < count - 1) {
        const more = [...list.slice(0, kept.length + 1), notice(count - kept.length - 1)];
        expect(encode(more).length, `${count} warnings`).toBeGreaterThan(MAX_WARNINGS_HEADER_CHARS);
      }
    }
  });

  it("keeps none and says so when the first warning alone is too long", () => {
    const value = warningsHeaderValue(["y".repeat(5000), "short"]);
    expect(decode(value)).toEqual([notice(2)]);
    expect(decode(warningsHeaderValue(["z".repeat(4001)]))).toEqual([notice(1)]);
  });

  it("counts what the encoding makes of the characters, not what they look like", () => {
    // 700 accented letters are 700 characters, and 4200 once they are encoded.
    const accents = "\u00e9".repeat(700);
    expect(accents.length).toBeLessThan(MAX_WARNINGS_HEADER_CHARS);
    expect(decode(warningsHeaderValue([accents]))).toEqual([notice(1)]);
    expect(decode(warningsHeaderValue(["\u00e9".repeat(600), "a"]))).toEqual([
      "\u00e9".repeat(600),
      "a",
    ]);
  });
});
