import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildDocx, check, doc, editedReview, mutate, para, run, text } from "./raw-docx.js";

const FIRST = "1.1 Recipient shall keep the Confidential Information secret for a perpetual term.";
// The review refuses a document with under 200 characters of clause text, and the shortest first
// clause here has 56, so the second clause carries the rest.
const second = text(
  "1.2 The obligations of confidence do not apply to information that is public, that the Recipient already knew, or that a third party who owes the Discloser no duty of confidence gave to the Recipient.",
);
const edit = { clauseId: "c1", quote: "perpetual term", replacement: "term of three years" };

const withoutPart = async (bytes: Uint8Array, name: string): Promise<Uint8Array> => {
  const zip = await JSZip.loadAsync(bytes);
  zip.remove(name);
  return zip.generateAsync({ type: "uint8array" });
};

describe("damage that leaves every character of every paragraph as it was", () => {
  it("is found in the formatting and the paragraph properties", async () => {
    const bold = "<w:b/><w:i/>";
    const original = await buildDocx(
      doc(
        para(
          run("1.1 Recipient shall keep it secret for a ", bold) + run("perpetual term", bold),
          '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:jc w:val="both"/>',
        ) + second,
      ),
    );
    const { report, redlined } = await editedReview(original, edit);
    expect((await check(original, redlined, report)).ok).toBe(true);

    const noFormat = await mutate(redlined, (xml) => xml.replace(/<w:rPr>.*?<\/w:rPr>/g, ""));
    const lostFormat = await check(original, noFormat, report);
    expect(lostFormat.ok).toBe(false);
    expect(lostFormat.problems[0]).toContain("original formatting or paragraph properties");

    const noNumbering = await mutate(redlined, (xml) =>
      xml.replace(/<w:numPr>.*?<\/w:numPr>/g, ""),
    );
    expect((await check(original, noNumbering, report)).ok).toBe(false);
  });

  it("is found in a footnote mark or a picture that went missing", async () => {
    const original = await buildDocx(
      doc(
        para(
          run(FIRST) +
            '<w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"/></w:drawing></w:r>',
        ) + second,
      ),
    );
    const { report, redlined } = await editedReview(original, edit);
    expect((await check(original, redlined, report)).ok).toBe(true);
    const gone = await mutate(redlined, (xml) =>
      xml.replace(/<w:r><w:footnoteReference[^>]*\/><\/w:r>/, ""),
    );
    expect((await check(original, gone, report)).ok).toBe(false);
  });

  it("is found in a space at the edge of a text element that Word would drop", async () => {
    const original = await buildDocx(doc(text(FIRST) + second));
    const { report, redlined } = await editedReview(original, edit);
    const bare = await mutate(redlined, (xml) => xml.replace(/ xml:space="preserve"/g, ""));
    const result = await check(original, bare, report);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("xml:space");
  });

  it("is found in another part of the package", async () => {
    const original = await buildDocx(doc(text(FIRST) + second), {
      "word/footnotes.xml":
        '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="1"><w:p><w:r><w:t>kept</w:t></w:r></w:p></w:footnote></w:footnotes>',
      "word/header1.xml":
        '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>CONFIDENTIAL</w:t></w:r></w:p></w:hdr>',
    });
    const { report, redlined } = await editedReview(original, edit);
    expect((await check(original, redlined, report)).ok).toBe(true);

    const changed = await mutate(
      redlined,
      (xml) => xml.replace("kept", "changed"),
      "word/footnotes.xml",
    );
    const first = await check(original, changed, report);
    expect(first.ok).toBe(false);
    // The message names the part and never its text.
    expect(first.problems.join(" ")).toContain("word/footnotes.xml");
    expect(first.problems.join(" ")).not.toContain("changed");

    const missing = await check(original, await withoutPart(redlined, "word/header1.xml"), report);
    expect(missing.problems.join(" ")).toContain("lacks the part word/header1.xml");
  });

  it("is found in comments that went missing", async () => {
    const original = await buildDocx(doc(text(FIRST) + second));
    const { report, redlined } = await editedReview(original, edit);
    const noAnchors = await mutate(redlined, (xml) =>
      xml
        .replace(/<w:commentRangeStart[^>]*\/>/g, "")
        .replace(/<w:commentRangeEnd[^>]*\/>/g, "")
        .replace(/<w:r><w:commentReference[^>]*\/><\/w:r>/g, ""),
    );
    expect((await check(original, noAnchors, report)).ok).toBe(false);
    const noPart = await check(original, await withoutPart(redlined, "word/comments.xml"), report);
    expect(noPart.ok).toBe(false);
    expect(noPart.problems.join(" ")).toContain("new comments");
  });
});

describe("correct output that must not be reported as damaged", () => {
  it("passes when a run without text lies inside the edit", async () => {
    const original = await buildDocx(
      doc(
        para(
          run("1.1 Recipient shall keep the ") +
            "<w:r><w:lastRenderedPageBreak/></w:r>" +
            run("Confidential Information secret for a perpetual term."),
        ) + second,
      ),
    );
    const { report, redlined } = await editedReview(original, {
      clauseId: "c1",
      quote: "the Confidential Information",
      replacement: "any Confidential Material",
    });
    expect(report.stats.editsApplied).toBe(1);
    expect(await check(original, redlined, report)).toMatchObject({ ok: true, trackedChanges: 1 });
  });

  it("passes when a footnote mark or an empty run lies inside the edit", async () => {
    const original = await buildDocx(
      doc(
        para(
          run("1.1 Recipient shall keep the Confidential") +
            '<w:r><w:footnoteReference w:id="2"/></w:r>' +
            run(" Information secret for a ") +
            "<w:r><w:rPr><w:b/></w:rPr></w:r>" +
            run("perpetual term."),
        ) + second,
      ),
    );
    const { report, redlined } = await editedReview(original, {
      clauseId: "c1",
      quote: "the Confidential Information",
      replacement: "any Confidential Material",
    });
    expect(report.stats.editsApplied).toBe(1);
    expect((await check(original, redlined, report)).ok).toBe(true);
  });

  it("passes when the edit touches a deletion an earlier reviewer made", async () => {
    const earlier =
      '<w:del w:id="90" w:author="Other" w:date="2026-01-01T00:00:00Z"><w:r><w:delText xml:space="preserve">very </w:delText></w:r></w:del>';
    const original = await buildDocx(
      doc(
        para(run("1.1 Recipient shall keep it ") + earlier + run("secret for a perpetual term.")) +
          second,
      ),
    );
    const { report, redlined } = await editedReview(original, {
      clauseId: "c1",
      quote: "secret for a perpetual term",
      replacement: "confidential for three years",
    });
    expect(report.stats.editsApplied).toBe(1);
    expect(await check(original, redlined, report)).toMatchObject({ ok: true, trackedChanges: 1 });
  });
});
