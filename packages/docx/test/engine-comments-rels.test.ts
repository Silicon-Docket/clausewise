import { describe, expect, it } from "vitest";
import { applyRedline } from "../src/index.js";
import { REL_TYPE, W_DECL, partBytes, relsXml, withPart, zipParts } from "./engine-support.js";
import { buildDocx, para, run } from "./helpers.js";

const date = new Date("2026-03-01T12:00:00Z");
const text = "The term is three years.";

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W_DECL}><w:docDefaults/></w:styles>`;
const SETTINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings ${W_DECL}><w:zoom w:percent="100"/></w:settings>`;
const FOOTNOTES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes ${W_DECL}><w:footnote w:id="1"><w:p><w:r><w:t>Note.</w:t></w:r></w:p></w:footnote></w:footnotes>`;
const COMMENTS = (...comments: Array<[number, string]>) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${W_DECL}>${comments
    .map(
      ([id, body]) =>
        `<w:comment w:id="${id}" w:author="Alice" w:initials="A" w:date="2026-01-01T00:00:00Z"><w:p><w:r><w:t>${body}</w:t></w:r></w:p></w:comment>`,
    )
    .join("")}</w:comments>`;

async function packageWith(
  relationships: Array<{ id: string; type: string; target: string; external?: boolean }>,
  parts: Record<string, string> = {},
): Promise<Uint8Array> {
  let buf = await buildDocx(para(run(text)), {
    "word/styles.xml": STYLES,
    "word/settings.xml": SETTINGS,
    "word/footnotes.xml": FOOTNOTES,
    ...parts,
  });
  buf = await withPart(buf, "word/_rels/document.xml.rels", relsXml(relationships));
  return buf;
}

const ops = {
  edits: [{ paragraphId: "p:0", start: 12, end: 17, replacement: "two" }],
  comments: [{ paragraphId: "p:0", text: "A note for the reviewer" }],
};

/** The names of the parts that hold a comment, as the package has them. */
async function commentParts(buf: Uint8Array): Promise<string[]> {
  const found: string[] = [];
  for (const [name, bytes] of Object.entries(await zipParts(buf))) {
    if (new TextDecoder().decode(bytes).includes("<w:comment ")) found.push(name);
  }
  return found.sort();
}

describe("a comments relationship that points somewhere it should not", () => {
  const hostile: Array<[string, { target: string; external?: boolean }]> = [
    ["the document itself", { target: "document.xml" }],
    ["the document itself, by absolute path", { target: "/word/document.xml" }],
    ["the styles", { target: "styles.xml" }],
    ["the settings", { target: "settings.xml" }],
    ["a numbering part", { target: "numbering.xml" }],
    ["the relationships of the document", { target: "_rels/document.xml.rels" }],
    ["the content types", { target: "../[Content_Types].xml" }],
    ["a part outside word/", { target: "../docProps/core.xml" }],
    ["a part that is not XML", { target: "comments.txt" }],
    ["a part that is something else", { target: "footnotes.xml" }],
    ["a path that leaves the package", { target: "../../../etc/passwd.xml" }],
    [
      "an address outside the package",
      { target: "https://example.com/comments.xml", external: true },
    ],
  ];

  it.each(hostile)(
    "ignores one that points at %s, and writes a comments part of its own",
    async (_, rel) => {
      const buf = await packageWith([
        { id: "rId1", type: "styles", target: "styles.xml" },
        { id: "rId9", type: "comments", ...rel },
      ]);
      const before = await zipParts(buf);
      const result = await applyRedline(buf, ops, { date });
      expect(result.edits).toEqual([{ applied: true }]);
      expect(result.comments).toEqual([{ applied: true }]);

      const after = await zipParts(result.buffer);
      const document = new TextDecoder().decode(after["word/document.xml"]!);
      expect(document).toContain("<w:ins ");
      expect(document).toContain("<w:commentRangeStart");
      expect(document).not.toContain("<w:comment ");

      for (const name of ["word/styles.xml", "word/settings.xml", "word/footnotes.xml"]) {
        expect(Buffer.from(after[name]!).equals(Buffer.from(before[name]!)), name).toBe(true);
      }
      expect(await commentParts(result.buffer)).toEqual(["word/comments.xml"]);
      expect(new TextDecoder().decode(after["word/comments.xml"]!)).toContain(
        "A note for the reviewer",
      );
      const rels = new TextDecoder().decode(after["word/_rels/document.xml.rels"]!);
      expect(rels).toContain(`${REL_TYPE}comments" Target="comments.xml"`);
    },
  );

  it("picks a name that no relationship points at, when the usual one is taken by a hostile one", async () => {
    const buf = await packageWith([{ id: "rId9", type: "comments", target: "comments.xml" }], {
      "word/comments.xml": FOOTNOTES,
    });
    const before = await zipParts(buf);
    const result = await applyRedline(buf, ops, { date });
    expect(result.comments).toEqual([{ applied: true }]);
    const after = await zipParts(result.buffer);
    expect(
      Buffer.from(after["word/comments.xml"]!).equals(Buffer.from(before["word/comments.xml"]!)),
    ).toBe(true);
    expect(await commentParts(result.buffer)).toEqual(["word/comments1.xml"]);
  });
});

