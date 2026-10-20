import { describe, expect, it } from "vitest";
import { parseDocx, type DocxParagraph } from "../src/index.js";
import { buildDocx, para, run } from "./helpers.js";

/**
 * The shapes real contracts come in, written the way Word, python-docx and LibreOffice write
 * them: numbering that lives in styles, lists linked to styles, localised style ids, a table of
 * contents, numbers kept in their own table cell.
 */

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const part = (root: string, inner: string): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${root} ${NS}>${inner}</w:${root}>`;

async function parse(
  body: string,
  parts: { numbering?: string; styles?: string } = {},
): Promise<DocxParagraph[]> {
  const extra: Record<string, string> = {};
  if (parts.numbering !== undefined)
    extra["word/numbering.xml"] = part("numbering", parts.numbering);
  if (parts.styles !== undefined) extra["word/styles.xml"] = part("styles", parts.styles);
  return (await parseDocx(await buildDocx(body, extra))).paragraphs;
}

const direct = (numId: number, ilvl: number): string =>
  `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`;
const numbered = (text: string, numId: number, ilvl: number): string =>
  para(run(text), direct(numId, ilvl));
const styled = (text: string, styleId: string): string =>
  para(run(text), `<w:pStyle w:val="${styleId}"/>`);

const shape = (ps: DocxParagraph[]) =>
  ps.map((p) => ({ label: p.label, level: p.level, bullet: p.isBullet }));

describe("articles with clauses and lettered items, numbered directly", () => {
  // ARTICLE I / Section 1.1 / (a) / (i), the layout law-firm templates and docx-js lists produce.
  const numbering =
    `<w:abstractNum w:abstractNumId="1">` +
    `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="upperRoman"/><w:lvlText w:val="ARTICLE %1"/></w:lvl>` +
    `<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:isLgl/><w:lvlText w:val="Section %1.%2"/></w:lvl>` +
    `<w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="(%3)"/></w:lvl>` +
    `<w:lvl w:ilvl="3"><w:start w:val="1"/><w:numFmt w:val="lowerRoman"/><w:lvlText w:val="(%4)"/></w:lvl>` +
    `</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>`;

  it("labels each level the way Word shows it, with the level beside the label", async () => {
    const ps = await parse(
      numbered("Definitions", 1, 0) +
        numbered("In this Agreement:", 1, 1) +
        numbered("Affiliate means a related company;", 1, 2) +
        numbered("Business Day means a weekday;", 1, 2) +
        numbered("Interpretation", 1, 1) +
        numbered("Headings do not affect meaning.", 1, 2) +
        numbered("Fees", 1, 0) +
        numbered("The Customer shall pay the Fees.", 1, 1) +
        numbered("Invoices are due in thirty days;", 1, 2) +
        numbered("Late sums bear interest.", 1, 3),
      { numbering },
    );
    expect(shape(ps)).toEqual([
      { label: "ARTICLE I", level: 0, bullet: false },
      { label: "Section 1.1", level: 1, bullet: false },
      { label: "(a)", level: 2, bullet: false },
      { label: "(b)", level: 2, bullet: false },
      { label: "Section 1.2", level: 1, bullet: false },
      { label: "(a)", level: 2, bullet: false },
      { label: "ARTICLE II", level: 0, bullet: false },
      { label: "Section 2.1", level: 1, bullet: false },
      { label: "(a)", level: 2, bullet: false },
      { label: "(i)", level: 3, bullet: false },
    ]);
    expect(ps.map((p) => p.numbering)).toEqual(
      [0, 1, 2, 2, 1, 2, 0, 1, 2, 3].map((level) => ({ id: "1", level })),
    );
  });

  it("leaves a number typed into the text to the segmenter", async () => {
    const ps = await parse(
      para(run("3.1 The Supplier shall deliver the Services.")) +
        para(run("(a) typed too")) +
        numbered("Auto numbered", 1, 1),
      { numbering },
    );
    expect(ps.map((p) => p.label)).toEqual([undefined, undefined, "Section 1.1"]);
  });
});

describe("a multilevel list linked to Heading 1, Heading 2 and Level 3 styles", () => {
  // The paragraphs carry only a style; the style carries numPr, and each list level names a style.
  const numbering =
    `<w:abstractNum w:abstractNumId="7"><w:multiLevelType w:val="multilevel"/>` +
    `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:pStyle w:val="Heading1"/><w:lvlText w:val="%1."/></w:lvl>` +
    `<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:pStyle w:val="Heading2"/><w:lvlText w:val="%1.%2"/></w:lvl>` +
    `<w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:pStyle w:val="Level3"/><w:lvlText w:val="(%3)"/></w:lvl>` +
    `</w:abstractNum><w:num w:numId="3"><w:abstractNumId w:val="7"/></w:num>`;
  const styles =
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>` +
    `<w:pPr><w:numPr><w:numId w:val="3"/></w:numPr><w:outlineLvl w:val="0"/></w:pPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>` +
    `<w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="3"/></w:numPr><w:outlineLvl w:val="1"/></w:pPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Level3"><w:name w:val="Level 3"/><w:basedOn w:val="Heading2"/>` +
    `<w:pPr><w:numPr><w:ilvl w:val="2"/><w:numId w:val="3"/></w:numPr></w:pPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="BodyIndent"><w:name w:val="Body Indent"/><w:basedOn w:val="Heading2"/></w:style>`;

  it("takes the label, level and effective numbering from the style chain", async () => {
    const ps = await parse(
      styled("Restrictions", "Heading1") +
        styled("The Customer shall not, and shall ensure that its users do not:", "Heading2") +
        styled("sublicense the Platform;", "Level3") +
        styled("resell the Platform.", "Level3") +
        styled("The Customer shall pay the Fees.", "Heading2") +
        styled("Payment", "Heading1") +
        styled("Fees are due in thirty days.", "BodyIndent"),
      { numbering, styles },
    );
    expect(shape(ps)).toEqual([
      { label: "1.", level: 0, bullet: false },
      { label: "1.1", level: 1, bullet: false },
      { label: "(a)", level: 2, bullet: false },
      { label: "(b)", level: 2, bullet: false },
      { label: "1.2", level: 1, bullet: false },
      { label: "2.", level: 0, bullet: false },
      { label: "2.1", level: 1, bullet: false },
    ]);
    expect(ps[0]!.numbering).toEqual({ id: "3", level: 0 });
    expect(ps[2]!.numbering).toEqual({ id: "3", level: 2 });
    expect(ps[6]!.numbering).toEqual({ id: "3", level: 1 });
  });

  it("reads style names and outline levels, which a derived style inherits", async () => {
    const ps = await parse(
      styled("Restrictions", "Heading1") +
        styled("Clause text", "Heading2") +
        styled("Item", "Level3") +
        styled("Indented", "BodyIndent") +
        para(run("Unstyled")),
      { numbering, styles },
    );
    expect(ps.map((p) => [p.style, p.styleName, p.outlineLevel])).toEqual([
      ["Heading1", "heading 1", 0],
      ["Heading2", "heading 2", 1],
      ["Level3", "Level 3", 1],
      ["BodyIndent", "Body Indent", 1],
      [undefined, "Normal", undefined],
    ]);
  });

  it("uses the document's own numbering when the paragraph carries a numPr of its own", async () => {
    const own =
      `<w:abstractNum w:abstractNumId="9"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="upperLetter"/><w:lvlText w:val="%1)"/></w:lvl></w:abstractNum>` +
      `<w:num w:numId="4"><w:abstractNumId w:val="9"/></w:num>`;
    const ps = await parse(
      styled("Restrictions", "Heading1") +
        para(run("Schedule item"), `<w:pStyle w:val="Heading1"/>${direct(4, 0)}`),
      { numbering: numbering + own, styles },
    );
    expect(ps.map((p) => p.label)).toEqual(["1.", "A)"]);
    expect(ps[1]!.numbering).toEqual({ id: "4", level: 0 });
  });
});

