import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewReport } from "@clausewise/review";
import { createOracleGenerator } from "@clausewise/review/testing";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.js";
import { formatSummary, notShownLine } from "../src/summary.js";
import { compliantScript, fixturePath, makeIo, playbookPath, tempDirs } from "./support.js";

const NOTHING_SHOWN: NonNullable<ReviewReport["notShown"]> = {
  trackedInsertions: 0,
  trackedDeletions: 0,
  comments: 0,
  footnotes: 0,
  endnotes: 0,
  headerFooterParts: 0,
  hiddenRuns: 0,
  images: 0,
};

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
  it("holds the results alone: the notes about the file go to stderr, not into the summary", () => {
    const text = formatSummary(
      report({
        warnings: ["The contract is big."],
        notShown: { ...NOTHING_SHOWN, comments: 2, trackedInsertions: 1 },
      }),
      WRITTEN,
    );

    expect(text).not.toContain("big");
    expect(text).not.toContain("Warning");
    expect(text).not.toContain("Not shown");
  });
});

describe("the line about what the model never saw", () => {
  it("names in one line the counts that are not zero", () => {
    const notShown = {
      trackedInsertions: 0,
      trackedDeletions: 1,
      comments: 1,
      footnotes: 0,
      endnotes: 0,
      headerFooterParts: 3,
      hiddenRuns: 0,
      images: 4,
    };

    expect(notShownLine(report({ notShown }))).toBe(
      "Not shown to the model: 1 tracked deletion, 1 comment, 3 header or footer parts, 4 pictures.",
    );
  });

  it("says that tracked insertions were read, as accepted text, and not that they were hidden", () => {
    expect(notShownLine(report({ notShown: { ...NOTHING_SHOWN, trackedInsertions: 2 } }))).toBe(
      "2 tracked insertions were read as accepted text.",
    );
    expect(
      notShownLine(report({ notShown: { ...NOTHING_SHOWN, trackedInsertions: 1, footnotes: 5 } })),
    ).toBe("Not shown to the model: 5 footnotes. 1 tracked insertion was read as accepted text.");
  });

  it("says nothing when there is nothing, or when the report has no such field", () => {
    expect(notShownLine(report({ notShown: NOTHING_SHOWN }))).toBeUndefined();
    expect(notShownLine(report())).toBeUndefined();
  });
});

describe("the summary of a review that could not check every rule", () => {
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

  async function markedContract(dir: string): Promise<string> {
    const input = join(dir, "marked.docx");
    const zip = await JSZip.loadAsync(await readFile(fixturePath("nda-balanced.docx")));
    const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
    const inserted =
      '<w:ins w:id="9001" w:author="Other" w:date="2024-01-01T00:00:00Z"><w:r><w:t>extra</w:t></w:r></w:ins>' +
      "<w:r><w:rPr><w:vanish/></w:rPr><w:t>hidden</w:t></w:r></w:p>";
    zip.file("word/document.xml", xml.replace("</w:p>", inserted));
    await writeFile(input, await zip.generateAsync({ type: "uint8array" }));
    return input;
  }

  it("prints the report's warnings and the line about what was not shown on stderr", async () => {
    const dir = await makeDir();
    const input = await markedContract(dir);
    const log: string[] = [];
    const { io, stdout, stderr } = makeIo({
      generator: createOracleGenerator(compliantScript()),
      log,
    });

    expect(await run(["review", input, "--playbook", playbookPath("nda-mutual.yaml")], io)).toBe(0);

    expect(stderr()).toMatch(/^Warning: The document has 1 tracked change/m);
    expect(stderr()).toMatch(
      /^Not shown to the model: 1 run of hidden text\. 1 tracked insertion was read as accepted text\.$/m,
    );
    expect(stdout()).not.toMatch(/Warning|Not shown/);
    // Under the summary: the notes come after it.
    const summary = log.findIndex((entry) => entry.startsWith("stdout: Reviewed"));
    const note = log.findIndex((entry) => entry.startsWith("stderr: Warning: The document has"));
    expect(summary).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(summary);
  });

  it("still prints them with --quiet, which only silences the progress lines", async () => {
    const dir = await makeDir();
    const input = await markedContract(dir);
    const { io, stderr } = makeIo({ generator: createOracleGenerator(compliantScript()) });

    expect(
      await run(["review", input, "--playbook", playbookPath("nda-mutual.yaml"), "--quiet"], io),
    ).toBe(0);

    expect(stderr()).not.toContain("[1/10]");
    expect(stderr()).toMatch(/^Warning: The document has 1 tracked change/m);
    expect(stderr()).toContain("Not shown to the model:");
  });

  it("prints nothing of the kind for a clean contract", async () => {
    const dir = await makeDir();
    const input = join(dir, "nda-balanced.docx");
    await writeFile(input, await readFile(fixturePath("nda-balanced.docx")));
    const { io, stderr } = makeIo({ generator: createOracleGenerator(compliantScript()) });

    expect(await run(["review", input, "--playbook", playbookPath("nda-mutual.yaml")], io)).toBe(0);

    expect(stderr()).not.toMatch(/^Warning:|Not shown to the model/m);
  });
});