describe("a comments part that the document really does point to", () => {
  const spellings = [
    "comments.xml",
    "./comments.xml",
    "/word/comments.xml",
    "../word/comments.xml",
    "Comments.XML",
    "sub/../comments.xml",
  ];

  it.each(spellings)("is found through the target %s and its comments are kept", async (target) => {
    const buf = await packageWith([{ id: "rId9", type: "comments", target }], {
      "word/comments.xml": COMMENTS([3, "Earlier remark"], [9, "Another remark"]),
    });
    const names = Object.keys(await zipParts(buf)).sort();
    const result = await applyRedline(buf, ops, { date });
    expect(result.comments).toEqual([{ applied: true }]);
    expect(Object.keys(await zipParts(result.buffer)).sort()).toEqual(names);
    const comments = new TextDecoder().decode(
      (await zipParts(result.buffer))["word/comments.xml"]!,
    );
    expect(comments).toContain("Earlier remark");
    expect(comments).toContain("Another remark");
    expect(comments).toContain("A note for the reviewer");
    const ids = [...comments.matchAll(/<w:comment w:id="(\d+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(3);
    expect(Math.max(...ids.map(Number))).toBeGreaterThan(9);
  });

  it("is created where the relationship says when the part itself is missing", async () => {
    const buf = await packageWith([{ id: "rId9", type: "comments", target: "comments7.xml" }]);
    const result = await applyRedline(buf, ops, { date });
    expect(result.comments).toEqual([{ applied: true }]);
    expect(await commentParts(result.buffer)).toEqual(["word/comments7.xml"]);
    const rels = new TextDecoder().decode(
      (await zipParts(result.buffer))["word/_rels/document.xml.rels"]!,
    );
    expect(rels.match(/relationships\/comments"/g)).toHaveLength(1);
  });

  it("is created, with its relationship, when the package has no relationships part at all", async () => {
    const buf = await withPart(await packageWith([]), "word/_rels/document.xml.rels", null);
    const result = await applyRedline(buf, ops, { date });
    expect(result.comments).toEqual([{ applied: true }]);
    expect(await commentParts(result.buffer)).toEqual(["word/comments.xml"]);
    expect(await partBytes(result.buffer, "word/_rels/document.xml.rels")).toBeDefined();
  });
});

describe("a package that cannot take comments", () => {
  const BROKEN = "<w:comments><w:comment";
  const base = [{ id: "rId1", type: "styles", target: "styles.xml" }];

  const broken: Array<[string, () => Promise<Uint8Array>]> = [
    [
      "a comments part that is not XML",
      () =>
        packageWith([...base, { id: "rId9", type: "comments", target: "comments.xml" }], {
          "word/comments.xml": BROKEN,
        }),
    ],
    [
      "a relationships part that is not XML",
      async () =>
        withPart(await packageWith(base), "word/_rels/document.xml.rels", "<Relationships><Relat"),
    ],
    [
      "no content types part to register a new comments part in",
      async () => withPart(await packageWith(base), "[Content_Types].xml", null),
    ],
  ];

  it.each(broken)("costs only the comments when it has %s", async (_, make) => {
    const buf = await make();
    const before = await zipParts(buf);
    const result = await applyRedline(buf, ops, { date });
    expect(result.edits).toEqual([{ applied: true }]);
    expect(result.comments).toEqual([
      { applied: false, reason: expect.stringContaining("comments cannot be read") },
    ]);
    const after = await zipParts(result.buffer);
    const document = new TextDecoder().decode(after["word/document.xml"]!);
    expect(document).toContain("<w:ins ");
    expect(document).not.toContain("commentRangeStart");
    for (const name of Object.keys(before).filter((n) => n !== "word/document.xml")) {
      expect(Buffer.from(after[name]!).equals(Buffer.from(before[name]!)), name).toBe(true);
    }
  });

  it.each(broken)("still takes edits alone when it has %s", async (_, make) => {
    const result = await applyRedline(await make(), { edits: ops.edits }, { date });
    expect(result.edits).toEqual([{ applied: true }]);
  });

  it("hands back the file untouched when the only request was a comment it could not place", async () => {
    const buf = await broken[0]![1]();
    const result = await applyRedline(buf, { comments: ops.comments }, { date });
    expect(result.comments).toEqual([{ applied: false, reason: expect.any(String) }]);
    expect(result.buffer).toBe(buf);
  });
});
