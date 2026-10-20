import { ModelOutputError } from "@clausewise/llm";
import { createScriptedGenerator } from "@clausewise/llm/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { ReviewError } from "../src/errors.js";
import { contextFloor, reviewContract, windowReserve } from "../src/pipeline.js";
import { estimateTokens } from "../src/prompt.js";
import { createOracleGenerator, type OracleRule } from "../src/testing.js";
import type { Clause, ProgressEvent, ReviewReport, RuleCheck } from "../src/types.js";
import {
  aggressiveScript,
  budgetFor,
  byWindow,
  clausesOf,
  compliantAnswer,
  expectedWindows,
  firstClauseId,
  fixture,
  intercept,
  loadPlaybook,
  longContract,
  onlyRules,
  padded,
  ruleIdOf,
  viewDocx,
} from "./pipeline-support.js";

const playbook = loadPlaybook();
const DATE = new Date("2026-03-02T09:30:00Z");

// A context limit has to leave room for a clause or two, so the contract is padded until it splits.
let input: Uint8Array;
let clauses: Clause[];
let maxContextTokens: number;
let windows: Clause[][];
let whole: { report: ReviewReport; redlined: Uint8Array };

const review = (script: Record<string, OracleRule>, tokens = maxContextTokens) =>
  reviewContract({ docx: input, playbook }, createOracleGenerator(script), {
    maxContextTokens: tokens,
    date: DATE,
  });

beforeAll(async () => {
  input = await padded(fixture("nda-aggressive.docx"));
  clauses = await clausesOf(input);
  maxContextTokens = budgetFor(playbook, clauses, 3);
  windows = expectedWindows(playbook, clauses, maxContextTokens);
  whole = await reviewContract(
    { docx: input, playbook },
    createOracleGenerator(aggressiveScript()),
    {
      date: DATE,
    },
  );
});

describe("a contract reviewed in several windows", () => {
  it("is split into overlapping windows, each checked for every rule", async () => {
    const events: ProgressEvent[] = [];
    const oracle = createOracleGenerator(aggressiveScript());
    const { report } = await reviewContract({ docx: input, playbook }, oracle, {
      maxContextTokens,
      onProgress: (event) => events.push(event),
    });
    expect(windows.length).toBeGreaterThan(1);
    expect(report.stats.windows).toBe(windows.length);
    expect(oracle.calls).toHaveLength(playbook.rules.length * windows.length);
    expect(events[0]).toEqual({
      type: "start",
      rules: 10,
      clauses: clauses.length,
      windows: windows.length,
    });
    // One event per rule, not per window.
    expect(events.filter((e) => e.type === "rule")).toHaveLength(10);
  });

  it("keeps every prompt within the context budget and drops no clause", async () => {
    const oracle = createOracleGenerator(aggressiveScript());
    await reviewContract({ docx: input, playbook }, oracle, { maxContextTokens });
    for (const call of oracle.calls) {
      expect(estimateTokens(call.system) + estimateTokens(call.prompt)).toBeLessThanOrEqual(
        maxContextTokens,
      );
    }
    for (const clause of clauses) {
      expect(oracle.calls.some((call) => call.prompt.includes(clause.text))).toBe(true);
    }
  });

  it("reaches the same findings, edits and comments as one window", async () => {
    const split = await review(aggressiveScript());
    expect(split.report.results).toEqual(whole.report.results);
    expect(split.report.counts).toEqual(whole.report.counts);
    expect(await viewDocx(split.redlined)).toEqual(await viewDocx(whole.redlined));
  });

  it("finds a deviation that is only in a later window", async () => {
    const { report } = await review(aggressiveScript());
    const term = report.results.find((r) => r.ruleId === "term");
    expect(term).toMatchObject({
      status: "deviation",
      clauseNumbers: ["3.1"],
      edit: { kind: "applied", paragraphId: "p:10" },
    });
    const firstWindowWithIt = windows.findIndex((w) => w.some((c) => c.number === "3.1"));
    expect(firstWindowWithIt).toBeGreaterThan(0);
  });

  it("merges deviations from different windows into one result", async () => {
    const script = aggressiveScript();
    script["term"] = {
      status: "deviation",
      clauseNumbers: ["1.1", "7.1"],
      explanation: "Two clauses fall short.",
      comment: "Fix both.",
      edit: {
        clauseNumber: "7.1",
        quote: "the exclusive jurisdiction of the courts of Singapore",
        replacement: "the non-exclusive jurisdiction of the courts of Delaware",
      },
    };
    const first = windows.findIndex((w) => w.some((c) => c.number === "1.1"));
    const last = windows.findLastIndex((w) => w.some((c) => c.number === "7.1"));
    expect(last).toBeGreaterThan(first);

    const { report } = await review(script);
    const term = report.results.find((r) => r.ruleId === "term");
    expect(term).toMatchObject({
      status: "deviation",
      clauseNumbers: ["1.1", "7.1"],
      explanation: "Two clauses fall short.",
      edit: { kind: "applied", paragraphId: "p:20" },
    });
  });

  it("lets a window that finds the clause compliant outweigh the ones that cannot see it", async () => {
    const script = aggressiveScript();
    script["exclusions"] = {
      status: "compliant",
      clauseNumbers: ["2.1"],
      explanation: "All four exclusions are present.",
    };
    const { report } = await review(script);
    expect(report.results.find((r) => r.ruleId === "exclusions")).toMatchObject({
      status: "compliant",
      clauseNumbers: ["2.1"],
      explanation: "All four exclusions are present.",
    });
  });

  it("reports a required rule that no window covers as missing", async () => {
    const script = aggressiveScript();
    script["exclusions"] = { status: "deviation", clauseNumbers: ["9.9"] };
    script["return-or-destroy"] = { status: "deviation", clauseNumbers: ["9.9"] };
    const { report } = await review(script);
    expect(report.results.find((r) => r.ruleId === "exclusions")).toMatchObject({
      status: "missing",
      clauseIds: [],
    });
    // Return or destroy is not required, so no clause means nothing to report.
    expect(report.results.find((r) => r.ruleId === "return-or-destroy")?.status).toBe(
      "not_applicable",
    );
  });

  it("keeps the suggested clause of a missing result across windows", async () => {
    const { report } = await review(aggressiveScript());
    expect(report.results.find((r) => r.ruleId === "compelled-disclosure")).toMatchObject({
      status: "missing",
      suggestedClause: aggressiveScript()["compelled-disclosure"]?.suggestedClause,
    });
  });
});

