import { parseDocx } from "@clausewise/docx";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { segment } from "../src/segment.js";
import type { Clause } from "../src/types.js";

/**
 * The whole chain: a .docx is built from document.xml, styles.xml and numbering.xml the way Word,
 * python-docx and docx-js write them, read with parseDocx and cut into clauses. Nothing here is
 * typed into the text: every number the lawyer sees in Word is computed from the numbering part.
 */

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const part = (root: string, inner: string): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${root} ${NS}>${inner}</w:${root}>`;

async function clausesOf(
  body: string,
  parts: { styles?: string; numbering?: string } = {},
): Promise<Clause[]> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/_rels/document.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>',
  );
  zip.file("word/document.xml", part("document", `<w:body>${body}</w:body>`));
  if (parts.styles !== undefined) zip.file("word/styles.xml", part("styles", parts.styles));
  if (parts.numbering !== undefined) {
    zip.file("word/numbering.xml", part("numbering", parts.numbering));
  }
  const bytes = await zip.generateAsync({ type: "uint8array" });
  return segment((await parseDocx(bytes)).paragraphs);
}

const esc = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const run = (text: string): string => `<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const para = (text: string, pPr = ""): string =>
  `<w:p>${pPr === "" ? "" : `<w:pPr>${pPr}</w:pPr>`}${run(text)}</w:p>`;
const emptyPara = (pPr: string): string => `<w:p><w:pPr>${pPr}</w:pPr></w:p>`;
const numPr = (numId: number, ilvl?: number): string =>
  `<w:numPr>${ilvl === undefined ? "" : `<w:ilvl w:val="${ilvl}"/>`}<w:numId w:val="${numId}"/></w:numPr>`;
const styled = (text: string, styleId: string): string =>
  para(text, `<w:pStyle w:val="${styleId}"/>`);
const style = (id: string, name: string, inner = "", basedOn = "Normal"): string =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="${basedOn}"/>${inner}</w:style>`;
const NORMAL = `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>`;
const level = (ilvl: number, numFmt: string, lvlText: string, extra = ""): string =>
  `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${numFmt}"/>${extra}<w:lvlText w:val="${lvlText}"/></w:lvl>`;

const summary = (clauses: Clause[]) =>
  clauses.map((c) => ({
    number: c.number,
    heading: c.heading,
    paragraphs: c.paragraphs.length,
    text: c.paragraphs[0]?.text,
  }));

describe("a contract numbered article / clause / item with direct numbering", () => {
  const numbering =
    `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="multilevel"/>` +
    level(0, "decimal", "%1.") +
    level(1, "decimal", "%1.%2") +
    level(2, "lowerLetter", "(%3)") +
    `</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>`;
  const styles =
    NORMAL +
    style("Heading1", "heading 1", `<w:pPr><w:outlineLvl w:val="0"/></w:pPr>`) +
    style("ListParagraph", "List Paragraph");

  it("gives one clause per clause, with the number Word shows and the article as its section", async () => {
    const clauses = await clausesOf(
      para("Services", `<w:pStyle w:val="Heading1"/>${numPr(1, 0)}`) +
        para("Provider shall deliver the Services.", numPr(1, 1)) +
        para("Each Statement of Work shall state:", numPr(1, 1)) +
        para("the scope of the Services;", numPr(1, 2)) +
        para("the timetable.", numPr(1, 2)) +
        para("Provider shall invoice monthly in arrears.", numPr(1, 1)) +
        para("Fees", `<w:pStyle w:val="Heading1"/>${numPr(1, 0)}`) +
        para("Customer shall pay the Fees.", numPr(1, 1)) +
        para("Fees are exclusive of tax.", numPr(1, 1)),
      { numbering, styles },
    );
    expect(summary(clauses)).toEqual([
      {
        number: "1.1",
        heading: "1. Services",
        paragraphs: 1,
        text: "Provider shall deliver the Services.",
      },
      {
        number: "1.2",
        heading: "1. Services",
        paragraphs: 3,
        text: "Each Statement of Work shall state:",
      },
      {
        number: "1.3",
        heading: "1. Services",
        paragraphs: 1,
        text: "Provider shall invoice monthly in arrears.",
      },
      { number: "2.1", heading: "2. Fees", paragraphs: 1, text: "Customer shall pay the Fees." },
      { number: "2.2", heading: "2. Fees", paragraphs: 1, text: "Fees are exclusive of tax." },
    ]);
  });

  it("keeps the numbers right when a list continues across a table and unnumbered text", async () => {
    const clauses = await clausesOf(
      para("Services", `<w:pStyle w:val="Heading1"/>${numPr(1, 0)}`) +
        para("Provider shall deliver the Services.", numPr(1, 1)) +
        para('"Services" means the services in Schedule 1.') +
        para("Provider shall invoice monthly.", numPr(1, 1)),
      { numbering, styles },
    );
    expect(clauses.map((c) => c.number)).toEqual(["1.1", undefined, "1.2"]);
  });
});

