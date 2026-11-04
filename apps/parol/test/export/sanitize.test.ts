import { describe, expect, it } from "vitest";
import { formatUtcDate, parseUtcInstant } from "../../src/export/dates.js";
import {
  MAX_QUOTE_CHARS,
  containBidi,
  printableId,
  sanitizeXmlText,
  splitLines,
  truncateQuote,
} from "../../src/export/sanitize.js";
import { verifyQuote } from "../../src/quotes.js";
import { BIDI_CLOSED, bidiStateAfter, firstInvalidXmlChar } from "./support.js";

describe("sanitizeXmlText", () => {
  it("removes every control character XML 1.0 forbids, and keeps the text around them", () => {
    let all = "";
    for (let code = 0; code < 0x20; code += 1) all += `<${String.fromCharCode(code)}>`;
    const out = sanitizeXmlText(all);
    expect(firstInvalidXmlChar(out)).toBeNull();
    // Tab, line feed and carriage return are valid: tab becomes a space and the other two a line feed.
    // Vertical tab and form feed are white space to the quote verifier, so each becomes a space and
    // the words around it stay apart.
    const gone = (count: number) => "<>".repeat(count);
    expect(out).toBe(`${gone(9)}< ><\n>< >< ><\n>${gone(18)}`);
  });

  it("removes the two non-characters, DEL and the C1 controls, and turns next line into a space", () => {
    expect(sanitizeXmlText("a\uFFFEb\uFFFFc\u007Fd\u0080e\u0085f\u009Fg")).toBe("abcde fg");
  });

  it("turns vertical tab, form feed and next line into one space each, so words do not fuse", () => {
    for (const ch of ["\u000B", "\u000C", "\u0085"]) {
      expect(sanitizeXmlText(`Section 6.1${ch}of the Agreement`)).toBe(
        "Section 6.1 of the Agreement",
      );
    }
  });

  it("shows a quote that verified as text that still verifies, for every white space the verifier counts", () => {
    // The white space set of locateQuote in packages/review/src/anchor.ts.
    const spaces = [
      ...Array.from({ length: 5 }, (_, at) => 0x09 + at),
      0x20,
      0x85,
      0xa0,
      0x1680,
      ...Array.from({ length: 11 }, (_, at) => 0x2000 + at),
      0x2028,
      0x2029,
      0x202f,
      0x205f,
      0x3000,
    ].map((code) => String.fromCharCode(code));
    for (const space of spaces) {
      const span = `Section 6.1${space}of the Agreement is deleted in its entirety.`;
      const quote = `6.1${space}of the Agreement is deleted`;
      expect(verifyQuote(span, quote).check, `U+${space.charCodeAt(0).toString(16)}`).toBe(
        "verified",
      );
      const shown = sanitizeXmlText(quote).trim();
      expect(verifyQuote(span, shown).check, `U+${space.charCodeAt(0).toString(16)}`).toBe(
        "verified",
      );
    }
  });

  it("removes a lone surrogate half and keeps a pair", () => {
    expect(sanitizeXmlText("x\uD800y")).toBe("xy");
    expect(sanitizeXmlText("x\uDC00y")).toBe("xy");
    expect(sanitizeXmlText("\uD83D\u{1F600}")).toBe("\u{1F600}");
    expect(sanitizeXmlText("\u{1F600}\uDE00")).toBe("\u{1F600}");
    expect(sanitizeXmlText("ok \u{1F600} ok")).toBe("ok \u{1F600} ok");
    expect(sanitizeXmlText("\uD800")).toBe("");
  });

  it("keeps characters that are valid, however odd", () => {
    const odd =
      "\u200B\u200D\u2060\uFEFF\u200E\u200F\u202E\u00A0\u2028\u2029 \u05E9 \u0645 \u{1F600} \u{10FFFF}";
    expect(sanitizeXmlText(odd)).toBe(odd);
  });

  it("settles line endings and tabs", () => {
    expect(sanitizeXmlText("a\r\nb\rc\nd\te")).toBe("a\nb\nc\nd e");
  });

  it("gives an empty string for anything that is not a string", () => {
    for (const value of [null, undefined, 4, {}, [], true]) expect(sanitizeXmlText(value)).toBe("");
  });

  it("passes a string with nothing to remove through unchanged", () => {
    expect(sanitizeXmlText("<a> & \"b\" 'c'")).toBe("<a> & \"b\" 'c'");
  });
});

