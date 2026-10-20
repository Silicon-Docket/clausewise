import { spawnSync } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseDocx } from "@clausewise/docx";
import JSZip from "jszip";
import { beforeAll, describe, expect, it } from "vitest";
import { ReviewError } from "../src/errors.js";
import { renderRedline } from "../src/redline.js";
import type { ReviewReport } from "../src/types.js";
import { viewDocx } from "./pipeline-support.js";
import {
  AUTHOR,
  DATE,
  FLAGGED,
  LAW,
  NOTICE,
  PREAMBLE,
  RETURN,
  RULES,
  SUGGESTED_CLAUSE,
  TERM,
  buildDocument,
  buildScenario,
  documentXml,
  paragraphXml,
  partsOf,
  resultOf,
  sameParts,
  type Scenario,
} from "./redline-support.js";

const run = promisify(execFile);
const hasSoffice = spawnSync("soffice", ["--version"]).status === 0;

let scenario: Scenario;
let originalTexts: string[];

beforeAll(async () => {
  scenario = await buildScenario();
  originalTexts = (await viewDocx(scenario.docx)).paragraphs.map((p) => p.accepted);
});

const render = (
  include: ReadonlySet<string> | "all",
  more: {
    replacements?: ReadonlyMap<string, string>;
    report?: ReviewReport;
    docx?: Uint8Array;
  } = {},
) =>
  renderRedline({
    docx: more.docx ?? scenario.docx,
    report: more.report ?? scenario.report,
    include,
    ...(more.replacements === undefined ? {} : { replacements: more.replacements }),
    author: AUTHOR,
    date: DATE,
  });

/** The paragraph each finding's comment is on, and what its tracked change makes of the text. */
const PARAGRAPH = {
  term: 1,
  "permitted-use": 2,
  "governing-law": 3,
  remedies: 4,
  "compelled-disclosure": 1,
} as const;
const EDITED: Record<string, [number, string]> = {
  term: [1, TERM.replace("three years", "two years")],
  "permitted-use": [2, NOTICE.replace("thirty days", "sixty days")],
  "governing-law": [3, LAW.replace("Singapore", "Delaware")],
};

const COMMENT_TEXT = {
  term: "[HIGH] Duration of confidentiality obligations\nShorten the term.",
  "permitted-use":
    "[MEDIUM] Permitted use and disclosure to representatives\nAsk for longer notice.",
  "governing-law": "[LOW] Governing law and venue\nUse a forum we know.",
  remedies:
    "[MEDIUM] Remedies\nLower the fee.\n\nSuggested wording (could not be applied automatically): three percent of revenue",
  "compelled-disclosure": `[MEDIUM] Disclosure required by law\nAdd a legal compulsion exception.\n\nSuggested clause:\n${SUGGESTED_CLAUSE}`,
} as const;

const clone = (report: ReviewReport): ReviewReport =>
  JSON.parse(JSON.stringify(report)) as ReviewReport;

describe("the scenario", () => {
  it("has the findings the tests below rely on", () => {
    const kinds = scenario.report.results.map((r) => [r.ruleId, r.status, r.edit.kind]);
    expect(kinds).toEqual([
      ["term", "deviation", "applied"],
      ["permitted-use", "deviation", "applied"],
      ["governing-law", "deviation", "applied"],
      ["remedies", "deviation", "comment-only"],
      ["compelled-disclosure", "missing", "none"],
      ["exclusions", "compliant", "none"],
    ]);
    expect(resultOf(scenario.report, "remedies").edit).toMatchObject({
      reason: expect.stringMatching(/hyperlink/),
    });
  });
});