describe("a contract numbered ARTICLE I / Section 1.01 / (a)", () => {
  const numbering =
    `<w:abstractNum w:abstractNumId="2"><w:multiLevelType w:val="multilevel"/>` +
    level(0, "upperRoman", "ARTICLE %1") +
    level(1, "decimalZero", "Section %1.%2", "<w:isLgl/>") +
    level(2, "lowerLetter", "(%3)") +
    `</w:abstractNum><w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>`;

  it("strips the words Article and Section from the numbers and keeps them in the headings", async () => {
    const clauses = await clausesOf(
      para("Definitions", numPr(2, 0)) +
        para("In this Agreement:", numPr(2, 1)) +
        para("Affiliate means a related company;", numPr(2, 2)) +
        para("Business Day means a weekday.", numPr(2, 2)) +
        para("Headings do not affect meaning.", numPr(2, 1)) +
        para("Services", numPr(2, 0)) +
        para("Provider shall deliver the Services.", numPr(2, 1)),
      { numbering },
    );
    expect(summary(clauses)).toEqual([
      {
        number: "1.01",
        heading: "ARTICLE I Definitions",
        paragraphs: 3,
        text: "In this Agreement:",
      },
      {
        number: "1.02",
        heading: "ARTICLE I Definitions",
        paragraphs: 1,
        text: "Headings do not affect meaning.",
      },
      {
        number: "2.01",
        heading: "ARTICLE II Services",
        paragraphs: 1,
        text: "Provider shall deliver the Services.",
      },
    ]);
  });
});

describe("numbering carried by the paragraph styles", () => {
  // Heading 1, Level 2 and Level 3 are linked to one multilevel list, and the paragraphs carry only
  // a style, which is how law-firm templates are built.
  const numbering =
    `<w:abstractNum w:abstractNumId="7"><w:multiLevelType w:val="multilevel"/>` +
    level(0, "decimal", "%1.", '<w:pStyle w:val="Heading1"/>') +
    level(1, "decimal", "%1.%2", '<w:pStyle w:val="Level2"/>') +
    level(2, "lowerLetter", "(%3)", '<w:pStyle w:val="Level3"/>') +
    `</w:abstractNum><w:num w:numId="3"><w:abstractNumId w:val="7"/></w:num>`;
  const styles =
    NORMAL +
    style("Heading1", "heading 1", `<w:pPr>${numPr(3)}<w:outlineLvl w:val="0"/></w:pPr>`) +
    style("Level2", "Level 2", `<w:pPr>${numPr(3)}</w:pPr>`) +
    style("Level3", "Level 3", `<w:pPr>${numPr(3)}</w:pPr>`);

  it("keeps a lead-in with its items and numbers each clause", async () => {
    const clauses = await clausesOf(
      styled("Restrictions", "Heading1") +
        styled("Customer shall not, and shall ensure that its users do not:", "Level2") +
        styled("sublicense, resell or otherwise make the Platform available;", "Level3") +
        styled("reverse engineer the Platform;", "Level3") +
        styled("attempt to gain unauthorised access.", "Level3") +
        styled("Customer shall pay the Fees within thirty days.", "Level2") +
        styled("Payment", "Heading1") +
        styled("Fees are exclusive of tax.", "Level2"),
      { numbering, styles },
    );
    expect(summary(clauses)).toEqual([
      {
        number: "1.1",
        heading: "1. Restrictions",
        paragraphs: 4,
        text: "Customer shall not, and shall ensure that its users do not:",
      },
      {
        number: "1.2",
        heading: "1. Restrictions",
        paragraphs: 1,
        text: "Customer shall pay the Fees within thirty days.",
      },
      { number: "2.1", heading: "2. Payment", paragraphs: 1, text: "Fees are exclusive of tax." },
    ]);
  });
});

