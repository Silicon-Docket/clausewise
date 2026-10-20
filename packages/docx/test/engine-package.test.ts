import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS,
  DocxError,
  applyRedline,
  inspectDocx,
  parseDocx,
  type Edit,
} from "../src/index.js";
import {
  W,
  craftZip,
  documentXml,
  hasStrictParser,
  strictParse,
  utf8,
  withPart,
  zipParts,
} from "./engine-support.js";
import { buildDocx, para, run } from "./helpers.js";

const date = new Date("2026-03-01T12:00:00Z");
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

const STRICT_NS = "http://purl.oclc.org/ooxml/wordprocessingml/main";
const edit = (start: number, end: number, replacement: string): Edit => ({
  paragraphId: "p:0",
  start,
  end,
  replacement,
});

/** A package whose word/document.xml is exactly these bytes. */
async function withDocumentBytes(bytes: Uint8Array): Promise<Uint8Array> {
  return withPart(await buildDocx(""), "word/document.xml", bytes);
}

describe("how a part is turned into text", () => {
  const xml = documentXml(para(run("Term is three years.")));

  async function expectReadable(buf: Uint8Array, text = "Term is three years."): Promise<void> {
    expect((await parseDocx(buf)).paragraphs[0]?.text).toBe(text);
    const result = await applyRedline(buf, { edits: [edit(0, 4, "Duration")] }, { date });
    expect(result.edits).toEqual([{ applied: true }]);
    const written = (await zipParts(result.buffer))["word/document.xml"]!;
    expect(new TextDecoder().decode(written)).toMatch(/^<\?xml version="1.0" encoding="UTF-8"/);
    if (hasStrictParser) {
      expect(strictParse({ "word/document.xml": written })["word/document.xml"]).toBeNull();
    }
  }

  it("strips a UTF-8 byte order mark", async () => {
    await expectReadable(
      await withDocumentBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xml)])),
    );
  });

  it("decodes UTF-16 with a byte order mark, either way round", async () => {
    const declared = xml.replace('encoding="UTF-8"', 'encoding="UTF-16"');
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(declared, "utf16le")]);
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(declared, "utf16le").swap16()]);
    await expectReadable(await withDocumentBytes(le));
    await expectReadable(await withDocumentBytes(be));
  });

  it("decodes UTF-16 that has no byte order mark", async () => {
    await expectReadable(await withDocumentBytes(Buffer.from(xml, "utf16le")));
  });

  it("honours the encoding the XML declaration names", async () => {
    const latin = documentXml(para(run("caf\u00e9 society")), '<?xml version="1.0" encoding="windows-1252"?>');
    await expectReadable(
      await withDocumentBytes(Buffer.from(latin, "latin1")),
      "caf\u00e9 society",
    );
  });

  it("says so when the declared encoding is unknown", async () => {
    const odd = xml.replace('encoding="UTF-8"', 'encoding="x-not-an-encoding"');
    const buf = await withDocumentBytes(Buffer.from(odd));
    await expect(parseDocx(buf)).rejects.toThrow(/text encoding that is not supported/);
  });
});

describe("files that are not ordinary Word documents", () => {
  it("names the Strict Open XML format and says what to do", async () => {
    const strict = documentXml(para(run("Term."))).replaceAll(W, STRICT_NS);
    const buf = await withDocumentBytes(utf8(strict));
    for (const attempt of [
      () => parseDocx(buf),
      () => applyRedline(buf, { edits: [edit(0, 4, "x")] }, { date }),
      () => inspectDocx(buf),
    ]) {
      const error = await attempt().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(DocxError);
      expect((error as Error).message).toMatch(/Strict Open XML/);
      expect((error as Error).message).toMatch(/save it again as a normal/);
    }
  });

  it("does not mistake an ordinary document for Strict", async () => {
    const note = `<!-- ${STRICT_NS} -->`;
    const buf = await withDocumentBytes(utf8(documentXml(note + para(run("Term.")))));
    expect((await parseDocx(buf)).paragraphs[0]?.text).toBe("Term.");
  });

  it("says a password protected or old-format file is exactly that", async () => {
    const ole = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    const error = await parseDocx(ole).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DocxError);
    expect((error as Error).message).toMatch(/password protected|encrypted/);
    expect((error as Error).message).toMatch(/old-format|older/);
    expect((error as Error).message).not.toMatch(/zip/);
  });

  it("keeps saying that other things are not zip archives", async () => {
    await expect(parseDocx(utf8("just some text"))).rejects.toThrow(
      "Not a .docx file: it is not a valid zip archive",
    );
  });

  it("reports XML that cannot be read as a DocxError, not as an unexpected failure", async () => {
    const buf = await withDocumentBytes(utf8("<w:document><w:body><w:p></w:body></w:document>"));
    const error = await parseDocx(buf).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DocxError);
    expect((error as Error).message).toBe("word/document.xml is not valid XML");
  });
});