describe("truncateQuote", () => {
  it("leaves a quote of the limit or less alone", () => {
    expect(truncateQuote("a".repeat(MAX_QUOTE_CHARS))).toBe("a".repeat(MAX_QUOTE_CHARS));
    expect(truncateQuote("short")).toBe("short");
    expect(truncateQuote("")).toBe("");
  });

  it("cuts a longer quote at the limit and adds three full stops", () => {
    expect(truncateQuote("a".repeat(MAX_QUOTE_CHARS + 1))).toBe(
      `${"a".repeat(MAX_QUOTE_CHARS)}...`,
    );
    expect(truncateQuote("abcdef", 3)).toBe("abc...");
  });

  it("never ends in the first half of a surrogate pair", () => {
    const text = `${"a".repeat(MAX_QUOTE_CHARS - 1)}\u{1F600}tail`;
    const out = truncateQuote(text);
    expect(out).toBe(`${"a".repeat(MAX_QUOTE_CHARS - 1)}...`);
    expect(firstInvalidXmlChar(out)).toBeNull();
  });

  it("drops trailing spaces before the full stops", () => {
    expect(truncateQuote("ab   cd", 5)).toBe("ab...");
  });
});

describe("containBidi", () => {
  it("leaves text without bidirectional controls untouched, right-to-left words included", () => {
    const text = "\u05E9\u05DC\u05D5\u05DD and \u0645\u0631\u062D\u0628\u0627 \u200F";
    expect(containBidi(text)).toBe(text);
  });

  it("adds one closer for each override, embedding or isolate opened", () => {
    expect(containBidi("a\u202Eb")).toBe("a\u202Eb\u202C");
    expect(containBidi("\u202A\u202B\u202D\u202E")).toBe(
      "\u202A\u202B\u202D\u202E\u202C\u202C\u202C\u202C",
    );
    expect(containBidi("\u2066\u2067\u2068")).toBe("\u2066\u2067\u2068\u2069\u2069\u2069");
  });

  it("closes what was opened last first, so an embedding opened before an isolate is closed", () => {
    // A PDF is ignored while an isolate is on top of the stack, so the isolate must close first.
    expect(containBidi("\u202Ex\u2067")).toBe("\u202Ex\u2067\u2069\u202C");
    expect(containBidi("\u2067x\u202E")).toBe("\u2067x\u202E\u202C\u2069");
    expect(containBidi("\u202B\u2066\u202D\u2067")).toBe(
      "\u202B\u2066\u202D\u2067\u2069\u202C\u2069\u202C",
    );
  });

  it("closes the case that a count of openers and closers gets wrong", () => {
    const text = "6.1 of the Agreement \u202E\u2066 is deleted";
    expect(containBidi(text)).toBe(`${text}\u2069\u202C`);
    expect(bidiStateAfter(text)).not.toEqual(BIDI_CLOSED);
    expect(bidiStateAfter(containBidi(text))).toEqual(BIDI_CLOSED);
  });

  it("respects the closers the text already has, and adds none for a balanced text", () => {
    for (const text of [
      "\u202Ea\u202C",
      "\u2067a\u2069",
      "\u202Ea\u2066b\u2069c\u202C",
      "\u2067\u202Ea\u2069",
      "\u202B\u202Ea\u202C\u202Cb",
    ]) {
      expect(containBidi(text)).toBe(text);
    }
  });

  it("adds a closer only for what is still open when the text ends", () => {
    expect(containBidi("\u202Ea\u202Cb\u202D")).toBe("\u202Ea\u202Cb\u202D\u202C");
    // A closer inside an isolate does not close an embedding opened before it.
    expect(containBidi("\u202Ea\u2067b\u202C")).toBe("\u202Ea\u2067b\u202C\u2069\u202C");
    // The isolate closer takes the embeddings opened inside it with it.
    expect(containBidi("\u2067\u202E\u202Ea\u2069\u202B")).toBe(
      "\u2067\u202E\u202Ea\u2069\u202B\u202C",
    );
  });

  it("ignores a closer with nothing to close", () => {
    expect(containBidi("a\u202Cb\u2069c")).toBe("a\u202Cb\u2069c");
    expect(containBidi("\u2069\u202C\u202E")).toBe("\u2069\u202C\u202E\u202C");
    // A PDF does not close an isolate, so the isolate is still open.
    expect(containBidi("\u2067\u202C")).toBe("\u2067\u202C\u2069");
  });

  it("does not cap the closers it adds", () => {
    for (const [opener, closer] of [
      ["\u202E", "\u202C"],
      ["\u202B", "\u202C"],
      ["\u2067", "\u2069"],
    ] as const) {
      for (const count of [125, 126, 200, 1000]) {
        const out = containBidi(opener.repeat(count));
        expect(out).toBe(opener.repeat(count) + closer.repeat(count));
        expect(bidiStateAfter(out)).toEqual(BIDI_CLOSED);
      }
    }
  });

  it("leaves nothing open for any mix of openers and closers, depth limit included", () => {
    const marks = [
      "\u202A",
      "\u202B",
      "\u202D",
      "\u202E",
      "\u202C",
      "\u2066",
      "\u2067",
      "\u2068",
      "\u2069",
      "x",
    ];
    // A small generator with a fixed seed, so the test is the same on every run.
    let seed = 20261103;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let round = 0; round < 600; round += 1) {
      // Some rounds are mostly openers, so that the depth limit of 125 is reached and passed.
      const openers = round % 3 === 0 ? 0.92 : 0.5;
      const length = 1 + Math.floor(next() * (round % 3 === 0 ? 600 : 60));
      let text = "";
      for (let at = 0; at < length; at += 1) {
        const open = next() < openers;
        const pool = open ? [0, 1, 2, 3, 5, 6, 7] : [4, 8, 9];
        text += marks[pool[Math.floor(next() * pool.length)]!];
      }
      expect(bidiStateAfter(containBidi(text)), JSON.stringify(text)).toEqual(BIDI_CLOSED);
    }
  });
});

