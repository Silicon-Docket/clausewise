import { createScriptedGenerator } from "@clausewise/llm/testing";
import type { Playbook, Rule } from "@clausewise/playbook";
import { beforeAll, describe, expect, it } from "vitest";
import { reviewContract } from "../src/pipeline.js";
import type { Clause, RuleCheck, RuleResult } from "../src/types.js";
import {
  buildDocx,
  clausesOf,
  compliantAnswer,
  fixture,
  idOf,
  loadPlaybook,
  onlyRules,
  viewDocx,
} from "./pipeline-support.js";

const input = fixture("nda-aggressive.docx");
const base = loadPlaybook();

function playbookWith(required: boolean): Playbook {
  const single = onlyRules(base, "term");
  return { ...single, rules: single.rules.map((rule) => ({ ...rule, required })) };
}

async function review(required: boolean, answer: RuleCheck) {
  return reviewContract(
    { docx: input, playbook: playbookWith(required) },
    createScriptedGenerator(() => answer),
  );
}

async function single(required: boolean, answer: RuleCheck): Promise<RuleResult> {
  const { report } = await review(required, answer);
  const [only] = report.results;
  if (only === undefined) throw new Error("no result");
  return only;
}

const GENERIC_DEVIATION = /does not meet the playbook standard for "Duration of confidentiality/;
const GENERIC_MISSING = /has no clause on "Duration of confidentiality obligations"/;

const edit = { clauseId: "c7", quote: "perpetual", replacement: "limited" };

describe("status normalization", () => {
  const cases: {
    name: string;
    required: boolean;
    answer: Partial<RuleCheck>;
    expected: Partial<RuleResult>;
    explanation?: RegExp;
  }[] = [
    {
      name: "a missing clause on a rule that is not required is not applicable",
      required: false,
      answer: {
        status: "missing",
        explanation: "No clause covers it.",
        comment: "Add one.",
        suggestedClause: "The parties agree.",
      },
      expected: {
        status: "not_applicable",
        comment: "",
        suggestedClause: null,
        explanation: "No clause covers it.",
        edit: { kind: "none" },
      },
    },
    {
      name: "a clause the model calls not applicable on a required rule is missing",
      required: true,
      answer: { status: "not_applicable", explanation: "No clause covers it." },
      expected: { status: "missing", explanation: "No clause covers it.", suggestedClause: null },
    },
    {
      name: "a required rule that is not applicable with no reason gets a generic one",
      required: true,
      answer: { status: "not_applicable", explanation: "  " },
      expected: { status: "missing" },
      explanation: GENERIC_MISSING,
    },
    {
      name: "not applicable stays when the rule is not required",
      required: false,
      answer: { status: "not_applicable", explanation: "Nothing to check." },
      expected: { status: "not_applicable", explanation: "Nothing to check." },
    },
    {
      name: "missing stays when the rule is required, with its suggested clause",
      required: true,
      answer: { status: "missing", explanation: "Nothing.", suggestedClause: " New wording. " },
      expected: { status: "missing", suggestedClause: "New wording." },
    },
    {
      name: "a deviation stays a deviation on a rule that is not required",
      required: false,
      answer: { status: "deviation", explanation: "Too long.", clauseIds: ["c7"] },
      expected: { status: "deviation", clauseIds: ["c7"], clauseNumbers: ["3.1"] },
    },
    {
      name: "a compliant result carries no comment, edit or suggested clause",
      required: true,
      answer: {
        status: "compliant",
        explanation: "At the fallback.",
        comment: "Looks fine.",
        edit,
        suggestedClause: "Unwanted.",
      },
      expected: {
        status: "compliant",
        explanation: "At the fallback.",
        comment: "",
        edit: { kind: "none" },
        suggestedClause: null,
      },
    },
    {
      name: "a not applicable result carries no comment, edit or suggested clause",
      required: false,
      answer: {
        status: "not_applicable",
        explanation: "Nothing.",
        comment: "Note.",
        edit,
        suggestedClause: "Unwanted.",
      },
      expected: {
        status: "not_applicable",
        comment: "",
        edit: { kind: "none" },
        suggestedClause: null,
      },
    },
    {
      name: "a deviation keeps no suggested clause",
      required: true,
      answer: { status: "deviation", explanation: "Too long.", suggestedClause: "Unwanted." },
      expected: { status: "deviation", suggestedClause: null },
    },
    {
      name: "a missing result keeps no edit and drops a blank suggested clause",
      required: true,
      answer: { status: "missing", explanation: "Nothing.", edit, suggestedClause: " \n " },
      expected: { status: "missing", edit: { kind: "none" }, suggestedClause: null },
    },
    {
      name: "a deviation with no explanation gets a generic one",
      required: true,
      answer: { status: "deviation", explanation: " \n " },
      expected: { status: "deviation" },
      explanation: GENERIC_DEVIATION,
    },
    {
      name: "a missing result with no explanation gets a generic one",
      required: true,
      answer: { status: "missing", explanation: "" },
      expected: { status: "missing" },
      explanation: GENERIC_MISSING,
    },
    {
      name: "a compliant result may have no explanation",
      required: true,
      answer: { status: "compliant", explanation: "" },
      expected: { status: "compliant", explanation: "" },
    },
    {
      name: "the model's explanation and comment are trimmed",
      required: true,
      answer: { status: "deviation", explanation: "  Too long.\n", comment: "\n Shorten it. " },
      expected: { status: "deviation", explanation: "Too long.", comment: "Shorten it." },
    },
  ];

  it.each(cases)("$name", async ({ required, answer, expected, explanation }) => {
    const result = await single(required, compliantAnswer(answer));
    expect(result).toMatchObject(expected);
    if (explanation !== undefined) expect(result.explanation).toMatch(explanation);
  });
});

