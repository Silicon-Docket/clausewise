import { createScriptedGenerator } from "@clausewise/llm/testing";
import type { Playbook } from "@clausewise/playbook";
import { beforeAll, describe, expect, it } from "vitest";
import { reviewContract } from "../src/pipeline.js";
import { renderMarkdown } from "../src/report.js";
import type { Clause, ReviewReport, RuleCheck, RuleResult } from "../src/types.js";
import {
  buildDocx,
  clausesOf,
  compliantAnswer,
  loadPlaybook,
  onlyRules,
  viewDocx,
} from "./pipeline-support.js";

// Written as code points because an editor or formatter may turn the escapes into the characters.
const LEFT_QUOTE = String.fromCharCode(0x201c);
const RIGHT_QUOTE = String.fromCharCode(0x201d);
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

const SUPPLY =
  "1.1 The Supplier shall deliver the Goods within thirty days of each order placed by the Customer, and risk in the Goods passes to the Customer on delivery.";
const SECRECY =
  "Customer shall not disclose Confidential Information to any third party without the prior written consent of Supplier in each case, whether in writing or orally.";
const TERMINATION =
  "The Supplier may terminate this Agreement on written notice if the Customer fails to pay any undisputed invoice within thirty days after the due date for payment.";

const SECRECY_WORDS = "Customer shall not disclose Confidential Information";
const TERMINATION_WORDS = "The Supplier may terminate this Agreement";

const base = loadPlaybook();
const term = onlyRules(base, "term");
let docx: Uint8Array;
let ids: { supply: string; secrecy: string; termination: string };

beforeAll(async () => {
  docx = await buildDocx([{ text: SUPPLY }, { text: SECRECY }, { text: TERMINATION }]);
  const clauses = await clausesOf(docx);
  // The tests below depend on one numbered clause followed by two clauses without a number.
  expect(clauses.map((c) => c.number)).toEqual(["1.1", undefined, undefined]);
  ids = { supply: clauses[0]!.id, secrecy: clauses[1]!.id, termination: clauses[2]!.id };
});

async function review(
  answer: Partial<RuleCheck>,
  playbook: Playbook = term,
  contract: Uint8Array = docx,
) {
  const { report, redlined } = await reviewContract(
    { docx: contract, playbook },
    createScriptedGenerator(() => compliantAnswer({ status: "deviation", ...answer })),
  );
  return { report, redlined, result: report.results[0] as RuleResult };
}

describe("the clauses a finding refers to, named for a lawyer", () => {
  it("gives the opening words of each cited clause that has no number, in the order cited", async () => {
    const { result } = await review({
      clauseIds: [ids.termination, ids.supply, ids.secrecy],
    });
    expect(result.clauseIds).toEqual([ids.termination, ids.supply, ids.secrecy]);
    expect(result.clauseNumbers).toEqual(["1.1"]);
    expect(result.clauseExcerpts).toEqual([TERMINATION_WORDS, SECRECY_WORDS]);
  });

  it("leaves the field out when every cited clause has a number", async () => {
    const { result } = await review({ clauseIds: [ids.supply] });
    expect(result.clauseNumbers).toEqual(["1.1"]);
    expect(result).not.toHaveProperty("clauseExcerpts");
  });

  it("leaves the field out for a finding that cites nothing, and for a rule that errored", async () => {
    const missing = await review({ status: "missing", clauseIds: [] });
    expect(missing.result).not.toHaveProperty("clauseExcerpts");
    const failed = await reviewContract(
      { docx, playbook: term },
      createScriptedGenerator(() => {
        throw new Error("down");
      }),
    );
    expect(failed.report.results[0]).toMatchObject({ status: "error", clauseIds: [] });
    expect(failed.report.results[0]).not.toHaveProperty("clauseExcerpts");
  });

  it("names the clause of a compliant result too", async () => {
    const { result } = await review({ status: "compliant", clauseIds: [ids.secrecy] });
    expect(result).toMatchObject({ status: "compliant", clauseExcerpts: [SECRECY_WORDS] });
  });

  it("ignores ids that name no clause, and names a clause once per mention that resolves", async () => {
    const { result } = await review({ clauseIds: ["c99", ids.secrecy, ids.secrecy.toUpperCase()] });
    expect(result.clauseIds).toEqual([ids.secrecy]);
    expect(result.clauseExcerpts).toEqual([SECRECY_WORDS]);
  });

  it("feeds the report, which then names the clause and never its id", async () => {
    const { report } = await review({ clauseIds: [ids.secrecy], explanation: "Too strict." });
    const markdown = renderMarkdown(report);
    expect(markdown).toContain(`The clause beginning "${SECRECY_WORDS}".`);
    expect(markdown).not.toContain(ids.secrecy);
  });
});

