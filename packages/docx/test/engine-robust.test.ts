import { describe, expect, it } from "vitest";
import { applyRedline, parseDocx } from "../src/index.js";
import { createCommentsPart } from "../src/comments.js";
import { parseXml, serializeXml } from "../src/ooxml.js";
import { bodyParagraphs } from "../src/paragraphs.js";
import { executeRedline, planRedline } from "../src/redline.js";
import {
  documentXml,
  hasStrictParser,
  rawDocumentXml,
  rawParagraphs,
  strictParse,
  writtenXml,
  zipParts,
} from "./engine-support.js";
import { buildDocx, para, run, views } from "./helpers.js";

const date = new Date("2026-03-01T12:00:00Z");

describe("text that is already in the contract is cut exactly", () => {
  // A carriage return can only be written as a character reference. Word does not produce one,
  // but other generators do, and cutting such a text node used to change it.
  const body = para('<w:r><w:t xml:space="preserve">aa&#13;bb cc&#13;&#10;dd ee</w:t></w:r>');
  const original = "aa\rbb cc\r\ndd ee";

  it("keeps a carriage return in the pieces an edit and a comment cut it into", async () => {
    const buf = await buildDocx(body);
    expect((await parseDocx(buf)).paragraphs[0]!.text).toBe(original);
    const result = await applyRedline(
      buf,
      {
        edits: [
          { paragraphId: "p:0", start: 6, end: 8, replacement: "XX" },
          { paragraphId: "p:0", start: 1, end: 4, replacement: "Y" },
        ],
        comments: [{ paragraphId: "p:0", start: 3, end: 11, text: "see here" }],
      },
      { date, minimize: false },
    );
    expect(result.edits).toEqual([{ applied: true }, { applied: true }]);
    expect(result.comments).toEqual([{ applied: true }]);
    expect((await views(result.buffer, "rejected"))[0]).toBe(original);
    expect((await views(result.buffer, "accepted"))[0]).toBe("aYb XX\r\ndd ee");
    const xml = await rawDocumentXml(result.buffer);
    expect(xml).not.toContain("\r");
    if (hasStrictParser) {
      const errors = strictParse(await writtenXml(result.buffer));
      for (const [name, error] of Object.entries(errors)) expect(error, name).toBeNull();
    }
  });
});

