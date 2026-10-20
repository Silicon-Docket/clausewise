import type { ReviewReport } from "@clausewise/review";
import { beforeAll, describe, expect, it } from "vitest";
import type { Fixture } from "../src/fixtures.js";
import { checkIntegrity } from "../src/integrity.js";
import { oracleScripts } from "../src/selftest.js";
import { corruptText, oneFixture, readDocumentXml, review, withDocumentXml } from "./support.js";

let aggressive: Fixture;
let balanced: Fixture;
let output: { report: ReviewReport; redlined: Uint8Array };

beforeAll(async () => {
  aggressive = await oneFixture("nda-aggressive.docx");
  balanced = await oneFixture("nda-balanced.docx");
  output = await review(aggressive);
});

const check = (redlined: Uint8Array, report: ReviewReport = output.report) =>
  checkIntegrity({ original: aggressive.docx, redlined, report });

describe("the integrity check on pipeline output", () => {
  it("passes, and counts the tracked changes it found", async () => {
    const result = await check(output.redlined);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    // Nine edits in nine different places, two of them in clause 1.1.
    expect(result.trackedChanges).toBe(9);
    expect(result.reportedChanges).toBe(9);
    expect(output.report.stats.editsApplied).toBe(9);
  });

  it("passes on a review that changed nothing, which returns the original bytes", async () => {
    const untouched = await review(balanced);
    const result = await checkIntegrity({
      original: balanced.docx,
      redlined: untouched.redlined,
      report: untouched.report,
    });
    expect(result).toMatchObject({ ok: true, trackedChanges: 0, reportedChanges: 0 });
  });

  it("passes when the edits are all comments", async () => {
    // Every edit is dropped, so the file holds comments and no tracked change.
    const scripts = Object.fromEntries(
      Object.entries(oracleScripts(aggressive)).map(([id, rule]) => [id, { ...rule, edit: null }]),
    );
    const commentsOnly = await review(aggressive, scripts);
    const result = await checkIntegrity({
      original: aggressive.docx,
      redlined: commentsOnly.redlined,
      report: commentsOnly.report,
    });
    expect(result).toMatchObject({ ok: true, trackedChanges: 0, reportedChanges: 0 });
  });
});