describe("a list defined once and reached through numStyleLink", () => {
  // Word's multilevel list "linked to a style": the paragraphs use a num whose abstractNum has no
  // levels, only a link to the numbering style, which names the num that holds them.
  const numbering =
    `<w:abstractNum w:abstractNumId="10"><w:styleLink w:val="ArticleList"/>` +
    `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>` +
    `<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl>` +
    `</w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="11"><w:numStyleLink w:val="ArticleList"/></w:abstractNum>` +
    `<w:num w:numId="4"><w:abstractNumId w:val="10"/></w:num>` +
    `<w:num w:numId="5"><w:abstractNumId w:val="11"/></w:num>`;
  const styles = `<w:style w:type="numbering" w:styleId="ArticleList"><w:name w:val="Article List"/><w:pPr><w:numPr><w:numId w:val="4"/></w:numPr></w:pPr></w:style>`;

  it("labels paragraphs that use either num as one list", async () => {
    const ps = await parse(
      numbered("Term", 5, 0) +
        numbered("The Agreement starts on the Effective Date.", 5, 1) +
        numbered("It continues for three years.", 4, 1) +
        numbered("Fees", 5, 0) +
        numbered("Fees are payable monthly.", 5, 1),
      { numbering, styles },
    );
    expect(ps.map((p) => p.label)).toEqual(["1.", "1.1", "1.2", "2.", "2.1"]);
    expect(ps.map((p) => p.level)).toEqual([0, 1, 1, 0, 1]);
  });
});