describe("a paragraph that cannot be prepared", () => {
  const body =
    para(run("First paragraph with some words.")) + para(run("Second paragraph with words."));

  function planned() {
    const doc = parseXml(documentXml(body), "word/document.xml");
    const plan = planRedline(
      doc,
      {
        edits: [
          { paragraphId: "p:0", start: 6, end: 15, replacement: "line" },
          { paragraphId: "p:1", start: 7, end: 16, replacement: "part" },
        ],
        comments: [
          { paragraphId: "p:0", text: "about the first" },
          { paragraphId: "p:1", text: "about the second" },
        ],
      },
      { date },
    );
    return { doc, plan };
  }

  it("is put back as it was and refused, while the others are still written", () => {
    const { doc, plan } = planned();
    const before = rawParagraphs(serializeXml(doc));
    // A plan whose reading of the paragraph no longer matches what is there is how a bug in the
    // cutting would show; the engine must degrade instead of throwing.
    plan.paragraphs[0]!.scan.text = "not what the paragraph says";
    const comments = createCommentsPart();
    const { addedComments } = executeRedline(doc, plan, comments, { date });

    const after = rawParagraphs(serializeXml(doc));
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(plan.edits[0]).toMatchObject({ applied: false });
    expect(plan.comments[0]).toMatchObject({ applied: false });
    expect((plan.edits[0] as { reason: string }).reason).toMatch(/left as it was/);
    expect(plan.edits[1]).toEqual({ applied: true });
    expect(plan.comments[1]).toEqual({ applied: true });
    expect(addedComments).toBe(true);
    const written = serializeXml(comments.doc);
    expect(written).toContain("about the second");
    expect(written).not.toContain("about the first");
  });

  it("takes back the comments it had already added for a paragraph that fails part way", () => {
    const link = "<w:hyperlink><w:r><w:t>li</w:t></w:r><w:r><w:t>nk</w:t></w:r></w:hyperlink>";
    const doc = parseXml(
      documentXml(para(run("A ") + link + run(" text here.")) + para(run("Second paragraph."))),
      "word/document.xml",
    );
    const plan = planRedline(
      doc,
      {
        edits: [
          { paragraphId: "p:0", start: 7, end: 11, replacement: "words" },
          { paragraphId: "p:0", start: 2, end: 4, replacement: "x" },
          { paragraphId: "p:1", start: 0, end: 6, replacement: "Third" },
        ],
        comments: [
          { paragraphId: "p:0", text: "about the first" },
          { paragraphId: "p:1", text: "about the second" },
        ],
      },
      { date },
    );
    // The hyperlink is refused when planned. Slipping the edit into the plan anyway makes the write
    // fail after the comment and the first edit were already placed, the worst moment to fail.
    expect(plan.edits[1]).toMatchObject({ applied: false });
    plan.paragraphs[0]!.edits.push({ index: 1, start: 2, end: 4, removed: "li", inserted: "x" });
    const before = rawParagraphs(serializeXml(doc));
    const comments = createCommentsPart();
    executeRedline(doc, plan, comments, { date });

    const after = rawParagraphs(serializeXml(doc));
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(plan.edits.map((o) => o.applied)).toEqual([false, false, true]);
    expect(plan.comments.map((o) => o.applied)).toEqual([false, true]);
    const written = serializeXml(comments.doc);
    expect(written).not.toContain("about the first");
    expect(written.match(/<w:comment /g)).toHaveLength(1);
  });

  it("reports nothing written when every paragraph is refused", () => {
    const { doc, plan } = planned();
    const before = serializeXml(doc);
    for (const pl of plan.paragraphs) pl.scan.text = "changed";
    const comments = createCommentsPart();
    expect(executeRedline(doc, plan, comments, { date }).addedComments).toBe(false);
    expect(serializeXml(doc)).toBe(before);
    expect(serializeXml(comments.doc)).not.toContain("<w:comment ");
    expect(plan.edits.every((o) => !o.applied)).toBe(true);
    expect(bodyParagraphs(doc)).toHaveLength(2);
  });
});

describe("a paragraph whose runs are cut into more runs than it started with", () => {
  it("is still edited, because the run limit is meant for the file as it arrives", async () => {
    const twoParts = "<w:r><w:t>ab</w:t><w:tab/></w:r>";
    const buf = await buildDocx(para(twoParts.repeat(8)));
    const result = await applyRedline(
      buf,
      { edits: [{ paragraphId: "p:0", start: 1, end: 2, replacement: "X" }] },
      { date, limits: { maxRunsPerParagraph: 12 } },
    );
    expect(result.edits).toEqual([{ applied: true }]);
    expect((await parseDocx(result.buffer)).paragraphs[0]!.text).toBe("aX\t" + "ab\t".repeat(7));
  });
});

describe("a text node that is almost all whitespace", () => {
  it("is cut without the quadratic cost of looking for its trailing whitespace", async () => {
    const spaces = " ".repeat(250_000);
    // No xml:space, so Word ignores the edges of the first text and the engine has to find them.
    const buf = await buildDocx(para(`<w:r><w:t>${spaces}x</w:t></w:r>${run("tail words here")}`));
    const started = performance.now();
    const result = await applyRedline(
      buf,
      { edits: [{ paragraphId: "p:0", start: 250_001 + 5, end: 250_001 + 10, replacement: "w" }] },
      { date },
    );
    const elapsed = performance.now() - started;
    expect(result.edits).toEqual([{ applied: true }]);
    expect(elapsed).toBeLessThan(5000);
    expect(Object.keys(await zipParts(result.buffer))).toContain("word/document.xml");
  }, 120_000);
});
