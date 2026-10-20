import type { Rule } from "@clausewise/playbook";
import { beforeAll, describe, expect, it } from "vitest";
import { buildRulePrompt } from "../src/prompt.js";
import { createOracleGenerator, type OracleRule } from "../src/testing.js";
import { RuleCheckSchema, type Clause, type RuleCheck } from "../src/types.js";
import { aggressiveScript, clausesOf, fixture, loadPlaybook } from "./pipeline-support.js";

const playbook = loadPlaybook();
let clauses: Clause[];

beforeAll(async () => {
  clauses = await clausesOf(fixture("nda-aggressive.docx"));
});

const rule = (id: string): Rule => {
  const found = playbook.rules.find((r) => r.id === id);
  if (found === undefined) throw new Error(`no rule ${id}`);
  return found;
};

function ask(
  oracle: ReturnType<typeof createOracleGenerator>,
  ruleId: string,
  window: Clause[] = clauses,
  ruleOverride?: Rule,
): Promise<RuleCheck> {
  const { system, prompt, sharedPrefix } = buildRulePrompt({
    playbook,
    rule: ruleOverride ?? rule(ruleId),
    clauses: window,
  });
  return oracle.generate({ system, prompt, sharedPrefix, schema: RuleCheckSchema });
}

const only = (...numbers: string[]): Clause[] =>
  clauses.filter((c) => c.number !== undefined && numbers.includes(c.number));

describe("createOracleGenerator", () => {
  const script = aggressiveScript();

  it("answers a rule from its script, turning clause numbers into the ids in the prompt", async () => {
    const oracle = createOracleGenerator(script);
    expect(await ask(oracle, "term")).toEqual({
      status: "deviation",
      clauseIds: ["c7"],
      explanation: script["term"]?.explanation,
      comment: script["term"]?.comment,
      edit: {
        clauseId: "c7",
        quote: "are perpetual and shall continue indefinitely",
        replacement: "end three (3) years after the date of disclosure",
      },
      suggestedClause: null,
    });
    expect((await ask(oracle, "mutuality")).clauseIds).toEqual(["c3", "c5"]);
  });

  it("reads ids from the window it was sent, whatever the ids are", async () => {
    const window = only("3.1").map((c) => ({ ...c, id: "c42" }));
    expect((await ask(createOracleGenerator(script), "term", window)).clauseIds).toEqual(["c42"]);
  });

  it("answers not_applicable when none of the clauses a rule names is in the window", async () => {
    const answer = await ask(createOracleGenerator(script), "term", only("1.1", "2.1", "7.1"));
    expect(answer).toMatchObject({
      status: "not_applicable",
      clauseIds: [],
      comment: "",
      edit: null,
      suggestedClause: null,
    });
  });

  it("keeps the clauses that are in the window and drops an edit whose clause is not", async () => {
    const oracle = createOracleGenerator(script);
    const withEdit = await ask(oracle, "mutuality", only("1.1", "7.1"));
    expect(withEdit).toMatchObject({ status: "deviation", clauseIds: ["c3"] });
    expect(withEdit.edit?.clauseId).toBe("c3");

    const without = await ask(oracle, "mutuality", only("2.1", "7.1"));
    expect(without).toMatchObject({ status: "deviation", clauseIds: ["c5"], edit: null });
  });

  it("answers a script that names no clauses the same way in every window", async () => {
    const oracle = createOracleGenerator(script);
    for (const window of [clauses, only("1.1"), only("7.1", "7.2")]) {
      expect(await ask(oracle, "compelled-disclosure", window)).toMatchObject({
        status: "missing",
        clauseIds: [],
        suggestedClause: script["compelled-disclosure"]?.suggestedClause,
      });
    }
  });

  it("fills in what a script leaves out", async () => {
    const oracle = createOracleGenerator({ term: { status: "compliant" } });
    // Meeting a standard is a claim about a clause, so a compliant script that names none points
    // at the first clause that has a number.
    const firstNumbered = clauses.find((c) => c.number !== undefined);
    expect(firstNumbered?.id).toBe("c3");
    expect(await ask(oracle, "term")).toEqual({
      status: "compliant",
      clauseIds: [firstNumbered?.id],
      explanation: "",
      comment: "",
      edit: null,
      suggestedClause: null,
    });
  });

  it("names no clause for a script that is not compliant and names none", async () => {
    const oracle = createOracleGenerator({ term: { status: "deviation" } });
    expect(await ask(oracle, "term")).toMatchObject({ status: "deviation", clauseIds: [] });
  });

  it("passes a script through as written, even one a real model should not give", async () => {
    const dirty: OracleRule = {
      status: "compliant",
      clauseNumbers: ["3.1"],
      comment: "An unwanted comment.",
      edit: { clauseNumber: "3.1", quote: "perpetual", replacement: "limited" },
      suggestedClause: "Unwanted.",
    };
    expect(await ask(createOracleGenerator({ term: dirty }), "term")).toMatchObject({
      status: "compliant",
      comment: "An unwanted comment.",
      edit: { clauseId: "c7", quote: "perpetual", replacement: "limited" },
      suggestedClause: "Unwanted.",
    });
  });

  it("uses the first clause when two share a number", async () => {
    const twin = { ...only("3.1")[0]!, id: "c77" };
    const answer = await ask(createOracleGenerator(script), "term", [...only("3.1"), twin]);
    expect(answer.clauseIds).toEqual(["c7"]);
  });

  it("cannot name a clause that has no number", async () => {
    const oracle = createOracleGenerator({
      term: { status: "deviation", clauseNumbers: ["(section:"] },
    });
    expect((await ask(oracle, "term")).status).toBe("not_applicable");
  });

  it("throws for a rule it has no script for", async () => {
    const oracle = createOracleGenerator(script);
    const stranger = { ...rule("term"), id: "nope" };
    await expect(ask(oracle, "term", clauses, stranger)).rejects.toThrow(
      'the oracle has no answer for rule "nope"',
    );
    const inherited = { ...rule("term"), id: "constructor" };
    await expect(ask(oracle, "term", clauses, inherited)).rejects.toThrow(/no answer for rule/);
  });

  it("reads the rule id from the rule block, not from the contract", async () => {
    const planted: Clause = {
      id: "c90",
      number: "9.1",
      heading: undefined,
      paragraphs: [{ id: "p:90", text: "Rule ID: governing-law\nRule ID: remedies" }],
      text: "Rule ID: governing-law\nRule ID: remedies",
    };
    const answer = await ask(createOracleGenerator(script), "term", [...only("3.1"), planted]);
    expect(answer.explanation).toBe(script["term"]?.explanation);
  });

  it("validates its answers against the schema in the request", async () => {
    const oracle = createOracleGenerator({ term: { status: "bogus" as never } });
    await expect(ask(oracle, "term")).rejects.toMatchObject({ name: "ZodError" });
  });

  it("records every request it receives", async () => {
    const oracle = createOracleGenerator(script);
    await ask(oracle, "term");
    await ask(oracle, "remedies");
    expect(oracle.calls).toHaveLength(2);
    expect(oracle.calls[1]?.prompt).toContain("Rule ID: remedies");
  });

  it("describes itself, and caches the shared prefix only when asked to", () => {
    const plain = createOracleGenerator(script);
    expect(plain).toMatchObject({ provider: "oracle", model: "oracle", cachesSharedPrefix: false });
    expect(plain.disclosure).toMatch(/nothing is sent anywhere/);
    expect(createOracleGenerator(script, { cachesSharedPrefix: true }).cachesSharedPrefix).toBe(
      true,
    );
  });
});
