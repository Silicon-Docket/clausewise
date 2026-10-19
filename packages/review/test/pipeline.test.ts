import type { Playbook } from "@clausewise/playbook";
import { beforeAll, describe, expect, it } from "vitest";
import { ReviewError } from "../src/errors.js";
import { reviewContract } from "../src/pipeline.js";
import { createOracleGenerator, type OracleRule } from "../src/testing.js";
import type { ProgressEvent, ReviewReport, RuleResult } from "../src/types.js";
import {
  aggressiveScript,
  balancedScript,
  buildDocx,
  fixture,
  loadPlaybook,
  onlyRules,
  run,
  viewDocx,
  type DocxView,
} from "./pipeline-support.js";

const playbook = loadPlaybook();
const DATE = new Date("2026-03-02T09:30:00Z");

function result(report: ReviewReport, ruleId: string): RuleResult {
  const found = report.results.find((r) => r.ruleId === ruleId);
  if (found === undefined) throw new Error(`no result for ${ruleId}`);
  return found;
}

describe("reviewContract on the aggressive NDA", () => {
  const input = fixture("nda-aggressive.docx");
  const script = aggressiveScript();
  const events: ProgressEvent[] = [];
  let report: ReviewReport;
  let redlined: Uint8Array;
  let before: DocxView;
  let after: DocxView;
  let calls: number;

  beforeAll(async () => {
    const oracle = createOracleGenerator(script);
    const review = await reviewContract(
      { docx: input, playbook, fileName: "nda-aggressive.docx" },
      oracle,
      { date: DATE, onProgress: (event) => events.push(event) },
    );
    report = review.report;
    redlined = review.redlined;
    calls = oracle.calls.length;
    before = await viewDocx(input);
    after = await viewDocx(redlined);
  });

  it("names the document, the playbook and the model, and makes one call per rule", () => {
    expect(report.document).toBe("nda-aggressive.docx");
    expect(report.playbook).toEqual({
      name: playbook.name,
      contractTypes: playbook.contractTypes,
    });
    expect(report.model).toEqual({
      provider: "oracle",
      model: "oracle",
      disclosure: "a scripted test oracle (nothing is sent anywhere)",
    });
    expect(calls).toBe(playbook.rules.length);
  });

  it("counts the results and lists them in playbook order", () => {
    expect(report.results.map((r) => r.ruleId)).toEqual(playbook.rules.map((r) => r.id));
    expect(report.counts).toEqual({
      compliant: 0,
      deviation: 9,
      missing: 1,
      not_applicable: 0,
      error: 0,
    });
    expect(report.open).toEqual({ high: 4, medium: 4, low: 2 });
    expect(report.stats).toEqual({ paragraphs: 31, clauses: 16, windows: 1, editsApplied: 2 });
    expect(report.stats.paragraphs).toBe(before.paragraphs.length);
  });

  it("copies the rule's title, severity and requirement into each result", () => {
    for (const rule of playbook.rules) {
      expect(result(report, rule.id)).toMatchObject({
        title: rule.title,
        severity: rule.severity,
        required: rule.required,
      });
    }
  });

  it("turns clause numbers the model cited into validated ids and numbers", () => {
    expect(result(report, "mutuality")).toMatchObject({
      clauseIds: ["c3", "c5"],
      clauseNumbers: ["1.1", "2.1"],
    });
    expect(result(report, "remedies").clauseNumbers).toEqual(["5.1", "5.2", "5.3"]);
  });

  it("applies a valid edit as a tracked change", () => {
    const term = result(report, "term");
    expect(term.status).toBe("deviation");
    expect(term.edit).toEqual({
      kind: "applied",
      paragraphId: "p:10",
      start: expect.any(Number),
      end: expect.any(Number),
      original: "perpetual and shall continue indefinitely",
      replacement: "end three (3) years after the date of disclosure",
    });
    if (term.edit.kind !== "applied") throw new Error("expected an applied edit");
    expect(before.paragraphs[10]?.accepted.slice(term.edit.start, term.edit.end)).toBe(
      term.edit.original,
    );
  });

  it("makes an overlapping second edit comment-only and says why", () => {
    expect(result(report, "mutuality").edit.kind).toBe("applied");
    const definition = result(report, "definition");
    expect(definition.edit).toEqual({
      kind: "comment-only",
      proposed: script["definition"]?.edit
        ? {
            clauseId: "c3",
            quote: script["definition"].edit.quote,
            replacement: script["definition"].edit.replacement,
          }
        : null,
      reason: "the edit overlaps an earlier edit",
    });
  });

  it("keeps a hallucinated quote out of the document", () => {
    const remedies = result(report, "remedies");
    expect(remedies.status).toBe("deviation");
    expect(remedies.edit).toMatchObject({
      kind: "comment-only",
      reason: expect.stringMatching(/not found/),
    });
    expect(after.paragraphs[15]?.tracked).toBe(false);
  });

  it("refuses an ambiguous quote", () => {
    expect(result(report, "governing-law").edit).toMatchObject({
      kind: "comment-only",
      reason: expect.stringMatching(/ambiguous: it occurs 2 times/),
    });
    expect(after.paragraphs[20]?.tracked).toBe(false);
  });

  it("reports a missing clause with its suggested clause and no edit", () => {
    const compelled = result(report, "compelled-disclosure");
    expect(compelled).toMatchObject({
      status: "missing",
      clauseIds: [],
      clauseNumbers: [],
      edit: { kind: "none" },
      suggestedClause: script["compelled-disclosure"]?.suggestedClause,
    });
  });

  it("reports the remaining deviations without an edit", () => {
    for (const id of [
      "exclusions",
      "permitted-use",
      "return-or-destroy",
      "restrictive-covenants",
    ]) {
      expect(result(report, id)).toMatchObject({ status: "deviation", edit: { kind: "none" } });
    }
  });

  it("restores exactly the original paragraphs when all changes are rejected", () => {
    expect(after.paragraphs.map((p) => p.rejected)).toEqual(
      before.paragraphs.map((p) => p.accepted),
    );
  });

  it("produces the expected text when all changes are accepted and leaves the rest alone", () => {
    const expected = before.paragraphs.map((p) => p.accepted);
    const replaceIn = (index: number, from: string, to: string): void => {
      const text = expected[index];
      if (text === undefined || !text.includes(from)) throw new Error("fixture changed");
      expected[index] = text.replace(from, to);
    };
    replaceIn(
      4,
      "disclosed by or on behalf of Discloser to Recipient",
      "disclosed by or on behalf of either party to the other",
    );
    replaceIn(
      10,
      "perpetual and shall continue indefinitely",
      "end three (3) years after the date of disclosure",
    );
    expect(after.paragraphs.map((p) => p.accepted)).toEqual(expected);

    const changed = after.paragraphs.flatMap((p, i) => (p.tracked ? [i] : []));
    expect(changed).toEqual([4, 10]);
  });

  it("writes one comment per deviation or missing result, none for the rest", () => {
    expect(after.comments).toHaveLength(10);
    expect(new Set(after.comments.map((c) => c.author))).toEqual(new Set(["Clausewise"]));
    expect(new Set(after.comments.map((c) => c.date))).toEqual(new Set(["2026-03-02T09:30:00Z"]));
  });

  const commentFor = (heading: string): DocxView["comments"][number] => {
    const found = after.comments.find((c) => c.text.startsWith(`${heading}\n`));
    if (found === undefined) throw new Error(`no comment for ${heading}`);
    return found;
  };

  it("puts the severity and title first, then the model's comment", () => {
    expect(commentFor("[HIGH] Duration of confidentiality obligations").text).toBe(
      "[HIGH] Duration of confidentiality obligations\n" + script["term"]?.comment,
    );
    expect(commentFor("[LOW] Return or destruction of information").text).toBe(
      "[LOW] Return or destruction of information\n" + script["return-or-destroy"]?.comment,
    );
  });

  it("appends the suggested clause to a missing result's comment", () => {
    expect(commentFor("[MEDIUM] Disclosure required by law").text).toBe(
      "[MEDIUM] Disclosure required by law\n" +
        script["compelled-disclosure"]?.comment +
        "\n\nSuggested clause:\n" +
        script["compelled-disclosure"]?.suggestedClause,
    );
  });

  it("appends the replacement to the comment of an edit that could not be applied", () => {
    const wording = "\n\nSuggested wording (could not be applied automatically): ";
    expect(commentFor("[MEDIUM] Remedies").text).toBe(
      "[MEDIUM] Remedies\n" + script["remedies"]?.comment + wording + "damages as provided by law",
    );
    expect(commentFor("[LOW] Governing law and venue").text).toBe(
      "[LOW] Governing law and venue\n" +
        script["governing-law"]?.comment +
        wording +
        "the State of Delaware",
    );
    expect(commentFor("[MEDIUM] Definition of Confidential Information").text).toContain(wording);
    expect(commentFor("[HIGH] Obligations bind both parties").text).not.toContain("Suggested");
  });

  it("anchors the comment of an applied edit on the edit's range", () => {
    const term = commentFor("[HIGH] Duration of confidentiality obligations");
    expect(term.paragraph).toBe(10);
    expect(term.anchored).toBe("perpetual and shall continue indefinitely");
    const mutuality = commentFor("[HIGH] Obligations bind both parties");
    expect(mutuality.paragraph).toBe(4);
    expect(mutuality.anchored).toBe("disclosed by or on behalf of Discloser to Recipient");
  });

  it("anchors every other comment on the whole first paragraph of its first clause", () => {
    const whole = (heading: string, paragraph: number): void => {
      const comment = commentFor(heading);
      expect(comment.paragraph).toBe(paragraph);
      expect(comment.anchored).toBe(before.paragraphs[paragraph]?.accepted);
    };
    whole("[MEDIUM] Definition of Confidential Information", 4);
    whole("[HIGH] Standard exclusions", 5);
    whole("[MEDIUM] Permitted use and disclosure to representatives", 8);
    whole("[LOW] Return or destruction of information", 12);
    whole("[MEDIUM] Remedies", 14);
    whole("[HIGH] No hidden restrictive covenants", 18);
    whole("[LOW] Governing law and venue", 20);
  });

  it("anchors a comment with no clause on the document's first clause", () => {
    const comment = commentFor("[MEDIUM] Disclosure required by law");
    expect(comment.paragraph).toBe(1);
    expect(comment.anchored).toBe(before.paragraphs[1]?.accepted);
  });

  it("sends one start event and then one event per rule", () => {
    expect(events[0]).toEqual({ type: "start", rules: 10, clauses: 16, windows: 1 });
    const ruleEvents = events.slice(1);
    expect(ruleEvents).toHaveLength(10);
    ruleEvents.forEach((event, i) => {
      if (event.type !== "rule") throw new Error("expected a rule event");
      expect(event.done).toBe(i + 1);
      expect(event.total).toBe(10);
      expect(event.status).toBe(result(report, event.ruleId).status);
    });
    expect(new Set(ruleEvents.map((e) => (e.type === "rule" ? e.ruleId : "")))).toEqual(
      new Set(playbook.rules.map((r) => r.id)),
    );
  });

  it("keeps contract text out of the report apart from what a finding quotes", () => {
    const json = JSON.stringify(report);
    // Clause 7.2 and the party names are in the contract, and no finding quotes them.
    for (const sentence of [
      "This Agreement is the entire agreement between the parties on its subject matter",
      "Fabrikam Labs LLC",
      "Northwind Holdings",
      "irreparable harm",
    ]) {
      expect(json).not.toContain(sentence);
    }
    // The control: the words an applied edit quotes are in the report.
    expect(json).toContain("perpetual and shall continue indefinitely");
  });
});