describe("renderRedline with every finding included", () => {
  it("writes the three tracked changes and the five comments the review wrote", async () => {
    const result = await render("all");
    expect(result).toMatchObject({ edits: 3, comments: 5, warnings: [] });
    const view = await viewDocx(result.redlined);
    expect(view.comments).toHaveLength(5);
    for (const [ruleId, text] of Object.entries(COMMENT_TEXT)) {
      expect(
        view.comments.map((c) => c.text),
        ruleId,
      ).toContain(text);
    }
    expect(view.comments.every((c) => c.author === AUTHOR)).toBe(true);
    expect(view.comments.every((c) => c.date === "2025-03-04T05:06:07Z")).toBe(true);
  });

  it("holds the same parts, byte for byte, as the file the review returned", async () => {
    const { redlined } = await render("all");
    expect(await sameParts(redlined, scenario.redlined)).toBe(true);
    // A comparison that cannot tell files apart proves nothing.
    expect(await sameParts((await render(new Set(["term"]))).redlined, scenario.redlined)).toBe(
      false,
    );
  });

  it("holds the same parts when the report has been through JSON, as one in a database has", async () => {
    const { redlined } = await render("all", { report: clone(scenario.report) });
    expect(await sameParts(redlined, scenario.redlined)).toBe(true);
  });

  it("writes the author given, and Clausewise when none is", async () => {
    const plain = await renderRedline({
      docx: scenario.docx,
      report: scenario.report,
      include: new Set(["term"]),
      date: DATE,
    });
    expect((await viewDocx(plain.redlined)).comments.map((c) => c.author)).toEqual(["Clausewise"]);
    const named = await render(new Set(["term"]));
    expect((await viewDocx(named.redlined)).comments.map((c) => c.author)).toEqual([AUTHOR]);
  });

  it("changes neither the report, the replacements nor the file it is given", async () => {
    const docxBefore = Buffer.from(scenario.docx);
    const reportBefore = JSON.stringify(scenario.report);
    const replacements = new Map([["term", "two (2) years"]]);
    await render("all", { replacements });
    expect(Buffer.from(scenario.docx).equals(docxBefore)).toBe(true);
    expect(JSON.stringify(scenario.report)).toBe(reportBefore);
    expect([...replacements]).toEqual([["term", "two (2) years"]]);
  });
});

describe("renderRedline with the file as a server reads it", () => {
  it("takes a Node Buffer, as fs.readFile returns, and writes the same file", async () => {
    const result = await render("all", { docx: Buffer.from(scenario.docx) });
    expect(result).toMatchObject({ edits: 3, comments: 5, warnings: [] });
    expect(await sameParts(result.redlined, scenario.redlined)).toBe(true);
  });
});

