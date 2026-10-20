import { describe, expect, it } from "vitest";
import { parseDocx } from "../src/index.js";
import { buildDocx, para, run } from "./helpers.js";

/**
 * Each case is a tiny document with its numbering.xml and styles.xml written out, and the labels
 * Word shows written down by hand from ECMA-376 17.9. The LibreOffice agreement test renders
 * documents of the same kind, so what is written here is not just the implementation talking.
 */

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

interface LvlOptions {
  /** null leaves w:start out. */
  start?: number | string | null;
  pStyle?: string;
  isLgl?: boolean;
  restart?: number;
}

const lvl = (ilvl: number, numFmt: string, text: string, o: LvlOptions = {}): string =>
  `<w:lvl w:ilvl="${ilvl}">` +
  (o.start === null ? "" : `<w:start w:val="${o.start ?? 1}"/>`) +
  `<w:numFmt w:val="${numFmt}"/>` +
  (o.restart === undefined ? "" : `<w:lvlRestart w:val="${o.restart}"/>`) +
  (o.pStyle ? `<w:pStyle w:val="${o.pStyle}"/>` : "") +
  (o.isLgl ? "<w:isLgl/>" : "") +
  `<w:lvlText w:val="${esc(text)}"/></w:lvl>`;

const abstractNum = (id: number, levels: string[], extra = ""): string =>
  `<w:abstractNum w:abstractNumId="${id}">${extra}${levels.join("")}</w:abstractNum>`;
const num = (id: number, abstractId: number, overrides = ""): string =>
  `<w:num w:numId="${id}"><w:abstractNumId w:val="${abstractId}"/>${overrides}</w:num>`;
const override = (ilvl: number, start?: number, replacement = ""): string =>
  `<w:lvlOverride w:ilvl="${ilvl}">${
    start === undefined ? "" : `<w:startOverride w:val="${start}"/>`
  }${replacement}</w:lvlOverride>`;