describe("limits", () => {
  const body = para(run("Term is three years."));
  const limited = async (limits: Record<string, number>, buf?: Uint8Array) =>
    applyRedline(buf ?? (await buildDocx(body)), { edits: [edit(8, 13, "two")] }, { date, limits })
      .then(() => "no error")
      .catch((e: unknown) => (e instanceof DocxError ? e.message : `unexpected ${String(e)}`));

  it("exports the defaults in one place, generous for a real contract", () => {
    expect(Object.keys(DEFAULT_LIMITS).sort()).toEqual([
      "maxDocumentXmlBytes",
      "maxInputBytes",
      "maxNestingDepth",
      "maxParagraphs",
      "maxPartBytes",
      "maxRunsPerParagraph",
      "maxUncompressedBytes",
      "maxZipEntries",
    ]);
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
  });

  it.each([
    ["maxInputBytes", 100],
    ["maxDocumentXmlBytes", 100],
    ["maxUncompressedBytes", 100],
    ["maxZipEntries", 2],
    ["maxParagraphs", 0],
    ["maxRunsPerParagraph", 0],
    ["maxNestingDepth", 2],
  ])("refuses a file over %s and names the limit", async (name, value) => {
    const message = await limited({ [name]: value });
    expect(message).toContain(`(${name})`);
    expect(message).toMatch(/over the limit/);
    expect(message).not.toContain("three years");
  });

  it("applies the same limits when inspecting", async () => {
    const buf = await buildDocx(body);
    await expect(inspectDocx(buf, { maxDocumentXmlBytes: 100 })).rejects.toThrow(
      /maxDocumentXmlBytes/,
    );
  });

  it("refuses a file nested far deeper than any contract, without running out of stack", async () => {
    const depth = 5000;
    const buf = await buildDocx(
      para("<w:ins>".repeat(depth) + run("x") + "</w:ins>".repeat(depth)),
    );
    const error = await parseDocx(buf).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DocxError);
    expect((error as Error).message).toContain("maxNestingDepth");
  });

  it("refuses more runs in a paragraph than the limit, more paragraphs than the limit", async () => {
    const runs = await buildDocx(para("<w:r/>".repeat(DEFAULT_LIMITS.maxRunsPerParagraph + 1)));
    await expect(parseDocx(runs)).rejects.toThrow(/maxRunsPerParagraph/);
    const many = await buildDocx("<w:p/>".repeat(DEFAULT_LIMITS.maxParagraphs + 1));
    await expect(parseDocx(many)).rejects.toThrow(/maxParagraphs/);
  });

  it("counts the entries of a zip before it is opened, whatever its end record claims", async () => {
    const entries = Array.from({ length: DEFAULT_LIMITS.maxZipEntries + 1 }, (_, i) => ({
      name: `junk/${i}.txt`,
      data: new Uint8Array(),
      method: 0 as const,
    }));
    const honest = craftZip(entries);
    const lying = craftZip(entries, { claimedEntries: 1 });
    await expect(parseDocx(honest)).rejects.toThrow(/maxZipEntries/);
    await expect(parseDocx(lying)).rejects.toThrow(/maxZipEntries/);
  });

  it("refuses a part whose header understates its size, naming the limit when it is hit first", async () => {
    const big = utf8(documentXml(para(run("x".repeat(2000)))));
    const forged = craftZip([
      { name: "[Content_Types].xml", data: utf8("<Types/>") },
      { name: "word/document.xml", data: big, claimedSize: 10 },
    ]);
    await expect(parseDocx(forged)).rejects.toThrow(DocxError);
    const message = await applyRedline(
      forged,
      { edits: [edit(0, 1, "y")] },
      { date, limits: { maxDocumentXmlBytes: 1000 } },
    ).then(
      () => "no error",
      (e: unknown) => (e instanceof DocxError ? e.message : `unexpected ${String(e)}`),
    );
    expect(message).toContain("(maxDocumentXmlBytes)");
  });
});

