import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRedline } from "../src/redline.js";
import type { ReviewReport } from "../src/types.js";
import { viewDocx } from "./pipeline-support.js";
import {
  AUTHOR,
  DATE,
  FEE,
  buildScenario,
  resultOf,
  sameParts,
  type Scenario,
} from "./redline-support.js";

type ApplyRedline = typeof import("@clausewise/docx").applyRedline;

// The writer is the real one unless a test makes it throw, so the same file shows both what a
// rebuilt redline does with a writer that fails and that a document which opened is safe.
const writer = vi.hoisted(() => ({
  calls: [] as unknown[][],
  fail: undefined as undefined | ((call: number) => unknown),
}));

vi.mock("@clausewise/docx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clausewise/docx")>();
  return {
    ...actual,
    applyRedline: (...args: Parameters<ApplyRedline>) => {
      writer.calls.push(args);
      const failure = writer.fail?.(writer.calls.length);
      if (failure !== undefined) throw failure;
      return actual.applyRedline(...args);
    },
  };
});

const SECRET = "Confidential Information secret";

let scenario: Scenario;
let originalTexts: string[];

beforeAll(async () => {
  scenario = await buildScenario();
  originalTexts = (await viewDocx(scenario.docx)).paragraphs.map((p) => p.accepted);
});

beforeEach(() => {
  writer.calls.length = 0;
  writer.fail = undefined;
});

const render = (report: ReviewReport = scenario.report, docx = scenario.docx) =>
  renderRedline({ docx, report, include: "all", author: AUTHOR, date: DATE });