const styleDef = (
  id: string,
  name: string,
  o: { basedOn?: string; numId?: number; ilvl?: number } = {},
): string => {
  const numPr =
    o.numId === undefined && o.ilvl === undefined
      ? ""
      : `<w:pPr><w:numPr>${o.ilvl === undefined ? "" : `<w:ilvl w:val="${o.ilvl}"/>`}${
          o.numId === undefined ? "" : `<w:numId w:val="${o.numId}"/>`
        }</w:numPr></w:pPr>`;
  return (
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>` +
    (o.basedOn ? `<w:basedOn w:val="${o.basedOn}"/>` : "") +
    `${numPr}</w:style>`
  );
};

const part = (root: string, inner: string): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${root} ${NS}>${inner}</w:${root}>`;

let counter = 0;
const text = (): string => run(`Paragraph ${++counter}`);

/** A paragraph with its own numPr. */
const item = (numId: number, ilvl: number, extraPPr = ""): string =>
  para(
    text(),
    `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>${extraPPr}`,
  );
/** A paragraph that only names a style. */
const styled = (styleId: string, extraPPr = ""): string =>
  para(text(), `<w:pStyle w:val="${styleId}"/>${extraPPr}`);
const plain = (): string => para(text());

type Mark = "del" | "ins";
/** A numbered paragraph whose mark is a tracked deletion or insertion. */
function tracked(numId: number, ilvl: number, mark: Mark): string {
  const meta = 'w:id="9" w:author="a" w:date="2026-01-01T00:00:00Z"';
  const inner =
    mark === "del"
      ? `<w:del ${meta}><w:r><w:delText>gone</w:delText></w:r></w:del>`
      : `<w:ins ${meta}>${text()}</w:ins>`;
  return para(
    inner,
    `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr><w:rPr><w:${mark} ${meta}/></w:rPr>`,
  );
}

async function labels(
  body: string[],
  parts: { numbering?: string; styles?: string } = {},
): Promise<(string | undefined)[]> {
  const extra: Record<string, string> = {};
  if (parts.numbering !== undefined)
    extra["word/numbering.xml"] = part("numbering", parts.numbering);
  if (parts.styles !== undefined) extra["word/styles.xml"] = part("styles", parts.styles);
  const buf = await buildDocx(body.join(""), extra);
  return (await parseDocx(buf)).paragraphs.map((p) => p.label);
}

interface Case {
  name: string;
  numbering: string;
  styles?: string;
  body: () => string[];
  expected: (string | undefined)[];
}

const levels = (numId: number, ...ilvls: number[]): string[] => ilvls.map((l) => item(numId, l));
const repeat = (n: number, make: () => string): string[] => Array.from({ length: n }, make);

/** 1. / 1.1 / (a) / (i), the shape of most legal multilevel lists. */
const legalList = (...more: string[]): string =>
  abstractNum(1, [
    lvl(0, "decimal", "%1."),
    lvl(1, "decimal", "%1.%2"),
    lvl(2, "lowerLetter", "(%3)"),
    lvl(3, "lowerRoman", "(%4)"),
    ...more,
  ]);

const single = (numFmt: string, lvlText = "%1.", o: LvlOptions = {}): string =>
  abstractNum(1, [lvl(0, numFmt, lvlText, o)]) + num(1, 1);

const CASES: Case[] = [
  {
    name: "lower levels restart when a higher level appears",
    numbering: legalList() + num(1, 1),
    body: () => levels(1, 0, 1, 2, 3, 3, 2, 1, 0, 1, 2),
    expected: ["1.", "1.1", "(a)", "(i)", "(ii)", "(b)", "1.2", "2.", "2.1", "(a)"],
  },
  {
    name: "paragraphs outside the list do not break it",
    numbering: legalList() + num(1, 1),
    body: () => [
      item(1, 0),
      item(1, 1),
      plain(),
      item(1, 1),
      plain(),
      plain(),
      item(1, 2),
      item(1, 1),
    ],
    expected: ["1.", "1.1", undefined, "1.2", undefined, undefined, "(a)", "1.3"],
  },
  {
    name: "a skipped level counts as used once",
    numbering: legalList() + num(1, 1),
    body: () => levels(1, 0, 2, 2, 1, 2),
    expected: ["1.", "(a)", "(b)", "1.2", "(a)"],
  },
  {
    name: "w:start sets the first value and startOverride restarts another instance",
    numbering:
      abstractNum(1, [
        lvl(0, "decimal", "%1.", { start: 3 }),
        lvl(1, "lowerLetter", "(%2)", { start: 2 }),
      ]) +
      num(1, 1) +
      num(2, 1, override(0, 10)),
    body: () => [...levels(1, 0, 1, 1, 0), ...levels(2, 0, 0)],
    expected: ["3.", "(b)", "(c)", "4.", "10.", "11."],
  },
  {
    name: "nums on one abstractNum without settings of their own continue each other",
    numbering: abstractNum(1, [lvl(0, "decimal", "%1.")]) + num(1, 1) + num(2, 1),
    body: () => [...levels(1, 0, 0), ...levels(2, 0, 0)],
    expected: ["1.", "2.", "3.", "4."],
  },
  {
    name: "letters run on after z by repeating the letter",
    numbering: single("lowerLetter", "(%1)"),
    body: () => repeat(28, () => item(1, 0)),
    expected: [..."abcdefghijklmnopqrstuvwxyz"].map((c) => `(${c})`).concat(["(aa)", "(bb)"]),
  },
  {
    name: "upper letters",
    numbering: single("upperLetter", "%1)"),
    body: () => repeat(3, () => item(1, 0)),
    expected: ["A)", "B)", "C)"],
  },
  {
    name: "upper roman numerals",
    numbering: single("upperRoman"),
    body: () => repeat(14, () => item(1, 0)),
    expected: [
      "I.",
      "II.",
      "III.",
      "IV.",
      "V.",
      "VI.",
      "VII.",
      "VIII.",
      "IX.",
      "X.",
      "XI.",
      "XII.",
      "XIII.",
      "XIV.",
    ],
  },
  {
    name: "lower roman numerals",
    numbering: single("lowerRoman"),
    body: () => repeat(4, () => item(1, 0)),
    expected: ["i.", "ii.", "iii.", "iv."],
  },
  {
    name: "decimalZero pads single digits only",
    numbering: single("decimalZero"),
    body: () => repeat(11, () => item(1, 0)),
    expected: ["01.", "02.", "03.", "04.", "05.", "06.", "07.", "08.", "09.", "10.", "11."],
  },
  {
    name: "ordinal numbers and number words",
    numbering:
      abstractNum(1, [lvl(0, "ordinalText", "%1")]) +
      num(1, 1) +
      abstractNum(2, [lvl(0, "cardinalText", "%1")]) +
      num(2, 2) +
      abstractNum(3, [lvl(0, "ordinal", "%1")]) +
      num(3, 3),
    body: () => [...levels(1, 0, 0), ...levels(2, 0, 0), ...repeat(13, () => item(3, 0))],
    expected: [
      "First",
      "Second",
      "One",
      "Two",
      ...[
        "1st",
        "2nd",
        "3rd",
        "4th",
        "5th",
        "6th",
        "7th",
        "8th",
        "9th",
        "10th",
        "11th",
        "12th",
        "13th",
      ],
    ],
  },
  {
    name: "ordinals 21 to 23 end in st, nd and rd again",
    numbering: single("ordinal", "%1", { start: 21 }),
    body: () => repeat(4, () => item(1, 0)),
    expected: ["21st", "22nd", "23rd", "24th"],
  },
  {
    name: "isLgl prints the earlier levels as Arabic numerals",
    numbering:
      abstractNum(1, [
        lvl(0, "upperRoman", "ARTICLE %1"),
        lvl(1, "decimal", "%1.%2", { isLgl: true }),
      ]) +
      num(1, 1) +
      abstractNum(2, [lvl(0, "upperRoman", "ARTICLE %1"), lvl(1, "decimal", "%1.%2")]) +
      num(2, 2),
    body: () => [...levels(1, 0, 1, 1, 0, 1), ...levels(2, 0, 1)],
    expected: ["ARTICLE I", "1.1", "1.2", "ARTICLE II", "2.1", "ARTICLE I", "I.1"],
  },
  {
    name: "isLgl leaves decimalZero as it is",
    numbering:
      abstractNum(1, [lvl(0, "decimalZero", "%1"), lvl(1, "decimal", "%1.%2", { isLgl: true })]) +
      num(1, 1),
    body: () => levels(1, 0, 1),
    expected: ["01", "01.1"],
  },
  {
    name: "lvlText with words, several placeholders and a bullet level",
    numbering:
      abstractNum(1, [
        lvl(0, "decimal", "Clause %1"),
        lvl(1, "decimal", "Clause %1.%2"),
        lvl(2, "decimal", "%1.%2.%3"),
        lvl(3, "lowerLetter", "%1.%2.%3(%4)"),
        lvl(4, "bullet", "-"),
      ]) + num(1, 1),
    body: () => levels(1, 0, 1, 2, 3, 3, 4, 1),
    expected: ["Clause 1", "Clause 1.1", "1.1.1", "1.1.1(a)", "1.1.1(b)", undefined, "Clause 1.2"],
  },
  {
    name: "lvlRestart follows ECMA-376: 1 restarts after level 0 only, 0 never restarts",
    numbering:
      abstractNum(1, [
        lvl(0, "decimal", "%1."),
        lvl(1, "decimal", "%1.%2"),
        lvl(2, "lowerLetter", "(%3)", { restart: 1 }),
        lvl(3, "lowerRoman", "(%4)", { restart: 0 }),
      ]) + num(1, 1),
    body: () => levels(1, 0, 1, 2, 2, 1, 2, 3, 3, 1, 3, 0, 1, 2, 3),
    expected: [
      "1.",
      "1.1",
      "(a)",
      "(b)",
      "1.2",
      "(c)",
      "(i)",
      "(ii)",
      "1.3",
      "(iii)",
      "2.",
      "2.1",
      "(a)",
      "(iv)",
    ],
  },
  {
    name: "a level that shows nothing still counts",
    numbering: abstractNum(1, [lvl(0, "decimal", "%1."), lvl(1, "none", "")]) + num(1, 1),
    body: () => levels(1, 0, 1, 0),
    expected: ["1.", undefined, "2."],
  },
  {
    name: "an absent w:start means 0, as ECMA-376 says",
    numbering: abstractNum(1, [lvl(0, "decimal", "%1.", { start: null })]) + num(1, 1),
    body: () => levels(1, 0, 0),
    expected: ["0.", "1."],
  },
  {
    name: "startOverride restarts the level for its own instance only",
    numbering:
      abstractNum(1, [lvl(0, "decimal", "%1."), lvl(1, "decimal", "%1.%2")]) +
      num(1, 1) +
      num(2, 1, override(0, 1)),
    body: () => [...levels(1, 0, 1, 0, 1), ...levels(2, 0, 1, 1)],
    expected: ["1.", "1.1", "2.", "2.1", "1.", "1.1", "1.2"],
  },
  {
    name: "a lvlOverride can replace the level definition",
    numbering:
      abstractNum(1, [lvl(0, "decimal", "%1.")]) +
      num(1, 1) +
      num(2, 1, override(0, 1, lvl(0, "upperLetter", "%1)"))),
    body: () => [...levels(1, 0, 0), ...levels(2, 0, 0)],
    expected: ["1.", "2.", "A)", "B)"],
  },
  {
    name: "Accept All view: a deleted paragraph mark does not count, an inserted one does",
    numbering: legalList() + num(1, 1),
    body: () => [item(1, 0), tracked(1, 1, "del"), item(1, 1), tracked(1, 1, "ins"), item(1, 0)],
    expected: ["1.", undefined, "1.1", "1.2", "2."],
  },
  {
    name: "empty paragraphs and table cells count in document order",
    numbering: abstractNum(1, [lvl(0, "decimal", "%1.")]) + num(1, 1),
    body: () => [
      item(1, 0),
      para("", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
      `<w:tbl><w:tr><w:tc>${item(1, 0)}</w:tc><w:tc>${item(1, 0)}</w:tc></w:tr><w:tr><w:tc>${item(1, 0)}</w:tc></w:tr></w:tbl>`,
      item(1, 0),
    ],
    expected: ["1.", "2.", "3.", "4.", "5.", "6."],
  },
  {
    name: "numbering from styles, a basedOn chain, and numId 0 on the paragraph",
    numbering:
      abstractNum(1, [
        lvl(0, "decimal", "%1.", { pStyle: "H1" }),
        lvl(1, "decimal", "%1.%2", { pStyle: "H2" }),
        lvl(2, "lowerLetter", "(%3)"),
      ]) + num(1, 1),
    styles:
      styleDef("Normal", "Normal") +
      styleDef("H1", "heading 1", { basedOn: "Normal", numId: 1 }) +
      styleDef("H2", "heading 2", { basedOn: "Normal", numId: 1, ilvl: 1 }) +
      styleDef("Body2", "Body 2", { basedOn: "H2" }) +
      styleDef("L3", "Level 3", { basedOn: "Normal", numId: 1, ilvl: 2 }),
    body: () => [
      styled("H1"),
      styled("H2"),
      styled("Body2"),
      styled("L3"),
      styled("L3"),
      styled("Body2"),
      styled("H1"),
      styled("H2"),
      styled("Body2", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr>'),
      styled("Body2"),
    ],
    expected: ["1.", "1.1", "1.2", "(a)", "(b)", "1.3", "2.", "2.1", undefined, "2.2"],
  },
  {
    name: "a style that carries only numId takes its level from the level that names the style",
    numbering:
      abstractNum(1, [
        lvl(0, "decimal", "%1.", { pStyle: "H1" }),
        lvl(1, "decimal", "%1.%2", { pStyle: "H2" }),
      ]) + num(1, 1),
    styles:
      styleDef("H1", "heading 1", { numId: 1 }) +
      styleDef("H2", "heading 2", { numId: 1 }) +
      styleDef("Sub", "Sub", { basedOn: "H2" }),
    body: () => [styled("H1"), styled("H2"), styled("Sub"), styled("H1"), styled("H2")],
    expected: ["1.", "1.1", "1.2", "2.", "2.1"],
  },
  {
    name: "a direct ilvl is combined with the numId of the style",
    numbering: legalList() + num(1, 1),
    styles: styleDef("ListStyle", "List Style", { numId: 1 }),
    body: () => [
      styled("ListStyle", '<w:numPr><w:ilvl w:val="0"/></w:numPr>'),
      styled("ListStyle", '<w:numPr><w:ilvl w:val="1"/></w:numPr>'),
      styled("ListStyle", '<w:numPr><w:ilvl w:val="1"/></w:numPr>'),
    ],
    expected: ["1.", "1.1", "1.2"],
  },
  {
    name: "numStyleLink: the list is defined by the abstractNum the numbering style points at",
    numbering:
      `<w:abstractNum w:abstractNumId="1"><w:numStyleLink w:val="LegalList"/></w:abstractNum>` +
      abstractNum(
        2,
        [lvl(0, "decimal", "%1."), lvl(1, "decimal", "%1.%2")],
        '<w:styleLink w:val="LegalList"/>',
      ) +
      num(1, 1) +
      num(2, 2),
    styles: `<w:style w:type="numbering" w:styleId="LegalList"><w:name w:val="Legal List"/><w:pPr><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr></w:style>`,
    body: () => levels(1, 0, 1, 1, 0, 1),
    expected: ["1.", "1.1", "1.2", "2.", "2.1"],
  },
  {
    name: "numStyleLink finds the list by its styleLink when the numbering style is missing",
    numbering:
      `<w:abstractNum w:abstractNumId="1"><w:numStyleLink w:val="LegalList"/></w:abstractNum>` +
      abstractNum(
        2,
        [lvl(0, "decimal", "%1."), lvl(1, "decimal", "%1.%2")],
        '<w:styleLink w:val="LegalList"/>',
      ) +
      num(1, 1) +
      num(2, 2),
    body: () => levels(1, 0, 1, 0),
    expected: ["1.", "1.1", "2."],
  },
  {
    name: "typed numbers are not labels",
    numbering: legalList() + num(1, 1),
    body: () => [para(run("1.1 Typed in the text")), item(1, 0), para(run("(a) Typed too"))],
    expected: [undefined, "1.", undefined],
  },
];

describe("list labels from numbering.xml and styles.xml", () => {
  it.each(CASES)("$name", async (c) => {
    counter = 0;
    const parts: { numbering: string; styles?: string } = { numbering: c.numbering };
    if (c.styles !== undefined) parts.styles = c.styles;
    expect(await labels(c.body(), parts)).toEqual(c.expected);
  });
});

describe("what is left undefined, and why", () => {
  it("bullets have no label but are marked as bullets, at every level", async () => {
    const numbering = abstractNum(1, [lvl(0, "bullet", "o"), lvl(1, "bullet", "-")]) + num(1, 1);
    const buf = await buildDocx([item(1, 0), item(1, 1), plain()].join(""), {
      "word/numbering.xml": part("numbering", numbering),
    });
    const ps = (await parseDocx(buf)).paragraphs;
    expect(ps.map((p) => [p.label, p.isBullet, p.level])).toEqual([
      [undefined, true, 0],
      [undefined, true, 1],
      [undefined, false, undefined],
    ]);
  });

  it("a bullet level does not take a counter, so a number after it is not shifted", async () => {
    const numbering =
      abstractNum(1, [lvl(0, "decimal", "%1."), lvl(1, "bullet", "-"), lvl(2, "decimal", "%3.")]) +
      num(1, 1);
    expect(await labels(levels(1, 0, 1, 1, 2), { numbering })).toEqual([
      "1.",
      undefined,
      undefined,
      "1.",
    ]);
  });

  it("a format that is not modelled gives no label, and the list keeps counting", async () => {
    const numbering =
      abstractNum(1, [lvl(0, "decimal", "%1."), lvl(1, "japaneseCounting", "(%2)")]) + num(1, 1);
    expect(await labels(levels(1, 0, 1, 1, 0), { numbering })).toEqual([
      "1.",
      undefined,
      undefined,
      "2.",
    ]);
  });

  it("a label that names a level in an unmodelled format is not guessed", async () => {
    const numbering =
      abstractNum(1, [lvl(0, "ideographTraditional", "%1"), lvl(1, "decimal", "%1.%2")]) +
      num(1, 1);
    expect(await labels(levels(1, 0, 1), { numbering })).toEqual([undefined, undefined]);
  });

  it("a roman numeral beyond 3999 is not guessed", async () => {
    const numbering = single("upperRoman", "%1.", { start: 3999 });
    expect(await labels(levels(1, 0, 0), { numbering })).toEqual(["MMMCMXCIX.", undefined]);
  });

  it("a start value that is not a number makes the level unusable", async () => {
    const numbering = single("decimal", "%1.", { start: "three" });
    expect(await labels(levels(1, 0, 0), { numbering })).toEqual([undefined, undefined]);
  });

  it("an enormous start value cannot make a letter label enormous", async () => {
    const numbering = single("lowerLetter", "%1.", { start: 999999999 });
    expect(await labels(levels(1, 0), { numbering })).toEqual([undefined]);
  });

  it("a number format text longer than Word allows gives no label", async () => {
    const numbering = single("decimal", `${"x".repeat(300)}%1`);
    expect(await labels(levels(1, 0), { numbering })).toEqual([undefined]);
  });

  it("a level the list does not define, or a num it does not know, gives no label", async () => {
    const numbering = abstractNum(1, [lvl(0, "decimal", "%1.")]) + num(1, 1);
    expect(await labels([item(1, 0), item(1, 4), item(9, 0)], { numbering })).toEqual([
      "1.",
      undefined,
      undefined,
    ]);
  });

  it("a num without an abstractNum, and an abstractNum without levels, give no label", async () => {
    const numbering = `<w:num w:numId="1"/>` + `<w:abstractNum w:abstractNumId="3"/>` + num(2, 3);
    expect(await labels([item(1, 0), item(2, 0)], { numbering })).toEqual([undefined, undefined]);
  });

  it("without a numbering part there are no labels, and nothing throws", async () => {
    expect(await labels([item(1, 0), item(1, 1)])).toEqual([undefined, undefined]);
  });

  it("a numbering part that is not XML is ignored while the styles part still works", async () => {
    const buf = await buildDocx(styled("H1"), {
      "word/numbering.xml": "<w:numbering><w:abstractNum",
      "word/styles.xml": part("styles", styleDef("H1", "heading 1", { numId: 1 })),
    });
    const [p] = (await parseDocx(buf)).paragraphs;
    expect(p).toMatchObject({
      label: undefined,
      styleName: "heading 1",
      numbering: { id: "1", level: 0 },
    });
  });

  it("a styles part that is not XML is ignored while the numbering still works", async () => {
    const numbering = abstractNum(1, [lvl(0, "decimal", "%1.")]) + num(1, 1);
    const buf = await buildDocx(item(1, 0), {
      "word/numbering.xml": part("numbering", numbering),
      "word/styles.xml": "not xml at all <<<",
    });
    expect((await parseDocx(buf)).paragraphs[0]).toMatchObject({
      label: "1.",
      styleName: undefined,
    });
  });

  it("styles that are based on each other in a circle do not hang", async () => {
    const styles = styleDef("A", "A", { basedOn: "B" }) + styleDef("B", "B", { basedOn: "A" });
    expect(await labels([styled("A"), styled("B")], { styles })).toEqual([undefined, undefined]);
  });

  it("numbering styles that point at each other in a circle do not hang", async () => {
    const numbering =
      `<w:abstractNum w:abstractNumId="1"><w:numStyleLink w:val="Loop"/></w:abstractNum>` +
      num(1, 1);
    const styles = `<w:style w:type="numbering" w:styleId="Loop"><w:name w:val="Loop"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>`;
    expect(await labels(levels(1, 0), { numbering, styles })).toEqual([undefined]);
  });

  it("numPr inside a recorded paragraph property change is not the paragraph's numbering", async () => {
    const numbering = abstractNum(1, [lvl(0, "decimal", "%1.")]) + num(1, 1);
    const changed = para(
      text(),
      '<w:pPrChange w:id="5" w:author="a" w:date="2026-01-01T00:00:00Z"><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr></w:pPrChange>',
    );
    const buf = await buildDocx(changed, { "word/numbering.xml": part("numbering", numbering) });
    expect((await parseDocx(buf)).paragraphs[0]).toMatchObject({
      label: undefined,
      numbering: undefined,
      level: undefined,
    });
  });
});

describe("paragraphs that take no part in the numbering of the body", () => {
  const numbering = abstractNum(1, [lvl(0, "decimal", "%1.")]) + num(1, 1);

  it("a text box is a separate story: its paragraphs get no label and do not advance the body list", async () => {
    counter = 0;
    const box = para(
      run("Outer") + `<w:r><w:pict><w:txbxContent>${item(1, 0)}</w:txbxContent></w:pict></w:r>`,
    );
    expect(await labels([item(1, 0), box, item(1, 0)], { numbering })).toEqual([
      "1.",
      undefined,
      undefined,
      "2.",
    ]);
  });

  it("mc:Fallback repeats mc:Choice, so only the choice is counted", async () => {
    const copy = (name: string): string =>
      para(run(name), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>');
    const alternate =
      '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
      `<mc:Choice Requires="w14">${copy("choice")}</mc:Choice>` +
      `<mc:Fallback>${copy("fallback")}</mc:Fallback></mc:AlternateContent>`;
    const buf = await buildDocx([copy("before"), alternate, copy("after")].join(""), {
      "word/numbering.xml": part("numbering", numbering),
    });
    // Whether the engine lists the fallback copy at all is its business; if it does, it has no label.
    const byText = new Map((await parseDocx(buf)).paragraphs.map((p) => [p.text, p.label]));
    expect([byText.get("before"), byText.get("choice"), byText.get("after")]).toEqual([
      "1.",
      "2.",
      "3.",
    ]);
    if (byText.has("fallback")) expect(byText.get("fallback")).toBeUndefined();
  });

  it("content controls are transparent", async () => {
    counter = 0;
    const control = `<w:sdt><w:sdtPr/><w:sdtContent>${item(1, 0)}</w:sdtContent></w:sdt>`;
    expect(await labels([item(1, 0), control, item(1, 0)], { numbering })).toEqual([
      "1.",
      "2.",
      "3.",
    ]);
  });
});
