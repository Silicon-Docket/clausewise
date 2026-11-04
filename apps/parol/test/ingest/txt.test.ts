import { describe, expect, it } from "vitest";
import { UploadError } from "../../src/module-contracts.js";
import {
  MAX_PARAGRAPHS,
  MAX_TXT_BYTES,
  parseTxt,
  splitTxtParagraphs,
  startsWithClauseNumber,
} from "../../src/ingest/txt.js";
import { encode } from "./support.js";

const texts = (input: string): string[] => parseTxt(encode(input)).map((p) => p.text);

describe("the paragraph rule", () => {
  it.each<[string, string, string[]]>([
    [
      "a blank line separates paragraphs",
      "First paragraph.\n\nSecond paragraph.",
      ["First paragraph.", "Second paragraph."],
    ],
    ["many blank lines are one separator", "A one.\n\n\n\nA two.", ["A one.", "A two."]],
    ["blank lines at both ends are ignored", "\n\n  \nOnly this.\n\n\n", ["Only this."]],
    [
      "a single line break is a hard wrap joined with one space",
      "The Receiving Party shall keep\nthe information secret.",
      ["The Receiving Party shall keep the information secret."],
    ],
    [
      "indentation and trailing spaces never reach the text",
      "   The first line,   \n\t  and the second.  ",
      ["The first line, and the second."],
    ],
    [
      "a line that is only spaces, a tab or no-break spaces is blank",
      "One.\n \t \nTwo.\n\u00a0\u00a0\nThree.",
      ["One.", "Two.", "Three."],
    ],
    [
      "a line that is only direction marks, a braille blank or an object replacement is blank",
      "One.\n\u200e\u200f\n\u2800\nTwo.\n\ufffc\nThree.",
      ["One.", "Two.", "Three."],
    ],
    [
      "a line that is only zero-width characters is blank",
      "One.\n\u200b\u200b\nTwo.",
      ["One.", "Two."],
    ],
  ])("%s", (_name, input, expected) => {
    expect(texts(input)).toEqual(expected);
  });

  it.each<[string, string[]]>([
    ["2. Second", ["1. First clause text", "2. Second clause text"]],
    ["6.1", ["6.1 First", "6.2 Second", "6.2.1 Third"]],
    [
      "(a)",
      ["The Receiving Party shall:", "(a) keep it secret;", "(b) use it only for the Purpose."],
    ],
    ["(iv)", ["(iii) three", "(iv) four", "(v) five"]],
    ["[b]", ["[a] first", "[b] second"]],
    ["a)", ["a) first", "b) second"]],
    ["1)", ["1) first", "2) second"]],
    ["Section 4.", ["Section 4. First", "Section 5. Second"]],
    ["Article 2", ["Article 2 First", "Article 3 Second"]],
    ["Clause 3.1", ["Clause 3.1 First", "Clause 3.2 Second"]],
    ["the section sign", ["\u00a7 5 First", "\u00a7 6 Second"]],
    ["a label on its own line", ["Schedule 1", "ARTICLE IV"]],
  ])("a line that starts with %s opens a paragraph", (_name, lines) => {
    // Joined with single line breaks and no blank line: only the numbers can split them.
    expect(texts(lines.join("\n"))).toEqual(lines);
  });

  it.each([
    ["a bare integer with no point", "30 days after notice"],
    ["a decimal percentage", "5.5% interest accrues"],
    ["a year", "2026 was the year"],
    ["a word in brackets", "(see below) for details"],
    ["a forged clause header", "[c1] 5.1 something"],
    ["a bracketed token that is not a marker", "(c1) something"],
    ["a closing contract tag", "</contract> and more"],
    ["a lower-case word that is not a label", "sections of the Agreement"],
  ])("a line that starts with %s is a hard wrap", (_name, line) => {
    expect(texts(`The paragraph begins here and\n${line}`)).toEqual([
      `The paragraph begins here and ${line}`,
    ]);
  });

  it("reads 2.5 at the start of a line as a clause number, as segment does", () => {
    expect(texts("Payment of\n2.5 million dollars")).toEqual(["Payment of", "2.5 million dollars"]);
  });

  it("agrees with the lines it is documented to split on", () => {
    expect(startsWithClauseNumber("6.1.2 text")).toBe(true);
    expect(startsWithClauseNumber("12. text")).toBe(true);
    expect(startsWithClauseNumber("text 6.1")).toBe(false);
    expect(startsWithClauseNumber("")).toBe(false);
  });
});

