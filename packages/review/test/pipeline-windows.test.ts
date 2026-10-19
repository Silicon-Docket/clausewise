import { ModelOutputError } from "@clausewise/llm";
import { beforeAll, describe, expect, it } from "vitest";
import { reviewContract } from "../src/pipeline.js";
import { estimateTokens } from "../src/prompt.js";
import { createOracleGenerator, type OracleRule } from "../src/testing.js";
import type { Clause, ProgressEvent, ReviewReport } from "../src/types.js";
import {
  aggressiveScript,
  budgetFor,
  clausesOf,
  expectedWindows,
  firstClauseId,
  fixture,
  intercept,
  loadPlaybook,
  ruleIdOf,
  viewDocx,
} from "./pipeline-support.js";

const input = fixture("nda-aggressive.docx");
const playbook = loadPlaybook();
const DATE = new Date("2026-03-02T09:30:00Z");

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
