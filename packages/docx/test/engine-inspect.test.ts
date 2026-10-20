import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DocxError, inspectDocx, type DocxInspection } from "../src/index.js";
import { MC_DECL, W_DECL, relsXml, utf8, withPart, type RelSpec } from "./engine-support.js";
import { buildDocx, para, run } from "./helpers.js";

const REVISION = 'w:author="Other" w:date="2026-01-01T00:00:00Z"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const hdr = (body: string) => `${XML}<w:hdr ${W_DECL}>${body}</w:hdr>`;
const ftr = (body: string) => `${XML}<w:ftr ${W_DECL}>${body}</w:ftr>`;
const notes = (root: "footnotes" | "endnotes", entries: string) =>
  `${XML}<w:${root} ${W_DECL}>${entries}</w:${root}>`;
const note = (kind: "footnote" | "endnote", id: number, type: string | undefined, text: string) =>
  `<w:${kind} w:id="${id}"${type ? ` w:type="${type}"` : ""}><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:${kind}>`;
const comments = (count: number) =>
  `${XML}<w:comments ${W_DECL}>${Array.from(
    { length: count },
    (_, i) =>
      `<w:comment w:id="${i}" w:author="Alice" w:initials="A" w:date="2026-01-01T00:00:00Z"><w:p><w:r><w:t>Remark ${i}</w:t></w:r></w:p></w:comment>`,
  ).join("")}</w:comments>`;

const NONE: DocxInspection = {
  trackedInsertions: 0,
  trackedDeletions: 0,
  comments: 0,
  footnotes: 0,
  endnotes: 0,
  headerFooterParts: 0,
  hiddenRuns: 0,
  images: 0,
};

const tracked = (kind: "ins" | "del" | "moveFrom" | "moveTo", id: number, text: string): string =>
  `<w:${kind} w:id="${id}" ${REVISION}><w:r><w:${kind === "del" || kind === "moveFrom" ? "delText" : "t"}>${text}</w:${kind === "del" || kind === "moveFrom" ? "delText" : "t"}></w:r></w:${kind}>`;

const textBox = (text: string): string =>
  `<w:r><w:drawing><w:txbxContent>${para(run(text))}</w:txbxContent></w:drawing></w:r>`;

const body =
  para(run("Plain.") + tracked("ins", 1, "added ") + tracked("del", 2, "removed ")) +
  para(tracked("moveFrom", 3, "moved ") + tracked("moveTo", 4, "moved ")) +
  para(
    run("Hidden: ") +
      "<w:r><w:rPr><w:vanish/></w:rPr><w:t>secret one</w:t></w:r>" +
      "<w:r><w:rPr><w:specVanish/></w:rPr><w:t>secret two</w:t></w:r>" +
      '<w:r><w:rPr><w:vanish w:val="0"/></w:rPr><w:t>shown</w:t></w:r>' +
      "<w:r><w:rPr><w:vanish/></w:rPr></w:r>",
  ) +
  para(
    '<w:r><w:drawing><wp:inline xmlns:wp="urn:wp"/></w:drawing></w:r>' +
      "<w:r><w:pict/></w:r>" +
      textBox("A text box, which is not a picture") +
      `<w:r><mc:AlternateContent ${MC_DECL}><mc:Choice Requires="wps"><w:drawing/></mc:Choice><mc:Fallback><w:pict/></mc:Fallback></mc:AlternateContent></w:r>`,
  );

const relationships: RelSpec[] = [
  { id: "rId1", type: "styles", target: "styles.xml" },
  { id: "rId2", type: "comments", target: "comments.xml" },
  { id: "rId3", type: "footnotes", target: "footnotes.xml" },
  { id: "rId4", type: "endnotes", target: "endnotes.xml" },
  { id: "rId5", type: "header", target: "header1.xml" },
  { id: "rId6", type: "header", target: "header2.xml" },
  { id: "rId7", type: "footer", target: "footer1.xml" },
  { id: "rId8", type: "footer", target: "footer2.xml" },
];

