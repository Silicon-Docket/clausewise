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

  it("tells the rows of a table apart, nested tables included", async () => {
    const cell = (text: string, inner = ""): string => `<w:tc>${para(run(text))}${inner}</w:tc>`;
    const row = (...cells: string[]): string => `<w:tr>${cells.join("")}</w:tr>`;
    const buf = await buildDocx(
      para(run("Before")) +
        `<w:tbl>${row(cell("1.1"), cell("Text of 1.1"))}${row(
          cell("1.2"),
          cell(
            "Outer",
            `<w:tbl>${row(cell("Inner a"), cell("Inner b"))}</w:tbl>${para(run("Tail"))}`,
          ),
        )}</w:tbl>` +
        para(run("After")),
    );
    const ps = (await parseDocx(buf)).paragraphs;
    expect(ps.map((p) => [p.text, p.tableRow])).toEqual([
      ["Before", undefined],
      ["1.1", 0],
      ["Text of 1.1", 0],
      ["1.2", 1],
      ["Outer", 1],
      ["Inner a", 2],
      ["Inner b", 2],
      ["Tail", 1],
      ["After", undefined],
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

describe("parseDocx limits", () => {
  const W_NS = `xmlns:w="${W}"`;
  const body = para(run("First paragraph.")) + para(run("Second paragraph."));
  const styles =
    `<?xml version="1.0"?><w:styles ${W_NS}><w:style w:type="paragraph" w:styleId="Heading1">` +
    `<w:name w:val="heading 1"/></w:style></w:styles>`;
  const headed = para(run("Heading"), '<w:pStyle w:val="Heading1"/>');

  const message = async (buf: Uint8Array, limits: Record<string, number>): Promise<string> =>
    parseDocx(buf, limits).then(
      () => "no error",
      (e: unknown) => (e instanceof DocxError ? e.message : `unexpected ${String(e)}`),
    );

  it("changes nothing when no limits, or an empty set, are given", async () => {
    const buf = await buildDocx(body);
    expect(await parseDocx(buf, {})).toEqual(await parseDocx(buf));
    expect(await parseDocx(buf, undefined)).toEqual(await parseDocx(buf));
  });

  it.each([
    ["maxInputBytes", 100],
    ["maxZipEntries", 2],
    ["maxUncompressedBytes", 100],
    ["maxDocumentXmlBytes", 100],
    ["maxParagraphs", 1],
    ["maxRunsPerParagraph", 0],
    ["maxNestingDepth", 3],
  ])("refuses a file over %s and names the limit", async (name, value) => {
    const text = await message(await buildDocx(body), { [name]: value });
    expect(text).toContain(`(${name})`);
    expect(text).toMatch(/over the limit/);
    expect(text).not.toContain("paragraph.");
  });

  it("reads the file with the limits it was given, not with the defaults", async () => {
    const buf = await buildDocx(body);
    expect((await parseDocx(buf, { maxParagraphs: 2 })).paragraphs).toHaveLength(2);
    expect(await message(buf, { maxParagraphs: 1 })).toContain("(maxParagraphs)");
  });

  it("applies the size limit to the optional parts it reads, which then count as absent", async () => {
    const buf = await buildDocx(headed, { "word/styles.xml": styles });
    expect((await parseDocx(buf)).paragraphs[0]?.styleName).toBe("heading 1");
    const limited = await parseDocx(buf, { maxPartBytes: 50 });
    expect(limited.paragraphs[0]).toMatchObject({ text: "Heading", styleName: undefined });
  });

  it("applies the structure limits to the optional parts it parses", async () => {
    const buf = await buildDocx(headed, {
      "word/styles.xml": styles.replace(
        "<w:name",
        "<w:pPr><w:pBdr><w:top><w:x>1</w:x></w:top></w:pBdr></w:pPr><w:name",
      ),
    });
    expect((await parseDocx(buf)).paragraphs[0]?.styleName).toBe("heading 1");
    const limited = await parseDocx(buf, { maxNestingDepth: 5 });
    expect(limited.paragraphs[0]).toMatchObject({ text: "Heading", styleName: undefined });
  });
});