describe("a Word writer that throws while a redline is rebuilt", () => {
  it("is reached once by a normal rebuild, which writes the changes and the comments together", async () => {
    const result = await render();
    expect(writer.calls).toHaveLength(1);
    expect(result).toMatchObject({ edits: 3, comments: 5, warnings: [] });
  });

  it("falls back to the comments alone, says what the file lacks, and does not throw", async () => {
    writer.fail = (call) => (call === 1 ? new TypeError(`broke on ${SECRET}`) : undefined);
    const result = await render();

    // The second call carries no change, and every comment of the first.
    expect(writer.calls).toHaveLength(2);
    const second = writer.calls[1] as [Uint8Array, { edits: unknown[]; comments: unknown[] }];
    expect(second[1].edits).toEqual([]);
    expect(second[1].comments).toHaveLength(5);

    expect(result.edits).toBe(0);
    expect(result.comments).toBe(5);
    expect(result.warnings).toEqual([
      "The Word file could not be edited with tracked changes (TypeError), so the suggested edits are written as comments and no text of the contract was changed.",
    ]);

    const view = await viewDocx(result.redlined);
    expect(view.paragraphs.some((p) => p.tracked)).toBe(false);
    expect(view.paragraphs.map((p) => p.accepted)).toEqual(originalTexts);
    // Each change that could not be written is in its comment, as the wording to type.
    const texts = view.comments.map((c) => c.text);
    expect(texts).toContain(
      "[HIGH] Duration of confidentiality obligations\nShorten the term.\n\nSuggested wording (could not be applied automatically): two years",
    );
    expect(texts).toContain(
      "[LOW] Governing law and venue\nUse a forum we know.\n\nSuggested wording (could not be applied automatically): Delaware",
    );
    expect(JSON.stringify(result.warnings)).not.toContain(SECRET);
  });

  it("returns a copy of the original when even the comments cannot be written", async () => {
    writer.fail = () => new RangeError("no");
    const result = await render();

    expect(writer.calls).toHaveLength(2);
    expect(Buffer.from(result.redlined).equals(Buffer.from(scenario.docx))).toBe(true);
    // A copy, so that changing one does not change the other.
    expect(result.redlined).not.toBe(scenario.docx);
    expect(result.edits).toBe(0);
    expect(result.comments).toBe(0);
    expect(result.warnings).toEqual([
      "The Word file could not be edited safely (RangeError), so the redlined file is a copy of the original with no tracked changes and no comments. Every finding is in the report.",
    ]);
  });

  it("repeats only an error name that is a plain label, never what the writer said", async () => {
    const cases: { thrown: unknown; label: string }[] = [
      { thrown: SECRET, label: "" },
      { thrown: Object.assign(new Error(SECRET), { name: SECRET.repeat(4) }), label: "" },
      {
        thrown: Object.assign(new Error(SECRET), { name: "NotFoundError" }),
        label: " (NotFoundError)",
      },
    ];
    for (const { thrown, label } of cases) {
      writer.calls.length = 0;
      writer.fail = (call) => (call === 1 ? thrown : undefined);
      const result = await render();
      expect(result.warnings).toEqual([
        `The Word file could not be edited with tracked changes${label}, so the suggested edits are written as comments and no text of the contract was changed.`,
      ]);
    }
  });

  it("does not turn a writer that throws after an edit was refused into a lost redline", async () => {
    // The report holds a change across a hyperlink, which the engine refuses on the first call. The
    // second call, which repeats without it, throws, and so does the third that gives up the edits.
    writer.fail = (call) => (call >= 2 ? new Error("second pass") : undefined);
    const report = JSON.parse(JSON.stringify(scenario.report)) as ReviewReport;
    const remedies = resultOf(report, "remedies");
    const original = "five percent of revenue";
    const start = FEE.indexOf(original);
    remedies.edit = {
      kind: "applied",
      paragraphId: "p:4",
      start,
      end: start + original.length,
      original,
      replacement: "three percent of revenue",
    };
    remedies.commentAnchor = { paragraphId: "p:4", start, end: start + original.length };

    const result = await renderRedline({
      docx: scenario.docx,
      report,
      include: new Set(["remedies"]),
      author: AUTHOR,
      date: DATE,
    });
    expect(writer.calls).toHaveLength(3);
    expect(Buffer.from(result.redlined).equals(Buffer.from(scenario.docx))).toBe(true);
    expect(result).toMatchObject({ edits: 0, comments: 0 });
    // The refusal the engine gave is reported, and so is the failure that followed it.
    expect(result.warnings).toEqual([
      'The tracked change for "Remedies" could not be written (the range includes a hyperlink, which cannot be edited safely), so its comment is on the paragraph and carries the suggested wording.',
      "The Word file could not be edited safely (Error), so the redlined file is a copy of the original with no tracked changes and no comments. Every finding is in the report.",
    ]);
  });

  it("never throws for a document that opened, whichever call fails", async () => {
    for (const failing of [[1], [2], [1, 2], [2, 3], [1, 2, 3]]) {
      writer.calls.length = 0;
      writer.fail = (call) => (failing.includes(call) ? new Error("no") : undefined);
      const result = await render();
      const view = await viewDocx(result.redlined);
      expect(
        view.paragraphs.map((p) => p.rejected),
        failing.join(","),
      ).toEqual(originalTexts);
    }
  });
});

describe("a review whose writer gives up the tracked changes", () => {
  it("anchors each comment on its paragraph, and its report rebuilds the very file the review returned", async () => {
    writer.fail = (call) => (call === 1 ? new TypeError("no") : undefined);
    const failed = await buildScenario();
    writer.fail = undefined;

    const paragraphs = { term: "p:1", "permitted-use": "p:2", "governing-law": "p:3" };
    for (const [ruleId, paragraphId] of Object.entries(paragraphs)) {
      const result = resultOf(failed.report, ruleId);
      expect(result.edit, ruleId).toMatchObject({
        kind: "comment-only",
        reason: "the document could not be edited safely",
      });
      // The comment is on the paragraph, with no span, because no change stands there.
      expect(result.commentAnchor, ruleId).toStrictEqual({ paragraphId });
    }

    const rebuilt = await render(failed.report);
    expect(rebuilt).toMatchObject({ edits: 0, comments: 5, warnings: [] });
    expect(await sameParts(rebuilt.redlined, failed.redlined)).toBe(true);
  });
});