const parts: Record<string, string> = {
  "word/comments.xml": comments(2),
  "word/footnotes.xml": notes(
    "footnotes",
    note("footnote", -1, "separator", "") +
      note("footnote", 0, "continuationSeparator", "") +
      note("footnote", 1, undefined, "First note.") +
      `<w:footnote w:id="2" w:type="normal"><w:p>${tracked("ins", 20, "Second note.")}</w:p></w:footnote>`,
  ),
  "word/endnotes.xml": notes(
    "endnotes",
    note("endnote", -1, "separator", "") +
      note("endnote", 0, "continuationSeparator", "") +
      note("endnote", 1, undefined, "An endnote."),
  ),
  "word/header1.xml": hdr(
    `<w:p>${run("Draft 4")}${tracked("del", 21, "old ")}<w:r><w:drawing/></w:r></w:p>`,
  ),
  "word/header2.xml": hdr("<w:p/>"),
  "word/footer1.xml": ftr(`<w:p>${run("   ")}</w:p>`),
  "word/footer2.xml": ftr(`<w:p>${run("Page 1")}</w:p>`),
};

async function documentWith(
  contents = body,
  extra = parts,
  rels: RelSpec[] | null = relationships,
): Promise<Uint8Array> {
  let buf = await buildDocx(contents, extra);
  if (rels) buf = await withPart(buf, "word/_rels/document.xml.rels", relsXml(rels));
  return buf;
}

describe("inspectDocx", () => {
  it("counts everything the review never shows the model", async () => {
    expect(await inspectDocx(await documentWith())).toEqual({
      // Two in the body (moves count as insertions and deletions) and one in a footnote.
      trackedInsertions: 3,
      // Two in the body and one in a header.
      trackedDeletions: 3,
      comments: 2,
      // The separators are not notes.
      footnotes: 2,
      endnotes: 1,
      // A header with text and a footer with text; an empty header and a blank footer do not count.
      headerFooterParts: 2,
      // Two hidden runs with text; the one with vanish switched off and the one with no content do not.
      hiddenRuns: 2,
      // A drawing, a picture, one alternate-content image (not twice) and one in the header; not the text box.
      images: 4,
    });
  });

  it("finds the parts where Word keeps them when the relationships do not say", async () => {
    const buf = await documentWith(body, parts, null);
    const found = await inspectDocx(await withPart(buf, "word/_rels/document.xml.rels", null));
    expect(found.comments).toBe(2);
    expect(found.footnotes).toBe(2);
    expect(found.endnotes).toBe(1);
    expect(found.headerFooterParts).toBe(2);
  });

  it("reports nothing for a plain document", async () => {
    expect(await inspectDocx(await buildDocx(para(run("Just text."))))).toEqual(NONE);
  });

  it("counts a revision on a paragraph mark as the insertion or deletion it is", async () => {
    const buf = await buildDocx(
      `<w:p><w:pPr><w:rPr><w:ins w:id="1" ${REVISION}/></w:rPr></w:pPr>${tracked("ins", 2, "new")}</w:p>` +
        `<w:p><w:pPr><w:rPr><w:del w:id="3" ${REVISION}/></w:rPr></w:pPr></w:p>`,
    );
    const found = await inspectDocx(buf);
    expect(found.trackedInsertions).toBe(2);
    expect(found.trackedDeletions).toBe(1);
  });

  it("counts a table row that was inserted under tracking", async () => {
    const buf = await buildDocx(
      `<w:tbl><w:tr><w:trPr><w:ins w:id="1" ${REVISION}/></w:trPr><w:tc>${para(run("cell"))}</w:tc></w:tr></w:tbl>`,
    );
    expect((await inspectDocx(buf)).trackedInsertions).toBe(1);
  });

  it("counts hidden text inside a text box and inside a table", async () => {
    const hidden = "<w:r><w:rPr><w:vanish/></w:rPr><w:t>x</w:t></w:r>";
    const buf = await buildDocx(
      `<w:tbl><w:tr><w:tc>${para(hidden)}</w:tc></w:tr></w:tbl>` +
        para(`<w:r><w:drawing><w:txbxContent>${para(hidden)}</w:txbxContent></w:drawing></w:r>`),
    );
    expect((await inspectDocx(buf)).hiddenRuns).toBe(2);
  });
});