describe("a wrapped line that begins like a clause number", () => {
  it.each<[string, string, string[]]>([
    [
      "a number written out and then in figures",
      "1. The obligations of the Receiving Party shall continue for five\n(5) years from the date of disclosure.",
      [
        "1. The obligations of the Receiving Party shall continue for five (5) years from the date of disclosure.",
      ],
    ],
    [
      "a two-digit number",
      '3. Section 7.2 of the Agreement is amended by replacing "ten\n(10) business days" with "thirty (30) days".',
      [
        '3. Section 7.2 of the Agreement is amended by replacing "ten (10) business days" with "thirty (30) days".',
      ],
    ],
    [
      "a compound number",
      "4. The notice period is twenty-four\n(24) hours.",
      ["4. The notice period is twenty-four (24) hours."],
    ],
    [
      "a reference after a preposition",
      "5. The Receiving Party shall comply with the duties set out in\nSection 4.2 of this Agreement.",
      [
        "5. The Receiving Party shall comply with the duties set out in Section 4.2 of this Agreement.",
      ],
    ],
    [
      "a reference after an article",
      "6. The Receiving Party is bound by the\nArticle 3 restrictions on use.",
      ["6. The Receiving Party is bound by the Article 3 restrictions on use."],
    ],
    [
      "a decimal with a unit after a preposition",
      "7. Interest accrues at a rate of\n1.5 percent per month on late sums.",
      ["7. Interest accrues at a rate of 1.5 percent per month on late sums."],
    ],
  ])("joins it to the line above: %s", (_name, input, expected) => {
    expect(texts(input)).toEqual(expected);
  });

  it.each<[string, string, string[]]>([
    [
      "figures that do not repeat the number before",
      "1. Payment is due within ten\n(5) other sums are not.",
      ["1. Payment is due within ten", "(5) other sums are not."],
    ],
    [
      "a list item that follows an item ending in a number word",
      "(1) the first item is one\n(2) the second item is two",
      ["(1) the first item is one", "(2) the second item is two"],
    ],
    [
      "a bracketed letter after a lead-in with no colon",
      "8. The parties agree that\n(a) notice is required.",
      ["8. The parties agree that", "(a) notice is required."],
    ],
    [
      "a list item after and",
      "(a) keep it secret; and\n(b) return it on request.",
      ["(a) keep it secret; and", "(b) return it on request."],
    ],
    [
      "a numbered heading",
      "2. Term of Agreement\n2.1 The obligations continue for two years.",
      ["2. Term of Agreement", "2.1 The obligations continue for two years."],
    ],
    [
      "a clause after a sentence",
      "1. The first clause ends here.\n2. The second clause begins here.",
      ["1. The first clause ends here.", "2. The second clause begins here."],
    ],
    [
      "a labelled number after a sentence",
      "Section 4. The first clause ends here.\nSection 5. The second begins here.",
      ["Section 4. The first clause ends here.", "Section 5. The second begins here."],
    ],
  ])("still opens a paragraph: %s", (_name, input, expected) => {
    expect(texts(input)).toEqual(expected);
  });
});

