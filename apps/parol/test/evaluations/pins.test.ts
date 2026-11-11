import { describe, expect, it } from "vitest";
import { SPLITS, type Split } from "../../../../fixtures/parol/types.js";
import {
  decideFromGates,
  renderComparison,
  type Comparison,
  type DecisionOutcome as EvalDecisionOutcome,
} from "../../../../evals/src/parol/compare.js";
import {
  GATE_IDS as EVAL_GATE_IDS,
  type GateOutcome as EvalGateOutcome,
  type GateReport,
} from "../../../../evals/src/parol/gates.js";
import {
  NOT_CLEAN as EVAL_NOT_CLEAN,
  REPLAY_BANNER,
  SELFTEST_BANNER,
  SIMULATED_BANNER,
  type RunHealth,
  type RunMode as EvalRunMode,
} from "../../../../evals/src/parol/results.js";
import {
  FAILURE_FACTORS,
  type FailureKind as EvalFailureKind,
} from "../../../../evals/src/parol/score.js";
import { PAGE_RULE_KEY } from "../../src/evaluations/document.js";
import { RULE_KEY_PATTERN } from "../../src/store/schemas.js";
import {
  DECISION_LABEL,
  DECISION_OUTCOMES,
  FAILURE_KINDS,
  GATE_IDS,
  GATE_OUTCOMES,
  MODE_WORDS,
  NOT_A_RECOMMENDATION,
  NOT_CLEAN,
  RUN_MODES,
  SPLIT_NAMES,
  type DecisionOutcome,
  type FailureKind,
  type GateOutcome,
  type RunMode,
} from "../../src/evaluations/index.js";

/**
 * The application copies a few words and lists from the evaluation (it imports nothing from there),
 * and shows them on the comparison page. Each is compared here with its source, so that the
 * evaluation cannot change one without the page being told: this test is what fails.
 */

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// A list that gains or loses a member on one side fails to compile, not only to pass.
const runModes: Same<RunMode, EvalRunMode> = true;
const gateOutcomes: Same<GateOutcome, EvalGateOutcome> = true;
const decisionOutcomes: Same<DecisionOutcome, EvalDecisionOutcome> = true;
const failureKinds: Same<FailureKind, EvalFailureKind> = true;
const splits: Same<(typeof SPLIT_NAMES)[number], Split> = true;

describe("the words and lists copied from the evaluation", () => {
  it("agree in type", () => {
    expect([runModes, gateOutcomes, decisionOutcomes, failureKinds, splits]).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it("have the banners of a scripted or replayed run, character for character", () => {
    expect(MODE_WORDS.selftest).toBe(SELFTEST_BANNER);
    expect(MODE_WORDS.simulated).toBe(SIMULATED_BANNER);
    expect(MODE_WORDS.replay).toBe(REPLAY_BANNER);
    expect(Object.keys(MODE_WORDS).sort()).toEqual(["replay", "selftest", "simulated"]);
  });

  it("have the words for a run that was not clean", () => {
    expect(NOT_CLEAN).toBe(EVAL_NOT_CLEAN);
  });

  it("have the same gates, in the same order", () => {
    expect([...GATE_IDS]).toEqual([...EVAL_GATE_IDS]);
  });

  it("have the same ways a slot can fail, in the same order", () => {
    expect([...FAILURE_KINDS]).toEqual(Object.keys(FAILURE_FACTORS));
  });

  it("have the same splits", () => {
    expect([...SPLIT_NAMES]).toEqual([...SPLITS]);
  });

  it("have the alphabet of a rule key that the application stores, so no playbook it accepts is refused", () => {
    expect(PAGE_RULE_KEY.source).toBe(RULE_KEY_PATTERN.source);
    expect(PAGE_RULE_KEY.flags).toBe(RULE_KEY_PATTERN.flags);
    for (const key of ["dur-1", "Non_solicit.2", "A", `A${"x".repeat(63)}`])
      expect(PAGE_RULE_KEY.test(key), key).toBe(true);
    for (const key of ["", "a b", "-dur", `A${"x".repeat(64)}`])
      expect(PAGE_RULE_KEY.test(key), key).toBe(false);
  });

  it("list every mode of a run", () => {
    expect([...RUN_MODES].sort()).toEqual(["live", "replay", "selftest", "simulated"]);
    expect([...GATE_OUTCOMES].sort()).toEqual(["fail", "not_evaluated", "pass"]);
  });
});

/** A gate report with the given gates failed and not evaluated; the decision rule reads only those. */
const gatesWith = (
  failed: GateReport["failed"],
  notEvaluated: GateReport["notEvaluated"] = [],
): GateReport => ({
  results: [],
  passed: failed.length === 0 && notEvaluated.length === 0,
  failed,
  notEvaluated,
});

const CLEAN: RunHealth = {
  runs: 1,
  failedRuns: 0,
  calls: {},
  transportCalls: 0,
  extractDegradedRuns: 0,
  rulesOverBudget: 0,
  clean: true,
  problems: [],
};

const OUTCOMES: [DecisionOutcome, GateReport][] = [
  ["promote", gatesWith([])],
  ["promote_with_conditions", gatesWith(["G13"])],
  ["do_not_promote", gatesWith(["G1"])],
];

describe("the decision rule's labels", () => {
  for (const [outcome, gates] of OUTCOMES)
    it(`${outcome} is worded as the evaluation words it`, () => {
      const decision = decideFromGates({ gates, changes: [], repeats: 3 });
      expect(decision.outcome).toBe(outcome);
      expect(DECISION_LABEL[outcome]).toBe(decision.label);
    });

  it("cover every outcome the rule has", () => {
    expect(OUTCOMES.map(([outcome]) => outcome).sort()).toEqual([...DECISION_OUTCOMES].sort());
    expect(Object.keys(DECISION_LABEL).sort()).toEqual([...DECISION_OUTCOMES].sort());
  });

  for (const [outcome, gates] of OUTCOMES)
    it(`${outcome} is followed, in the evaluation's own report, by the sentence the page prints`, () => {
      const decision = decideFromGates({ gates, changes: [], repeats: 3 });
      const comparison: Extract<Comparison, { ok: true }> = {
        ok: true,
        differences: [],
        baselineName: "a.json",
        candidateName: "b.json",
        baselineMode: "live",
        candidateMode: "live",
        baselineHealth: CLEAN,
        candidateHealth: CLEAN,
        sections: [
          {
            split: "dev",
            repeats: "3",
            baselineGates: null,
            candidateGates: gates,
            rows: [],
            changes: [],
            paired: 0,
            unpaired: 0,
            decision,
            decisionNote: null,
            notes: [],
          },
        ],
        notes: [],
      };
      const report = renderComparison(comparison, { baseline: "v1", candidate: "v2" });
      expect(report).toContain(`**${DECISION_LABEL[outcome]}.** ${NOT_A_RECOMMENDATION}`);
    });
});