describe("heading styles numbered through a linked list style", () => {
  // The paragraphs name a heading style; the heading style names a num whose list is only a link
  // to a numbering style; the list itself, with the level-to-style links, lives in another one.
  const numbering =
    `<w:abstractNum w:abstractNumId="20"><w:styleLink w:val="HeadingList"/>` +
    `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:pStyle w:val="Heading1"/><w:lvlText w:val="%1."/></w:lvl>` +
    `<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:pStyle w:val="Heading2"/><w:lvlText w:val="%1.%2"/></w:lvl>` +
    `<w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:pStyle w:val="Heading3"/><w:lvlText w:val="(%3)"/></w:lvl>` +
    `</w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="21"><w:numStyleLink w:val="HeadingList"/></w:abstractNum>` +
    `<w:num w:numId="8"><w:abstractNumId w:val="20"/></w:num>` +
    `<w:num w:numId="9"><w:abstractNumId w:val="21"/></w:num>`;
  const heading = (id: string, name: string): string =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:pPr><w:numPr><w:numId w:val="9"/></w:numPr></w:pPr></w:style>`;
  const styles =
    `<w:style w:type="numbering" w:styleId="HeadingList"><w:name w:val="Heading List"/><w:pPr><w:numPr><w:numId w:val="8"/></w:numPr></w:pPr></w:style>` +
    heading("Heading1", "heading 1") +
    heading("Heading2", "heading 2") +
    heading("Heading3", "heading 3");

  it("takes labels and levels from the linked list, by the level that names the style", async () => {
    const ps = await parse(
      styled("Definitions", "Heading1") +
        styled("Interpretation", "Heading2") +
        styled("Words in the singular", "Heading3") +
        styled("Words in the plural", "Heading3") +
        styled("Fees", "Heading1") +
        styled("Payment", "Heading2"),
      { numbering, styles },
    );
    expect(shape(ps)).toEqual([
      { label: "1.", level: 0, bullet: false },
      { label: "1.1", level: 1, bullet: false },
      { label: "(a)", level: 2, bullet: false },
      { label: "(b)", level: 2, bullet: false },
      { label: "2.", level: 0, bullet: false },
      { label: "2.1", level: 1, bullet: false },
    ]);
    expect(ps.map((p) => p.numbering?.id)).toEqual(["9", "9", "9", "9", "9", "9"]);
  });
});

describe("python-docx list styles", () => {
  // The default python-docx template: List Number, List Number 2 and List Number 3 are each a
  // single-level list of their own, and the style carries a numId without any ilvl.
  const single = (abs: number, style: string): string =>
    `<w:abstractNum w:abstractNumId="${abs}"><w:multiLevelType w:val="singleLevel"/>` +
    `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:pStyle w:val="${style}"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>`;
  const numbering =
    single(3, "ListNumber") +
    single(4, "ListNumber2") +
    `<w:abstractNum w:abstractNumId="5"><w:multiLevelType w:val="singleLevel"/>` +
    `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:pStyle w:val="ListBullet"/><w:lvlText w:val="o"/></w:lvl></w:abstractNum>` +
    `<w:num w:numId="5"><w:abstractNumId w:val="3"/></w:num>` +
    `<w:num w:numId="6"><w:abstractNumId w:val="4"/></w:num>` +
    `<w:num w:numId="8"><w:abstractNumId w:val="5"/></w:num>`;
  const listStyle = (id: string, name: string, numId: number): string =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/>` +
    `<w:pPr><w:numPr><w:numId w:val="${numId}"/></w:numPr></w:pPr></w:style>`;
  const styles =
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
    listStyle("ListNumber", "List Number", 5) +
    listStyle("ListNumber2", "List Number 2", 6) +
    listStyle("ListBullet", "List Bullet", 8);

  it("numbers each style's list on its own, at level 0", async () => {
    const ps = await parse(
      styled("First", "ListNumber") +
        styled("Second", "ListNumber") +
        styled("Nested one", "ListNumber2") +
        styled("Nested two", "ListNumber2") +
        styled("Third", "ListNumber") +
        styled("Nested three", "ListNumber2") +
        styled("A bullet", "ListBullet"),
      { numbering, styles },
    );
    expect(shape(ps)).toEqual([
      { label: "1.", level: 0, bullet: false },
      { label: "2.", level: 0, bullet: false },
      { label: "1.", level: 0, bullet: false },
      { label: "2.", level: 0, bullet: false },
      { label: "3.", level: 0, bullet: false },
      { label: "3.", level: 0, bullet: false },
      { label: undefined, level: 0, bullet: true },
    ]);
    expect(ps.map((p) => p.numbering?.id)).toEqual(["5", "5", "6", "6", "5", "6", "8"]);
  });
});