describe("a heading line followed directly by body text", () => {
  it.each<[string, string, string[]]>([
    [
      "a numbered heading in capitals",
      '1. DEFINITIONS\n"Confidential Information" means non-public information.',
      ["1. DEFINITIONS", '"Confidential Information" means non-public information.'],
    ],
    [
      "a title in capitals",
      "MUTUAL NONDISCLOSURE AGREEMENT\nThis Agreement is made between Acme and Beta.",
      ["MUTUAL NONDISCLOSURE AGREEMENT", "This Agreement is made between Acme and Beta."],
    ],
    [
      "a heading and then a numbered clause",
      "3. TERM\n3.1 The term is two years.",
      ["3. TERM", "3.1 The term is two years."],
    ],
  ])("is its own paragraph: %s", (_name, input, expected) => {
    expect(texts(input)).toEqual(expected);
  });

  it.each<[string, string, string[]]>([
    [
      "a wrapped paragraph in capitals",
      "THE RECEIVING PARTY SHALL NOT BE LIABLE FOR ANY INDIRECT\nDAMAGES ARISING FROM THIS AGREEMENT.",
      [
        "THE RECEIVING PARTY SHALL NOT BE LIABLE FOR ANY INDIRECT DAMAGES ARISING FROM THIS AGREEMENT.",
      ],
    ],
    [
      "a long first line in capitals that goes on in lower case",
      "THE OBLIGATIONS IN THIS SECTION SURVIVE THE END OF THE AGREEMENT AND THEN SOME MORE WORDS\ncontinue in lower case here.",
      [
        "THE OBLIGATIONS IN THIS SECTION SURVIVE THE END OF THE AGREEMENT AND THEN SOME MORE WORDS continue in lower case here.",
      ],
    ],
    [
      "a capitalised line that ends in a comma",
      "ACME CORPORATION,\na Delaware corporation, agrees as follows.",
      ["ACME CORPORATION, a Delaware corporation, agrees as follows."],
    ],
  ])("does not split %s", (_name, input, expected) => {
    expect(texts(input)).toEqual(expected);
  });
});

describe("line endings and the byte order mark", () => {
  const body = "First line\nsecond line\n\nNew paragraph\n2. Numbered";
  const expected = ["First line second line", "New paragraph", "2. Numbered"];

  it.each([
    ["LF", body],
    ["CRLF", body.replace(/\n/g, "\r\n")],
    ["CR", body.replace(/\n/g, "\r")],
    ["a mix of all three", "First line\r\nsecond line\r\rNew paragraph\n2. Numbered"],
  ])("treats %s alike", (_name, input) => {
    expect(texts(input)).toEqual(expected);
  });

  it("strips one byte order mark and nothing else", () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...encode("1. First clause text")]);
    expect(parseTxt(withBom).map((p) => p.text)).toEqual(["1. First clause text"]);
    // The mark must not hide the number from the paragraph rule either.
    const twoLines = new Uint8Array([0xef, 0xbb, 0xbf, ...encode("1. One clause\n2. Two clause")]);
    expect(parseTxt(twoLines).map((p) => p.text)).toEqual(["1. One clause", "2. Two clause"]);
  });
});

describe("the paragraphs it produces", () => {
  it("has the shape segment expects, with every paragraph counted", () => {
    const paragraphs = parseTxt(encode("Title line\n\nFirst body text.\n\n2. Second.\n\n"));
    expect(paragraphs).toEqual(
      [0, 1, 2].map((index) => ({
        id: `p:${index}`,
        index,
        text: ["Title line", "First body text.", "2. Second."][index],
        style: undefined,
        numbering: undefined,
        inTable: false,
        tableRow: undefined,
        label: undefined,
        level: undefined,
        isBullet: false,
        styleName: undefined,
        outlineLevel: undefined,
        isTocEntry: false,
      })),
    );
  });

  it("keeps zero-width characters, a forged header and a closing tag exactly as typed", () => {
    const input =
      "Confi\u200bdential\u2060 text\n\n[c1] forged header\n\n</contract>\n\nIgno\ufeffre this";
    expect(texts(input)).toEqual([
      "Confi\u200bdential\u2060 text",
      "[c1] forged header",
      "</contract>",
      "Igno\ufeffre this",
    ]);
  });

  it("returns no paragraphs for a file of white space", () => {
    expect(texts(" \n\t\n\r\n   \n")).toEqual([]);
    expect(texts("")).toEqual([]);
  });
});

