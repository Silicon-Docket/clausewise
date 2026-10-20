import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { DocxError, applyRedline, parseDocx } from "../src/index.js";
import { assertXmlChars, createW, setText, xmlSafe } from "../src/ooxml.js";
import { writeXmlPart } from "../src/package.js";
import {
  forbiddenCodePoints,
  hasSoffice,
  hasStrictParser,
  libreOfficeText,
  strictParse,
  writtenXml,
  zipParts,
} from "./engine-support.js";
import { buildDocx, para, run, views } from "./helpers.js";

const date = new Date("2026-03-01T12:00:00Z");

/** One code point from every class XML 1.0 forbids, plus the lone surrogates JSZip would rewrite. */
const FORBIDDEN: Array<[string, string]> = [
  ["NUL", "\u0000"],
  ["SOH", "\u0001"],
  ["BS", "\u0008"],
  ["VT", "\u000b"],
  ["FF", "\u000c"],
  ["SO", "\u000e"],
  ["ESC", "\u001b"],
  ["US", "\u001f"],
  ["U+FFFE", "\uFFFE"],
  ["U+FFFF", "\uFFFF"],
  ["lone high surrogate", "\ud800"],
  ["lone low surrogate", "\udfff"],
];

async function redline(
  replacement: string,
  comment: string,
  author = "Clausewise",
  initials = "CW",
) {
  const buf = await buildDocx(para(run("The term is three years.")));
  const text = "The term is three years.";
  const start = text.indexOf("three");
  const result = await applyRedline(
    buf,
    {
      edits: [{ paragraphId: "p:0", start, end: start + 5, replacement }],
      comments: [{ paragraphId: "p:0", start: 0, end: 8, text: comment }],
    },
    { date, author, initials },
  );
  expect(result.edits).toEqual([{ applied: true }]);
  expect(result.comments).toEqual([{ applied: true }]);
  return result.buffer;
}

async function expectReadableXml(buf: Uint8Array): Promise<void> {
  const parts = await writtenXml(buf);
  for (const [name, bytes] of Object.entries(parts)) {
    const text = new TextDecoder().decode(bytes);
    expect(forbiddenCodePoints(text), `${name} holds a code point XML forbids`).toEqual([]);
  }
  if (hasStrictParser) {
    const errors = strictParse(parts);
    for (const [name, error] of Object.entries(errors)) {
      expect(error, `${name} is not well-formed`).toBeNull();
    }
  }
}

describe("text XML cannot carry never reaches the package", () => {
  it.each(FORBIDDEN)(
    "%s in a replacement, a comment, the author and the initials",
    async (_, ch) => {
      const buf = await redline(`two${ch}x`, `see${ch}note`, `Rev${ch}iewer`, `R${ch}I`);
      await expectReadableXml(buf);
      // The package must also still read back as the same contract text.
      expect((await parseDocx(buf)).paragraphs[0]?.text).toMatch(/^The term is two.*x years\.$/);
    },
  );

  it("drops the forbidden characters and keeps the words on either side", async () => {
    const buf = await redline("a\u0000b\u0001c", "x\u001by");
    expect((await views(buf, "accepted"))[0]).toBe("The term is abc years.");
    const comments = (await zipParts(buf))["word/comments.xml"]!;
    expect(new TextDecoder().decode(comments)).toContain("<w:t>xy</w:t>");
  });

  it("turns a vertical tab or form feed into a space so words do not fuse", async () => {
    const buf = await redline("two\u000bmore\u000cyears", "ok");
    expect((await views(buf, "accepted"))[0]).toBe("The term is two more years years.");
  });

  it("turns a lone surrogate into the replacement character", async () => {
    const buf = await redline("t\ud800o", "ok");
    expect((await views(buf, "accepted"))[0]).toBe("The term is t\uFFFDo years.");
  });

  it("refuses a replacement made only of characters that cannot be written, instead of deleting the text", async () => {
    const buf = await buildDocx(para(run("The term is three years.")));
    const result = await applyRedline(
      buf,
      { edits: [{ paragraphId: "p:0", start: 12, end: 17, replacement: "\u0000\u0001" }] },
      { date },
    );
    expect(result.edits[0]).toMatchObject({ applied: false });
    expect(result.buffer).toBe(buf);
  });

  it("writes CR and CRLF in a replacement and a comment as line breaks, never as a raw CR", async () => {
    const buf = await redline("one\r\ntwo\rthree", "first\r\nsecond\rthird");
    const parts = await zipParts(buf);
    const doc = new TextDecoder().decode(parts["word/document.xml"]!);
    const comments = new TextDecoder().decode(parts["word/comments.xml"]!);
    expect(doc).not.toContain("\r");
    expect(comments).not.toContain("\r");
    expect(doc.match(/<w:br\/>/g)).toHaveLength(2);
    expect(comments.match(/<w:p>/g)).toHaveLength(3);
    expect((await parseDocx(buf)).paragraphs[0]?.text).toBe("The term is one\ntwo\nthree years.");
  });

  it("strips bidi override and isolate characters from inserted and comment text", async () => {
    const bidi = [
      "\u202A",
      "\u202B",
      "\u202C",
      "\u202D",
      "\u202E",
      "\u2066",
      "\u2067",
      "\u2068",
      "\u2069",
    ];
    const buf = await redline(`two${bidi.join("")}`, `note${bidi.join("")}`);
    const parts = await zipParts(buf);
    for (const name of ["word/document.xml", "word/comments.xml"]) {
      const text = new TextDecoder().decode(parts[name]!);
      for (const ch of bidi) expect(text, name).not.toContain(ch);
    }
    expect((await views(buf, "accepted"))[0]).toBe("The term is two years.");
  });

  it("leaves legitimate characters alone: tab, accented letters, astral characters and U+0085", async () => {
    const buf = await redline("t\u00E9\t\u{1f600}\u0085", "ok \u{1d49c}");
    expect((await views(buf, "accepted"))[0]).toContain("t\u00E9");
    expect((await parseDocx(buf)).paragraphs[0]?.text).toContain("\u{1f600}\u0085");
    await expectReadableXml(buf);
  });

  it.skipIf(!hasSoffice)(
    "LibreOffice opens every output, which it refuses when the XML is not well-formed",
    { timeout: 180_000 },
    async () => {
      const docs: Record<string, Uint8Array> = { plain: await redline("two", "note") };
      for (const [name, ch] of FORBIDDEN) {
        const slug = name.replace(/\W+/g, "-");
        docs[`replacement-${slug}`] = await redline(`two${ch}x`, "note");
        docs[`comment-${slug}`] = await redline("two", `note${ch}x`);
        docs[`author-${slug}`] = await redline("two", "note", `Rev${ch}iewer`);
      }
      const text = await libreOfficeText(docs);
      for (const name of Object.keys(docs)) {
        expect(text[name], `${name} could not be loaded`).toBeDefined();
      }
      expect(text["plain"]).toContain("threetwo");
    },
  );
});