describe("splitLines and printableId", () => {
  it("splits on line feeds only", () => {
    expect(splitLines("a\nb\n\nc")).toEqual(["a", "b", "", "c"]);
    expect(splitLines("one")).toEqual(["one"]);
  });

  it("prints an id that looks like one and nothing else", () => {
    expect(printableId("dur-1")).toBe("dur-1");
    expect(printableId("dv_x:p19")).toBe("dv_x:p19");
    for (const bad of ["", "a b", "<b>", "x".repeat(81), "dur-1\n", null, 7, undefined]) {
      expect(printableId(bad)).toBe("(unprintable id)");
    }
  });
});

describe("formatUtcDate", () => {
  it.each([
    ["2026-11-03T14:05:00.000Z", "3 November 2026"],
    ["2026-11-03T14:05:00Z", "3 November 2026"],
    ["2026-11-03T14:05", "3 November 2026"],
    ["2026-11-03 14:05:00", "3 November 2026"],
    ["2026-11-03", "3 November 2026"],
    ["2026-11-03T23:59:59-01:00", "4 November 2026"],
    ["2026-11-03T23:59:59-0100", "4 November 2026"],
    ["2026-11-03T00:00:00+05:30", "2 November 2026"],
    ["2026-01-01T00:00:00Z", "1 January 2026"],
    ["2026-12-31T23:59:59.999Z", "31 December 2026"],
    ["2028-02-29", "29 February 2028"],
    ["2026-12-31T23:30:00-01:00", "1 January 2027"],
  ])("%s is %s", (iso, words) => {
    expect(formatUtcDate(iso)).toBe(words);
  });

  it.each([
    "",
    "3 November 2026",
    "2026-11",
    "2026-13-01",
    "2026-00-10",
    "2026-02-29",
    "2026-02-30",
    "2026-04-31",
    "2026-11-03T24:00:00Z",
    "2026-11-03T12:60:00Z",
    "2026-11-03T12:00:60Z",
    "2026-11-03T12:00:00+24:00",
    "2026-11-03T12:00:00+05:60",
    "1850-01-01",
    "yesterday",
    "2026-11-03T12:00:00 and more",
  ])("refuses %j", (iso) => {
    expect(formatUtcDate(iso)).toBeNull();
  });

  it("refuses a value that is not a string", () => {
    for (const value of [null, undefined, 20261103, new Date(), {}]) {
      expect(formatUtcDate(value)).toBeNull();
    }
  });

  it("reads a time with no zone as UTC whatever the machine's zone is", () => {
    expect(parseUtcInstant("2026-11-03T14:05:00")!.toISOString()).toBe("2026-11-03T14:05:00.000Z");
    expect(parseUtcInstant("2026-11-03T14:05:00+02:00")!.toISOString()).toBe(
      "2026-11-03T12:05:00.000Z",
    );
    expect(parseUtcInstant("2026-11-03")!.toISOString()).toBe("2026-11-03T00:00:00.000Z");
  });
});