describe("localised heading style ids", () => {
  // A French Word writes the id Titre1 and the English name heading 1.
  const styles =
    NORMAL +
    style("Titre1", "heading 1", `<w:pPr><w:outlineLvl w:val="0"/></w:pPr>`) +
    style("Titre", "Title");

  it("finds the sections through the style name", async () => {
    const clauses = await clausesOf(
      styled("CONTRAT DE SERVICES", "Titre") +
        styled("Definitions", "Titre1") +
        para("1. Le Prestataire fournit les Services.") +
        styled("Duree", "Titre1") +
        para("2. Le contrat dure deux ans."),
      { styles },
    );
    expect(clauses.map((c) => [c.number, c.heading])).toEqual([
      ["1", "Definitions"],
      ["2", "Duree"],
    ]);
  });
});

describe("a table of contents", () => {
  const styles =
    NORMAL +
    style("Heading1", "heading 1", `<w:pPr><w:outlineLvl w:val="0"/></w:pPr>`) +
    style("TOC1", "toc 1") +
    style("TOCHeading", "TOC Heading", "", "Heading1");
  const tab = "<w:r><w:tab/></w:r>";
  const entry = (number: string, title: string, page: number): string =>
    `<w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr>${run(number)}${tab}${run(title)}${tab}${run(String(page))}</w:p>`;

  it("is left out, and does not name the section of what follows", async () => {
    const toc =
      `<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/></w:docPartObj></w:sdtPr><w:sdtContent>` +
      styled("Contents", "TOCHeading") +
      entry("1.", "Definitions", 3) +
      entry("2.", "Subscription and Access", 3) +
      entry("11.", "General", 8) +
      `</w:sdtContent></w:sdt>`;
    const clauses = await clausesOf(
      para("SOFTWARE SUBSCRIPTION TERMS", `<w:pStyle w:val="Heading1"/>`) +
        toc +
        para("These Terms are entered into on 1 October 2026.") +
        para("Definitions", `<w:pStyle w:val="Heading1"/>`) +
        para("1.1 In these Terms the following words apply."),
      { styles },
    );
    expect(summary(clauses)).toEqual([
      {
        number: undefined,
        heading: "SOFTWARE SUBSCRIPTION TERMS",
        paragraphs: 1,
        text: "These Terms are entered into on 1 October 2026.",
      },
      {
        number: "1.1",
        heading: "Definitions",
        paragraphs: 1,
        text: "1.1 In these Terms the following words apply.",
      },
    ]);
  });

  it("is left out when it is only marked by its style", async () => {
    const clauses = await clausesOf(
      entry("1.", "Definitions", 3) + entry("2.", "Fees", 4) + para("1.1 Provider shall deliver."),
      { styles },
    );
    expect(clauses.map((c) => c.number)).toEqual(["1.1"]);
  });
});

