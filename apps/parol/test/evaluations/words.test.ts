import { describe, expect, it } from "vitest";
import {
  CHANGE_KIND_LABEL,
  CHANGE_KINDS,
  DECISION_LABEL,
  DECISION_OUTCOMES,
  FAILURE_KINDS,
  FAILURE_LABEL,
  GATE_OUTCOMES,
  GATE_OUTCOME_LABEL,
  MODE_LABEL,
  MODE_WORDS,
  PROBLEM_ACTION,
  PROBLEM_LABEL,
  RUN_MODES,
  WHY_NOT_LABEL,
  ANSWERS_BY_MODE,
  scriptedModesIn,
  warningsFor,
  type PageProblem,
} from "../../src/evaluations/index.js";

/**
 * The fixed words of the comparison page. The tables are typed records over closed lists, so a
 * missing entry does not compile; these tests hold what a type cannot: that every entry says
 * something, that no two entries of a list say the same thing, and the order of the warnings.
 */

const PROBLEMS: PageProblem[] = [
  "too_large",
  "unreadable",
  "not_json",
  "not_a_comparison",
  "fingerprint_mismatch",
  "name_mismatch",
];

const TABLES: [string, readonly string[]][] = [
  ["MODE_WORDS", Object.values(MODE_WORDS)],
  ["MODE_LABEL", Object.values(MODE_LABEL)],
  ["DECISION_LABEL", Object.values(DECISION_LABEL)],
  ["GATE_OUTCOME_LABEL", Object.values(GATE_OUTCOME_LABEL)],
  ["CHANGE_KIND_LABEL", Object.values(CHANGE_KIND_LABEL)],
  ["FAILURE_LABEL", Object.values(FAILURE_LABEL)],
  ["WHY_NOT_LABEL", Object.values(WHY_NOT_LABEL)],
  ["PROBLEM_ACTION", Object.values(PROBLEM_ACTION)],
  ["PROBLEM_LABEL", Object.values(PROBLEM_LABEL)],
  ["ANSWERS_BY_MODE", Object.values(ANSWERS_BY_MODE)],
];

describe("the fixed words", () => {
  it("have an entry for every member of the list they are for, and no other", () => {
    expect(Object.keys(MODE_LABEL).sort()).toEqual([...RUN_MODES].sort());
    expect(Object.keys(ANSWERS_BY_MODE).sort()).toEqual([...RUN_MODES].sort());
    expect(Object.keys(DECISION_LABEL).sort()).toEqual([...DECISION_OUTCOMES].sort());
    expect(Object.keys(GATE_OUTCOME_LABEL).sort()).toEqual([...GATE_OUTCOMES].sort());
    expect(Object.keys(CHANGE_KIND_LABEL).sort()).toEqual([...CHANGE_KINDS].sort());
    expect(Object.keys(FAILURE_LABEL).sort()).toEqual([...FAILURE_KINDS].sort());
    expect(Object.keys(PROBLEM_ACTION).sort()).toEqual([...PROBLEMS].sort());
    expect(Object.keys(PROBLEM_LABEL).sort()).toEqual([...PROBLEMS].sort());
    expect(Object.keys(WHY_NOT_LABEL).sort()).toEqual(["case_changed", "not_recorded"]);
    expect(Object.keys(MODE_WORDS).sort()).toEqual(["replay", "selftest", "simulated"]);
  });

  for (const [name, values] of TABLES)
    it(`${name}: each says something, in a line of its own, with no dash character`, () => {
      for (const value of values) {
        expect(value.trim(), value).not.toBe("");
        expect(value, value).not.toMatch(/\n/);
        expect(value, value).not.toMatch(/[\u2013\u2014]/);
      }
    });

  it("say something different for each way a slot can fail, each outcome and each problem", () => {
    for (const table of [
      FAILURE_LABEL,
      GATE_OUTCOME_LABEL,
      CHANGE_KIND_LABEL,
      PROBLEM_LABEL,
      PROBLEM_ACTION,
      DECISION_LABEL,
    ])
      expect(new Set(Object.values(table)).size).toBe(Object.values(table).length);
  });

  it("word every outcome of the decision rule as a gate result", () => {
    for (const label of Object.values(DECISION_LABEL)) expect(label).toMatch(/, as a gate result$/);
  });

  it("tell a person what to do about a file that cannot be used", () => {
    for (const action of Object.values(PROBLEM_ACTION)) expect(action).toMatch(/--publish|--case/);
  });
});

describe("the warnings of a scripted or replayed run", () => {
  it("are the three capital sentences in the order selftest, simulated, replay, whatever the order given", () => {
    expect(scriptedModesIn(["replay", "simulated", "selftest"])).toEqual([
      "selftest",
      "simulated",
      "replay",
    ]);
    expect(warningsFor(["replay", "selftest"])).toEqual([MODE_WORDS.selftest, MODE_WORDS.replay]);
  });

  it("name each mode once, even when both runs have it", () => {
    expect(warningsFor(["simulated", "simulated"])).toEqual([MODE_WORDS.simulated]);
  });

  it("are none for a live run: the page cannot know that a model was called", () => {
    expect(warningsFor(["live", "live"])).toEqual([]);
    expect(warningsFor(["live", "replay"])).toEqual([MODE_WORDS.replay]);
    expect(warningsFor([])).toEqual([]);
  });

  it("are in capitals", () => {
    for (const words of Object.values(MODE_WORDS)) expect(words).toBe(words.toUpperCase());
  });
});