describe("reviewContract on the balanced NDA", () => {
  it("finds nothing to do and returns the input bytes untouched", async () => {
    const input = fixture("nda-balanced.docx");
    const { report, redlined } = await reviewContract(
      { docx: input, playbook },
      createOracleGenerator(balancedScript()),
    );
    expect(report.document).toBeUndefined();
    expect(report.counts).toEqual({
      compliant: 9,
      deviation: 0,
      missing: 0,
      not_applicable: 1,
      error: 0,
    });
    expect(report.open).toEqual({ high: 0, medium: 0, low: 0 });
    expect(report.stats.editsApplied).toBe(0);
    expect(result(report, "return-or-destroy").status).toBe("not_applicable");
    expect(Buffer.from(redlined).equals(Buffer.from(input))).toBe(true);
    expect((await viewDocx(redlined)).comments).toEqual([]);
  });
});

describe("reviewContract options", () => {
  const input = fixture("nda-aggressive.docx");
  const oneRule = onlyRules(playbook, "term");
  const script = (): Record<string, OracleRule> => ({ term: aggressiveScript()["term"]! });

  it("writes the author and date it is given", async () => {
    const { redlined } = await reviewContract(
      { docx: input, playbook: oneRule },
      createOracleGenerator(script()),
      { author: "Ada Reviewer", date: DATE },
    );
    const { comments } = await viewDocx(redlined);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ author: "Ada Reviewer", date: "2026-03-02T09:30:00Z" });
  });

  it("defaults the author to Clausewise", async () => {
    const { redlined } = await reviewContract(
      { docx: input, playbook: oneRule },
      createOracleGenerator(script()),
    );
    expect((await viewDocx(redlined)).comments[0]?.author).toBe("Clausewise");
  });

  it("passes the rule's own system prompt, schema and prefix to the model", async () => {
    const oracle = createOracleGenerator(script());
    await reviewContract({ docx: input, playbook: oneRule }, oracle);
    const [call] = oracle.calls;
    expect(call?.schemaName).toBe("rule_check");
    expect(call?.prompt.startsWith(call.sharedPrefix ?? "\u0000")).toBe(true);
    expect(call?.prompt).toContain("Rule ID: term");
    expect(call?.signal).toBeUndefined();
  });

  it("rejects options that cannot work, before any call", async () => {
    for (const options of [
      { concurrency: 0 },
      { concurrency: 1.5 },
      { concurrency: Number.NaN },
      { maxContextTokens: 0 },
      { maxContextTokens: Number.NaN },
    ]) {
      const oracle = createOracleGenerator(script());
      await expect(
        reviewContract({ docx: input, playbook: oneRule }, oracle, options),
      ).rejects.toBeInstanceOf(ReviewError);
      expect(oracle.calls).toHaveLength(0);
    }
  });

  it("rejects a playbook with no rules", async () => {
    const empty: Playbook = { ...playbook, rules: [] };
    await expect(
      reviewContract({ docx: input, playbook: empty }, createOracleGenerator({})),
    ).rejects.toThrow(ReviewError);
  });

  it("throws a ReviewError when the document has no reviewable clauses", async () => {
    const docx = await buildDocx([
      { text: "SERVICES AGREEMENT", style: "Heading1" },
      { text: "" },
      { text: "1. Definitions", style: "Heading2" },
    ]);
    const oracle = createOracleGenerator(script());
    const failure = reviewContract({ docx, playbook: oneRule }, oracle);
    await expect(failure).rejects.toBeInstanceOf(ReviewError);
    await expect(failure).rejects.toThrow(/no reviewable clauses/);
    expect(oracle.calls).toHaveLength(0);
  });
});

