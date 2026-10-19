import { describe, expect, it } from "vitest";
import { applyRedline, parseDocx } from "../src/index.js";
import { annotationIds, buildDocx, elements, para, readPartText, run, views } from "./helpers.js";

const date = new Date("2026-03-01T12:00:00.123Z");
const opts = { date };

describe("applyRedline: edits", () => {
  it("returns the original bytes when there is nothing to do", async () => {
    const buf = await buildDocx(para(run("Hello.")));
    const result = await applyRedline(buf, {});
    expect(result.buffer).toBe(buf);
  });

  it("returns the original bytes when every edit is rejected", async () => {
    const buf = await buildDocx(para(run("Hello.")));
    const result = await applyRedline(
      buf,
      { edits: [{ paragraphId: "p:9", start: 0, end: 1, replacement: "x" }] },
      opts,
    );
    expect(result.buffer).toBe(buf);
    expect(result.edits[0]).toEqual({ applied: false, reason: "unknown paragraph p:9" });
  });

  it("replaces text inside one run as a tracked change", async () => {
    const buf = await buildDocx(para(run("The term is three years.")));
    const text = "The term is three years.";
    const start = text.indexOf("three");
    const result = await applyRedline(
      buf,
      { edits: [{ paragraphId: "p:0", start, end: start + 5, replacement: "two" }] },
      opts,
    );
    expect(result.edits).toEqual([{ applied: true }]);
    expect(await views(result.buffer, "accepted")).toEqual(["The term is two years."]);
    expect(await views(result.buffer, "rejected")).toEqual([text]);

    const [del] = await elements(result.buffer, "del");
    expect(del?.getAttribute("w:author")).toBe("Clausewise");
    expect(del?.getAttribute("w:date")).toBe("2026-03-01T12:00:00Z");
    expect(await elements(result.buffer, "delText")).toHaveLength(1);
  });

  it("edits across runs and copies the first affected run's formatting onto the insertion", async () => {
    const buf = await buildDocx(
      para(run("Pay within ") + run("thirty (30)", "<w:b/>") + run(" days of receipt.")),
    );
    const text = "Pay within thirty (30) days of receipt.";
    const start = text.indexOf("thirty");
    const end = text.indexOf(" days");
    const result = await applyRedline(
      buf,
      { edits: [{ paragraphId: "p:0", start, end, replacement: "sixty (60)" }] },
      opts,
    );
    expect(await views(result.buffer, "accepted")).toEqual([
      "Pay within sixty (60) days of receipt.",
    ]);
    expect(await views(result.buffer, "rejected")).toEqual([text]);
    const [ins] = await elements(result.buffer, "ins");
    expect(ins?.getElementsByTagNameNS("*", "b")).toHaveLength(1);
  });

  it("strikes and inserts only the words that differ", async () => {
    const buf = await buildDocx(para(run("Obligations last for three (3) years from disclosure.")));
    const original = "Obligations last for three (3) years from disclosure.";
    const result = await applyRedline(
      buf,
      {
        edits: [
          {
            paragraphId: "p:0",
            start: 0,
            end: original.length,
            replacement: "Obligations last for two (2) years from disclosure.",
          },
        ],
      },
      opts,
    );
    const deleted = (await elements(result.buffer, "delText")).map((e) => e.textContent).join("");
    const inserted = (await elements(result.buffer, "ins")).map((e) => e.textContent).join("");
    expect(deleted).toBe("three (3)");
    expect(inserted).toBe("two (2)");
    expect(await views(result.buffer, "rejected")).toEqual([original]);
  });

  it("inserts at a position", async () => {
    const buf = await buildDocx(para(run("Hello world.")));
    const result = await applyRedline(
      buf,
      { edits: [{ paragraphId: "p:0", start: 5, end: 5, replacement: ", brave" }] },
      opts,
    );
    expect(await views(result.buffer, "accepted")).toEqual(["Hello, brave world."]);
    expect(await views(result.buffer, "rejected")).toEqual(["Hello world."]);
    expect(await elements(result.buffer, "del")).toHaveLength(0);
  });

  it("deletes text when the replacement is empty", async () => {
    const buf = await buildDocx(para(run("Keep this. Drop this.")));
    const result = await applyRedline(
      buf,
      { edits: [{ paragraphId: "p:0", start: 10, end: 21, replacement: "" }] },
      opts,
    );
    expect(await views(result.buffer, "accepted")).toEqual(["Keep this."]);
    expect(await views(result.buffer, "rejected")).toEqual(["Keep this. Drop this."]);
  });

  it("applies several edits to one paragraph, whatever order they are given in", async () => {
    const text = "Alpha one. Beta two. Gamma three.";
    const buf = await buildDocx(para(run(text)));
    const result = await applyRedline(
      buf,
      {
        edits: [
          {
            paragraphId: "p:0",
            start: text.indexOf("one"),
            end: text.indexOf("one") + 3,
            replacement: "1",
          },
          {
            paragraphId: "p:0",
            start: text.indexOf("three"),
            end: text.indexOf("three") + 5,
            replacement: "3",
          },
          {
            paragraphId: "p:0",
            start: text.indexOf("two"),
            end: text.indexOf("two") + 3,
            replacement: "2",
          },
        ],
      },
      opts,
    );
    expect(result.edits.every((o) => o.applied)).toBe(true);
    expect(await views(result.buffer, "accepted")).toEqual(["Alpha 1. Beta 2. Gamma 3."]);
    expect(await views(result.buffer, "rejected")).toEqual([text]);
  });

  it("rejects an edit that overlaps an earlier one and keeps the earlier one", async () => {
    const buf = await buildDocx(para(run("abcdefghij")));
    const result = await applyRedline(
      buf,
      {
        edits: [
          { paragraphId: "p:0", start: 2, end: 6, replacement: "X" },
          { paragraphId: "p:0", start: 4, end: 8, replacement: "Y" },
        ],
      },
      opts,
    );
    expect(result.edits).toEqual([
      { applied: true },
      { applied: false, reason: "the edit overlaps an earlier edit" },
    ]);
    expect(await views(result.buffer, "accepted")).toEqual(["abXghij"]);
  });

  it("rejects edits that touch a hyperlink or a field result but applies the rest", async () => {
    const buf = await buildDocx(
      para(
        run("See ") +
          `<w:hyperlink r:id="rId9">${run("the link")}</w:hyperlink>` +
          run(" and ") +
          `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> REF x </w:instrText></w:r>` +
          `<w:r><w:fldChar w:fldCharType="separate"/></w:r>${run("Section 4")}` +
          `<w:r><w:fldChar w:fldCharType="end"/></w:r>` +
          run(" applies."),
      ),
    );
    const text = "See the link and Section 4 applies.";
    const result = await applyRedline(
      buf,
      {
        edits: [
          {
            paragraphId: "p:0",
            start: text.indexOf("the link"),
            end: text.indexOf("the link") + 8,
            replacement: "x",
          },
          {
            paragraphId: "p:0",
            start: text.indexOf("Section"),
            end: text.indexOf("Section") + 7,
            replacement: "y",
          },
          {
            paragraphId: "p:0",
            start: text.indexOf("applies"),
            end: text.indexOf("applies") + 7,
            replacement: "governs",
          },
        ],
      },
      opts,
    );
    expect(result.edits.map((o) => o.applied)).toEqual([false, false, true]);
    expect(await views(result.buffer, "accepted")).toEqual(["See the link and Section 4 governs."]);
  });

  it("keeps non-text content, such as a footnote reference, in place", async () => {
    const buf = await buildDocx(
      para(
        `<w:r><w:rPr><w:b/></w:rPr><w:t>Bold text</w:t><w:footnoteReference w:id="1"/><w:t> more</w:t></w:r>`,
      ),
    );
    const result = await applyRedline(
      buf,
      { edits: [{ paragraphId: "p:0", start: 5, end: 9, replacement: "word" }] },
      opts,
    );
    expect(await views(result.buffer, "accepted")).toEqual(["Bold word more"]);
    expect(await elements(result.buffer, "footnoteReference")).toHaveLength(1);
  });

  it("rejects bad ranges, no-ops and surrogate splits", async () => {
    const buf = await buildDocx(para(run("a😀b")));
    const result = await applyRedline(
      buf,
      {
        edits: [
          { paragraphId: "p:0", start: 0, end: 99, replacement: "x" },
          { paragraphId: "p:0", start: 0, end: 1, replacement: "a" },
          { paragraphId: "p:0", start: 2, end: 3, replacement: "x" },
        ],
      },
      opts,
    );
    expect(result.edits.map((o) => o.applied)).toEqual([false, false, false]);
    expect(result.edits[2]).toEqual({
      applied: false,
      reason: "the range splits a surrogate pair",
    });
  });

  it("writes newlines and tabs in a replacement as breaks and tabs", async () => {
    const buf = await buildDocx(para(run("Line.")));
    const result = await applyRedline(
      buf,
      { edits: [{ paragraphId: "p:0", start: 0, end: 5, replacement: "A\nB\tC" }] },
      opts,
    );
    expect((await parseDocx(result.buffer)).paragraphs[0]?.text).toBe("A\nB\tC");
  });

  it("gives every tracked change a unique id", async () => {
    const text = "one two three four";
    const buf = await buildDocx(para(run(text)));
    const result = await applyRedline(
      buf,
      {
        edits: [
          { paragraphId: "p:0", start: 0, end: 3, replacement: "1" },
          { paragraphId: "p:0", start: 4, end: 7, replacement: "2" },
          { paragraphId: "p:0", start: 8, end: 13, replacement: "3" },
        ],
        comments: [{ paragraphId: "p:0", text: "note" }],
      },
      opts,
    );
    const ids = await annotationIds(result.buffer);
    expect(ids).toHaveLength(7);
    expect(ids.every((id) => id !== "")).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("applyRedline: comments", () => {
  it("anchors a comment on a range and registers the comments part", async () => {
    const text = "Governing law is Delaware.";
    const buf = await buildDocx(para(run(text)));
    const result = await applyRedline(
      buf,
      {
        comments: [{ paragraphId: "p:0", start: 17, end: 25, text: "Check venue.\nSecond line." }],
      },
      opts,
    );
    expect(result.comments).toEqual([{ applied: true }]);
    expect(await views(result.buffer, "accepted")).toEqual([text]);

    const comments = await readPartText(result.buffer, "word/comments.xml");
    expect(comments).toContain("Check venue.");
    expect(comments).toContain("Second line.");
    expect(comments).toContain('w:author="Clausewise"');
    expect(await readPartText(result.buffer, "word/_rels/document.xml.rels")).toContain(
      "relationships/comments",
    );
    expect(await readPartText(result.buffer, "[Content_Types].xml")).toContain(
      'PartName="/word/comments.xml"',
    );

    const doc = await readPartText(result.buffer, "word/document.xml");
    const order = ["commentRangeStart", "Delaware", "commentRangeEnd", "commentReference"].map(
      (s) => doc?.indexOf(s),
    );
    expect(order.every((n) => n !== undefined && n >= 0)).toBe(true);
    expect([...order]).toEqual([...order].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });

  it("anchors on the whole paragraph when no range is given, including an empty one", async () => {
    const buf = await buildDocx(para(run("Some clause.")) + para(""));
    const result = await applyRedline(
      buf,
      {
        comments: [
          { paragraphId: "p:0", text: "first" },
          { paragraphId: "p:1", text: "empty" },
        ],
      },
      opts,
    );
    expect(result.comments).toEqual([{ applied: true }, { applied: true }]);
    expect(await elements(result.buffer, "commentRangeStart")).toHaveLength(2);
    expect(await elements(result.buffer, "commentRangeEnd")).toHaveLength(2);
  });

  it("appends to an existing comments part without renumbering its comments", async () => {
    const existing =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="41" w:author="Pat" w:date="2025-01-01T00:00:00Z"><w:p><w:r><w:t>Old note</w:t></w:r></w:p></w:comment></w:comments>';
    const buf = await buildDocx(
      para(run("Clause.")),
      { "word/comments.xml": existing },
      { withCommentsRel: true },
    );
    const result = await applyRedline(
      buf,
      { comments: [{ paragraphId: "p:0", text: "New note" }] },
      opts,
    );
    const comments = (await readPartText(result.buffer, "word/comments.xml")) ?? "";
    expect(comments).toContain('w:id="41"');
    expect(comments).toContain("Old note");
    expect(comments).toContain("New note");
    expect(comments).toContain('w:id="42"');
    const rels = (await readPartText(result.buffer, "word/_rels/document.xml.rels")) ?? "";
    expect(rels.match(/relationships\/comments/g)).toHaveLength(1);
  });

  it("puts a comment and an edit on the same text without disturbing either", async () => {
    const text = "Term is perpetual.";
    const buf = await buildDocx(para(run(text)));
    const result = await applyRedline(
      buf,
      {
        edits: [{ paragraphId: "p:0", start: 8, end: 17, replacement: "three years" }],
        comments: [{ paragraphId: "p:0", start: 0, end: 17, text: "Too long." }],
      },
      opts,
    );
    expect(await views(result.buffer, "accepted")).toEqual(["Term is three years."]);
    expect(await views(result.buffer, "rejected")).toEqual([text]);
    expect(await elements(result.buffer, "commentRangeEnd")).toHaveLength(1);
  });

  it("rejects comments with unknown paragraphs or empty ranges", async () => {
    const buf = await buildDocx(para(run("Clause.")));
    const result = await applyRedline(
      buf,
      {
        comments: [
          { paragraphId: "p:5", text: "x" },
          { paragraphId: "p:0", start: 3, end: 3, text: "x" },
          { paragraphId: "p:0", start: 0, end: 50, text: "x" },
        ],
      },
      opts,
    );
    expect(result.comments.map((o) => o.applied)).toEqual([false, false, false]);
    expect(result.buffer).toBe(buf);
  });
});

describe("applyRedline: package integrity", () => {
  it("leaves every other part of the package byte-identical", async () => {
    const buf = await buildDocx(para(run("Hello world.")), { "word/styles.xml": "<styles/>" });
    const result = await applyRedline(
      buf,
      { edits: [{ paragraphId: "p:0", start: 0, end: 5, replacement: "Howdy" }] },
      opts,
    );
    expect(await readPartText(result.buffer, "word/styles.xml")).toBe("<styles/>");
    expect(await readPartText(result.buffer, "word/_rels/document.xml.rels")).toBe(
      await readPartText(buf, "word/_rels/document.xml.rels"),
    );
  });

  it("keeps the XML declaration and root namespaces", async () => {
    const buf = await buildDocx(para(run("Hello world.")));
    const result = await applyRedline(
      buf,
      { edits: [{ paragraphId: "p:0", start: 0, end: 5, replacement: "Howdy" }] },
      opts,
    );
    const xml = (await readPartText(result.buffer, "word/document.xml")) ?? "";
    expect(xml.startsWith("<?xml")).toBe(true);
    expect(xml).toContain(
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
    );
  });
});