describe("a contract laid out one clause per table row", () => {
  const row = (...cells: string[]): string =>
    `<w:tr>${cells.map((cell) => `<w:tc>${cell}</w:tc>`).join("")}</w:tr>`;
  const table = (...rows: string[]): string => `<w:tbl>${rows.join("")}</w:tbl>`;

  it("takes the typed number from its own cell", async () => {
    const clauses = await clausesOf(
      table(
        row(para("1."), para("Definitions")),
        row(para("1.1"), para("In this Lease:") + para("(a) Premises means the suite;")),
        row(para("1.2"), para("Landlord and Tenant include their successors.")),
        row(para("2."), para("Grant of Lease")),
        row(para("2.1"), para("Landlord lets the Premises to Tenant.")),
      ),
    );
    expect(summary(clauses)).toEqual([
      { number: "1.1", heading: "1. Definitions", paragraphs: 2, text: "In this Lease:" },
      {
        number: "1.2",
        heading: "1. Definitions",
        paragraphs: 1,
        text: "Landlord and Tenant include their successors.",
      },
      {
        number: "2.1",
        heading: "2. Grant of Lease",
        paragraphs: 1,
        text: "Landlord lets the Premises to Tenant.",
      },
    ]);
  });

  it("takes the number Word prints in an empty cell", async () => {
    const numbering =
      `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="multilevel"/>` +
      level(0, "decimal", "%1.", '<w:pStyle w:val="Heading1"/>') +
      level(1, "decimal", "%1.%2") +
      level(2, "lowerLetter", "(%3)") +
      `</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>`;
    const styles =
      NORMAL +
      style("Heading1", "heading 1", `<w:pPr>${numPr(1)}<w:outlineLvl w:val="0"/></w:pPr>`);
    const clauses = await clausesOf(
      table(
        row(emptyPara(`<w:pStyle w:val="Heading1"/>`), para("Definitions")),
        row(
          emptyPara(numPr(1, 1)),
          para("In this Lease:") + para("Premises means the suite;", numPr(1, 2)),
        ),
        row(emptyPara(numPr(1, 1)), para("Landlord and Tenant include their successors.")),
        row(emptyPara(`<w:pStyle w:val="Heading1"/>`), para("Grant of Lease")),
        row(emptyPara(numPr(1, 1)), para("Landlord lets the Premises to Tenant.")),
      ),
      { numbering, styles },
    );
    expect(summary(clauses)).toEqual([
      { number: "1.1", heading: "1. Definitions", paragraphs: 2, text: "In this Lease:" },
      {
        number: "1.2",
        heading: "1. Definitions",
        paragraphs: 1,
        text: "Landlord and Tenant include their successors.",
      },
      {
        number: "2.1",
        heading: "2. Grant of Lease",
        paragraphs: 1,
        text: "Landlord lets the Premises to Tenant.",
      },
    ]);
  });
});

describe("python-docx list styles", () => {
  // List Number and List Number 2 are lists of their own, both at level 0, and the numbers go on
  // through the whole document.
  const single = (abs: number, style: string): string =>
    `<w:abstractNum w:abstractNumId="${abs}"><w:multiLevelType w:val="singleLevel"/>` +
    level(0, "decimal", "%1.", `<w:pStyle w:val="${style}"/>`) +
    `</w:abstractNum>`;
  const numbering =
    single(3, "ListNumber") +
    single(4, "ListNumber2") +
    `<w:num w:numId="5"><w:abstractNumId w:val="3"/></w:num>` +
    `<w:num w:numId="6"><w:abstractNumId w:val="4"/></w:num>`;
  const styles =
    NORMAL +
    style("Heading1", "heading 1", `<w:pPr><w:outlineLvl w:val="0"/></w:pPr>`) +
    style("ListNumber", "List Number", `<w:pPr>${numPr(5)}</w:pPr>`) +
    style("ListNumber2", "List Number 2", `<w:pPr>${numPr(6)}</w:pPr>`);

  it("keeps the items with the lead-in that introduces them, and numbers the clauses", async () => {
    const clauses = await clausesOf(
      styled("Obligations", "Heading1") +
        styled("The Receiving Party shall:", "ListNumber") +
        styled("keep the information confidential;", "ListNumber2") +
        styled("use it only for the Purpose.", "ListNumber2") +
        styled("The Receiving Party may disclose it if:", "ListNumber") +
        styled("the Representative needs to know;", "ListNumber2") +
        styled("the Representative is bound by confidence.", "ListNumber2") +
        styled("The Receiving Party shall return it on request.", "ListNumber") +
        styled("Where law requires retention, copies may be kept.", "ListNumber2"),
      { numbering, styles },
    );
    expect(summary(clauses)).toEqual([
      { number: "1", heading: "Obligations", paragraphs: 3, text: "The Receiving Party shall:" },
      {
        number: "2",
        heading: "Obligations",
        paragraphs: 3,
        text: "The Receiving Party may disclose it if:",
      },
      {
        number: "3",
        heading: "Obligations",
        paragraphs: 2,
        text: "The Receiving Party shall return it on request.",
      },
    ]);
  });
});