describe("localised style ids", () => {
  // Word writes the canonical English name and derives the id from the localised one.
  const numbering =
    `<w:abstractNum w:abstractNumId="2">` +
    `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:pStyle w:val="Titre1"/><w:lvlText w:val="%1."/></w:lvl>` +
    `<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:pStyle w:val="Titre2"/><w:lvlText w:val="%1.%2"/></w:lvl>` +
    `</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="2"/></w:num>`;
  const named = (id: string, name: string, ilvl: number): string =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/>` +
    `<w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="1"/></w:numPr><w:outlineLvl w:val="${ilvl}"/></w:pPr></w:style>`;
  const styles =
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Titre"><w:name w:val="Title"/><w:basedOn w:val="Normal"/></w:style>` +
    named("Titre1", "heading 1", 0) +
    named("Titre2", "heading 2", 1) +
    `<w:style w:type="paragraph" w:styleId="TM1"><w:name w:val="toc 1"/><w:basedOn w:val="Normal"/></w:style>`;

  it("finds the canonical name, outline level and numbering behind a French id", async () => {
    const ps = await parse(
      styled("Titre du contrat", "Titre") +
        styled("Definitions", "Titre1") +
        styled("Objet", "Titre2") +
        styled("Sommaire", "TM1"),
      { numbering, styles },
    );
    expect(ps.map((p) => [p.style, p.styleName, p.outlineLevel, p.label, p.isTocEntry])).toEqual([
      ["Titre", "Title", undefined, undefined, false],
      ["Titre1", "heading 1", 0, "1.", false],
      ["Titre2", "heading 2", 1, "1.1", false],
      ["TM1", "toc 1", undefined, undefined, true],
    ]);
  });

  it("gives no name for a style the document does not define", async () => {
    const ps = await parse(styled("Orphan", "Gone") + styled("Heading", "Heading1"));
    expect(ps.map((p) => [p.style, p.styleName])).toEqual([
      ["Gone", undefined],
      ["Heading1", undefined],
    ]);
  });
});

describe("numbers kept in their own table cell", () => {
  it("labels the empty paragraph that holds the number and leaves the text cell alone", async () => {
    const numbering =
      `<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>` +
      `<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl></w:abstractNum>` +
      `<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>`;
    const row = (ilvl: number, text: string): string =>
      `<w:tr><w:tc>${para("", direct(1, ilvl))}</w:tc><w:tc>${para(run(text))}</w:tc></w:tr>`;
    const ps = await parse(
      `<w:tbl>${row(0, "DEFINITIONS")}${row(1, "In this Lease:")}${row(1, "Rent means the sum payable.")}${row(0, "TERM")}${row(1, "Five years.")}</w:tbl>`,
      { numbering },
    );
    expect(ps.map((p) => [p.label, p.text, p.inTable])).toEqual([
      ["1.", "", true],
      [undefined, "DEFINITIONS", true],
      ["1.1", "", true],
      [undefined, "In this Lease:", true],
      ["1.2", "", true],
      [undefined, "Rent means the sum payable.", true],
      ["2.", "", true],
      [undefined, "TERM", true],
      ["2.1", "", true],
      [undefined, "Five years.", true],
    ]);
  });
});