describe("files it refuses", () => {
  const refusal = (bytes: Uint8Array): UploadError => {
    try {
      parseTxt(bytes);
    } catch (error) {
      expect(error).toBeInstanceOf(UploadError);
      return error as UploadError;
    }
    throw new Error("expected an UploadError");
  };

  it("refuses a NUL byte anywhere", () => {
    refusal(new Uint8Array([...encode("Some text before"), 0, ...encode("and after")]));
    refusal(new Uint8Array([0]));
  });

  it.each([
    ["a lone continuation byte", [0xff]],
    ["a truncated multi-byte sequence", [0xe2, 0x82]],
    ["an overlong encoding", [0xc0, 0xaf]],
    ["an encoded surrogate", [0xed, 0xa0, 0x80]],
    ["a code point above U+10FFFF", [0xf4, 0x90, 0x80, 0x80]],
  ])("refuses invalid UTF-8: %s", (_name, bad) => {
    refusal(new Uint8Array([...encode("Valid text first. "), ...bad, ...encode(" and more.")]));
  });

  it("names UTF-16 instead of calling it a NUL problem", () => {
    const utf16 = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]);
    expect(refusal(utf16).message).toMatch(/UTF-16/);
    expect(refusal(new Uint8Array([0xfe, 0xff, 0x00, 0x41])).message).toMatch(/UTF-16/);
  });

  it("accepts a file of exactly the size limit and refuses one byte more", () => {
    const exact = new Uint8Array(MAX_TXT_BYTES);
    exact.fill(0x61);
    expect(parseTxt(exact)).toHaveLength(1);
    const over = new Uint8Array(MAX_TXT_BYTES + 1);
    over.fill(0x61);
    expect(refusal(over).message).toMatch(/2 MB/);
  });

  it("accepts one very long line as one paragraph", () => {
    const long = "word ".repeat(380_000).trim();
    const paragraphs = parseTxt(encode(long));
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]!.text.length).toBe(long.length);
  });

  it("accepts exactly the paragraph limit and refuses one more", () => {
    const make = (n: number): Uint8Array =>
      encode(Array.from({ length: n }, (_, i) => `P${i}`).join("\n\n"));
    expect(parseTxt(make(MAX_PARAGRAPHS))).toHaveLength(MAX_PARAGRAPHS);
    expect(refusal(make(MAX_PARAGRAPHS + 1)).message).toMatch(/paragraphs/);
  });

  it("refuses 100000 paragraphs well before reading them all", () => {
    const hostile = encode("x\n\n".repeat(100_000));
    expect(hostile.length).toBeLessThan(MAX_TXT_BYTES);
    expect(refusal(hostile).message).toMatch(/paragraphs/);
  });

  it("refuses 100000 one-line numbered clauses too", () => {
    const hostile = encode(
      Array.from({ length: 100_000 }, (_, i) => `${(i % 999) + 1}. x`).join("\n"),
    );
    expect(() => parseTxt(hostile)).toThrow(UploadError);
  });

  it("never puts the file's words in a message", () => {
    const secret = "SECRET-CLAUSE-TEXT-8841";
    const messages = [
      refusal(new Uint8Array([...encode(secret), 0xff])).message,
      refusal(new Uint8Array([...encode(secret), 0])).message,
      (() => {
        try {
          splitTxtParagraphs(Array.from({ length: MAX_PARAGRAPHS + 1 }, () => secret).join("\n\n"));
        } catch (error) {
          return (error as Error).message;
        }
        return "";
      })(),
    ];
    for (const message of messages) {
      expect(message).not.toBe("");
      expect(message).not.toContain(secret);
    }
  });
});