describe("a window that fails", () => {
  const failWindowStartingAt = (clauseId: string, ruleId: string) =>
    intercept(createOracleGenerator(aggressiveScript()), (request) => {
      if (ruleIdOf(request) === ruleId && firstClauseId(request) === clauseId) {
        throw new ModelOutputError("Singapore is not in the schema");
      }
    });

  const windowOf = (number: string): number =>
    windows.findIndex((w) => w.some((c) => c.number === number));
  const firstIdOf = (window: number): string => windows[window]![0]!.id;

  it("makes the rule an error when no other window found a deviation", async () => {
    const script = aggressiveScript();
    script["exclusions"] = { status: "compliant", clauseNumbers: ["1.2"], explanation: "Fine." };
    // The window that holds 1.2 is not the one that fails, so the finding is "compliant".
    const failing = firstIdOf(windows.length - 1);
    const generator = intercept(createOracleGenerator(script), (request) => {
      if (ruleIdOf(request) === "exclusions" && firstClauseId(request) === failing) {
        throw new ModelOutputError("bad");
      }
    });
    const { report } = await reviewContract({ docx: input, playbook }, generator, {
      maxContextTokens,
    });
    const exclusions = report.results.find((r) => r.ruleId === "exclusions");
    expect(exclusions?.status).toBe("error");
    expect(exclusions?.error).toBe(
      `1 of ${windows.length} parts of the contract could not be checked, and none of the others showed a deviation. ` +
        "The model did not return an answer in the expected format for this rule.",
    );
    expect(report.counts.error).toBe(1);
  });

  it("makes a missing result an error too, since the failed window might hold the clause", async () => {
    const generator = failWindowStartingAt(firstIdOf(1), "compelled-disclosure");
    const { report } = await reviewContract({ docx: input, playbook }, generator, {
      maxContextTokens,
    });
    expect(report.results.find((r) => r.ruleId === "compelled-disclosure")?.status).toBe("error");
  });

  it("still reports a deviation another window found", async () => {
    const holding = windowOf("3.1");
    const sees = windows.flatMap((w, i) => (w.some((c) => c.number === "3.1") ? [i] : []));
    expect(sees.length).toBeGreaterThan(1);
    const generator = failWindowStartingAt(firstIdOf(holding), "term");
    const { report, redlined } = await reviewContract({ docx: input, playbook }, generator, {
      maxContextTokens,
    });
    const term = report.results.find((r) => r.ruleId === "term");
    expect(term).toMatchObject({
      status: "deviation",
      edit: { kind: "applied", original: "perpetual and shall continue indefinitely" },
    });
    expect(term?.error).toBeUndefined();
    expect(report.counts.error).toBe(0);
    expect((await viewDocx(redlined)).comments).toHaveLength(10);
  });

  it("makes the rule an error when every window fails, and never repeats contract text", async () => {
    const generator = intercept(createOracleGenerator(aggressiveScript()), (request) => {
      if (ruleIdOf(request) === "term") throw new Error("could not parse: perpetual and shall");
    });
    const { report } = await reviewContract({ docx: input, playbook }, generator, {
      maxContextTokens,
    });
    const term = report.results.find((r) => r.ruleId === "term");
    expect(term?.status).toBe("error");
    expect(term?.error).toBe(
      `${windows.length} of ${windows.length} parts of the contract could not be checked. ` +
        "The check failed unexpectedly (Error).",
    );
    expect(JSON.stringify(report)).not.toContain("perpetual and shall");
  });
});