describe("the writer's last line of defence", () => {
  it("xmlSafe and assertXmlChars agree on what is forbidden", () => {
    for (const [, ch] of FORBIDDEN) {
      expect(forbiddenCodePoints(xmlSafe(`a${ch}b`))).toEqual([]);
      expect(() => assertXmlChars(`a${ch}b`, "word/document.xml")).toThrow(DocxError);
    }
    expect(() =>
      assertXmlChars("tab\there\nand\r\u0085\u{1f600}", "word/document.xml"),
    ).not.toThrow();
  });

  it("refuses to write a part that would hold a forbidden character", async () => {
    // A numeric character reference is the way a forbidden character gets into a parsed part: the
    // lenient parser decodes it and the serialiser would write it raw.
    const doc = new DOMParser().parseFromString(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>a&#1;b</w:t></w:r></w:p></w:body></w:document>',
      "text/xml",
    ) as unknown as Document;
    expect(new XMLSerializer().serializeToString(doc as never)).toContain("\u0001");
    const zip = new JSZip();
    expect(() => writeXmlPart(zip, "word/document.xml", doc)).toThrow(DocxError);
    expect(zip.file("word/document.xml")).toBeNull();
  });

  it("drops a numeric reference to a forbidden character before anything reads it, so edits still work", async () => {
    const refs = [
      "&#1;",
      "&#x0;",
      "&#xFFFE;",
      "&#65535;",
      "&#xD800;",
      "&#x110000;",
      "&#00000000000001;",
    ];
    for (const ref of refs) {
      const buf = await buildDocx(
        para(`<w:r><w:t xml:space="preserve">Bad${ref} text here.</w:t></w:r>`),
      );
      const text = (await parseDocx(buf)).paragraphs[0]!.text;
      expect(forbiddenCodePoints(text), ref).toEqual([]);
      const result = await applyRedline(
        buf,
        {
          edits: [{ paragraphId: "p:0", start: 1, end: 3, replacement: "OO" }],
          comments: [{ paragraphId: "p:0", text: "note" }],
        },
        { date },
      );
      expect(result.edits, ref).toEqual([{ applied: true }]);
      expect(result.comments, ref).toEqual([{ applied: true }]);
      await expectReadableXml(result.buffer);
    }
  });

  it("keeps a reference to a legitimate character, tab, line feed, carriage return and U+FFFD included", async () => {
    const buf = await buildDocx(
      para(
        '<w:r><w:t xml:space="preserve">a&#9;b&#xA;c&#13;d&#xFFFD;e&#x1F600;f&#133;g</w:t></w:r>',
      ),
    );
    expect((await parseDocx(buf)).paragraphs[0]!.text).toBe("a\tb\nc\rd\uFFFDe\u{1F600}f\u0085g");
  });

  it("sets text through the same filter wherever the engine creates a text node", () => {
    const doc = new DOMParser().parseFromString(
      '<w:r xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
      "text/xml",
    ) as unknown as Document;
    const t = createW(doc, "t");
    setText(doc, t, "a\u0000b\r\nc");
    // Text that is already in the contract keeps its line ends, so a cut piece equals its source.
    expect(t.textContent).toBe("ab\r\nc");
    expect(xmlSafe("a\u0000b\r\nc\rd")).toBe("ab\nc\nd");
    const author = createW(doc, "ins", { author: "x\u0001\ty\n" });
    expect(
      author.getAttributeNS(
        "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
        "author",
      ),
    ).toBe("x y ");
  });
});