describe("renderRedline with some findings included", () => {
  it("writes only the tracked change and the comment of the one rule asked for", async () => {
    const result = await render(new Set(["term"]));
    expect(result).toMatchObject({ edits: 1, comments: 1, warnings: [] });

    const view = await viewDocx(result.redlined);
    expect(view.comments.map((c) => [c.text, c.anchored, c.paragraph])).toEqual([
      [COMMENT_TEXT.term, "three years", 1],
    ]);
    expect(view.paragraphs.map((p) => p.accepted)).toEqual(
      originalTexts.map((text, i) => (i === 1 ? TERM.replace("three years", "two years") : text)),
    );
    expect(view.paragraphs.map((p) => p.rejected)).toEqual(originalTexts);

    // The other paragraphs are the original's, byte for byte.
    const before = await paragraphXml(scenario.docx);
    const after = await paragraphXml(result.redlined);
    expect(after).toHaveLength(before.length);
    expect(after.map((xml, i) => xml === before[i])).toEqual([true, false, true, true, true, true]);
  });

  it("writes only a comment for a missing clause, and for a change the engine refused", async () => {
    const missing = await render(new Set([RULES.missing]));
    expect(missing).toMatchObject({ edits: 0, comments: 1, warnings: [] });
    const view = await viewDocx(missing.redlined);
    expect(view.comments.map((c) => c.text)).toEqual([COMMENT_TEXT["compelled-disclosure"]]);
    expect(view.paragraphs.some((p) => p.tracked)).toBe(false);

    const refused = await render(new Set([RULES.commentOnly]));
    expect(refused).toMatchObject({ edits: 0, comments: 1, warnings: [] });
    expect((await viewDocx(refused.redlined)).comments.map((c) => c.text)).toEqual([
      COMMENT_TEXT.remedies,
    ]);
  });

  it("writes exactly the findings of every subset of them, and rejecting all restores the original", async () => {
    const subsets = Array.from({ length: 2 ** FLAGGED.length }, (_, mask) =>
      FLAGGED.filter((_, bit) => (mask & (1 << bit)) !== 0),
    );
    expect(subsets).toHaveLength(32);

    const before = await paragraphXml(scenario.docx);
    for (const subset of subsets) {
      const label = `{${subset.join(", ")}}`;
      const result = await render(new Set<string>(subset));
      const applied = subset.filter((id) => id in EDITED);
      expect(result.edits, label).toBe(applied.length);
      expect(result.comments, label).toBe(subset.length);
      expect(result.warnings, label).toEqual([]);

      const view = await viewDocx(result.redlined);
      // Reject all: the text of every paragraph is the original's.
      expect(
        view.paragraphs.map((p) => p.rejected),
        label,
      ).toEqual(originalTexts);
      // Accept all: only the paragraphs of the changes asked for differ.
      const edited = new Map(applied.map((id) => EDITED[id] as [number, string]));
      expect(
        view.paragraphs.map((p) => p.accepted),
        label,
      ).toEqual(originalTexts.map((text, i) => edited.get(i) ?? text));
      // The comments are those of the rules asked for, and no others.
      expect(view.comments.map((c) => c.text).sort(), label).toEqual(
        subset.map((id) => COMMENT_TEXT[id as keyof typeof COMMENT_TEXT]).sort(),
      );
      // A paragraph with no change and no comment of the subset is untouched.
      const touched = new Set<number>(subset.map((id) => PARAGRAPH[id as keyof typeof PARAGRAPH]));
      const after = await paragraphXml(result.redlined);
      before.forEach((xml, i) => {
        if (!touched.has(i)) expect(after[i], `${label} paragraph ${i}`).toBe(xml);
      });
    }
  });

  it("writes nothing for an empty set, a rule that is met, or an id that is not in the report", async () => {
    for (const include of [
      new Set<string>(),
      new Set([RULES.compliant]),
      new Set(["no-such-rule"]),
    ]) {
      const result = await render(include);
      expect(result).toMatchObject({ edits: 0, comments: 0, warnings: [] });
      expect(Buffer.from(result.redlined).equals(Buffer.from(scenario.docx))).toBe(true);
    }
  });

  it("returns a copy of the original when nothing is written, not the bytes it was given", async () => {
    const result = await render(new Set());
    expect(result.redlined).not.toBe(scenario.docx);
    expect(result.redlined.buffer).not.toBe(scenario.docx.buffer);
    // Changing the copy leaves the original alone.
    const first = result.redlined[0] ?? 0;
    result.redlined[0] = first ^ 0xff;
    expect(scenario.docx[0]).toBe(first);
  });

  it("returns a copy even when the file is a Node Buffer, whose slice shares memory", async () => {
    const buffer = Buffer.from(scenario.docx);
    const result = await render(new Set(), { docx: buffer });
    result.redlined[0] = (result.redlined[0] ?? 0) ^ 0xff;
    expect(buffer[0]).toBe(scenario.docx[0]);
  });
});