describe("the integrity check on a damaged file", () => {
  it("fails when a paragraph's text is changed outside any tracked change", async () => {
    const result = await check(await corruptText(output.redlined));
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(2);
    // The title is the first paragraph of the body.
    expect(result.problems[0]).toMatch(/^Paragraph p:0 does not reject back to the original text/);
    expect(result.problems[0]).toMatch(/it was 25 characters and is 26/);
    expect(result.problems[0]).toMatch(/first difference is at character 25/);
    // Nothing tracked explains the change, so it is not what accepting should give either.
    expect(result.problems[1]).toMatch(/^Paragraph p:0 does not accept to the original text/);
  });

  it("does not put any contract text in what it reports", async () => {
    const result = await check(await corruptText(output.redlined));
    expect(result.problems.join("\n")).not.toMatch(/CONFIDENTIALITY/i);
  });

  it("fails when a deleted word is dropped, because rejecting no longer restores it", async () => {
    const damaged = await withDocumentXml(output.redlined, (xml) =>
      xml.replace(/<w:del [^>]*>.*?<\/w:del>/s, ""),
    );
    const result = await check(damaged);
    expect(result.ok).toBe(false);
    expect(result.problems.some((problem) => /does not reject back/.test(problem))).toBe(true);
  });

  it("fails when an edit's tracked change is missing a paragraph's replacement", async () => {
    const damaged = await withDocumentXml(output.redlined, (xml) =>
      xml.replace(/<w:ins [^>]*>.*?<\/w:ins>/s, ""),
    );
    const result = await check(damaged);
    expect(result.ok).toBe(false);
    // Rejecting still gives the original, but accepting no longer gives the reported edit.
    expect(
      result.problems.some((problem) => /does not accept to the original text/.test(problem)),
    ).toBe(true);
    expect(result.problems.some((problem) => /does not reject back/.test(problem))).toBe(false);
  });

  it("fails when the file has a tracked change the report does not list", async () => {
    // A stray insertion in a paragraph no edit touched: rejecting it changes nothing.
    const damaged = await withDocumentXml(output.redlined, (xml) =>
      xml.replace(
        "CONFIDENTIALITY AGREEMENT</w:t></w:r>",
        'CONFIDENTIALITY AGREEMENT</w:t></w:r><w:ins w:id="9001" w:author="X" w:date="2026-01-01T00:00:00Z"><w:r><w:t>!</w:t></w:r></w:ins>',
      ),
    );
    const result = await check(damaged);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain("Paragraph p:0 has 1 tracked change and the report lists 0.");
    expect(result.trackedChanges).toBe(10);
  });

  it("fails when the report lists a tracked change the file does not have", async () => {
    // Forget one applied edit in the report and keep its total consistent, so only the file and
    // the report disagree.
    const report = structuredClone(output.report);
    // The term edit is the only one in its paragraph.
    const applied = report.results.find((item) => item.ruleId === "term");
    if (applied?.edit.kind !== "applied") throw new Error("no applied edit");
    applied.edit = { kind: "none" };
    report.stats.editsApplied -= 1;
    const result = await check(output.redlined, report);
    expect(result.ok).toBe(false);
    expect(
      result.problems.some((problem) =>
        /has 1 tracked change and the report lists 0/.test(problem),
      ),
    ).toBe(true);
  });

  it("fails when the report's own total disagrees with its edits", async () => {
    const report = structuredClone(output.report);
    report.stats.editsApplied += 1;
    const result = await check(output.redlined, report);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/lists 9 applied edits but says 10/);
  });

  it("fails when the report applied an edit in a paragraph that does not exist", async () => {
    const report = structuredClone(output.report);
    const applied = report.results.find((item) => item.edit.kind === "applied");
    if (applied === undefined || applied.edit.kind !== "applied")
      throw new Error("no applied edit");
    applied.edit.paragraphId = "p:9999";
    const result = await check(output.redlined, report);
    expect(result.ok).toBe(false);
    expect(
      result.problems.some((problem) => /paragraph p:9999, which does not exist/.test(problem)),
    ).toBe(true);
  });

  it("fails when a paragraph is added or removed", async () => {
    const damaged = await withDocumentXml(output.redlined, (xml) =>
      xml.replace("<w:body>", "<w:body><w:p><w:r><w:t>extra</w:t></w:r></w:p>"),
    );
    const result = await check(damaged);
    expect(result.ok).toBe(false);
    const counts = /^The redlined file has (\d+) paragraphs and the original has (\d+)\.$/.exec(
      result.problems[0] ?? "",
    );
    expect(Number(counts?.[1])).toBe(Number(counts?.[2]) + 1);
  });

  it("fails when the file is not a docx at all", async () => {
    const result = await check(new Uint8Array([1, 2, 3, 4]));
    expect(result.ok).toBe(false);
    expect(result.problems.at(-1)).toBe(
      "The redlined file cannot be read: it is not a valid zip archive.",
    );
  });

  it("fails when word/document.xml is not well-formed", async () => {
    const result = await check(
      await withDocumentXml(output.redlined, (xml) => xml.replace("</w:body>", "</w:bodyx>")),
    );
    expect(result.ok).toBe(false);
    expect(result.problems.at(-1)).toBe(
      "The redlined file cannot be read: word/document.xml is not well-formed XML.",
    );
  });

  it("fails when a formatting or paragraph mark revision appears that the original did not have", async () => {
    const damaged = await withDocumentXml(output.redlined, (xml) =>
      xml.replace(
        '<w:pStyle w:val="Title"/>',
        '<w:pStyle w:val="Title"/><w:rPr><w:ins w:id="9002" w:author="X" w:date="2026-01-01T00:00:00Z"/></w:rPr>',
      ),
    );
    const result = await check(damaged);
    expect(result.ok).toBe(false);
    expect(
      result.problems.some((problem) =>
        /paragraph mark, table or formatting revisions/.test(problem),
      ),
    ).toBe(true);
  });
});

describe("what the check reads", () => {
  it("looks at word/document.xml itself, so the same file read twice agrees", async () => {
    const { xml } = await readDocumentXml(output.redlined);
    expect(xml).toContain("<w:ins ");
    expect(xml).toContain("<w:del ");
    expect(xml).toContain("<w:delText");
  });

  it("counts two edits in one paragraph as two, since text lies between them", async () => {
    // Clause 1.1 of the aggressive contract holds the mutuality and the definition edits.
    const { xml } = await readDocumentXml(output.redlined);
    const paragraph = xml
      .split("</w:p>")
      .find((part) => part.includes("disclosed by or on behalf of"));
    expect(paragraph?.match(/<w:ins /g)).toHaveLength(2);
  });
});
