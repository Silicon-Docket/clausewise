import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewReport } from "@clausewise/review";
import { createOracleGenerator } from "@clausewise/review/testing";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.js";
import { formatSummary } from "../src/summary.js";
import { compliantScript, fixturePath, makeIo, playbookPath, tempDirs } from "./support.js";

const WRITTEN = { redlined: "r.docx", report: "r.json", summary: "r.md" };

function report(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    document: "nda.docx",
    playbook: { name: "Mutual NDA", contractTypes: ["nda"] },
    model: { provider: "oracle", model: "oracle", disclosure: "a test" },
    counts: { compliant: 2, deviation: 0, missing: 0, not_applicable: 0, error: 0 },
    open: { high: 0, medium: 0, low: 0 },
    results: [
      ...["a", "b"].map((id) => ({
        ruleId: id,
        title: `Rule ${id}`,
        severity: "high" as const,
        required: true,
        status: "compliant" as const,
        clauseIds: ["c1"],
        clauseNumbers: [],
        explanation: "",
        comment: "",
        suggestedClause: null,
        edit: { kind: "none" as const },
      })),
    ],
    stats: { paragraphs: 3, clauses: 3, windows: 1, editsApplied: 0 },
    ...overrides,
  };
}

describe("the summary of a report", () => {
  it("prints the warnings of the report under the results", () => {
    const text = formatSummary(
      report({ warnings: ["The contract is big.", "  Two\nlines \u001b[31m here  "] }),
      WRITTEN,
    );

    expect(text).toContain("\nWarnings:\n  The contract is big.\n  Two lines [31m here\n");
    expect(text.indexOf("Warnings:")).toBeLessThan(text.indexOf("Written:"));
    expect(text).not.toContain(String.fromCharCode(27));
  });

  it("prints no warnings block when there are none", () => {
    expect(formatSummary(report({ warnings: [] }), WRITTEN)).not.toContain("Warnings:");
    expect(formatSummary(report(), WRITTEN)).not.toContain("Warnings:");
  });

  it("mentions in one line what the model never saw, only the counts that are not zero", () => {
    const notShown = {
      trackedInsertions: 2,
      trackedDeletions: 1,
      comments: 1,
      footnotes: 0,
      endnotes: 0,
      headerFooterParts: 3,
      hiddenRuns: 0,
      images: 4,
    };

    const text = formatSummary(report({ notShown }), WRITTEN);

    expect(text).toContain(
      "\nNot shown to the model: 2 tracked insertions, 1 tracked deletion, 1 comment, " +
        "3 header or footer parts, 4 pictures.\n",
    );
    expect(text.match(/Not shown to the model/g)).toHaveLength(1);
  });

  it("says nothing about what was not shown when there is none", () => {
    const zero = Object.fromEntries(
      ["trackedInsertions", "trackedDeletions", "comments", "footnotes", "endnotes"]
        .concat(["headerFooterParts", "hiddenRuns", "images"])
        .map((key) => [key, 0]),
    ) as NonNullable<ReviewReport["notShown"]>;

    expect(formatSummary(report({ notShown: zero }), WRITTEN)).not.toContain("Not shown");
  });

  it("never says there are no deviations when a rule was not checked", () => {
    const base = report();
    const [first, second] = base.results;
    const broken = report({
      counts: { ...base.counts, compliant: 1, error: 1 },
      results: [
        first ?? base.results[0]!,
        { ...(second ?? base.results[0]!), status: "error", error: "The request failed." },
      ],
    });

    const text = formatSummary(broken, WRITTEN);

    expect(text).not.toMatch(/^No deviations or missing clauses\.$/m);
    expect(text).toContain("No deviations or missing clauses among the 1 rule that was checked.");
  });

  it("says that nothing was checked when nothing was", () => {
    const base = report();
    const broken = report({
      counts: { ...base.counts, compliant: 0, error: 2 },
      results: base.results.map((result) => ({ ...result, status: "error", error: "Down." })),
    });

    expect(formatSummary(broken, WRITTEN)).toContain("No rule could be checked.");
  });
});

describe("a review of a contract with markup the model does not see", () => {
  const makeDir = tempDirs();

  it("prints the report's warnings and the line about what was not shown", async () => {
    const dir = await makeDir();
    const input = join(dir, "marked.docx");
    const zip = await JSZip.loadAsync(await readFile(fixturePath("nda-balanced.docx")));
    const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
    const inserted =
      '<w:ins w:id="9001" w:author="Other" w:date="2024-01-01T00:00:00Z"><w:r><w:t>extra</w:t></w:r></w:ins>' +
      "<w:r><w:rPr><w:vanish/></w:rPr><w:t>hidden</w:t></w:r></w:p>";
    zip.file("word/document.xml", xml.replace("</w:p>", inserted));
    await writeFile(input, await zip.generateAsync({ type: "uint8array" }));
    const { io, stdout } = makeIo({ generator: createOracleGenerator(compliantScript()) });

    expect(await run(["review", input, "--playbook", playbookPath("nda-mutual.yaml")], io)).toBe(0);

    expect(stdout()).toContain("Warnings:\n  The document has 1 tracked change");
    expect(stdout()).toMatch(
      /\nNot shown to the model: 1 tracked insertion, 1 run of hidden text\.\n/,
    );
  });
});
