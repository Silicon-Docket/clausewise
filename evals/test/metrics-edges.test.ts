import { describe, expect, it } from "vitest";
import { compareResults, type Previous } from "../src/compare.js";
import type { Fixture } from "../src/fixtures.js";
import type { EvalResult } from "../src/result.js";
import { computeScore, type RunRecord } from "../src/score.js";

type Expected = "compliant" | "deviation" | "missing" | "not_applicable";
type Got = Expected | "error";
const EXPECTED: Expected[] = ["compliant", "deviation", "missing", "not_applicable"];
const GOT: Got[] = [...EXPECTED, "error"];

function fixtureOf(name: string, expected: Expected[]): Fixture {
  const rules = expected.map((_, i) => ({
    id: `r${i}`,
    title: `r${i}`,
    severity: "high" as const,
    required: true,
    standard: "s",
  }));
  return {
    name,
    playbookPath: "p.yaml",
    playbook: { name: "p", description: "", contractTypes: [], perspective: "", rules },
    docx: new Uint8Array(),
    expected: Object.fromEntries(expected.map((status, i) => [`r${i}`, status])),
  } as unknown as Fixture;
}

function recordOf(fixture: Fixture, run: number, got: Got[]): RunRecord {
  return {
    fixture: fixture.name,
    run,
    calls: 0,
    usage: null,
    integrity: { ok: true, problems: [], paragraphs: 1, trackedChanges: 0, reportedChanges: 0 },
    report: {
      results: got.map((status, i) => ({ ruleId: `r${i}`, status, edit: { kind: "none" } })),
    },
  } as unknown as RunRecord;
}

// The scorer written out again, a different way: by counting pairs.
function reference(pairs: { expected: Expected; got: Got }[]) {
  const flag = (status: string): boolean => status === "deviation" || status === "missing";
  const count = (test: (pair: { expected: Expected; got: Got }) => boolean): number =>
    pairs.filter(test).length;
  const tp = count((p) => flag(p.expected) && flag(p.got));
  const fn = count((p) => flag(p.expected) && !flag(p.got));
  const fp = count((p) => !flag(p.expected) && flag(p.got));
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const f1 =
    precision === null && recall === null
      ? null
      : (precision ?? 0) + (recall ?? 0) === 0
        ? 0
        : (2 * (precision ?? 0) * (recall ?? 0)) / ((precision ?? 0) + (recall ?? 0));
  return {
    tp,
    fn,
    fp,
    tn: count((p) => !flag(p.expected) && !flag(p.got) && p.got !== "error"),
    unchecked: count((p) => !flag(p.expected) && p.got === "error"),
    accuracy: pairs.length === 0 ? null : count((p) => p.expected === p.got) / pairs.length,
    precision,
    recall,
    f1,
  };
}

const near = (a: number | null, b: number | null): boolean =>
  a === null || b === null ? a === b : Math.abs(a - b) < 1e-12;