describe("numId 0", () => {
  const numbering =
    `<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>` +
    `<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="(%2)"/></w:lvl></w:abstractNum>` +
    `<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>`;

  it("means no list, even with a leftover ilvl", async () => {
    const ps = await parse(
      numbered("First", 1, 0) + numbered("Not a list item", 0, 1) + numbered("Second", 1, 0),
      { numbering },
    );
    expect(ps.map((p) => [p.label, p.numbering, p.level])).toEqual([
      ["1.", { id: "1", level: 0 }, 0],
      [undefined, undefined, undefined],
      ["2.", { id: "1", level: 0 }, 0],
    ]);
  });

  it("switches off the numbering a style would give", async () => {
    const styles = `<w:style w:type="paragraph" w:styleId="Clause"><w:name w:val="Clause"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>`;
    const ps = await parse(
      styled("Numbered by style", "Clause") +
        para(run("Opted out"), `<w:pStyle w:val="Clause"/>${direct(0, 0)}`),
      { numbering, styles },
    );
    expect(ps.map((p) => [p.label, p.numbering])).toEqual([
      ["1.", { id: "1", level: 0 }],
      [undefined, undefined],
    ]);
  });

  it("is what an empty numId means too, and it also beats the style", async () => {
    const styles = `<w:style w:type="paragraph" w:styleId="Clause"><w:name w:val="Clause"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>`;
    const ps = await parse(
      para(run("Opted out"), '<w:pStyle w:val="Clause"/><w:numPr><w:numId w:val=""/></w:numPr>') +
        para(run("Opted out"), '<w:pStyle w:val="Clause"/><w:numPr><w:numId/></w:numPr>'),
      { numbering, styles },
    );
    expect(ps.map((p) => [p.label, p.numbering])).toEqual([
      [undefined, undefined],
      [undefined, undefined],
    ]);
  });

  it("is also what a style can say to end a list it was based on", async () => {
    const styles =
      `<w:style w:type="paragraph" w:styleId="Clause"><w:name w:val="Clause"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>` +
      `<w:style w:type="paragraph" w:styleId="Plain"><w:name w:val="Plain"/><w:basedOn w:val="Clause"/><w:pPr><w:numPr><w:numId w:val="0"/></w:numPr></w:pPr></w:style>`;
    const ps = await parse(styled("A", "Clause") + styled("B", "Plain"), { numbering, styles });
    expect(ps.map((p) => p.numbering)).toEqual([{ id: "1", level: 0 }, undefined]);
  });
});

describe("outline levels", () => {
  const styles =
    `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="ArticleHeading"><w:name w:val="Article Heading"/><w:basedOn w:val="Heading1"/></w:style>` +
    `<w:style w:type="paragraph" w:styleId="NotAHeading"><w:name w:val="Not A Heading"/><w:basedOn w:val="Heading1"/><w:pPr><w:outlineLvl w:val="9"/></w:pPr></w:style>`;
  const withOutline = (styleId: string, level: number): string =>
    para(run("x"), `<w:pStyle w:val="${styleId}"/><w:outlineLvl w:val="${level}"/>`);

  it("comes from the paragraph, else the style chain, and 9 means body text", async () => {
    const ps = await parse(
      styled("a", "Heading1") +
        styled("b", "ArticleHeading") +
        styled("c", "NotAHeading") +
        withOutline("Heading1", 3) +
        withOutline("Heading1", 9) +
        para(run("e"), '<w:outlineLvl w:val="2"/>') +
        para(run("plain")),
      { styles },
    );
    expect(ps.map((p) => p.outlineLevel)).toEqual([0, 0, undefined, 3, undefined, 2, undefined]);
  });
});

