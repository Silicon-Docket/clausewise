import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadFixtures } from "../../../evals/src/fixtures.js";
import { oracleScripts } from "../../../evals/src/selftest.js";
import { reviewContract } from "../src/pipeline.js";
import { renderRedline } from "../src/redline.js";
import { createOracleGenerator } from "../src/testing.js";
import type { ReviewReport } from "../src/types.js";
import { viewDocx } from "./pipeline-support.js";
import { paragraphXml, partsOf, sameParts } from "./redline-support.js";

const root = join(import.meta.dirname, "..", "..", "..");

// The equality property of docs/m3-design.md section 2.2: rebuilt from its report with every
// finding included and nothing replaced, a redline holds exactly what the review returned. It is
// shown on the shipped contracts with their shipped playbooks, answered by the evals' oracle,
// which proposes a tracked change for every deviation.

const AUTHOR = "Equality Reviewer";
const DATE = new Date("2026-01-02T03:04:05Z");

const NAMES = ["nda-aggressive.docx", "saas-vendor-friendly.docx"];
const fixtures = await loadFixtures(root, NAMES);

describe.each(fixtures)("$name", (fixture) => {
  async function review() {
    return reviewContract(
      { docx: fixture.docx, playbook: fixture.playbook, fileName: fixture.name },
      createOracleGenerator(oracleScripts(fixture)),
      { author: AUTHOR, date: DATE },
    );
  }
  const flagged = (report: ReviewReport) =>
    report.results.filter((r) => r.status === "deviation" || r.status === "missing");

  it("is rebuilt with the parts of the review's own file, byte for byte", async () => {
    const { report, redlined } = await review();
    // The file is worth comparing: it has tracked changes and a comment for every finding.
    expect(report.stats.editsApplied).toBeGreaterThanOrEqual(5);
    expect(flagged(report).length).toBeGreaterThanOrEqual(5);

    const rebuilt = await renderRedline({
      docx: fixture.docx,
      report,
      include: "all",
      author: AUTHOR,
      date: DATE,
    });
    expect(rebuilt.edits).toBe(report.stats.editsApplied);
    expect(rebuilt.comments).toBe(flagged(report).length);
    expect(rebuilt.warnings).toEqual([]);

    const left = await partsOf(rebuilt.redlined);
    const right = await partsOf(redlined);
    expect([...left.keys()]).toEqual([...right.keys()]);
    for (const [name, data] of left) {
      expect(data.equals(right.get(name) ?? Buffer.alloc(0)), name).toBe(true);
    }
    // And the review's file is not simply the original.
    expect(await sameParts(redlined, fixture.docx)).toBe(false);
  });

  it("is rebuilt the same from the report as a database holds it, after JSON", async () => {
    const { report, redlined } = await review();
    const stored = JSON.parse(JSON.stringify(report)) as ReviewReport;
    const rebuilt = await renderRedline({
      docx: fixture.docx,
      report: stored,
      include: "all",
      author: AUTHOR,
      date: DATE,
    });
    expect(await sameParts(rebuilt.redlined, redlined)).toBe(true);
  });

  it("is rebuilt one finding at a time, each leaving the original text when rejected", async () => {
    const { report } = await review();
    const original = (await viewDocx(fixture.docx)).paragraphs.map((p) => p.rejected);
    // The engine writes a document back with its own serializer, which spells a quotation mark or
    // an apostrophe in text as the character and not as &quot; or &apos;. Apart from that, an
    // untouched paragraph is as it was.
    const plain = (xmls: string[]): string[] =>
      xmls.map((xml) => xml.replaceAll("&quot;", '"').replaceAll("&apos;", "'"));
    const before = plain(await paragraphXml(fixture.docx));
    for (const result of flagged(report)) {
      const one = await renderRedline({
        docx: fixture.docx,
        report,
        include: new Set([result.ruleId]),
        author: AUTHOR,
        date: DATE,
      });
      const label = result.ruleId;
      const applied = result.edit.kind === "applied";
      expect(one.edits, label).toBe(applied ? 1 : 0);
      expect(one.comments, label).toBe(1);
      expect(one.warnings, label).toEqual([]);

      const view = await viewDocx(one.redlined);
      expect(
        view.paragraphs.map((p) => p.rejected),
        label,
      ).toEqual(original);
      expect(
        view.paragraphs.filter((p) => p.tracked),
        label,
      ).toHaveLength(applied ? 1 : 0);
      expect(view.comments, label).toHaveLength(1);

      // Every other paragraph is the original's.
      const after = plain(await paragraphXml(one.redlined));
      const at = Number((result.commentAnchor?.paragraphId ?? "").slice(2));
      expect(after, label).toHaveLength(before.length);
      before.forEach((xml, i) => {
        if (i !== at) expect(after[i], `${label} paragraph ${i}`).toBe(xml);
      });
    }
  });
});
