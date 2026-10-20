import { createScriptedGenerator } from "@clausewise/llm/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { reviewContract } from "../src/pipeline.js";
import type { ReviewReport, RuleCheck } from "../src/types.js";
import {
  buildDocx,
  clausesOf,
  compliantAnswer,
  idOf,
  loadPlaybook,
  onlyRules,
  ruleIdOf,
  viewDocx,
} from "./pipeline-support.js";

type ApplyRedline = typeof import("@clausewise/docx").applyRedline;

// The writer is the real one unless a test makes it throw, so the same file can show both what
// the pipeline does with a writer that fails and that a document which used to crash one is safe.
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
const playbook = onlyRules(loadPlaybook(), "term", "permitted-use");
const UNSAFE = "the document could not be edited safely";

const PREAMBLE =
  "This Agreement is made between Acme Inc and Beta LLC to govern what each of them shares with the other.";
const RECIPIENT = `Recipient shall keep the ${SECRET} for three years from the date it is disclosed to Recipient.`;
const NOTICE = "1.1 Either party may end this Agreement by giving thirty days written notice.";

let docx: Uint8Array;
let ids: { recipient: string; notice: string };

beforeAll(async () => {
  docx = await buildDocx([{ text: PREAMBLE }, { text: RECIPIENT }, { text: NOTICE }]);
  const clauses = await clausesOf(docx);
  ids = {
    recipient: clauses.find((c) => c.text.startsWith("Recipient shall"))?.id ?? "",
    notice: idOf(clauses, "1.1"),
  };
});

beforeEach(() => {
  writer.calls.length = 0;
  writer.fail = undefined;
});

const deviation = (overrides: Partial<RuleCheck>): RuleCheck =>
  compliantAnswer({ status: "deviation", explanation: "Falls short.", ...overrides });

/** Two rules whose edits sit in different paragraphs, so both would normally apply. */
function separateEdits() {
  const answers: Record<string, RuleCheck> = {
    term: deviation({
      clauseIds: [ids.recipient],
      comment: "Shorten the term.",
      edit: { clauseId: ids.recipient, quote: "three years", replacement: "two years" },
    }),
    "permitted-use": deviation({
      clauseIds: [ids.notice],
      comment: "Ask for longer notice.",
      edit: { clauseId: ids.notice, quote: "thirty days", replacement: "sixty days" },
    }),
  };
  return createScriptedGenerator((request) => answers[ruleIdOf(request)]);
}

const rejectedText = async (bytes: Uint8Array): Promise<string[]> =>
  (await viewDocx(bytes)).paragraphs.map((p) => p.rejected);

