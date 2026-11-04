import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_DOCX_BYTES, MIN_REVIEWABLE_CHARS, parseDocument } from "../../src/ingest/parse.js";
import { MAX_PARAGRAPHS } from "../../src/ingest/txt.js";
import { UploadError } from "../../src/module-contracts.js";
import { brokenDocxBytes, docxBytes, encode, strictDocxBytes } from "./support.js";

const fixture = (name: string): Uint8Array =>
  new Uint8Array(
    readFileSync(fileURLToPath(new URL(`../../../../fixtures/${name}`, import.meta.url))),
  );

async function refusal(promise: Promise<unknown>): Promise<UploadError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(UploadError);
    expect((error as UploadError).name).toBe("UploadError");
    return error as UploadError;
  }
  throw new Error("expected an UploadError");
}

const txt = (text: string) => parseDocument({ bytes: encode(text), mediaType: "txt" });
const docx = (bytes: Uint8Array) => parseDocument({ bytes, mediaType: "docx" });

describe("parseDocument for Word files", () => {
  it("returns the paragraphs and the inspection of a real file", async () => {
    const parsed = await docx(fixture("nda-balanced.docx"));
    expect(parsed.paragraphs[0]!.text).toBe("MUTUAL NON-DISCLOSURE AGREEMENT");
    expect(parsed.paragraphs.length).toBeGreaterThan(20);
    expect(parsed.inspection).toEqual({
      trackedInsertions: 0,
      trackedDeletions: 0,
      comments: 0,
      footnotes: 0,
      endnotes: 0,
      headerFooterParts: 0,
      hiddenRuns: 0,
      images: 0,
    });
  });

  it("reports what the file holds that is not reviewed", async () => {
    const parsed = await docx(
      await docxBytes(["A paragraph that is long enough to review."], {
        footnote: true,
        header: "Header words",
        footer: "Footer words",
        comment: true,
        hidden: "hidden words",
        image: true,
      }),
    );
    expect(parsed.inspection).toMatchObject({
      footnotes: 1,
      comments: 1,
      headerFooterParts: 2,
      hiddenRuns: 1,
      images: 1,
    });
  });

  it("refuses a file over the byte limit before reading it", async () => {
    // Zeros are not a zip. If the parser ran, the message would say the file is damaged.
    const error = await refusal(docx(new Uint8Array(MAX_DOCX_BYTES + 1)));
    expect(error.message).toMatch(/10 MB limit/);
    expect(error.message).not.toMatch(/damaged/);
  });

  it("hands a file of exactly the limit to the parser", async () => {
    const error = await refusal(docx(new Uint8Array(MAX_DOCX_BYTES)));
    expect(error.message).toMatch(/could not be read/);
  });

  it("refuses an empty file and bytes that are not a Word file", async () => {
    await refusal(docx(new Uint8Array(0)));
    expect((await refusal(docx(encode("This is plain text, not a zip archive.")))).message).toMatch(
      /could not be read as a Word document/,
    );
    const zip = await docxBytes(["A paragraph that is long enough to review."]);
    await refusal(docx(zip.slice(0, Math.floor(zip.length / 2))));
  });

  it("says what is wrong with a password protected or old format file", async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    expect((await refusal(docx(ole))).message).toMatch(/password|old Word format/);
  });

  it("says what is wrong with a Strict Open XML file", async () => {
    const error = await refusal(
      docx(await strictDocxBytes(["A paragraph that is long enough to review."])),
    );
    expect(error.message).toMatch(/Strict Open XML/);
  });

  it("never quotes the file in the message and attaches no cause", async () => {
    const secret = "SECRET-CLAUSE-TEXT-7712";
    const error = await refusal(docx(await brokenDocxBytes(secret)));
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toMatch(/word\/document\.xml/);
    expect(error.cause).toBeUndefined();
  });

  it("refuses more paragraphs than the limit", async () => {
    const many = await docxBytes(
      Array.from({ length: MAX_PARAGRAPHS + 1 }, () => "Paragraph text."),
    );
    expect((await refusal(docx(many))).message).toMatch(/paragraphs/);
  }, 60_000);
});

describe("the minimum amount of text", () => {
  const line = (n: number): string => "a".repeat(n);

  it("refuses 19 characters and accepts 20, in either file type", async () => {
    expect(MIN_REVIEWABLE_CHARS).toBe(20);
    await refusal(txt(line(19)));
    await expect(txt(line(20))).resolves.toBeDefined();
    await refusal(docx(await docxBytes([line(19)])));
    await expect(docx(await docxBytes([line(20)]))).resolves.toBeDefined();
  });

  it("counts text across paragraphs", async () => {
    await expect(txt(`${line(10)}\n\n${line(10)}`)).resolves.toBeDefined();
    await refusal(txt(`${line(10)}\n\n${line(9)}`));
  });

  it("does not count white space, invisible characters or table of contents lines", async () => {
    await refusal(txt(`${line(5)}${"\u200b".repeat(50)}`));
    await refusal(txt("   \n\n\t\n"));
    await refusal(txt(""));
    await refusal(docx(await docxBytes(["   ", "\u200b\u200b\u200b"])));
    const contents = {
      text: "1. Definitions .......... 3 and a long contents line",
      style: "TOC1",
    };
    await refusal(docx(await docxBytes([contents, line(10)])));
    await expect(docx(await docxBytes([contents, line(20)]))).resolves.toBeDefined();
  });

  it("counts a character outside the basic plane once", async () => {
    await refusal(txt("\u{1f600}".repeat(19)));
    await expect(txt("\u{1f600}".repeat(20))).resolves.toBeDefined();
  });

  it("counts the words of a contract, not only its letters", async () => {
    // 20 characters with spaces in them is enough: spaces are part of the text.
    await expect(txt("one two three four 5")).resolves.toBeDefined();
  });
});

describe("parseDocument for plain text", () => {
  it("has no inspection", async () => {
    const parsed = await txt("1. The first clause of the agreement.\n2. The second clause.");
    expect(parsed.inspection).toBeNull();
    expect(parsed.paragraphs.map((p) => p.text)).toEqual([
      "1. The first clause of the agreement.",
      "2. The second clause.",
    ]);
  });

  it("passes the reasons for refusal through as UploadError", async () => {
    await refusal(
      parseDocument({ bytes: new Uint8Array([0xff, 0xfe, 0x41, 0]), mediaType: "txt" }),
    );
    await refusal(
      parseDocument({
        bytes: new Uint8Array([...encode("Valid text, long enough. "), 0xff]),
        mediaType: "txt",
      }),
    );
  });
});

describe("the media type", () => {
  it("refuses a type that is neither docx nor txt", async () => {
    const error = await refusal(
      parseDocument({ bytes: encode("Some text that is long enough."), mediaType: "pdf" as "txt" }),
    );
    expect(error.message).toMatch(/\.docx and \.txt/);
  });
});