describe("the opening words of a clause", () => {
  const first = async (text: string, rest: string[] = []) => {
    const contract = await buildDocx([
      { text: SUPPLY },
      { text },
      ...rest.map((line) => ({ text: line })),
    ]);
    const clauses = await clausesOf(contract);
    const clause = clauses.find((c: Clause) => c.text.startsWith(text.slice(0, 5)));
    const { result } = await review({ clauseIds: [clause!.id] }, term, contract);
    return { result, clause };
  };

  it("are the first six words", async () => {
    const { result } = await first(`${SECRECY} ${SECRECY}`);
    expect(result.clauseExcerpts).toEqual([SECRECY_WORDS]);
    expect(SECRECY_WORDS.split(" ")).toHaveLength(6);
  });

  it("are all of the words when a clause has fewer than six", async () => {
    const { result } = await first(
      `Time is of the essence. ${"The parties agree to everything stated above. ".repeat(4)}`,
    );
    expect(result.clauseExcerpts?.[0]?.split(" ").length).toBeLessThanOrEqual(6);
  });

  it("are on one line, whatever line breaks, tabs and spaces the clause holds", async () => {
    const { result } = await first(
      `Customer\tshall\u000bnot   disclose\u0007 Confidential Information to anybody at all, ever, under any terms.`,
    );
    expect(result.clauseExcerpts).toEqual([SECRECY_WORDS]);
  });

  it("show double quotation marks as single ones, so they can be put between double ones", async () => {
    const { result } = await first(
      `${LEFT_QUOTE}Confidential Information${RIGHT_QUOTE} means all information, in any form, that the Supplier discloses to the Customer.`,
    );
    expect(result.clauseExcerpts).toEqual(["'Confidential Information' means all information, in"]);
    const { result: straight } = await first(
      '"Confidential Information" means all information, in any form, that the Supplier discloses to the Customer.',
    );
    expect(straight.clauseExcerpts).toEqual([
      "'Confidential Information' means all information, in",
    ]);
  });

  it("are cut at 80 characters, with no whole word of unbounded length", async () => {
    const { result } = await first(
      `${"x".repeat(300)} and then some more words that follow it in the clause, to make it long enough.`,
    );
    const [excerpt] = result.clauseExcerpts ?? [];
    expect(excerpt).toBe("x".repeat(80));
  });

  it("are cut at 80 characters in a language written without spaces", async () => {
    const text = "\u7532\u65b9\u4e0d\u5f97\u62ab\u9732\u4fdd\u5bc6\u4fe1\u606f".repeat(30);
    const { result } = await first(text);
    const [excerpt] = result.clauseExcerpts ?? [];
    expect([...(excerpt ?? "")]).toHaveLength(80);
  });
});

