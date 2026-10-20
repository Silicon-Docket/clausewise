import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DocxError, parseDocx } from "../src/index.js";
import { buildDocx, para, run } from "./helpers.js";

const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures");
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

describe("parseDocx", () => {
  it("joins split runs and numbers paragraphs in document order", async () => {
    const buf = await buildDocx(
      para(run("The term is ") + run("three (3)", "<w:b/>") + run(" years.")) +
        para(run("Second.")),
    );
    const { paragraphs } = await parseDocx(buf);
    expect(paragraphs.map((p) => [p.id, p.text])).toEqual([
      ["p:0", "The term is three (3) years."],
      ["p:1", "Second."],
    ]);
  });

  it("reads tabs and line breaks as characters", async () => {
    const buf = await buildDocx(
      para(`<w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t></w:r>`),
    );
    expect((await parseDocx(buf)).paragraphs[0]?.text).toBe("A\tB\nC");
  });

  it("shows the accepted view of tracked changes", async () => {
    const buf = await buildDocx(
      para(
        run("Keep ") +
          `<w:del w:id="1" w:author="x" w:date="2026-01-01T00:00:00Z"><w:r><w:delText>gone </w:delText></w:r></w:del>` +
          `<w:ins w:id="2" w:author="x" w:date="2026-01-01T00:00:00Z">${run("added")}</w:ins>`,
      ),
    );
    expect((await parseDocx(buf)).paragraphs[0]?.text).toBe("Keep added");
  });

  it("includes hyperlink text and ignores field instructions", async () => {
    const buf = await buildDocx(
      para(
        run("See ") +
          `<w:hyperlink r:id="rId9">${run("this link")}</w:hyperlink>` +
          `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> REF x </w:instrText></w:r>` +
          `<w:r><w:fldChar w:fldCharType="separate"/></w:r>${run("Section 4")}` +
          `<w:r><w:fldChar w:fldCharType="end"/></w:r>`,
      ),
    );
    expect((await parseDocx(buf)).paragraphs[0]?.text).toBe("See this linkSection 4");
  });

  it("reports style, numbering and table membership", async () => {
    const buf = await buildDocx(
      para(run("Heading"), '<w:pStyle w:val="Heading1"/>') +
        para(run("Item"), '<w:numPr><w:ilvl w:val="1"/><w:numId w:val="3"/></w:numPr>') +
        `<w:tbl><w:tr><w:tc>${para(run("Cell"))}</w:tc></w:tr></w:tbl>`,
    );
    const [heading, item, cell] = (await parseDocx(buf)).paragraphs;
    expect(heading).toMatchObject({ style: "Heading1", numbering: undefined, inTable: false });
    expect(item).toMatchObject({ numbering: { id: "3", level: 1 }, inTable: false });
    expect(cell).toMatchObject({ text: "Cell", inTable: true, id: "p:2" });
  });

  it("does not fold a text box's paragraphs into the paragraph that holds it", async () => {
    const buf = await buildDocx(
      para(
        run("Outer") +
          `<w:r><w:pict><w:txbxContent>${para(run("Inner"))}</w:txbxContent></w:pict></w:r>`,
      ),
    );
    expect((await parseDocx(buf)).paragraphs.map((p) => p.text)).toEqual(["Outer", "Inner"]);
  });

  it("computes list, style and contents fields for every paragraph", async () => {
    const numbering =
      `<?xml version="1.0"?><w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="1">` +
      `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>` +
      `<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl>` +
      `</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
    const styles =
      `<?xml version="1.0"?><w:styles xmlns:w="${W}">` +
      `<w:style w:type="paragraph" w:styleId="Titre1"><w:name w:val="heading 1"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr><w:outlineLvl w:val="0"/></w:pPr></w:style>` +
      `<w:style w:type="paragraph" w:styleId="TM1"><w:name w:val="toc 1"/></w:style></w:styles>`;
    const item = '<w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr>';
    const buf = await buildDocx(
      para(run("Definitions"), '<w:pStyle w:val="Titre1"/>') +
        para(run("In this Agreement:"), item) +
        para(run("1. Definitions\t3"), '<w:pStyle w:val="TM1"/>') +
        para(run("Plain")),
      { "word/numbering.xml": numbering, "word/styles.xml": styles },
    );
    const ps = (await parseDocx(buf)).paragraphs;
    expect(
      ps.map((p) => [p.label, p.level, p.isBullet, p.styleName, p.outlineLevel, p.isTocEntry]),
    ).toEqual([
      ["1.", 0, false, "heading 1", 0, false],
      ["1.1", 1, false, undefined, undefined, false],
      [undefined, undefined, false, "toc 1", undefined, true],
      [undefined, undefined, false, undefined, undefined, false],
    ]);
    expect(ps.map((p) => p.numbering)).toEqual([
      { id: "1", level: 0 },
      { id: "1", level: 1 },
      undefined,
      undefined,
    ]);
  });

  it("does not report a paragraph with numId 0 as numbered", async () => {
    const buf = await buildDocx(
      para(
        run("Plain, as LibreOffice writes it"),
        '<w:numPr><w:ilvl w:val="1"/><w:numId w:val="0"/></w:numPr>',
      ),
    );
    expect((await parseDocx(buf)).paragraphs[0]).toMatchObject({
      numbering: undefined,
      level: undefined,
      label: undefined,
      isBullet: false,
    });
  });

  it("reads a contract whose styles and numbering parts are damaged", async () => {
    const buf = await buildDocx(
      para(
        run("Clause"),
        '<w:pStyle w:val="Heading1"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>',
      ),
      { "word/styles.xml": "<w:styles", "word/numbering.xml": "\u0000 not xml" },
    );
    expect((await parseDocx(buf)).paragraphs[0]).toMatchObject({
      text: "Clause",
      numbering: { id: "2", level: 0 },
      label: undefined,
      styleName: undefined,
    });
  });

  it("leaves numbers typed into the text to the segmenter", async () => {
    for (const name of ["nda-aggressive", "nda-balanced", "saas-vendor-friendly"]) {
      const { paragraphs } = await parseDocx(
        new Uint8Array(await readFile(join(fixtures, `${name}.docx`))),
      );
      const typed = paragraphs.filter((p) => /^\d+(\.\d+)*\.? /.test(p.text));
      expect(typed.length).toBeGreaterThan(5);
      expect(paragraphs.filter((p) => p.label !== undefined || p.numbering !== undefined)).toEqual(
        [],
      );
      expect(paragraphs.find((p) => p.style === "Heading1")?.styleName).toBe("Heading 1");
    }
  });

  it("rejects things that are not a docx", async () => {
    await expect(parseDocx(new TextEncoder().encode("hello"))).rejects.toThrow(DocxError);
  });
});