describe("a clause bigger than the budget", () => {
  it("gets a window of its own and is sent whole", async () => {
    const tiny = budgetFor(playbook, clauses, 0);
    const oracle = createOracleGenerator(aggressiveScript());
    const { report } = await reviewContract({ docx: input, playbook }, oracle, {
      maxContextTokens: tiny,
      date: DATE,
    });
    expect(report.stats.windows).toBe(clauses.length);
    for (const clause of clauses) {
      expect(oracle.calls.some((call) => call.prompt.includes(clause.text))).toBe(true);
    }
    expect(report.results).toEqual(whole.report.results);
  });
});

describe("the window budget", () => {
  const floor = contextFloor(playbook);
  const oneRule = onlyRules(playbook, "term");

  it("refuses a limit with no room for contract text, and says how large it must be", async () => {
    for (const tooSmall of [1, 2048, 3000, windowReserve(playbook), floor]) {
      const oracle = createOracleGenerator(aggressiveScript());
      const failure = await reviewContract({ docx: input, playbook }, oracle, {
        maxContextTokens: tooSmall,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ReviewError);
      const message = (failure as Error).message;
      expect(message).toContain(`${tooSmall} tokens is too small`);
      expect(message).toContain(`must be above ${floor}`);
      expect(message).toContain(`about ${windowReserve(playbook)} tokens`);
      expect(message).toContain("CLAUSEWISE_MAX_CONTEXT_TOKENS");
      expect(oracle.calls).toHaveLength(0);
    }
  });

  it("accepts a limit one above that, which leaves room for a clause or two", async () => {
    const { report } = await reviewContract(
      { docx: input, playbook: oneRule },
      createOracleGenerator(aggressiveScript()),
      { maxContextTokens: floor + 1 },
    );
    expect(report.stats.windows).toBeGreaterThan(0);
  });

  it("refuses a plan of more than 2000 model calls before making any", async () => {
    const docx = await longContract(201);
    const oracle = createOracleGenerator(aggressiveScript());
    const failure = await reviewContract({ docx, playbook }, oracle, {
      maxContextTokens: floor + 1,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReviewError);
    const message = (failure as Error).message;
    expect(message).toMatch(/too small for this contract/);
    expect(message).toContain("201 parts");
    expect(message).toContain("2010 model calls");
    expect(message).toContain("10 rules");
    expect(oracle.calls).toHaveLength(0);
  });

  it("allows a plan of exactly 2000 model calls", async () => {
    const docx = await longContract(200);
    const generator = createScriptedGenerator(() => compliantAnswer());
    const { report } = await reviewContract({ docx, playbook }, generator, {
      maxContextTokens: floor + 1,
      concurrency: 16,
    });
    expect(report.stats.windows).toBe(200);
    expect(generator.calls).toHaveLength(2000);
  });

  // The estimate is whatever estimateTokens says, so the size of the contract is found with it.
  const sample = "The parties have agreed that nothing in this paragraph changes the clause. ";
  const charsFor = (tokens: number): number =>
    Math.ceil((tokens * sample.length * 100) / estimateTokens(sample.repeat(100)));
  const sized = (tokens: number): Promise<Uint8Array> =>
    longContract(Math.ceil(charsFor(tokens) / 3600), 3600);

  it("warns, and still sends the whole contract, when an unwindowed prompt is over 500,000 tokens", async () => {
    const docx = await sized(540_000);
    const generator = createScriptedGenerator(() => compliantAnswer());
    const { report } = await reviewContract({ docx, playbook: oneRule }, generator);
    expect(generator.calls).toHaveLength(1);
    expect(report.stats.windows).toBe(1);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings?.[0]).toMatch(
      /^The contract is about \d+ tokens \(estimated\) and goes to the model whole with every rule/,
    );
    expect(report.warnings?.[0]).toContain("CLAUSEWISE_MAX_CONTEXT_TOKENS");
    expect(Number(/about (\d+) tokens/.exec(report.warnings?.[0] ?? "")?.[1])).toBeGreaterThan(
      500_000,
    );
  });

  it("does not warn for a prompt under that size, or when the review is windowed", async () => {
    const under = await sized(440_000);
    const quiet = await reviewContract(
      { docx: under, playbook: oneRule },
      createScriptedGenerator(() => compliantAnswer()),
    );
    expect(quiet.report.warnings).toBeUndefined();

    const over = await sized(540_000);
    const windowed = await reviewContract(
      { docx: over, playbook: oneRule },
      createScriptedGenerator(() => compliantAnswer()),
      { maxContextTokens: 300_000 },
    );
    expect(windowed.report.stats.windows).toBeGreaterThan(1);
    expect(windowed.report.warnings).toBeUndefined();
  });
});

describe("the start of a window's prompt", () => {
  it("is byte for byte the same for every rule, so a provider can cache it", async () => {
    const oracle = createOracleGenerator(aggressiveScript());
    await reviewContract({ docx: input, playbook }, oracle, { maxContextTokens });
    const groups = byWindow(oracle.calls);
    expect(groups.size).toBe(windows.length);
    for (const calls of groups.values()) {
      expect(calls).toHaveLength(playbook.rules.length);
      const [first] = calls;
      expect(first?.sharedPrefix).toBeTypeOf("string");
      expect(first?.sharedPrefix?.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.sharedPrefix).toBe(first?.sharedPrefix);
        expect(call.prompt.startsWith(call.sharedPrefix ?? "\u0000")).toBe(true);
        expect(call.system).toBe(first?.system);
      }
      // The rules differ after the prefix, and only there.
      expect(new Set(calls.map((call) => call.prompt)).size).toBe(playbook.rules.length);
    }
  });

  it("stays the same across rules when a client is named", async () => {
    const oracle = createOracleGenerator(aggressiveScript());
    await reviewContract({ docx: input, playbook }, oracle, {
      maxContextTokens: budgetFor(playbook, clauses, 3, "Fabrikam Labs LLC, the Recipient"),
      client: "Fabrikam Labs LLC, the Recipient",
    });
    const groups = byWindow(oracle.calls);
    for (const calls of groups.values()) {
      expect(new Set(calls.map((call) => call.sharedPrefix)).size).toBe(1);
    }
  });
});