describe("clause id normalization", () => {
  let clauses: Clause[];
  beforeAll(async () => {
    clauses = await clausesOf(input);
  });

  it("keeps only ids that exist in the document, once each, and numbers the ones that have one", async () => {
    const ids = [idOf(clauses, "3.1"), "c999", idOf(clauses, "1.1"), "c3", "", "C7", "c1"];
    const result = await single(
      true,
      compliantAnswer({ status: "deviation", explanation: "Too long.", clauseIds: ids }),
    );
    // c1 is the document's first paragraph and carries no number.
    expect(result.clauseIds).toEqual(["c7", "c3", "c1"]);
    expect(result.clauseNumbers).toEqual(["3.1", "1.1"]);
  });

  it("returns no ids when none of them exists", async () => {
    const result = await single(
      true,
      compliantAnswer({ status: "deviation", explanation: "Too long.", clauseIds: ["c0", "x"] }),
    );
    expect(result).toMatchObject({ clauseIds: [], clauseNumbers: [] });
  });
});

describe("clause references the model writes in its own way", () => {
  // In the aggressive NDA the term clause is c7 and carries the number 3.1.
  const deviation = (clauseIds: string[], extra: Partial<RuleCheck> = {}): RuleCheck =>
    compliantAnswer({ status: "deviation", explanation: "Too long.", clauseIds, ...extra });

  it.each([
    "c7",
    "[c7]",
    "C7",
    " c7 ",
    "c7.",
    "(c7)",
    "c7,",
    "clause c7",
    "Clause C7:",
    "[Clause c7]",
    "`c7`",
    "**c7**",
    "\tc7\n",
  ])("reads %j as the clause c7", async (raw) => {
    const result = await single(true, deviation([raw]));
    expect(result).toMatchObject({ clauseIds: ["c7"], clauseNumbers: ["3.1"] });
  });

  it.each([
    "3.1",
    "3.1.",
    "[3.1]",
    " 3.1 ",
    "Clause 3.1",
    "clause 3.1,",
    "Section 3.1",
    "section 3.1.",
    "\u00a7 3.1",
    "\u00a73.1",
  ])("reads the clause number %j as the one clause that has it", async (raw) => {
    const result = await single(true, deviation([raw]));
    expect(result).toMatchObject({ clauseIds: ["c7"], clauseNumbers: ["3.1"] });
  });

  it.each([
    "c07",
    "c0",
    "c",
    "c7x",
    "xc7",
    "see c7",
    "c7 and c3",
    "c7 c3",
    "c999",
    "c1234567",
    "",
    "  ",
    "clause",
    "7",
    "3",
    "3.9",
    "c7".padStart(200, " "),
    `${"1.".repeat(100)}1`,
  ])("drops %j, which names no one clause", async (raw) => {
    const result = await single(true, deviation([raw]));
    expect(result).toMatchObject({ clauseIds: [], clauseNumbers: [] });
  });

  it("does not spend time on a reference that is a megabyte of padding", async () => {
    const started = performance.now();
    const result = await single(
      true,
      deviation([
        `${" ".repeat(1_000_000)}x`,
        `c7${" ".repeat(1_000_000)}x`,
        `${"1.".repeat(500_000)}x`,
      ]),
    );
    expect(result.clauseIds).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("counts a clause once however it was written", async () => {
    const result = await single(true, deviation(["c7", "[c7]", "3.1", "C7.", "c3"]));
    expect(result.clauseIds).toEqual(["c7", "c3"]);
    expect(result.clauseNumbers).toEqual(["3.1", "1.1"]);
  });

  it("drops a number that two clauses carry", async () => {
    const docx = await buildDocx([
      { text: "This Agreement is made between Acme Inc and Beta LLC to govern what they share." },
      { text: "2.1 The obligations in this clause are perpetual and shall continue indefinitely." },
      { text: "2.1 The recipient shall return every copy of the information when asked to." },
      { text: "2.2 Each party shall bear its own costs of performing its duties under this deal." },
    ]);
    const asked = async (ref: string) => {
      const { report } = await reviewContract(
        { docx, playbook: playbookWith(true) },
        createScriptedGenerator(() => deviation([ref])),
      );
      return report.results[0]?.clauseIds;
    };
    expect(await asked("2.1")).toEqual([]);
    expect(await asked("2.2")).toEqual(["c4"]);
    expect(await asked("[c3]")).toEqual(["c3"]);
  });

  it("anchors the comment on the clause the model meant, written however it was", async () => {
    const { redlined } = await review(true, deviation(["[c7]"], { comment: "Fix the term." }));
    const [comment] = (await viewDocx(redlined)).comments;
    expect(comment?.paragraph).toBe(10);
    expect(comment?.anchored).toMatch(/^3\.1 Recipient's obligations/);
  });

  it.each(["[c7]", "C7", " c7 ", "c7.", "3.1", "Clause 3.1"])(
    "applies an edit whose clause is written %j",
    async (raw) => {
      const { report, redlined } = await review(
        true,
        deviation([], {
          edit: {
            clauseId: raw,
            quote: "perpetual and shall continue",
            replacement: "end after three years",
          },
        }),
      );
      expect(report.results[0]?.edit).toMatchObject({
        kind: "applied",
        original: "perpetual and shall continue",
      });
      const view = await viewDocx(redlined);
      expect(view.paragraphs[10]?.tracked).toBe(true);
      expect(view.paragraphs[10]?.rejected).toBe((await viewDocx(input)).paragraphs[10]?.accepted);
    },
  );

  it("still refuses an edit whose clause is not one clause, and keeps what the model wrote", async () => {
    for (const raw of ["c99", "9.9", "see c7", ""]) {
      const { report } = await review(
        true,
        deviation(["c7"], { edit: { clauseId: raw, quote: "perpetual", replacement: "limited" } }),
      );
      expect(report.results[0]?.edit).toEqual({
        kind: "comment-only",
        proposed: { clauseId: raw, quote: "perpetual", replacement: "limited" },
        reason: "the clause id does not match any clause in the document",
      });
    }
  });

  it("still refuses a quote that is not in the clause the model named", async () => {
    // c3 is clause 1.1. The leniency about how a clause is written never reaches into another.
    const { report } = await review(
      true,
      deviation(["c7"], {
        edit: { clauseId: "[c3]", quote: "perpetual and shall continue", replacement: "x" },
      }),
    );
    expect(report.results[0]?.edit).toMatchObject({ kind: "comment-only" });
  });
});

describe("status policy for rules that forbid something", () => {
  const forbid = (extra: Partial<Rule> = {}): Playbook => {
    const single = onlyRules(base, "term");
    return {
      ...single,
      rules: single.rules.map((rule) => ({
        ...rule,
        kind: "absence" as const,
        required: false,
        ...extra,
      })),
    };
  };
  const run = async (playbook: Playbook, answer: RuleCheck): Promise<RuleResult> => {
    const { report } = await reviewContract(
      { docx: input, playbook },
      createScriptedGenerator(() => answer),
    );
    return report.results[0]!;
  };

  it("passes with no clause named, because there is nothing to name", async () => {
    const result = await run(
      forbid(),
      compliantAnswer({ clauseIds: [], explanation: "The agreement has no such clause." }),
    );
    expect(result).toMatchObject({ status: "compliant", clauseIds: [] });
    expect(result.error).toBeUndefined();
  });

  it.each(["missing", "not_applicable"] as const)(
    "settles an answer of %s to compliant, with no comment or suggested clause",
    async (status) => {
      const { report, redlined } = await reviewContract(
        { docx: input, playbook: forbid() },
        createScriptedGenerator(() =>
          compliantAnswer({
            status,
            clauseIds: [],
            explanation: "Nothing like it is in the contract.",
            comment: "Add one.",
            suggestedClause: "Neither party shall solicit.",
          }),
        ),
      );
      expect(report.results[0]).toMatchObject({
        status: "compliant",
        explanation: "Nothing like it is in the contract.",
        comment: "",
        suggestedClause: null,
        edit: { kind: "none" },
      });
      expect(report.counts).toMatchObject({ compliant: 1, missing: 0, not_applicable: 0 });
      expect(report.open).toEqual({ high: 0, medium: 0, low: 0 });
      expect((await viewDocx(redlined)).comments).toEqual([]);
    },
  );

  it("ignores required, which a hand-built playbook can still set", async () => {
    const result = await run(
      forbid({ required: true }),
      compliantAnswer({ status: "missing", clauseIds: [], explanation: "None." }),
    );
    expect(result.status).toBe("compliant");
  });

  it("still reports a deviation when the contract has the forbidden clause", async () => {
    const result = await run(
      forbid(),
      compliantAnswer({ status: "deviation", clauseIds: ["c7"], explanation: "It is there." }),
    );
    expect(result).toMatchObject({ status: "deviation", clauseNumbers: ["3.1"] });
  });

  it("reads kind presence like a rule with no kind", async () => {
    const presence = onlyRules(base, "term");
    const explicit: Playbook = {
      ...presence,
      rules: presence.rules.map((rule) => ({ ...rule, kind: "presence" as const })),
    };
    const result = await run(explicit, compliantAnswer({ clauseIds: [] }));
    expect(result.status).toBe("error");
  });
});

describe("a compliant answer for a rule that asks for a clause", () => {
  const MESSAGE =
    "The model reported this rule as met without pointing at a clause, so it could not be checked.";

  it.each([
    ["no clause named", []],
    ["only clauses that do not exist", ["c999", "nope", ""]],
  ])("becomes an error when it has %s", async (_name, clauseIds) => {
    for (const required of [true, false]) {
      const result = await single(required, compliantAnswer({ clauseIds }));
      expect(result).toMatchObject({
        status: "error",
        error: MESSAGE,
        clauseIds: [],
        explanation: "",
        edit: { kind: "none" },
      });
    }
  });

  it("is counted as an error, not as a pass, and gets no comment", async () => {
    const { report, redlined } = await review(true, compliantAnswer({ clauseIds: [] }));
    expect(report.counts).toMatchObject({ error: 1, compliant: 0 });
    expect(report.open).toEqual({ high: 0, medium: 0, low: 0 });
    expect((await viewDocx(redlined)).comments).toEqual([]);
    expect(Buffer.from(redlined).equals(Buffer.from(input))).toBe(true);
  });

  it("is a pass once it names a clause, even in another form", async () => {
    for (const ref of ["c7", "[C7]", "3.1"]) {
      const result = await single(true, compliantAnswer({ clauseIds: [ref] }));
      expect(result).toMatchObject({ status: "compliant", clauseIds: ["c7"] });
    }
  });

  it("does not touch the other statuses", async () => {
    expect((await single(true, compliantAnswer({ status: "missing", clauseIds: [] }))).status).toBe(
      "missing",
    );
    expect(
      (await single(false, compliantAnswer({ status: "not_applicable", clauseIds: [] }))).status,
    ).toBe("not_applicable");
    expect(
      (await single(true, compliantAnswer({ status: "not_applicable", clauseIds: [] }))).status,
    ).toBe("missing");
    expect(
      (await single(true, compliantAnswer({ status: "deviation", clauseIds: [] }))).status,
    ).toBe("deviation");
  });
});

describe("comment text", () => {
  it("falls back to the explanation when the model wrote no comment", async () => {
    const { redlined } = await review(
      true,
      compliantAnswer({
        status: "deviation",
        explanation: "The term never ends.",
        comment: "",
        clauseIds: ["c7"],
      }),
    );
    const { comments } = await viewDocx(redlined);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.text).toBe(
      "[HIGH] Duration of confidentiality obligations\nThe term never ends.",
    );
  });

  it("writes no comment for compliant or not applicable results", async () => {
    for (const status of ["compliant", "not_applicable"] as const) {
      const { redlined } = await review(false, compliantAnswer({ status, comment: "ignored" }));
      expect((await viewDocx(redlined)).comments).toEqual([]);
    }
  });

  it("collapses a title that spans lines into one", async () => {
    const term = onlyRules(base, "term");
    const playbook: Playbook = {
      ...term,
      rules: term.rules.map((rule) => ({ ...rule, title: "Duration of\n  obligations\n" })),
    };
    const { redlined } = await reviewContract(
      { docx: input, playbook },
      createScriptedGenerator(() =>
        compliantAnswer({ status: "deviation", explanation: "Too long.", comment: "Shorten." }),
      ),
    );
    expect((await viewDocx(redlined)).comments[0]?.text).toBe(
      "[HIGH] Duration of obligations\nShorten.",
    );
  });
});