describe("table of contents entries", () => {
  const styles =
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/></w:style>` +
    `<w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/><w:basedOn w:val="Normal"/></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Sommaire2"><w:name w:val="toc 2"/><w:basedOn w:val="Normal"/></w:style>` +
    `<w:style w:type="paragraph" w:styleId="ContentsHeading"><w:name w:val="TOC Heading"/><w:basedOn w:val="Heading1"/></w:style>` +
    `<w:style w:type="paragraph" w:styleId="FirmContents"><w:name w:val="Firm Contents"/><w:basedOn w:val="TOC1"/></w:style>`;
  const flags = (ps: DocxParagraph[]): boolean[] => ps.map((p) => p.isTocEntry);

  it("recognises a style named toc N or TOC Heading, also further up the basedOn chain", async () => {
    const ps = await parse(
      styled("Contents", "ContentsHeading") +
        styled("1. Definitions 3", "TOC1") +
        styled("1.1 Scope 3", "Sommaire2") +
        styled("Firm entry", "FirmContents") +
        styled("1. Definitions", "Heading1") +
        para(run("Contents")),
      { styles },
    );
    expect(flags(ps)).toEqual([true, true, true, true, false, false]);
  });

  it("falls back to the id of a TOC style the file does not define", async () => {
    const ps = await parse(
      styled("Entry", "TOC1") + styled("Entry", "TOC3") + styled("Other", "TOCAmounts"),
    );
    expect(flags(ps)).toEqual([true, true, false]);
  });

  it("recognises everything inside a Table of Contents content control", async () => {
    const control = (gallery: string, inner: string): string =>
      `<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="${gallery}"/><w:docPartUnique/></w:docPartObj></w:sdtPr><w:sdtContent>${inner}</w:sdtContent></w:sdt>`;
    const ps = await parse(
      para(run("Preamble")) +
        control("Table of Contents", para(run("Plain 1")) + para(run("Plain 2"))) +
        control("Cover Pages", para(run("Cover"))) +
        para(run("After")),
    );
    expect(flags(ps)).toEqual([false, true, true, false, false]);
  });

  const field = (kind: "begin" | "separate" | "end"): string =>
    `<w:r><w:fldChar w:fldCharType="${kind}"/></w:r>`;
  const instr = (text: string): string =>
    `<w:r><w:instrText xml:space="preserve"> ${text} </w:instrText></w:r>`;

  it("recognises the paragraphs between a TOC field's begin and end, nested fields included", async () => {
    const entry = (title: string): string =>
      `<w:hyperlink w:anchor="_Toc1">${run(title)}${field("begin")}${instr("PAGEREF _Toc1 \\h")}${field("separate")}${run("3")}${field("end")}</w:hyperlink>`;
    const ps = await parse(
      para(run("Before")) +
        para(
          field("begin") +
            instr('TOC \\o "1-3" \\h \\z \\u') +
            field("separate") +
            entry("Definitions"),
        ) +
        para(entry("Fees")) +
        para(entry("Term")) +
        para(field("end")) +
        para(run("After")),
    );
    expect(flags(ps)).toEqual([false, true, true, true, true, false]);
  });

  it("recognises a TOC held in a simple field", async () => {
    const ps = await parse(
      para(run("Before")) +
        para(`<w:fldSimple w:instr=' TOC \\o "1-3" '>${run("1. Definitions 3")}</w:fldSimple>`) +
        para(run("After")),
    );
    expect(flags(ps)).toEqual([false, true, false]);
  });

  it("does not mistake other fields for a table of contents", async () => {
    const ps = await parse(
      para(
        field("begin") +
          instr("REF _Ref9 \\h") +
          field("separate") +
          run("clause 4") +
          field("end"),
      ) +
        para(field("begin") + instr("TOA \\h") + field("separate")) +
        para(run("inside")) +
        para(field("end")) +
        para(run("after")),
    );
    expect(flags(ps)).toEqual([false, false, false, false, false]);
  });

  it("does not trust a TOC field that never ends", async () => {
    const ps = await parse(
      para(field("begin") + instr("TOC \\o 1-3") + field("separate") + run("1. Definitions 3")) +
        para(run("This Agreement is made on 1 March 2026.")) +
        para(run("The Supplier shall deliver the Services.")),
    );
    expect(flags(ps)).toEqual([false, false, false]);
  });

  it("ignores a TOC field inside text that was deleted with tracked changes", async () => {
    const meta = 'w:id="1" w:author="a" w:date="2026-01-01T00:00:00Z"';
    const ps = await parse(
      para(
        `<w:del ${meta}>${field("begin")}${instr("TOC \\o 1-3")}${field("separate")}</w:del>` +
          run("Kept text") +
          `<w:del ${meta}>${field("end")}</w:del>`,
      ) + para(run("Next")),
    );
    expect(flags(ps)).toEqual([false, false]);
  });
});

describe("the other fields of a paragraph", () => {
  it("are all computed for every paragraph, also when styles.xml and numbering.xml are absent", async () => {
    const ps = await parse(para(run("Plain")) + styled("Styled", "Heading1"));
    expect(ps.map((p) => ({ ...p, text: undefined, id: undefined }))).toEqual([
      {
        id: undefined,
        index: 0,
        text: undefined,
        style: undefined,
        numbering: undefined,
        inTable: false,
        label: undefined,
        level: undefined,
        isBullet: false,
        styleName: undefined,
        outlineLevel: undefined,
        isTocEntry: false,
      },
      {
        id: undefined,
        index: 1,
        text: undefined,
        style: "Heading1",
        numbering: undefined,
        inTable: false,
        label: undefined,
        level: undefined,
        isBullet: false,
        styleName: undefined,
        outlineLevel: undefined,
        isTocEntry: false,
      },
    ]);
  });
});