describe("renderRedline with the lawyer's own replacements", () => {
  const edited = async (replacement: string, ruleId = "term") =>
    render(new Set([ruleId]), { replacements: new Map([[ruleId, replacement]]) });
  const paragraphs = async (bytes: Uint8Array) => (await viewDocx(bytes)).paragraphs;

  it("writes the lawyer's text instead of the model's", async () => {
    const result = await edited("two (2) years");
    expect(result).toMatchObject({ edits: 1, comments: 1, warnings: [] });
    const view = await paragraphs(result.redlined);
    expect(view[1]?.accepted).toBe(TERM.replace("three years", "two (2) years"));
    expect(view[1]?.rejected).toBe(TERM);
  });

  it("deletes the span for the empty string", async () => {
    const result = await edited("");
    expect(result).toMatchObject({ edits: 1, comments: 1, warnings: [] });
    const view = await paragraphs(result.redlined);
    expect(view[1]?.accepted).toBe(TERM.replace("three years", ""));
    expect(view[1]?.rejected).toBe(TERM);
    const xml = await documentXml(result.redlined);
    expect(xml).toContain("<w:del ");
    expect(xml).not.toContain("<w:ins ");
  });

  it.each([
    ["the original words", "three years"],
    ["the original words with space around them", "  three years\n"],
  ])("leaves only the comment when the replacement is %s", async (_label, text) => {
    const result = await edited(text);
    expect(result).toMatchObject({ edits: 0, comments: 1, warnings: [] });
    const xml = await documentXml(result.redlined);
    expect(xml).not.toContain("<w:del ");
    expect(xml).not.toContain("<w:ins ");
    const view = await viewDocx(result.redlined);
    expect(view.paragraphs.map((p) => p.accepted)).toEqual(originalTexts);
    // The comment is where the change would have been, and says what it always says.
    expect(view.comments.map((c) => [c.text, c.anchored])).toEqual([
      [COMMENT_TEXT.term, "three years"],
    ]);
  });

  it("drops the space and the line end the text area leaves at either end, as for the model's wording", async () => {
    const result = await edited("  two years\n");
    expect(result).toMatchObject({ edits: 1, warnings: [] });
    const view = await paragraphs(result.redlined);
    expect(view[1]?.accepted).toBe(TERM.replace("three years", "two years"));
  });

  it("leaves a change alone for which there is no replacement", async () => {
    const result = await render("all", { replacements: new Map([["term", "two years"]]) });
    const view = await paragraphs(result.redlined);
    expect(view[2]?.accepted).toBe(NOTICE.replace("thirty days", "sixty days"));
    expect(view[3]?.accepted).toBe(LAW.replace("Singapore", "Delaware"));
  });

  it("cleans a replacement of what XML cannot hold, and the file opens", async () => {
    const dirty = "two\u0001 (2)\u0008 years\u202e\u0000";
    const result = await edited(dirty);
    expect(result).toMatchObject({ edits: 1, comments: 1, warnings: [] });

    const view = await paragraphs(result.redlined);
    expect(view[1]?.accepted).toBe(TERM.replace("three years", "two (2) years"));

    // No part holds a character XML forbids, or a bidi control that could reorder what is read.
    const zip = await JSZip.loadAsync(result.redlined);
    for (const name of ["word/document.xml", "word/comments.xml"]) {
      const xml = (await zip.file(name)?.async("string")) ?? "";
      expect(xml, name).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u202a-\u202e]/);
    }
    // And the engine itself, which refuses a file it cannot parse, opens it again.
    const reopened = await parseDocx(result.redlined);
    expect(reopened.paragraphs[1]?.text).toBe(TERM.replace("three years", "two (2) years"));
  });

  it.skipIf(!hasSoffice)(
    "opens in LibreOffice as the tracked changes and comments that were asked for (skipped where soffice is not installed)",
    { timeout: 120_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "clausewise-redline-"));
      try {
        const { redlined } = await render(new Set(["term", "remedies"]), {
          replacements: new Map([["term", "two\u0001 (2) years"]]),
        });
        const input = join(dir, "redlined.docx");
        await writeFile(input, redlined);
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
        const content = (await odt.file("content.xml")?.async("string")) ?? "";
        expect(content.match(/<text:deletion[ >]/g)).toHaveLength(1);
        expect(content.match(/<text:insertion[ >]/g)).toHaveLength(1);
        expect(content).toContain("two (2)");
        expect(content.match(/<office:annotation /g)).toHaveLength(2);
        expect(content).toContain("Shorten the term.");
        expect(content).toContain("Lower the fee.");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it("turns a replacement of nothing but forbidden characters into a comment, and says so", async () => {
    const result = await edited("\u0001\u0002");
    expect(result).toMatchObject({ edits: 0, comments: 1 });
    expect(result.warnings).toEqual([
      'The tracked change for "Duration of confidentiality obligations" could not be written (the replacement has no text that Word can hold), so its comment is on the paragraph and carries the suggested wording.',
    ]);
    const view = await viewDocx(result.redlined);
    expect(view.paragraphs.some((p) => p.tracked)).toBe(false);
    // The comment moved from the words to their paragraph.
    expect(view.comments.map((c) => c.anchored)).toEqual([TERM]);
  });

  it("refuses a replacement of more than 20,000 characters, whichever rule it is for", async () => {
    const tooLong = "x".repeat(20_001);
    for (const [ruleId, include] of [
      ["term", new Set(["term"])],
      ["permitted-use", new Set(["term"])],
      ["no-such-rule", new Set(["term"])],
      ["term", new Set<string>()],
    ] as const) {
      const failure = render(include, { replacements: new Map([[ruleId, tooLong]]) });
      await expect(failure, ruleId).rejects.toBeInstanceOf(ReviewError);
      await expect(failure, ruleId).rejects.toThrow(/most that can be written is 20000/);
    }
  });

  it("does not repeat the text of the replacement in the error", async () => {
    const secret = "Confidential Information secret ".repeat(1000);
    const failure = await render(new Set(["term"]), {
      replacements: new Map([["term", secret]]),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReviewError);
    expect((failure as Error).message).not.toContain("secret");
  });

  it("accepts a replacement of exactly 20,000 characters", async () => {
    const result = await edited("y".repeat(20_000));
    expect(result).toMatchObject({ edits: 1, warnings: [] });
    expect((await paragraphs(result.redlined))[1]?.accepted).toContain("y".repeat(20_000));
  });

  it("says when a replacement could not be used because the finding has no tracked change", async () => {
    const result = await render("all", {
      replacements: new Map([
        ["remedies", "four percent"],
        ["compelled-disclosure", "anything"],
        ["term", "two years"],
      ]),
    });
    expect(result.edits).toBe(3);
    expect(result.warnings).toEqual([
      'The replacement text for "Remedies" was not used, because that finding has no tracked change to put it in.',
      'The replacement text for "Disclosure required by law" was not used, because that finding has no tracked change to put it in.',
    ]);
    // What was written is what the findings say, nothing more.
    const view = await viewDocx(result.redlined);
    expect(view.paragraphs.map((p) => p.rejected)).toEqual(originalTexts);
  });

  it("ignores a replacement for a rule that is not included or not in the report, and says nothing", async () => {
    const plain = await render(new Set(["term"]));
    const result = await render(new Set(["term"]), {
      replacements: new Map([
        ["governing-law", "the State of Oregon"],
        ["no-such-rule", "anything"],
      ]),
    });
    expect(result.warnings).toEqual([]);
    expect(await sameParts(result.redlined, plain.redlined)).toBe(true);
  });
});

