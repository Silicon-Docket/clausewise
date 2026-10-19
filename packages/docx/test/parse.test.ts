import { describe, expect, it } from "vitest";
import { DocxError, parseDocx } from "../src/index.js";
import { buildDocx, para, run } from "./helpers.js";

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

  it("rejects things that are not a docx", async () => {
    await expect(parseDocx(new TextEncoder().encode("hello"))).rejects.toThrow(DocxError);
  });
});