describe("a zip bomb", () => {
  const childScript = join(here, "engine-bomb-child.ts");

  function runChild(mode: "forged" | "honest", bytes: number) {
    const child = spawnSync(
      join(repoRoot, "node_modules", ".bin", "tsx"),
      [childScript, mode, String(bytes)],
      { encoding: "utf8", timeout: 120_000, cwd: repoRoot },
    );
    expect(child.status, child.stderr).toBe(0);
    return JSON.parse(child.stdout.trim().split("\n").at(-1)!) as {
      error: string;
      ms: number;
      zipBytes: number;
      maxRssMb: number;
    };
  }

  it("of 600 MiB in well under a megabyte is refused at once whatever its header says", () => {
    for (const mode of ["honest", "forged"] as const) {
      const result = runChild(mode, 600 * 1024 * 1024);
      expect(result.zipBytes).toBeLessThan(1024 * 1024);
      expect(result.error).toContain("(maxDocumentXmlBytes)");
      expect(result.ms).toBeLessThan(5000);
      // Reading the part in full would take well over a gigabyte; a bare process takes about 80 MB.
      expect(result.maxRssMb).toBeLessThan(320);
    }
  }, 240_000);
});

describe("a real contract", () => {
  const WORDS = "the party shall deliver written notice of any breach within thirty days of discovery".split(" ");

  function contract(pages: number): { body: string; paragraphs: number; maxRuns: number } {
    const perPage = 10;
    let body = "";
    let maxRuns = 0;
    for (let i = 0; i < pages * perPage; i++) {
      const runs: string[] = [];
      for (let r = 0; r < 6; r++) {
        const words = Array.from({ length: 9 }, (_, w) => WORDS[(i + r + w) % WORDS.length]).join(" ");
        const props = r % 3 === 0 ? "<w:b/>" : r % 3 === 1 ? '<w:i/><w:color w:val="1F3864"/>' : "";
        runs.push(run(`${r === 0 ? `${i + 1}.${r + 1} ` : ""}${words} `, props));
      }
      maxRuns = Math.max(maxRuns, runs.length);
      body += para(runs.join(""), '<w:pStyle w:val="Body"/>');
    }
    return { body, paragraphs: pages * perPage, maxRuns };
  }

  it("of 500 pages is nowhere near a limit and is processed in reasonable time", async () => {
    const { body, paragraphs, maxRuns } = contract(500);
    const buf = await buildDocx(body);
    const xmlBytes = (await zipParts(buf))["word/document.xml"]!.length;

    const quarter = 0.25;
    expect(xmlBytes).toBeLessThan(DEFAULT_LIMITS.maxDocumentXmlBytes * quarter);
    expect(paragraphs).toBeLessThan(DEFAULT_LIMITS.maxParagraphs * quarter);
    expect(maxRuns).toBeLessThan(DEFAULT_LIMITS.maxRunsPerParagraph * quarter);
    expect(buf.length).toBeLessThan(DEFAULT_LIMITS.maxInputBytes * quarter);

    const parsed = await parseDocx(buf);
    expect(parsed.paragraphs).toHaveLength(paragraphs);
    expect((await inspectDocx(buf)).hiddenRuns).toBe(0);

    const edits: Edit[] = [];
    for (let i = 0; i < 50; i++) {
      const p = parsed.paragraphs[i * 90]!;
      edits.push({ paragraphId: p.id, start: 3, end: 8, replacement: "an" });
    }
    const result = await applyRedline(buf, { edits }, { date });
    expect(result.edits.every((o) => o.applied)).toBe(true);
  }, 120_000);
});