describe("renderRedline with a file that is not the one reviewed", () => {
  const mismatch = /^The document does not match the report/;

  it("throws a ReviewError that names the rule and never repeats the document", async () => {
    const other = await buildDocument({
      law: "1.3 This Agreement is governed by the laws of Ireland.",
    });
    const failure = await render("all", { docx: other }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReviewError);
    const message = (failure as Error).message;
    expect(message).toMatch(mismatch);
    expect(message).toContain("Governing law and venue");
    for (const text of ["Singapore", "Ireland", "Recipient", "Acme", "three years"]) {
      expect(message).not.toContain(text);
    }
  });

  it("writes nothing at a span that does not match, and checks only the findings asked for", async () => {
    const other = await buildDocument({
      law: "1.3 This Agreement is governed by the laws of Ireland.",
    });
    await expect(render(new Set(["governing-law"]), { docx: other })).rejects.toThrow(mismatch);
    // The span of the term is where the report says it is, so this one is written.
    const fine = await render(new Set(["term"]), { docx: other });
    expect(fine).toMatchObject({ edits: 1, comments: 1 });
    // Nothing is asked for, so nothing is checked.
    await expect(render(new Set(), { docx: other })).resolves.toMatchObject({ edits: 0 });
  });

  it("throws when a paragraph the report names is not in the document", async () => {
    const shorter = await buildDocument({ keep: 4 });
    await expect(render(new Set([RULES.commentOnly]), { docx: shorter })).rejects.toThrow(mismatch);
    await expect(render("all", { docx: shorter })).rejects.toThrow(mismatch);
  });

  it("throws when the words changed are not the words recorded", async () => {
    const report = clone(scenario.report);
    const term = resultOf(report, "term");
    if (term.edit.kind !== "applied") throw new Error("the scenario changed");
    term.edit.original = "four years";
    await expect(render(new Set(["term"]), { report })).rejects.toThrow(mismatch);
  });

  it.each([
    ["starts before the paragraph", { start: -1, end: 5 }],
    ["ends after the paragraph", { start: 0, end: 100_000 }],
    ["ends before it starts", { start: 9, end: 3 }],
    ["is not a whole number", { start: 1.5, end: 4 }],
  ])("throws when the span of a tracked change %s", async (_label, span) => {
    const report = clone(scenario.report);
    const term = resultOf(report, "term");
    if (term.edit.kind !== "applied") throw new Error("the scenario changed");
    Object.assign(term.edit, span);
    await expect(render(new Set(["term"]), { report })).rejects.toThrow(mismatch);
  });

  it.each([
    ["a paragraph that does not exist", { paragraphId: "p:77" }],
    ["a place outside its paragraph", { paragraphId: "p:1", start: 5, end: 100_000 }],
    ["a start after its end", { paragraphId: "p:1", start: 9, end: 3 }],
  ])("throws when the recorded place of a comment is %s", async (_label, anchor) => {
    const report = clone(scenario.report);
    resultOf(report, "compelled-disclosure").commentAnchor = anchor;
    await expect(render(new Set(["compelled-disclosure"]), { report })).rejects.toThrow(mismatch);
  });
});

