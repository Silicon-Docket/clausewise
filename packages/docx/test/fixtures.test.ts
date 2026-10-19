import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyRedline, parseDocx } from "../src/index.js";
import { elements, views } from "./helpers.js";

const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures");
const load = async (name: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(join(fixtures, name)));

describe("shipped fixtures", () => {
  it("parse into clause paragraphs a reviewer can address", async () => {
    const { paragraphs } = await parseDocx(await load("nda-aggressive.docx"));
    const term = paragraphs.find((p) => p.text.startsWith("3.1 "));
    expect(term?.text).toContain("perpetual and shall continue indefinitely");
    expect(paragraphs.find((p) => p.text === "3. Term")?.style).toBe("Heading1");
    expect(paragraphs.some((p) => p.inTable && p.text.startsWith("By:"))).toBe(true);
  });

  it("take a redline on a real, multi-run clause and read back both ways", async () => {
    const buf = await load("nda-aggressive.docx");
    const { paragraphs } = await parseDocx(buf);
    const para = paragraphs.find((p) => p.text.startsWith("3.1 "))!;
    const from = para.text.indexOf("are perpetual and shall continue indefinitely");
    const to = from + "are perpetual and shall continue indefinitely".length;

    const result = await applyRedline(
      buf,
      {
        edits: [
          {
            paragraphId: para.id,
            start: from,
            end: to,
            replacement: "end three (3) years after the date of disclosure",
          },
        ],
        comments: [{ paragraphId: para.id, text: "Perpetual term is outside our playbook." }],
      },
      { date: new Date("2026-03-01T00:00:00Z") },
    );

    expect(result.edits).toEqual([{ applied: true }]);
    const before = paragraphs.map((p) => p.text);
    const rejected = await views(result.buffer, "rejected");
    expect(rejected).toEqual(before);
    const accepted = await views(result.buffer, "accepted");
    expect(accepted[para.index]).toContain("obligations under this Agreement end three (3) years");
    expect(accepted.filter((_, i) => i !== para.index)).toEqual(
      before.filter((_, i) => i !== para.index),
    );
    expect(await elements(result.buffer, "commentRangeStart")).toHaveLength(1);
  });
});