describe("reviewContract when the redline engine refuses an edit", () => {
  it("falls back to a comment on the clause and keeps the edits that apply", async () => {
    const docx = await buildDocx([
      {
        xml:
          run("1.1 The fee is ") +
          '<w:hyperlink w:anchor="fees">' +
          run("five percent of revenue") +
          "</w:hyperlink>" +
          run(" annually, payable monthly in arrears."),
      },
      { xml: run("1.2 Fees are payable within thirty days of invoice.") },
    ]);
    const rules = onlyRules(playbook, "term", "permitted-use");
    const { report, redlined } = await reviewContract(
      { docx, playbook: rules },
      createOracleGenerator({
        term: {
          status: "deviation",
          clauseNumbers: ["1.1"],
          explanation: "The fee is too high.",
          comment: "Lower the fee.",
          edit: {
            clauseNumber: "1.1",
            quote: "five percent of revenue",
            replacement: "three percent of revenue",
          },
        },
        "permitted-use": {
          status: "deviation",
          clauseNumbers: ["1.2"],
          explanation: "Thirty days is short.",
          comment: "Ask for sixty.",
          edit: { clauseNumber: "1.2", quote: "thirty days", replacement: "sixty days" },
        },
      }),
      { date: DATE },
    );

    expect(result(report, "term").edit).toMatchObject({
      kind: "comment-only",
      reason: expect.stringMatching(/hyperlink/),
    });
    expect(result(report, "permitted-use").edit).toMatchObject({
      kind: "applied",
      original: "thirty days",
      replacement: "sixty days",
    });
    expect(report.stats.editsApplied).toBe(1);

    const view = await viewDocx(redlined);
    expect(view.paragraphs.map((p) => p.tracked)).toEqual([false, true]);
    expect(view.paragraphs[1]?.accepted).toBe("1.2 Fees are payable within sixty days of invoice.");
    expect(view.paragraphs[1]?.rejected).toBe(
      "1.2 Fees are payable within thirty days of invoice.",
    );
    const fee = view.comments.find((c) => c.text.startsWith("[HIGH]"));
    expect(fee?.text).toBe(
      "[HIGH] Duration of confidentiality obligations\nLower the fee.\n\n" +
        "Suggested wording (could not be applied automatically): three percent of revenue",
    );
    expect(fee).toMatchObject({
      paragraph: 0,
      anchored: "1.1 The fee is five percent of revenue annually, payable monthly in arrears.",
    });
    const terms = view.comments.find((c) => c.text.startsWith("[MEDIUM]"));
    expect(terms).toMatchObject({ paragraph: 1, anchored: "thirty days" });
  });
});