describe("renderRedline with a report from before comments were anchored", () => {
  it("puts the comments on the first paragraph and says so, and still writes the changes", async () => {
    const report = clone(scenario.report);
    for (const result of report.results) delete result.commentAnchor;
    const result = await render("all", { report });
    expect(result.edits).toBe(3);
    expect(result.comments).toBe(5);
    expect(result.warnings).toEqual([
      "5 findings have no recorded place for their comments, because the report was made by an older version, so the comments are on the first paragraph.",
    ]);
    const view = await viewDocx(result.redlined);
    expect(view.comments.map((c) => c.paragraph)).toEqual([0, 0, 0, 0, 0]);
    expect(view.comments.map((c) => c.anchored)).toEqual(Array(5).fill(PREAMBLE));
    // The tracked changes are where the report says, and rejecting them restores the original.
    expect(view.paragraphs.map((p) => p.rejected)).toEqual(originalTexts);
    expect(view.paragraphs.filter((p) => p.tracked)).toHaveLength(3);
  });

  it("says it in the singular for one finding", async () => {
    const report = clone(scenario.report);
    delete resultOf(report, "term").commentAnchor;
    const result = await render(new Set(["term", "governing-law"]), { report });
    expect(result.warnings).toEqual([
      "1 finding has no recorded place for its comment, because the report was made by an older version, so the comment is on the first paragraph.",
    ]);
    const view = await viewDocx(result.redlined);
    expect(view.comments.map((c) => [c.paragraph, c.anchored])).toEqual([
      [0, PREAMBLE],
      [3, "Singapore"],
    ]);
  });
});