describe("a Word writer that throws", () => {
  it("is not reached by a normal review, which writes both edits and both comments", async () => {
    const { report, redlined } = await reviewContract({ docx, playbook }, separateEdits());
    expect(writer.calls).toHaveLength(1);
    expect(report.warnings).toBeUndefined();
    expect(report.stats.editsApplied).toBe(2);
    expect((await viewDocx(redlined)).comments).toHaveLength(2);
  });

  it("falls back to the comments alone and says what the file lacks", async () => {
    writer.fail = (call) => (call === 1 ? new TypeError(`broke on ${SECRET}`) : undefined);
    const { report, redlined } = await reviewContract({ docx, playbook }, separateEdits());

    // The second call carries no edit, and every comment of the first.
    expect(writer.calls).toHaveLength(2);
    const second = writer.calls[1] as [Uint8Array, { edits: unknown[]; comments: unknown[] }];
    expect(second[1].edits).toEqual([]);
    expect(second[1].comments).toHaveLength(2);

    expect(report.warnings).toEqual([
      "The Word file could not be edited with tracked changes (TypeError), so the suggested edits are written as comments and no text of the contract was changed.",
    ]);
    expect(report.stats.editsApplied).toBe(0);
    for (const id of ["term", "permitted-use"]) {
      const found = report.results.find((r) => r.ruleId === id);
      expect(found?.edit).toMatchObject({ kind: "comment-only", reason: UNSAFE });
    }

    const view = await viewDocx(redlined);
    expect(view.paragraphs.some((p) => p.tracked)).toBe(false);
    expect(view.comments.map((c) => c.text)).toEqual([
      "[HIGH] Duration of confidentiality obligations\nShorten the term.\n\nSuggested wording (could not be applied automatically): two years",
      "[MEDIUM] Permitted use and disclosure to representatives\nAsk for longer notice.\n\nSuggested wording (could not be applied automatically): sixty days",
    ]);
    expect(await rejectedText(redlined)).toEqual(await rejectedText(docx));
    expect(JSON.stringify(report.warnings)).not.toContain(SECRET);
  });

  it("returns the original bytes when even the comments cannot be written", async () => {
    writer.fail = () => new RangeError("no");
    const { report, redlined } = await reviewContract({ docx, playbook }, separateEdits());

    expect(writer.calls).toHaveLength(2);
    expect(Buffer.from(redlined).equals(Buffer.from(docx))).toBe(true);
    expect(report.warnings).toEqual([
      "The Word file could not be edited safely (RangeError), so the redlined file is a copy of the original with no tracked changes and no comments. Every finding is in the report.",
    ]);
    // The paid-for findings are all there, each edit downgraded to a comment that was not written.
    expect(report.counts).toMatchObject({ deviation: 2, error: 0 });
    expect(report.open).toEqual({ high: 1, medium: 1, low: 0 });
    for (const result of report.results) {
      expect(result.status).toBe("deviation");
      expect(result.edit).toMatchObject({ kind: "comment-only", reason: UNSAFE });
    }
    expect(report.stats.editsApplied).toBe(0);
  });

  it("keeps a reason the engine or the anchoring already gave, and downgrades only the live edits", async () => {
    writer.fail = (call) => (call === 1 ? new Error("first") : undefined);
    const answers: Record<string, RuleCheck> = {
      term: deviation({
        clauseIds: [ids.recipient],
        edit: { clauseId: ids.recipient, quote: "no such words", replacement: "x" },
      }),
      "permitted-use": deviation({
        clauseIds: [ids.notice],
        edit: { clauseId: ids.notice, quote: "thirty days", replacement: "sixty days" },
      }),
    };
    const { report } = await reviewContract(
      { docx, playbook },
      createScriptedGenerator((request) => answers[ruleIdOf(request)]),
    );
    const edits = report.results.map((r) => r.edit);
    expect(edits[0]).toMatchObject({
      kind: "comment-only",
      reason: expect.stringMatching(/not found/),
    });
    expect(edits[1]).toMatchObject({ kind: "comment-only", reason: UNSAFE });
  });

  it("never repeats what the writer said, only an error name that is a plain label", async () => {
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
      const { report } = await reviewContract({ docx, playbook }, separateEdits());
      expect(report.warnings).toEqual([
        `The Word file could not be edited with tracked changes${label}, so the suggested edits are written as comments and no text of the contract was changed.`,
      ]);
    }
  });

  it("does not turn a writer that throws after an edit was refused into a lost review", async () => {
    // The first pass refuses nothing here, so the fallback is reached from the very first call, and
    // a later throw (the loop's second pass) is covered by failing every call after the first.
    writer.fail = (call) => (call >= 2 ? new Error("second pass") : undefined);
    const hyperlinked = await buildDocx([
      { text: PREAMBLE },
      {
        xml:
          `<w:r><w:t xml:space="preserve">1.1 The fee is </w:t></w:r>` +
          `<w:hyperlink w:anchor="fees"><w:r><w:t>five percent of revenue</w:t></w:r></w:hyperlink>` +
          `<w:r><w:t xml:space="preserve"> annually, payable monthly in arrears by the customer.</w:t></w:r>`,
      },
      { text: "1.2 Fees are payable within thirty days of the date of each invoice." },
    ]);
    const clauses = await clausesOf(hyperlinked);
    const clauseId = idOf(clauses, "1.1");
    const { report, redlined } = await reviewContract(
      { docx: hyperlinked, playbook: onlyRules(playbook, "term") },
      createScriptedGenerator(() =>
        deviation({
          clauseIds: [clauseId],
          comment: "Lower the fee.",
          edit: { clauseId, quote: "five percent of revenue", replacement: "three percent" },
        }),
      ),
    );
    // The engine refused the edit across the hyperlink, the second pass threw, and the review
    // still came back with a copy of the original and the finding.
    expect(writer.calls).toHaveLength(3);
    expect(Buffer.from(redlined).equals(Buffer.from(hyperlinked))).toBe(true);
    expect(report.counts.deviation).toBe(1);
    expect(report.results[0]?.edit).toMatchObject({
      kind: "comment-only",
      reason: expect.stringMatching(/hyperlink/),
    });
  });
});

describe("two rules whose edits start at the same place", () => {
  // Quote "Recipient" and quote "Recipient shall" both start at the first character of a
  // paragraph that no number precedes. The second becomes a pure insertion next to the first
  // replacement, which a redline engine can fail on. Either way the review has to come back.
  it("returns a valid review whether or not the engine can write both edits", async () => {
    const answers: Record<string, RuleCheck> = {
      term: deviation({
        clauseIds: [ids.recipient],
        comment: "Name the party.",
        edit: { clauseId: ids.recipient, quote: "Recipient", replacement: "The Receiving Party" },
      }),
      "permitted-use": deviation({
        clauseIds: [ids.recipient],
        comment: "Say who is bound.",
        edit: {
          clauseId: ids.recipient,
          quote: "Recipient shall",
          replacement: "Each Recipient shall",
        },
      }),
    };
    const { report, redlined } = await reviewContract(
      { docx, playbook },
      createScriptedGenerator((request) => answers[ruleIdOf(request)]),
    );
    expect(report.counts.deviation).toBe(2);
    const view = await viewDocx(redlined);
    expect(view.comments).toHaveLength(2);
    expect(await rejectedText(redlined)).toEqual(await rejectedText(docx));
    const written = (report as ReviewReport).warnings ?? [];
    expect(written.every((w) => !w.includes(SECRET))).toBe(true);
  });
});
