import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildMemo } from "../../src/export/memo.js";
import { DUR_EDITED_FALLBACK, SPAN, replaceFinding, workedExample } from "./support.js";
import { memoFinding, passage, review, verifiedFinding } from "./support.js";

const run = promisify(execFile);
const hasSoffice = spawnSync("soffice", ["--version"]).status === 0;

/**
 * Word is the real target and is not available here. LibreOffice is the strictest reader that
 * can be run on a build machine: if it reads the headings, the table and the text, the package is
 * wired up correctly. The test is skipped where `soffice` is not installed, as the one for
 * `@clausewise/docx` is.
 */
describe.skipIf(!hasSoffice)("LibreOffice reads the memo", () => {
  it(
    "opens the worked example and a memo full of hostile text, and finds the structure",
    { timeout: 180_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "parol-memo-lo-"));
      const hostile =
        '<b>x</b> & { INCLUDETEXT "c:\\\\x.docx" } \u202Eevil \u200B \u05E9\u05DC\u05D5\u05DD';
      const input = workedExample();
      input.spanTexts[SPAN.d1Parties] = `${hostile} ${input.spanTexts[SPAN.d1Parties]}`;
      const hostileInput = replaceFinding(input, "pty-1", () =>
        memoFinding(
          verifiedFinding({
            ruleKey: "pty-1",
            category: "parties",
            severity: "medium",
            status: "compliant",
            evidence: [passage(SPAN.d1Parties, hostile)],
            explanation: hostile,
          }),
          review("accept", { reviewerName: hostile }),
        ),
      );
      const files = {
        worked: join(dir, "worked.docx"),
        hostile: join(dir, "hostile.docx"),
      };
      await writeFile(files.worked, await buildMemo(workedExample()));
      await writeFile(files.hostile, await buildMemo(hostileInput));

      await run(
        "soffice",
        [
          `-env:UserInstallation=file://${join(dir, "profile")}`,
          "--headless",
          "--convert-to",
          "odt",
          "--outdir",
          dir,
          files.worked,
          files.hostile,
        ],
        { timeout: 170_000 },
      );

      const content = async (name: string): Promise<string> => {
        const odt = await JSZip.loadAsync(await readFile(join(dir, `${name}.odt`)));
        return odt.file("content.xml")!.async("string");
      };

      const worked = await content("worked");
      expect(worked).toContain(
        "MEMORANDUM: DRAFT FOR ATTORNEY REVIEW. SYNTHETIC DEMONSTRATION, NOT LEGAL ADVICE.",
      );
      // Five level one headings and eight finding headings, plus the title.
      expect(worked.match(/<text:h [^>]*text:outline-level="1"/g)).toHaveLength(5);
      expect(worked.match(/<text:h [^>]*text:outline-level="2"/g)).toHaveLength(8);
      // The summary table has a header and eight rules.
      expect(worked.match(/<table:table-row[ >]/g) ?? []).toHaveLength(9);
      expect(worked).toContain("DUR-1");
      expect(worked).toContain("Duration of confidentiality obligations");
      expect(worked).toContain(DUR_EDITED_FALLBACK.slice(0, 60));
      expect(worked).toContain("Appendix B. Provenance");

      const odd = await content("hostile");
      // The hostile text is text in the converted file too, never a field or a link.
      expect(odd).toContain("INCLUDETEXT");
      expect(odd).not.toMatch(/<text:(?:text-input|user-field-get|variable-set|a)[ >]/);
      expect(odd).not.toContain("<b>x</b>");
      expect(odd).toContain("&lt;b&gt;x&lt;/b&gt; &amp;");
      expect(odd).toContain("\u05E9\u05DC\u05D5\u05DD");
    },
  );
});