describe("renderRedline when the engine refuses a tracked change the report holds", () => {
  // The report says "five percent of revenue" was changed, but in this file the words sit in a
  // hyperlink, which the engine will not edit. It is a report made from another copy of the file.
  async function refusedCase() {
    const report = clone(scenario.report);
    const remedies = resultOf(report, "remedies");
    const original = "five percent of revenue";
    const text = (await parseDocx(scenario.docx)).paragraphs[4]?.text ?? "";
    const start = text.indexOf(original);
    expect(start).toBeGreaterThan(0);
    const end = start + original.length;
    remedies.edit = {
      kind: "applied",
      paragraphId: "p:4",
      start,
      end,
      original,
      replacement: "three percent of revenue",
    };
    remedies.commentAnchor = { paragraphId: "p:4", start, end };
    return { report, text };
  }

  it("moves the comment to the paragraph, adds the wording, and warns", async () => {
    const { report, text } = await refusedCase();
    const result = await render(new Set(["remedies", "term"]), { report });
    expect(result).toMatchObject({ edits: 1, comments: 2 });
    expect(result.warnings).toEqual([
      'The tracked change for "Remedies" could not be written (the range includes a hyperlink, which cannot be edited safely), so its comment is on the paragraph and carries the suggested wording.',
    ]);
    const view = await viewDocx(result.redlined);
    const remedies = view.comments.find((c) => c.text.startsWith("[MEDIUM] Remedies"));
    expect(remedies?.text).toBe(COMMENT_TEXT.remedies);
    expect(remedies?.anchored).toBe(text);
    // The other finding is written as it would have been.
    expect(view.paragraphs.filter((p) => p.tracked)).toHaveLength(1);
    expect(view.paragraphs.map((p) => p.rejected)).toEqual(originalTexts);
  });
});

describe("renderRedline when the engine refuses a comment the report holds", () => {
  it("warns that the comment is missing and still writes the tracked change", async () => {
    // A comment on an empty range is refused: the report says the comment is at 5-5 of a paragraph.
    const report = clone(scenario.report);
    resultOf(report, "term").commentAnchor = { paragraphId: "p:1", start: 5, end: 5 };
    const result = await render(new Set(["term", "governing-law"]), { report });
    expect(result).toMatchObject({ edits: 2, comments: 1 });
    expect(result.warnings).toEqual([
      'The comment for "Duration of confidentiality obligations" could not be written (range 5-5 is outside the paragraph or empty).',
    ]);
    const view = await viewDocx(result.redlined);
    expect(view.comments.map((c) => c.text)).toEqual([COMMENT_TEXT["governing-law"]]);
    expect(view.paragraphs.filter((p) => p.tracked)).toHaveLength(2);
  });
});

describe("renderRedline with a replacement the engine takes but does not change", () => {
  it("leaves the comment on the words and writes no change for the same words in other quotation marks", async () => {
    // The span is a name with an apostrophe in it; the replacement spells it with a curly one.
    const text =
      "1.1 The courts of Recipient's home state shall hear any dispute about this Agreement.";
    const docx = await buildDocument({ term: text });
    const report = clone(scenario.report);
    const term = resultOf(report, "term");
    const start = text.indexOf("Recipient's home state");
    const original = "Recipient's home state";
    term.edit = {
      kind: "applied",
      paragraphId: "p:1",
      start,
      end: start + original.length,
      original,
      replacement: "the state of Delaware",
    };
    term.commentAnchor = { paragraphId: "p:1", start, end: start + original.length };
    const result = await render(new Set(["term"]), {
      report,
      docx,
      replacements: new Map([["term", "Recipient\u2019s home state"]]),
    });
    expect(result).toMatchObject({ edits: 0, comments: 1, warnings: [] });
    const view = await viewDocx(result.redlined);
    expect(view.paragraphs.some((p) => p.tracked)).toBe(false);
    expect(view.comments.map((c) => c.anchored)).toEqual([original]);
  });
});

describe("the parts of the file it writes", () => {
  it("keeps every part the original has, and adds only the comments", async () => {
    const result = await render("all");
    const before = await partsOf(scenario.docx);
    const after = await partsOf(result.redlined);
    for (const name of before.keys()) expect(after.has(name), name).toBe(true);
    const added = [...after.keys()].filter((name) => !before.has(name));
    expect(added).toEqual(["word/comments.xml"]);
    // The preamble and the last clause are not touched by anything.
    const paragraphsBefore = await paragraphXml(scenario.docx);
    const paragraphsAfter = await paragraphXml(result.redlined);
    expect(paragraphsAfter[0]).toBe(paragraphsBefore[0]);
    expect(paragraphsAfter[5]).toBe(paragraphsBefore[5]);
    expect(originalTexts[0]).toBe(PREAMBLE);
    expect(originalTexts[5]).toBe(RETURN);
  });
});
