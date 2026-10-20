import { describe, expect, it } from "vitest";
import { applyRedline, parseDocx } from "../src/index.js";
import { rawDocumentXml, rawParagraphs } from "./engine-support.js";
import { paragraphsOf, parseDom, viewText } from "./engine-fuzz-support.js";
import { buildDocx, elements, para, run, views } from "./helpers.js";

const date = new Date("2026-03-01T12:00:00Z");
const opts = { date, author: "Clausewise" };

/** What Word shows of every paragraph, ignoring the whitespace it ignores at the edge of a w:t. */
async function shown(buf: Uint8Array, mode: "accepted" | "rejected"): Promise<string[]> {
  const doc = parseDom(await rawDocumentXml(buf));
  return paragraphsOf(doc).map((p) => viewText(p, mode, "Clausewise", true));
}

describe("a paragraph nobody edited stays exactly as it was", () => {
  const SEPARATED =
    "Governing law: Delaware.\u2028Venue: New York.\u0085Notice: 30 days.\u2029End.";

  it("keeps NEL, line separator and paragraph separator characters, before and after a redline", async () => {
    const buf = await buildDocx(para(run("Term is three years.")) + para(run(SEPARATED)));
    expect((await parseDocx(buf)).paragraphs[1]?.text).toBe(SEPARATED);

    const result = await applyRedline(
      buf,
      { edits: [{ paragraphId: "p:0", start: 8, end: 13, replacement: "two" }] },
      opts,
    );
    expect(result.edits).toEqual([{ applied: true }]);
    expect((await parseDocx(result.buffer)).paragraphs[1]?.text).toBe(SEPARATED);

    const before = rawParagraphs(await rawDocumentXml(buf));
    const after = rawParagraphs(await rawDocumentXml(result.buffer));
    expect(after[1]).toBe(before[1]);
    for (const ch of ["\u2028", "\u0085", "\u2029"]) expect(after[1]).toContain(ch);
  });

  it("keeps them in a paragraph that is edited, outside the edit", async () => {
    const text = `Pay \u2028thirty\u0085 days\u2029later.`;
    const buf = await buildDocx(para(run(text)));
    const result = await applyRedline(
      buf,
      { edits: [{ paragraphId: "p:0", start: 5, end: 11, replacement: "sixty" }] },
      opts,
    );
    expect(result.edits).toEqual([{ applied: true }]);
    expect((await views(result.buffer, "rejected"))[0]).toBe(text);
    expect((await views(result.buffer, "accepted"))[0]).toBe(
      "Pay \u2028sixty\u0085 days\u2029later.",
    );
  });

  it("reads a carriage return given as a character reference as itself, and writes it back as one", async () => {
    const buf = await buildDocx(para('<w:r><w:t>a&#13;b</w:t></w:r>') + para(run("edit me")));
    expect((await parseDocx(buf)).paragraphs[0]?.text).toBe("a\rb");
    const result = await applyRedline(
      buf,
      { edits: [{ paragraphId: "p:1", start: 0, end: 4, replacement: "fix" }] },
      opts,
    );
    expect((await parseDocx(result.buffer)).paragraphs[0]?.text).toBe("a\rb");
    expect(rawParagraphs(await rawDocumentXml(result.buffer))[0]).toContain("&#13;");
  });

  it("reads a raw line end the way XML says to, as a line feed, and keeps it that way", async () => {
    const buf = await buildDocx(para('<w:r><w:t xml:space="preserve">a\r\nb\rc</w:t></w:r>') + para(run("x")));
    expect((await parseDocx(buf)).paragraphs[0]?.text).toBe("a\nb\nc");
    const result = await applyRedline(
      buf,
      { edits: [{ paragraphId: "p:1", start: 0, end: 1, replacement: "y" }] },
      opts,
    );
    expect((await parseDocx(result.buffer)).paragraphs[0]?.text).toBe("a\nb\nc");
  });
});

describe("comment ranges", () => {
  const text = "Pay \u{1F600} within 30 days.";

  it("are refused when they cut a surrogate pair, as edits are", async () => {
    const buf = await buildDocx(para(run(text)));
    const split = "the range splits a surrogate pair";
    const result = await applyRedline(
      buf,
      {
        comments: [
          { paragraphId: "p:0", start: 5, end: 12, text: "starts inside the emoji" },
          { paragraphId: "p:0", start: 0, end: 5, text: "ends inside the emoji" },
          { paragraphId: "p:0", start: 4, end: 5, text: "covers half of it" },
          { paragraphId: "p:0", start: 4, end: 6, text: "covers all of it" },
          { paragraphId: "p:0", start: 6, end: 12, text: "starts after it" },
        ],
      },
      opts,
    );
    expect(result.comments).toEqual([
      { applied: false, reason: split },
      { applied: false, reason: split },
      { applied: false, reason: split },
      { applied: true },
      { applied: true },
    ]);
    expect((await views(result.buffer, "accepted"))[0]).toBe(text);
    expect(await rawDocumentXml(result.buffer)).not.toContain("\uFFFD");
    expect((await parseDocx(result.buffer)).paragraphs[0]?.text).toBe(text);
  });
});

