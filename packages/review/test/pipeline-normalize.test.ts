import { createScriptedGenerator } from "@clausewise/llm/testing";
import type { Playbook } from "@clausewise/playbook";
import { beforeAll, describe, expect, it } from "vitest";
import { reviewContract } from "../src/pipeline.js";
import type { Clause, RuleCheck, RuleResult } from "../src/types.js";
import {
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