describe("inspectDocx on documents that are strange but valid", () => {
  it("does not stop for a notes part that is not XML", async () => {
    const buf = await documentWith(body, { ...parts, "word/footnotes.xml": "this is not xml <<<" });
    const found = await inspectDocx(buf);
    expect(found.footnotes).toBe(0);
    expect(found.endnotes).toBe(1);
  });

  it("does not stop for a header nested beyond the limit, or too large to read", async () => {
    const deep = "<w:ins>".repeat(1000) + "</w:ins>".repeat(1000);
    const buf = await documentWith(body, {
      ...parts,
      "word/header1.xml": hdr(`<w:p>${deep}</w:p>`),
    });
    const found = await inspectDocx(buf);
    expect(found.headerFooterParts).toBe(1);
    const small = await inspectDocx(buf, { maxPartBytes: 100 });
    expect(small.headerFooterParts).toBe(0);
    expect(small.trackedInsertions).toBe(2);
  });

  it("does not follow a comments relationship to a part that is something else", async () => {
    const buf = await documentWith(body, { ...parts, "word/comments.xml": hdr("<w:p/>") }, [
      ...relationships.filter((r) => r.type !== "comments"),
      { id: "rId2", type: "comments", target: "document.xml" },
    ]);
    expect((await inspectDocx(buf)).comments).toBe(0);
  });

  it("counts a comments part that a relationship spells differently from its name", async () => {
    const buf = await documentWith(
      body,
      parts,
      relationships.map((r) => (r.type === "comments" ? { ...r, target: "./Comments.XML" } : r)),
    );
    expect((await inspectDocx(buf)).comments).toBe(2);
  });

  it("reads a document with no body, and one with only an empty paragraph", async () => {
    const empty = await withPart(
      await buildDocx(""),
      "word/document.xml",
      utf8(`${XML}<w:document ${W_DECL}/>`),
    );
    expect(await inspectDocx(empty)).toEqual(NONE);
    expect(await inspectDocx(await buildDocx("<w:p/>"))).toEqual(NONE);
  });

  it("reads a notes part in UTF-16 and one with a byte order mark", async () => {
    const buf = await documentWith(body, parts);
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(
        parts["word/endnotes.xml"]!.replace('encoding="UTF-8"', 'encoding="UTF-16"'),
        "utf16le",
      ),
    ]);
    const bom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(parts["word/footnotes.xml"]!),
    ]);
    const found = await inspectDocx(
      await withPart(await withPart(buf, "word/endnotes.xml", utf16), "word/footnotes.xml", bom),
    );
    expect(found.endnotes).toBe(1);
    expect(found.footnotes).toBe(2);
  });

  it("refuses what cannot be read at all, with a message that is safe to show", async () => {
    await expect(inspectDocx(utf8("not a zip"))).rejects.toThrow(DocxError);
    await expect(inspectDocx(await buildDocx("<w:p>"))).rejects.toThrow("is not valid XML");
  });

  it("describes the shipped fixtures without trouble", async () => {
    const dir = join(import.meta.dirname, "..", "..", "..", "fixtures");
    for (const name of ["nda-aggressive.docx", "nda-balanced.docx", "saas-vendor-friendly.docx"]) {
      const found = await inspectDocx(new Uint8Array(await readFile(join(dir, name))));
      for (const value of Object.values(found)) {
        expect(Number.isInteger(value) && value >= 0).toBe(true);
      }
      expect(found.hiddenRuns).toBe(0);
    }
  });
});