describe("whitespace that Word ignores", () => {
  const body = para(
    "<w:r><w:t>Hello </w:t></w:r><w:r><w:t> brown fox </w:t></w:r><w:r><w:t>jumps</w:t></w:r>",
  );

  it("does not start to show when a run is cut for an edit", async () => {
    const buf = await buildDocx(body);
    const original = await shown(buf, "accepted");
    expect(original).toEqual(["Hellobrown foxjumps"]);
    expect((await parseDocx(buf)).paragraphs[0]?.text).toBe("Hello  brown fox jumps");

    const start = "Hello  brown fox jumps".indexOf("brown");
    const result = await applyRedline(
      buf,
      { edits: [{ paragraphId: "p:0", start, end: start + 5, replacement: "red" }] },
      { ...opts, minimize: false },
    );
    expect(result.edits).toEqual([{ applied: true }]);
    expect(await shown(result.buffer, "rejected")).toEqual(original);
    expect(await shown(result.buffer, "accepted")).toEqual(["Hellored foxjumps"]);
  });

  it("gives a piece xml:space only when the cut leaves real whitespace at its edge", async () => {
    const buf = await buildDocx(para("<w:r><w:t>one two three</w:t></w:r>"));
    const result = await applyRedline(
      buf,
      { edits: [{ paragraphId: "p:0", start: 4, end: 7, replacement: "2" }] },
      { ...opts, minimize: false },
    );
    const xml = await rawDocumentXml(result.buffer);
    expect(xml).toContain('<w:t xml:space="preserve">one </w:t>');
    expect(xml).toContain("<w:delText>two</w:delText>");
    expect(xml).toContain('<w:t xml:space="preserve"> three</w:t>');
    expect(await shown(result.buffer, "rejected")).toEqual(["one two three"]);
  });

  it("keeps xml:space on every piece of a run that had it", async () => {
    const buf = await buildDocx(para(run(" one two ")));
    const result = await applyRedline(
      buf,
      { edits: [{ paragraphId: "p:0", start: 5, end: 8, replacement: "2" }] },
      { ...opts, minimize: false },
    );
    const xml = await rawDocumentXml(result.buffer);
    expect(xml).toContain('<w:delText xml:space="preserve">two</w:delText>');
    expect(await shown(result.buffer, "rejected")).toEqual([" one two "]);
  });

  it("writes inserted text with xml:space only when it starts or ends with whitespace", async () => {
    const buf = await buildDocx(para(run("Pay now")));
    const result = await applyRedline(
      buf,
      {
        edits: [
          { paragraphId: "p:0", start: 3, end: 3, replacement: " us" },
          { paragraphId: "p:0", start: 7, end: 7, replacement: "!" },
        ],
      },
      { ...opts, minimize: false },
    );
    const xml = await rawDocumentXml(result.buffer);
    expect(xml).toContain('<w:t xml:space="preserve"> us</w:t>');
    expect(xml).toContain("<w:t>!</w:t>");
  });
});

describe("a formatting revision on a run that is split or copied", () => {
  const revision =
    '<w:rPr><w:b/><w:rPrChange w:id="7" w:author="Alice" w:date="2026-01-01T00:00:00Z"><w:rPr/></w:rPrChange></w:rPr>';

  it("is not repeated on the inserted text and keeps one id each everywhere else", async () => {
    const buf = await buildDocx(
      para(`<w:r>${revision}<w:t xml:space="preserve">The term is three years.</w:t></w:r>`),
    );
    const result = await applyRedline(
      buf,
      { edits: [{ paragraphId: "p:0", start: 12, end: 17, replacement: "two" }] },
      { ...opts, minimize: false },
    );
    expect(result.edits).toEqual([{ applied: true }]);

    const changes = await elements(result.buffer, "rPrChange");
    const ids = changes.map((c) => c.getAttributeNS("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "id"));
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("7");

    for (const ins of await elements(result.buffer, "ins")) {
      expect(ins.getElementsByTagNameNS("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "rPrChange")).toHaveLength(0);
    }
  });
});