describe("the scores against a second implementation", () => {
  it("agree on 400 random sets of reviews of several fixtures", () => {
    let seed = 20261020;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;

    for (let trial = 0; trial < 400; trial += 1) {
      const fixtures: Fixture[] = [];
      const records: RunRecord[] = [];
      const pairs: { expected: Expected; got: Got }[] = [];
      const runs = 1 + Math.floor(random() * 4);
      for (let f = 0; f < 1 + Math.floor(random() * 3); f += 1) {
        const expected = Array.from({ length: 1 + Math.floor(random() * 10) }, () =>
          pick(EXPECTED),
        );
        const fixture = fixtureOf(`f${f}.docx`, expected);
        fixtures.push(fixture);
        for (let run = 1; run <= runs; run += 1) {
          const got = expected.map((status) => (random() < 0.5 ? status : pick(GOT)));
          records.push(recordOf(fixture, run, got));
          got.forEach((status, i) =>
            pairs.push({ expected: expected[i] as Expected, got: status }),
          );
        }
      }
      const score = computeScore(fixtures, records);
      const want = reference(pairs);
      expect(score.flag).toMatchObject({
        truePositives: want.tp,
        misses: want.fn,
        falseAlarms: want.fp,
        trueNegatives: want.tn,
        unchecked: want.unchecked,
      });
      expect(near(score.accuracy, want.accuracy)).toBe(true);
      expect(near(score.flag.precision, want.precision)).toBe(true);
      expect(near(score.flag.recall, want.recall)).toBe(true);
      expect(near(score.flag.f1, want.f1)).toBe(true);
      expect(score.total).toBe(pairs.length);
    }
  });

  it("has no precision, recall or F1 when nothing is flagged or expected to be", () => {
    const fixture = fixtureOf("x.docx", ["compliant", "not_applicable", "not_applicable"]);
    const score = computeScore(
      [fixture],
      [recordOf(fixture, 1, ["compliant", "not_applicable", "not_applicable"])],
    );
    expect(score.accuracy).toBe(1);
    expect(score.flag).toMatchObject({ precision: null, recall: null, f1: null, trueNegatives: 3 });
  });

  it("counts an error where a flag was expected as a miss, and gives recall and F1 of zero", () => {
    const fixture = fixtureOf("x.docx", ["deviation", "missing"]);
    const score = computeScore([fixture], [recordOf(fixture, 1, ["error", "error"])]);
    expect(score.flag).toMatchObject({ misses: 2, precision: null, recall: 0, f1: 0 });
    expect(score.accuracy).toBe(0);
  });

  it("does not call a rule that errored a correct non-flag", () => {
    const fixture = fixtureOf("x.docx", ["compliant", "compliant"]);
    const score = computeScore([fixture], [recordOf(fixture, 1, ["error", "compliant"])]);
    expect(score.flag).toMatchObject({ trueNegatives: 1, unchecked: 1 });
  });

  it("counts a deviation given as a missing clause as a right flag and a wrong status", () => {
    const fixture = fixtureOf("x.docx", ["deviation", "compliant", "compliant"]);
    const score = computeScore(
      [fixture],
      [recordOf(fixture, 1, ["missing", "deviation", "compliant"])],
    );
    expect(score.flag).toMatchObject({ truePositives: 1, falseAlarms: 1, misses: 0 });
    expect(score.accuracy).toBeCloseTo(1 / 3, 12);
  });
});

describe("--compare when the answer key changed", () => {
  const previous = (expected: string, modal: string, accuracy: number): Previous => ({
    schemaVersion: 1,
    selftest: false,
    startedAt: "2026-10-01T09:00:00.000Z",
    model: { provider: "anthropic", model: "claude-sonnet-5-5" },
    score: {
      accuracy,
      flag: { f1: null },
      rules: [{ fixture: "a.docx", ruleId: "term", expected, modal, accuracy }],
    },
  });
  const today = (expected: string, modal: string, accuracy: number): EvalResult =>
    ({
      score: {
        accuracy,
        flag: { f1: null },
        rules: [{ fixture: "a.docx", ruleId: "term", expected, modal, accuracy }],
      },
    }) as unknown as EvalResult;

  it("does not call a relabelled rule an improvement or a regression", () => {
    // The model said compliant both times. The key was compliant, then deviation.
    const comparison = compareResults(
      previous("compliant", "compliant", 1),
      today("deviation", "compliant", 0),
    );
    expect(comparison.regressions).toHaveLength(0);
    expect(comparison.improvements).toHaveLength(0);
    expect(comparison.relabelled).toHaveLength(1);
  });

  it("still compares rules whose key did not change", () => {
    const comparison = compareResults(
      previous("deviation", "compliant", 0),
      today("deviation", "deviation", 1),
    );
    expect(comparison.improvements).toHaveLength(1);
    expect(comparison.relabelled).toHaveLength(0);
  });
});
