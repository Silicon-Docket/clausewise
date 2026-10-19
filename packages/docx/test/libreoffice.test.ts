import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { applyRedline, parseDocx } from "../src/index.js";

const run = promisify(execFile);
const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures");
const hasSoffice = spawnSync("soffice", ["--version"]).status === 0;

/**
 * Word is the real target, but LibreOffice is the strictest reader we can run in CI-like
 * environments: if it recognises our markup as tracked changes and comments, the OOXML is
 * well-formed and wired up correctly.
 */
describe.skipIf(!hasSoffice)("LibreOffice reads the redlined output", () => {
  it(
    "sees one tracked deletion, one tracked insertion and one comment",
    { timeout: 120_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "clausewise-lo-"));
      const buf = new Uint8Array(await readFile(join(fixtures, "nda-aggressive.docx")));
      const { paragraphs } = await parseDocx(buf);
      const para = paragraphs.find((p) => p.text.startsWith("3.1 "))!;
      const phrase = "perpetual and shall continue indefinitely";
      const start = para.text.indexOf(phrase);

      const { buffer, edits } = await applyRedline(buf, {
        edits: [
          {
            paragraphId: para.id,
            start,
            end: start + phrase.length,
            replacement: "end three (3) years after disclosure",
          },
        ],
        comments: [{ paragraphId: para.id, text: "Perpetual term is outside our playbook." }],
      });
      expect(edits).toEqual([{ applied: true }]);

      const input = join(dir, "redlined.docx");
      await writeFile(input, buffer);
      await run(
        "soffice",
        [
          `-env:UserInstallation=file://${join(dir, "profile")}`,
          "--headless",
          "--convert-to",
          "odt",
          "--outdir",
          dir,
          input,
        ],
        { timeout: 110_000 },
      );

      const odt = await JSZip.loadAsync(await readFile(join(dir, "redlined.odt")));
      const content = await odt.file("content.xml")!.async("string");
      expect(content.match(/<text:deletion[ >]/g)).toHaveLength(1);
      expect(content.match(/<text:insertion[ >]/g)).toHaveLength(1);
      expect(content).toContain("perpetual and shall continue indefinitely");
      expect(content).toContain("end three (3) years after disclosure");
      expect(content).toContain("<office:annotation ");
      expect(content).toContain("Perpetual term is outside our playbook.");
    },
  );
});
