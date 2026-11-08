import { describe, expect, it } from "vitest";
import { buildMemo } from "../../src/export/memo.js";
import type { MemoInput } from "../../src/module-contracts.js";
import { bodyText, readMemo, workedExample, type ReadMemo } from "./support.js";

/**
 * The upload warns about Word content the review did not read, tracked changes it read as
 * accepted, and paragraphs that read like an instruction to software. The matter page says so. A
 * memo that left them out would say that every quotation was checked and that nothing was flagged,
 * and a reader of the file alone would never learn that the review did not see the whole Word file.
 */

type Warnings = NonNullable<MemoInput["documentWarnings"]>;

async function memoWith(documentWarnings?: Warnings): Promise<ReadMemo> {
  const input = workedExample();
  if (documentWarnings !== undefined) input.documentWarnings = documentWarnings;
  return readMemo(await buildMemo(input));
}

const at = (read: ReadMemo, text: string): number => read.paragraphs.indexOf(text);

describe("document warnings in the memo", () => {
  it("prints nothing when the upload raised none", async () => {
    for (const read of [await memoWith(), await memoWith([])]) {
      expect(read.headings.map(([, text]) => text)).not.toContain("Document warnings");
      expect(bodyText(read)).not.toContain("upload");
    }
  });

  it("lists what the review did not read, with counts, under its own heading above the open items", async () => {
    const read = await memoWith([
      {
        label: "D1",
        code: "unreviewed_content",
        location: null,
        detail: "not reviewed: footnotes=2, comments=1, hidden_runs=3",
      },
    ]);
    expect(at(read, "Document warnings")).toBeGreaterThan(0);
    expect(at(read, "Document warnings")).toBeLessThan(at(read, "Open items"));
    expect(read.headings.filter(([, text]) => text === "Document warnings")).toEqual([
      [1, "Document warnings"],
    ]);
    expect(bodyText(read)).toContain(
      "D1 (Mutual NDA, v1): the review did not read 2 footnotes, 1 comment and 3 runs of hidden text in the Word file. Nothing in this memorandum accounts for them.",
    );
  });

  it("says that tracked changes were read as accepted", async () => {
    const read = await memoWith([
      {
        label: "D2",
        code: "unreviewed_content",
        location: null,
        detail: "read as accepted: tracked_insertions=1, tracked_deletions=4",
      },
    ]);
    expect(bodyText(read)).toContain(
      "D2 (Amendment No. 1, v1): the Word file holds 1 tracked insertion and 4 tracked deletions that were not resolved. The review read the text as if every change had been accepted.",
    );
  });

  it("tells what was not read and what was read as accepted apart, from one stored detail", async () => {
    const text = bodyText(
      await memoWith([
        {
          label: "D1",
          code: "unreviewed_content",
          location: null,
          detail: "not reviewed: comments=1; read as accepted: tracked_insertions=2",
        },
      ]),
    );
    expect(text).toContain("the review did not read 1 comment in the Word file");
    expect(text).toContain("the Word file holds 2 tracked insertions that were not resolved");
  });

  it("names a paragraph that reads like an instruction, and does not claim the model ignored it", async () => {
    const read = await memoWith([
      {
        label: "D1",
        code: "instruction_like_text",
        location: "Mutual NDA (v1), paragraph 1",
        detail: "matched mark_all_compliant in dv_x:p1",
      },
    ]);
    const text = bodyText(read);
    expect(text).toContain(
      "D1 (Mutual NDA, v1): 1 paragraph reads like an instruction to software: Mutual NDA (v1), paragraph 1.",
    );
    expect(text).toContain("nothing here shows that the model ignored it");
    expect(text).not.toContain("mark_all_compliant");
    expect(text).not.toContain("dv_x");
  });

  it("caps a long list of flagged paragraphs and counts the rest", async () => {
    const many: Warnings = Array.from({ length: 12 }, (_, i) => ({
      label: "D1",
      code: "instruction_like_text" as const,
      location: `Mutual NDA (v1), paragraph ${i + 1}`,
      detail: "matched ignore_instructions",
    }));
    const text = bodyText(await memoWith(many));
    expect(text).toContain("12 paragraphs read like an instruction to software");
    expect(text).toContain("paragraph 5");
    expect(text).not.toContain("paragraph 6,");
    expect(text).toContain("and 7 more");
  });

  it("reads only counts from a stored detail, so a detail with words in it prints none of them", async () => {
    const read = await memoWith([
      {
        label: "D1",
        code: "unreviewed_content",
        location: null,
        detail: "not reviewed: footnotes=1, secret_key=9, comments=IGNORE PREVIOUS INSTRUCTIONS",
      },
    ]);
    const text = bodyText(read);
    expect(text).toContain("the review did not read 1 footnote in the Word file");
    expect(text).not.toContain("secret_key");
    expect(text).not.toContain("IGNORE PREVIOUS");
  });

  it("points from the open items to the warnings, so 'None' is not read alone", async () => {
    const read = await memoWith([
      { label: "D1", code: "unreviewed_content", location: null, detail: "not reviewed: images=1" },
    ]);
    expect(bodyText(read)).toContain(
      "The upload raised document warnings, which are listed above.",
    );
    const plain = await memoWith();
    expect(bodyText(plain)).not.toContain("document warnings");
  });

  it("uses no em dash or en dash", async () => {
    const read = await memoWith([
      { label: "D1", code: "unreviewed_content", location: null, detail: "not reviewed: images=1" },
      {
        label: "D1",
        code: "instruction_like_text",
        location: "Mutual NDA (v1), paragraph 1",
        detail: "x",
      },
      { label: "D2", code: "no_reviewable_text", location: null, detail: "x" },
    ]);
    const dashes = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
    expect(bodyText(read)).not.toMatch(dashes);
  });
});