describe("a window that says compliant without naming a clause", () => {
  const MESSAGE =
    "The model reported this rule as met without pointing at a clause, so it could not be checked.";
  const missing = (): RuleCheck => ({
    status: "missing",
    clauseIds: [],
    explanation: "Nothing here covers it.",
    comment: "Add a clause.",
    edit: null,
    suggestedClause: "New wording.",
  });

  /** Windows named by their position answer as the function says; every other rule is compliant. */
  const answering = (answer: (window: number) => RuleCheck) =>
    createScriptedGenerator((request) => {
      if (ruleIdOf(request) !== "exclusions") return compliantAnswer();
      return answer(windows.findIndex((w) => w[0]?.id === firstClauseId(request)));
    });

  it("cannot outrank the other windows' missing; the rule is an error instead of a pass", async () => {
    const generator = answering((w) => (w === 0 ? compliantAnswer({ clauseIds: [] }) : missing()));
    const { report, redlined } = await reviewContract({ docx: input, playbook }, generator, {
      maxContextTokens,
    });
    const exclusions = report.results.find((r) => r.ruleId === "exclusions");
    expect(exclusions).toMatchObject({ status: "error" });
    expect(exclusions?.error).toBe(
      `1 of ${windows.length} parts of the contract could not be checked, and none of the others showed a deviation. ${MESSAGE}`,
    );
    expect(report.counts.compliant).toBe(9);
    expect(
      (await viewDocx(redlined)).comments.some((c) => c.text.includes("Standard exclusions")),
    ).toBe(false);
  });

  it("is an error too when every window answers that way", async () => {
    const generator = answering(() => compliantAnswer({ clauseIds: ["c999"] }));
    const { report } = await reviewContract({ docx: input, playbook }, generator, {
      maxContextTokens,
    });
    expect(report.results.find((r) => r.ruleId === "exclusions")?.error).toBe(
      `${windows.length} of ${windows.length} parts of the contract could not be checked. ${MESSAGE}`,
    );
  });

  it("does not hide a deviation another window found", async () => {
    const generator = answering((w) =>
      w === 0
        ? compliantAnswer({ clauseIds: [] })
        : compliantAnswer({ status: "deviation", clauseIds: ["c5"], explanation: "Short." }),
    );
    const { report } = await reviewContract({ docx: input, playbook }, generator, {
      maxContextTokens,
    });
    expect(report.results.find((r) => r.ruleId === "exclusions")).toMatchObject({
      status: "deviation",
      clauseIds: ["c5"],
    });
  });

  it("is accepted from a window that names a clause, as before", async () => {
    const generator = answering(() => compliantAnswer({ clauseIds: ["c5"] }));
    const { report } = await reviewContract({ docx: input, playbook }, generator, {
      maxContextTokens,
    });
    expect(report.results.find((r) => r.ruleId === "exclusions")).toMatchObject({
      status: "compliant",
      clauseIds: ["c5"],
    });
  });
});