describe("a clause id in what the model wrote", () => {
  const mention = async (
    fields: Partial<Pick<RuleCheck, "explanation" | "comment" | "suggestedClause" | "edit">>,
    status: RuleCheck["status"] = "deviation",
  ) => {
    const { report, redlined, result } = await review({
      status,
      clauseIds: [ids.supply],
      ...fields,
    });
    const comments = (await viewDocx(redlined)).comments;
    return { report, result, comment: comments[0]?.text ?? "", markdown: renderMarkdown(report) };
  };

  it("becomes the clause number where the contract gives one, in the report and the Word comment", async () => {
    const { result, comment, markdown } = await mention({
      explanation: `Compare [${ids.supply}] with this.`,
      comment: `Fix clause ${ids.supply} first.`,
    });
    expect(result.explanation).toBe("Compare (clause 1.1) with this.");
    expect(result.comment).toBe("Fix clause 1.1 first.");
    expect(comment).toBe("[HIGH] Duration of confidentiality obligations\nFix clause 1.1 first.");
    expect(markdown).toContain("Compare (clause 1.1) with this.");
    expect(markdown).not.toContain(ids.supply);
  });

  it("becomes the clause's opening words in quotation marks where it has no number", async () => {
    const { result, comment } = await mention({
      explanation: `As in clause ${ids.secrecy}.`,
      comment: `Look at [${ids.termination}], then ${ids.secrecy.toUpperCase()} is next to clause ${ids.secrecy}.`,
    });
    expect(result.explanation).toBe(`As in the clause beginning "${SECRECY_WORDS}".`);
    expect(result.comment).toBe(
      `Look at (the clause beginning "${TERMINATION_WORDS}"), then ${ids.secrecy.toUpperCase()} is next to the clause beginning "${SECRECY_WORDS}".`,
    );
    expect(comment).toContain(result.comment);
  });

  it("keeps a capital at the start of a sentence", async () => {
    const { result } = await mention({
      explanation: `Clause ${ids.secrecy} is too strict. The clause ${ids.termination} is silent.`,
    });
    expect(result.explanation).toBe(
      `The clause beginning "${SECRECY_WORDS}" is too strict. The clause beginning "${TERMINATION_WORDS}" is silent.`,
    );
  });

  it("names several clauses at once", async () => {
    const { result } = await mention({
      explanation: `See clauses ${ids.supply}, ${ids.secrecy} and ${ids.termination}, or [${ids.supply}, ${ids.secrecy}].`,
    });
    expect(result.explanation).toBe(
      `See clause 1.1 and the clauses beginning "${SECRECY_WORDS}", "${TERMINATION_WORDS}", or (clause 1.1 and the clause beginning "${SECRECY_WORDS}").`,
    );
  });

  it("is dropped when it names no clause of the document", async () => {
    const { result } = await mention({
      explanation: "Too long [c99] and worse [ c98, c97 ]. See clause c99 and the clause c98.",
      comment: "Shorten it [c99].",
    });
    expect(result.explanation).toBe("Too long and worse. See a clause and a clause.");
    expect(result.comment).toBe("Shorten it.");
  });

  it("is replaced in a suggested clause too", async () => {
    const { result, comment } = await mention(
      { suggestedClause: `The Customer shall comply with clause ${ids.supply}.` },
      "missing",
    );
    expect(result.suggestedClause).toBe("The Customer shall comply with clause 1.1.");
    expect(comment).toContain("Suggested clause:\nThe Customer shall comply with clause 1.1.");
    expect(comment).not.toContain(ids.supply);
  });

  it("is replaced in the fields the model left as text, and not in the edit it proposed", async () => {
    const { result } = await mention({
      explanation: `See clause ${ids.supply}.`,
      edit: { clauseId: ids.supply, quote: "thirty days", replacement: "sixty days" },
    });
    expect(result.explanation).toBe("See clause 1.1.");
    expect(result.edit).toMatchObject({ kind: "applied", original: "thirty days" });
  });

  it("is left alone when it is not written as a bracketed id or as 'clause' and an id", async () => {
    const untouched = [
      `See Schedule ${ids.supply} and abc${ids.supply} and ${ids.supply}x.`,
      "See clause c07, clause c, clause cat and [c1x] and [c].",
      "Use form C-3 and clause 3.1.",
      `The ${ids.supply} form.`,
    ];
    for (const explanation of untouched) {
      expect((await mention({ explanation })).result.explanation).toBe(explanation);
    }
  });

  it("is not a reason to change a finding that has no id in it", async () => {
    const { result } = await mention({ explanation: "Nothing to see.", comment: "Shorten it." });
    expect(result).toMatchObject({ explanation: "Nothing to see.", comment: "Shorten it." });
  });

  it("is dealt with in time on text built to stall a pattern", async () => {
    const n = 300_000;
    const shapes = [
      "[".repeat(n),
      "[ ".repeat(n / 2),
      `clause${" ".repeat(n)}x`,
      "clause ".repeat(n / 7),
      "the ".repeat(n / 4),
      `clause ${ids.supply}${" and ".concat(ids.supply).repeat(n / 8)}`,
      `clause ${ids.supply}${" ".repeat(n)}x`,
      `[${ids.supply}${" ".repeat(n)}`,
    ];
    for (const explanation of shapes) {
      const started = performance.now();
      const { result } = await review({ explanation, clauseIds: [ids.supply] });
      expect(result.status).toBe("deviation");
      expect(performance.now() - started).toBeLessThan(3000);
    }
  });
});

describe("a rule title with nothing in it", () => {
  const untitled = (title: string): Playbook => ({
    ...term,
    rules: term.rules.map((rule) => ({ ...rule, title })),
  });

  it.each(["", "  ", `${ZERO_WIDTH_SPACE}${ZERO_WIDTH_SPACE}`])(
    "is replaced by the rule id in the Word comment and the explanation (%j)",
    async (title) => {
      const { result, redlined } = await review(
        { explanation: "", clauseIds: [ids.supply] },
        untitled(title),
      );
      expect(result.explanation).toBe(
        'The contract does not meet the playbook standard for "term".',
      );
      expect((await viewDocx(redlined)).comments[0]?.text).toBe(
        '[HIGH] term\nThe contract does not meet the playbook standard for "term".',
      );
    },
  );

  it("is left alone when it has something in it", async () => {
    const { redlined } = await review({ comment: "Shorten it." }, untitled("  Term\nof deal "));
    expect((await viewDocx(redlined)).comments[0]?.text).toBe("[HIGH] Term of deal\nShorten it.");
  });
});

describe("the words of a finding in the report", () => {
  it("never include an id, whichever clauses it cites", async () => {
    const { report } = await review({
      clauseIds: [ids.supply, ids.secrecy, ids.termination],
      explanation: `See [${ids.secrecy}] and clause ${ids.termination}.`,
      comment: `Check ${ids.supply}.`,
    });
    const json: ReviewReport = report;
    const markdown = renderMarkdown(json);
    for (const id of Object.values(ids)) {
      expect(markdown).not.toMatch(new RegExp(`\\b${id}\\b`));
    }
  });
});
