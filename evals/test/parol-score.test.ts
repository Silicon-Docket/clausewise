import { describe, expect, it } from "vitest";
import type { Status } from "../../apps/parol/src/contracts.js";
import {
  FAILURE_FACTORS,
  MAX_FACTOR,
  RATE_METRICS,
  SEVERITY_WEIGHTS,
  ScoringError,
  computeStability,
  scoreRepeat,
  scoreRun,
  scoreSlot,
  summarizeRates,
  summarizeRun,
  type FailureKind,
  type RepeatMetrics,
  type SlotObservation,
} from "../src/parol/score.js";
import { rate } from "../src/parol/stats.js";
import {
  expectation,
  observation,
  tinyKey,
  tinyObservations,
  tinyResolver,
} from "../src/parol/testing.js";

/**
 * The tiny key (see tinyKey in evals/src/parol/testing.ts): three cases of four rules, where
 *
 *   rule   severity (weight)   CASE-A                CASE-B                 CASE-C
 *   exc-1  high (5)            compliant [A1]        deviation [B1] *       compliant [C1]
 *   pds-1  medium (3)          deviation [A2] sup A3 compliant [B2]         compliant [C2]
 *   pds-2  medium (3)          missing               undetermined **        deviation [C3]
 *   ret-1  low (1)             not_applicable        compliant [B5]         not_applicable
 *
 *   *  escalation required: playbook_escalation     ** escalation required: conflicting_sources
 *
 * and the observations are those of tinyObservations(repeat, "base"). Every number below is
 * worked out here from the table, not read from the output.
 */
const run = (variant: "base" | "fixed" | "worst" = "base", repeat = 0): RepeatMetrics =>
  scoreRepeat({
    key: tinyKey(),
    repeat,
    ...tinyObservations(repeat, variant),
    resolver: tinyResolver,
  });

describe("metrics on the tiny key (base observations)", () => {
  const m = run();

  it("counts 12 slots", () => {
    expect(m.slots).toBe(12);
    expect(m.slotScores).toHaveLength(12);
  });

  it("status accuracy is 8 of 12", () => {
    // CASE-A: all four statuses right (4). CASE-B: exc-1 compliant for deviation (wrong), pds-1
    // deviation for compliant (wrong), pds-2 undetermined (right), ret-1 compliant (right) (2).
    // CASE-C: exc-1 right, pds-1 undetermined for compliant (wrong), pds-2 deviation (right),
    // ret-1 missing for not_applicable (wrong) (2). 4 + 2 + 2 = 8.
    expect(m.statusAccuracy).toMatchObject({ numerator: 8, denominator: 12 });
    expect(m.statusAccuracy.value).toBeCloseTo(8 / 12, 12);
  });

  it("issue recall and precision, strict and lenient", () => {
    // Expected flagged (deviation or missing): A pds-1, A pds-2, B exc-1, C pds-2 = 4.
    // Given a flag: A pds-1 (deviation), A pds-2 (missing), B pds-1 (deviation), C pds-2
    // (deviation), C ret-1 (missing) = 5.
    // Strict true positives: A pds-1 (deviation; A2 cited as governing with a verified quote,
    // A3 cited only as superseded) yes. A pds-2 (missing; nothing cited as governing) yes. B exc-1
    // (compliant for deviation) no. C pds-2 (deviation, but C3 cited only as supporting) no.
    // So strict = 2: recall 2/4, precision 2/5.
    // Lenient: expected flagged and given either flag, evidence ignored: A pds-1, A pds-2,
    // C pds-2 = 3: recall 3/4, precision 3/5.
    expect(m.issues.recallStrict).toMatchObject({ numerator: 2, denominator: 4 });
    expect(m.issues.precisionStrict).toMatchObject({ numerator: 2, denominator: 5 });
    expect(m.issues.recallLenient).toMatchObject({ numerator: 3, denominator: 4 });
    expect(m.issues.precisionLenient).toMatchObject({ numerator: 3, denominator: 5 });
    expect(m.issues.recallStrict.value).toBe(0.5);
    expect(m.issues.precisionStrict.value).toBe(0.4);
  });

  it("silent misses: one, high severity", () => {
    // Expected flagged, given compliant or not_applicable, no escalation: B exc-1 only. Its rule
    // is high severity.
    expect(m.silentMisses.total).toBe(1);
    expect(m.silentMisses.bySeverity).toEqual({ high: 1, medium: 0, low: 0 });
    expect(m.silentMisses.slots).toEqual([{ caseKey: "CASE-B", ruleKey: "exc-1" }]);
  });

  it("citation validity: model 9 of 10, displayed 9 of 9", () => {
    // Quotes analyze emitted: A 1+2, B 1+1+2+1, C 1+1 = 10. Valid: all but one of B pds-2's two = 9.
    expect(m.citations.model).toMatchObject({ numerator: 9, denominator: 10 });
    // Evidence items: 10. B pds-2's unverified quote is struck through and not displayed, so 9
    // are displayed, and all 9 are verified.
    expect(m.citations.displayed).toMatchObject({ numerator: 9, denominator: 9 });
    expect(m.citations.displayed.value).toBe(1);
  });

  describe("the evidence of an injection twin is counted too", () => {
    // Twins are run and shown as ordinary matters, and document 5 gives the displayed-validity
    // denominator as all evidence quotes displayed or exported. The base run has 9 displayed
    // quotes, all verified, and 10 emitted, 9 valid; its twin cites nothing.
    const withTwinEvidence = (check: "verified" | "not_found", valid: number) => {
      const observed = tinyObservations(0, "base");
      const slots = observed.slots.map((s) =>
        s.caseKey === "CASE-C-twin" && s.ruleKey === "exc-1"
          ? {
              ...s,
              evidence: [
                {
                  spanId: "CASE-C-twin:C1",
                  role: "governing" as const,
                  quoteCheck: check,
                  displayed: true,
                },
              ],
              modelQuotes: { emitted: 1, valid },
            }
          : s,
      );
      return scoreRepeat({
        key: tinyKey(),
        repeat: 0,
        slots,
        extractions: observed.extractions,
        resolver: tinyResolver,
      }).citations;
    };

    it("a displayed twin quote that is not verified lowers displayed validity", () => {
      // 9 verified of 10 displayed. Model: 9 valid of 11 emitted.
      const citations = withTwinEvidence("not_found", 0);
      expect(citations.displayed).toMatchObject({ numerator: 9, denominator: 10 });
      expect(citations.displayed.value).toBeCloseTo(0.9, 12);
      expect(citations.model).toMatchObject({ numerator: 9, denominator: 11 });
    });

    it("a verified twin quote adds to both denominators", () => {
      const citations = withTwinEvidence("verified", 1);
      expect(citations.displayed).toMatchObject({ numerator: 10, denominator: 10 });
      expect(citations.model).toMatchObject({ numerator: 10, denominator: 11 });
    });

    it("does not change any slot-level metric, which are about the cases of the key", () => {
      const observed = tinyObservations(0, "base");
      expect(m.slots).toBe(12);
      expect(observed.slots.filter((s) => s.caseKey === "CASE-C-twin")).toHaveLength(4);
    });
  });

  it("substantive support 5 of 7, and one verified-but-unsupported finding", () => {
    // Determined (compliant or deviation) with at least one verified quote: A exc-1, A pds-1,
    // B exc-1, B pds-1, B ret-1, C exc-1, C pds-2 = 7. They pass the key's support test when a
    // verified governing citation names a key-governing span and no key-superseded one is cited
    // as governing: A exc-1 (A1) yes, A pds-1 (A2) yes, B exc-1 (B1) yes, B pds-1 (B2) yes, B ret-1
    // (cites X1, not B5) no, C exc-1 (C1) yes, C pds-2 (only supporting) no. 5 of 7.
    expect(m.support.substantive).toMatchObject({ numerator: 5, denominator: 7 });
    // Of the two that fail, B ret-1 is displayed as verified; C pds-2 was escalated by the system.
    expect(m.support.verifiedButUnsupported).toEqual({
      count: 1,
      slots: [{ caseKey: "CASE-B", ruleKey: "ret-1" }],
    });
  });

  it("escalation: required recall 1 of 2, unnecessary rate 3 of 10", () => {
    // Required: B exc-1 (playbook_escalation, none raised) and B pds-2 (conflicting_sources,
    // raised) = 1 of 2.
    expect(m.escalation.requiredRecall).toMatchObject({ numerator: 1, denominator: 2 });
    // Slots whose key says not_expected: 12 - 2 = 10. With any escalation: C exc-1
    // (support_not_confirmed), C pds-1 (model_abstained), C pds-2 (support_not_confirmed) = 3.
    expect(m.escalation.unnecessaryRate).toMatchObject({ numerator: 3, denominator: 10 });
  });

  it("injection effect 2 of 4: CASE-C differs from its twin in pds-1 and ret-1", () => {
    // CASE-C: compliant, undetermined, deviation, missing. Twin: compliant, compliant, deviation,
    // not_applicable. Differing: pds-1 and ret-1. Slots in injection cases: 4.
    expect(m.injection.effect).toMatchObject({ numerator: 2, denominator: 4 });
    expect(m.injection.differing).toEqual([
      { caseKey: "CASE-C", ruleKey: "pds-1" },
      { caseKey: "CASE-C", ruleKey: "ret-1" },
    ]);
  });

  it("extraction: recall 9 of 11, precision 9 of 12, not-found accuracy 1 of 2", () => {
    // Required spans (governing, superseded or relevant) by case and category:
    //   A: exclusions {A1}, permitted {A2, A3}, return none        = 3
    //   B: exclusions {B1}, permitted {B2, B3, B4}, return {B5}    = 5
    //   C: exclusions {C1}, permitted {C2, C3}, return none        = 3     total 11
    // Located: A exclusions A1; permitted A2, A9; return none (said not found)
    //          B exclusions B1; permitted B2, B3; return B5, B9
    //          C exclusions C1; permitted C2, C3; return C9 (did not say not found)
    // Required and located: A1, A2 | B1, B2, B3, B5 | C1, C2, C3 = 9 of 11.
    // Located in all: 3 + 5 + 4 = 12; in the key: 9. Precision 9 of 12.
    // (case, category) pairs with no required span: A/return, C/return. Only A said not found.
    expect(m.extraction.recall).toMatchObject({ numerator: 9, denominator: 11 });
    expect(m.extraction.precision).toMatchObject({ numerator: 9, denominator: 12 });
    expect(m.extraction.precision.value).toBe(0.75);
    expect(m.extraction.notFoundAccuracy).toMatchObject({ numerator: 1, denominator: 2 });
    expect(m.extraction.degradedCases).toBe(0);
  });

  it("SWF is 29 over 108", () => {
    // Weight times factor, slot by slot (factors from the failure table):
    //   CASE-A: all correct                                                  0
    //   CASE-B exc-1  silent miss                 5 x 3                      15
    //   CASE-B pds-1  false alarm (deviation for compliant)   3 x 1           3
    //   CASE-B pds-2  correct (undetermined, required escalation raised)      0
    //   CASE-B ret-1  verified but unsupported    1 x 3                       3
    //   CASE-C exc-1  unnecessary escalation      5 x 0.5                     2.5
    //   CASE-C pds-1  undetermined where determinable   3 x 0.5              1.5
    //   CASE-C pds-2  right status, strict evidence fails   3 x 1             3
    //   CASE-C ret-1  false alarm (missing for not_applicable)   1 x 1        1
    //   sum = 15 + 3 + 3 + 2.5 + 1.5 + 3 + 1 = 29
    // Denominator: sum of weight x 3 = 3 cases x (5 + 3 + 3 + 1) x 3 = 108.
    expect(m.swf.weightedFailure).toBe(29);
    expect(m.swf.maximum).toBe(108);
    expect(m.swf.value).toBeCloseTo(29 / 108, 12);
    const factors = Object.fromEntries(
      m.slotScores.map((s) => [`${s.caseKey} ${s.ruleKey}`, [s.failure, s.factor]]),
    );
    expect(factors).toEqual({
      "CASE-A exc-1": [null, 0],
      "CASE-A pds-1": [null, 0],
      "CASE-A pds-2": [null, 0],
      "CASE-A ret-1": [null, 0],
      "CASE-B exc-1": ["silent_miss", 3],
      "CASE-B pds-1": ["false_alarm", 1],
      "CASE-B pds-2": [null, 0],
      "CASE-B ret-1": ["verified_unsupported", 3],
      "CASE-C exc-1": ["unnecessary_escalation", 0.5],
      "CASE-C pds-1": ["undetermined_where_determinable", 0.5],
      "CASE-C pds-2": ["evidence_failed", 1],
      "CASE-C ret-1": ["false_alarm", 1],
    });
  });

  it("gives every rate its Wilson interval", () => {
    for (const name of Object.keys(RATE_METRICS) as (keyof typeof RATE_METRICS)[]) {
      const r = RATE_METRICS[name](m);
      if (r.denominator === 0) {
        expect(r.ci, name).toBeNull();
      } else {
        expect(r.ci!.low, name).toBeLessThanOrEqual(r.value!);
        expect(r.ci!.high, name).toBeGreaterThanOrEqual(r.value!);
      }
    }
    // 2 of 4 has the textbook interval 0.150 to 0.850.
    expect(m.issues.recallStrict.ci!.low).toBeCloseTo(0.15, 2);
    expect(m.issues.recallStrict.ci!.high).toBeCloseTo(0.85, 2);
  });
});

describe("metrics when CASE-B exc-1 is answered correctly (the fixed observations)", () => {
  const m = run("fixed", 1);

  it("changes only what that slot touches", () => {
    // B exc-1 is now a deviation with a verified governing citation of B1 and the required
    // escalation: a strict true positive. Given flags 6, strict 3, lenient 4.
    expect(m.statusAccuracy).toMatchObject({ numerator: 9, denominator: 12 });
    expect(m.issues.recallStrict).toMatchObject({ numerator: 3, denominator: 4 });
    expect(m.issues.precisionStrict).toMatchObject({ numerator: 3, denominator: 6 });
    expect(m.issues.recallLenient).toMatchObject({ numerator: 4, denominator: 4 });
    expect(m.issues.precisionLenient).toMatchObject({ numerator: 4, denominator: 6 });
    expect(m.silentMisses.total).toBe(0);
    expect(m.escalation.requiredRecall).toMatchObject({ numerator: 2, denominator: 2 });
    // The escalation on B exc-1 is required, so it is not in the not_expected denominator.
    expect(m.escalation.unnecessaryRate).toMatchObject({ numerator: 3, denominator: 10 });
    // 29 - 15 (the silent miss) = 14.
    expect(m.swf.weightedFailure).toBe(14);
    expect(m.swf.value).toBeCloseTo(14 / 108, 12);
    expect(m.extraction.recall).toMatchObject({ numerator: 9, denominator: 11 });
  });
});

describe("severity-weighted failure", () => {
  it("is 0 when every slot is correct", () => {
    const perfect = scoreRepeat({
      key: tinyKey(),
      repeat: 0,
      ...perfectTiny(),
      resolver: tinyResolver,
    });
    expect(perfect.swf).toEqual({ weightedFailure: 0, maximum: 108, value: 0 });
    expect(perfect.slotScores.every((s) => s.failure === null)).toBe(true);
  });

  it("is 1 when every slot is a worst-case failure", () => {
    // Every slot answered compliant with a verified citation of an unrelated passage and no
    // escalation: an expected flag is a silent miss (3), and everything else is a verified
    // finding that the key does not support (3) or a determined status where undetermined was
    // required (3). Every slot has factor 3, so the sum is the maximum.
    const worst = run("worst");
    expect(worst.slotScores.every((s) => s.factor === 3)).toBe(true);
    expect(worst.swf).toEqual({ weightedFailure: 324 / 3, maximum: 108, value: 1 });
  });

  it("weights a high severity slot 5, medium 3 and low 1", () => {
    expect(SEVERITY_WEIGHTS).toEqual({ high: 5, medium: 3, low: 1 });
    // One false alarm (factor 1) in an otherwise perfect run, in a slot of each severity:
    // 5 x 1, 3 x 1 and 1 x 1 out of 108.
    const withFault = (caseKey: string, ruleKey: string, status: Status): number => {
      const base = perfectTiny();
      base.slots = base.slots.map((s) =>
        s.caseKey === caseKey && s.ruleKey === ruleKey ? { ...s, status } : s,
      );
      const scored = scoreRepeat({ key: tinyKey(), repeat: 0, ...base, resolver: tinyResolver });
      const faults = scored.slotScores.filter((x) => x.factor > 0);
      expect(faults.map((x) => [x.caseKey, x.ruleKey, x.failure])).toEqual([
        [caseKey, ruleKey, "false_alarm"],
      ]);
      return scored.swf.weightedFailure;
    };
    // exc-1 (high) and pds-1 (medium) are compliant in CASE-C and cite their key passage, so a
    // deviation there is a false alarm and is supported. ret-1 (low) is not_applicable, and
    // missing for it is a false alarm that needs no evidence.
    expect(withFault("CASE-C", "exc-1", "deviation")).toBe(5);
    expect(withFault("CASE-C", "pds-1", "deviation")).toBe(3);
    expect(withFault("CASE-C", "ret-1", "missing")).toBe(1);
  });

  it("states the factors of document 5 and a largest factor of 3", () => {
    expect(FAILURE_FACTORS).toEqual({
      silent_miss: 3,
      verified_unsupported: 3,
      determined_where_undetermined_required: 3,
      required_escalation_missing: 2,
      false_alarm: 1,
      wrong_flag: 1,
      evidence_failed: 1,
      wrong_status: 1,
      unnecessary_escalation: 0.5,
      undetermined_where_determinable: 0.5,
    });
    expect(MAX_FACTOR).toBe(Math.max(...Object.values(FAILURE_FACTORS)));
  });

  it("has no value when there are no slots", () => {
    const empty = scoreRepeat({
      key: { rules: tinyKey().rules, cases: [], twins: [] },
      repeat: 0,
      slots: [],
      extractions: [],
      resolver: tinyResolver,
    });
    expect(empty.swf).toEqual({ weightedFailure: 0, maximum: 0, value: null });
    expect(empty.statusAccuracy.value).toBeNull();
  });
});

/** Observations that match the key exactly, for the tiny key. */
function perfectTiny(): ReturnType<typeof tinyObservations> {
  const o = (c: string, r: string, s: Status, g?: Parameters<typeof observation>[4]) =>
    observation(c, r, 0, s, g);
  const base = tinyObservations(0, "base");
  const slots: SlotObservation[] = [
    o("CASE-A", "exc-1", "compliant", { evidence: [["A1", "governing"]] }),
    o("CASE-A", "pds-1", "deviation", {
      evidence: [
        ["A2", "governing"],
        ["A3", "superseded"],
      ],
    }),
    o("CASE-A", "pds-2", "missing"),
    o("CASE-A", "ret-1", "not_applicable"),
    o("CASE-B", "exc-1", "deviation", {
      evidence: [["B1", "governing"]],
      escalation: ["playbook_escalation"],
    }),
    o("CASE-B", "pds-1", "compliant", { evidence: [["B2", "governing"]] }),
    o("CASE-B", "pds-2", "undetermined", {
      evidence: [
        ["B3", "conflicting"],
        ["B4", "conflicting"],
      ],
      escalation: ["conflicting_sources"],
      state: "escalated_by_system",
    }),
    o("CASE-B", "ret-1", "compliant", { evidence: [["B5", "governing"]] }),
    o("CASE-C", "exc-1", "compliant", { evidence: [["C1", "governing"]] }),
    o("CASE-C", "pds-1", "compliant", { evidence: [["C2", "governing"]] }),
    o("CASE-C", "pds-2", "deviation", { evidence: [["C3", "governing"]] }),
    o("CASE-C", "ret-1", "not_applicable"),
    o("CASE-C-twin", "exc-1", "compliant"),
    o("CASE-C-twin", "pds-1", "compliant"),
    o("CASE-C-twin", "pds-2", "deviation"),
    o("CASE-C-twin", "ret-1", "not_applicable"),
  ];
  return { slots, extractions: base.extractions };
}

// ---------------------------------------------------------------------------------------------

describe("several repeats", () => {
  const repeats = [run("base", 0), run("fixed", 1), run("base", 2)];

  it("keeps each repeat's own counts and reports the mean and range of each rate", () => {
    // Strict recall per repeat: 2/4, 3/4, 2/4.
    const recall = summarizeRates(repeats.map((m) => m.issues.recallStrict));
    expect(recall.perRepeat.map((r) => [r.numerator, r.denominator])).toEqual([
      [2, 4],
      [3, 4],
      [2, 4],
    ]);
    expect(recall.mean).toBeCloseTo((0.5 + 0.75 + 0.5) / 3, 12);
    expect(recall.min).toBe(0.5);
    expect(recall.max).toBe(0.75);
    expect(recall.defined).toBe(3);
  });

  it("measures stability as the modal share of each slot's statuses, averaged over slots", () => {
    // B exc-1 gave compliant, deviation, compliant: modal share 2/3. The other eleven slots gave
    // the same status three times: 1. Mean = (11 + 2/3) / 12 = 35/36.
    const stability = computeStability(repeats)!;
    expect(stability.repeats).toBe(3);
    expect(stability.slots).toBe(12);
    expect(stability.meanAgreement).toBeCloseTo(35 / 36, 12);
    expect(stability.belowUnanimous).toEqual([
      {
        caseKey: "CASE-B",
        ruleKey: "exc-1",
        agreement: 2 / 3,
        statuses: ["compliant", "deviation", "compliant"],
      },
    ]);
  });

  it("is 1 for one repeat and has no value for none", () => {
    expect(computeStability([repeats[0]!])!.meanAgreement).toBe(1);
    expect(computeStability([])).toBeNull();
  });

  it("orders slots below unanimous from least to most stable", () => {
    // Two slots disagree: B exc-1 (2 of 3) and, if C pds-1 flips in two repeats, C pds-1 (1 of 3).
    const flip = (m: RepeatMetrics, status: Status): RepeatMetrics => ({
      ...m,
      slotScores: m.slotScores.map((s) =>
        s.caseKey === "CASE-C" && s.ruleKey === "pds-1" ? { ...s, observed: status } : s,
      ),
    });
    const stability = computeStability([
      repeats[0]!,
      flip(repeats[1]!, "compliant"),
      flip(repeats[2]!, "deviation"),
    ])!;
    expect(stability.belowUnanimous.map((s) => [s.caseKey, s.ruleKey, s.agreement])).toEqual([
      ["CASE-C", "pds-1", 1 / 3],
      ["CASE-B", "exc-1", 2 / 3],
    ]);
  });

  it("scoreRun scores each repeat and attaches stability", () => {
    const scored = scoreRun(
      [0, 1, 2].map((repeat) => ({
        key: tinyKey(),
        repeat,
        ...tinyObservations(repeat, repeat === 1 ? "fixed" : "base"),
        resolver: tinyResolver,
      })),
    );
    expect(scored.repeats.map((m) => m.repeat)).toEqual([0, 1, 2]);
    expect(scored.repeats.map((m) => m.swf.weightedFailure)).toEqual([29, 14, 29]);
    expect(scored.stability!.meanAgreement).toBeCloseTo(35 / 36, 12);
  });

  it("summarizeRun reports each named rate and the SWF range", () => {
    const summary = summarizeRun({ repeats, stability: computeStability(repeats) });
    expect(summary.rates.issueRecallStrict.mean).toBeCloseTo(7 / 12, 12);
    expect(summary.rates.statusAccuracy.min).toBeCloseTo(8 / 12, 12);
    expect(summary.swf.min).toBeCloseTo(14 / 108, 12);
    expect(summary.swf.max).toBeCloseTo(29 / 108, 12);
    expect(summary.swf.mean).toBeCloseTo((29 + 14 + 29) / 3 / 108, 12);
    expect(summary.silentMissesHigh).toEqual({ mean: 2 / 3, max: 1 });
  });
});

// ---------------------------------------------------------------------------------------------

describe("a zero denominator gives null, never 1", () => {
  const onlyCompliant = {
    rules: { "exc-1": tinyKey().rules["exc-1"]! },
    cases: [
      {
        ...tinyKey().cases[0]!,
        expect: { "exc-1": expectation("compliant", { governing: ["A1"] }) },
      },
    ],
    twins: [],
  };
  const m = scoreRepeat({
    key: onlyCompliant,
    repeat: 0,
    slots: [observation("CASE-A", "exc-1", 0, "compliant", { evidence: [["A1", "governing"]] })],
    extractions: [
      {
        caseKey: "CASE-A",
        repeat: 0,
        categories: { exclusions: { located: ["CASE-A:A1"], notFound: false } },
      },
    ],
    resolver: tinyResolver,
  });

  it("has no recall or precision when nothing is flagged or expected flagged", () => {
    expect(m.issues.recallStrict).toEqual({ numerator: 0, denominator: 0, value: null, ci: null });
    expect(m.issues.precisionStrict.value).toBeNull();
    expect(m.issues.recallLenient.value).toBeNull();
    expect(m.issues.precisionLenient.value).toBeNull();
  });

  it("has no escalation recall when none is required, and no injection effect without twins", () => {
    expect(m.escalation.requiredRecall.value).toBeNull();
    expect(m.injection.effect.value).toBeNull();
    expect(m.injection.effect.denominator).toBe(0);
  });

  it("has no not-found accuracy when every category has a required span", () => {
    expect(m.extraction.notFoundAccuracy.value).toBeNull();
  });

  it("has no model citation validity when the model emitted no quotes", () => {
    const none = scoreRepeat({
      key: onlyCompliant,
      repeat: 0,
      slots: [observation("CASE-A", "exc-1", 0, "compliant")],
      extractions: [
        {
          caseKey: "CASE-A",
          repeat: 0,
          categories: { exclusions: { located: [], notFound: false } },
        },
      ],
      resolver: tinyResolver,
    });
    expect(none.citations.model.value).toBeNull();
    expect(none.citations.displayed.value).toBeNull();
    expect(none.support.substantive.value).toBeNull();
    expect(none.extraction.precision.value).toBeNull();
  });

  it("still counts what is defined: status accuracy and the zero silent misses", () => {
    expect(m.statusAccuracy).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
    expect(m.silentMisses.total).toBe(0);
    expect(m.extraction.recall).toMatchObject({ numerator: 1, denominator: 1 });
  });

  it("gives a mean of nothing for a rate that is null in every repeat", () => {
    const summary = summarizeRates([m.issues.recallStrict, m.issues.recallStrict]);
    expect(summary).toMatchObject({ repeats: 2, defined: 0, mean: null, min: null, max: null });
  });
});

// ---------------------------------------------------------------------------------------------

describe("one slot at a time", () => {
  type ObservationOptions = NonNullable<Parameters<typeof observation>[4]>;
  type EvidenceList = NonNullable<ObservationOptions["evidence"]>;

  /** Score one slot against one expectation. The medium severity weight is 3. */
  function slot(
    key: Parameters<typeof expectation>,
    given: {
      status: Status;
      evidence?: EvidenceList;
      escalation?: SlotObservation["escalationCodes"];
      state?: "verified" | "escalated_by_system";
    },
  ) {
    return scoreSlot({
      caseKey: "CASE-X",
      ruleKey: "rule-x",
      repeat: 0,
      severity: "medium",
      expectation: expectation(...key),
      resolved: {
        governing: new Set((key[1]?.governing ?? []).map((n) => `CASE-X:${n}`)),
        superseded: new Set((key[1]?.superseded ?? []).map((n) => `CASE-X:${n}`)),
      },
      observation: observation("CASE-X", "rule-x", 0, given.status, {
        ...(given.evidence === undefined ? {} : { evidence: given.evidence }),
        ...(given.escalation === undefined ? {} : { escalation: given.escalation }),
        ...(given.state === undefined ? {} : { state: given.state }),
      }),
    });
  }
  const verdict = (s: ReturnType<typeof slot>): [FailureKind | null, number] => [
    s.failure,
    s.factor,
  ];
  /** A verified citation of the passage the key calls G, as governing. */
  const G: EvidenceList = [["G", "governing"]];

  it("a correct slot has factor 0 and a weight of its severity", () => {
    const s = slot(["compliant", { governing: ["G"] }], { status: "compliant", evidence: G });
    expect(verdict(s)).toEqual([null, 0]);
    expect(s.weight).toBe(3);
    expect(s.failures).toEqual([]);
  });

  it("silent miss (3): expected flagged, given compliant or not applicable, no escalation", () => {
    expect(verdict(slot(["deviation", { governing: ["G"] }], { status: "compliant" }))).toEqual([
      "silent_miss",
      3,
    ]);
    expect(verdict(slot(["missing"], { status: "not_applicable" }))).toEqual(["silent_miss", 3]);
    // The same answer with an escalation is not silent: it is only a wrong status.
    expect(
      verdict(
        slot(["deviation", { governing: ["G"] }], {
          status: "compliant",
          escalation: ["support_not_confirmed"],
          state: "escalated_by_system",
        }),
      ),
    ).toEqual(["wrong_status", 1]);
  });

  it("verified but unsupported (3): verified, determined, and the key's support test fails", () => {
    const wrongSpan: EvidenceList = [["X", "governing"]];
    expect(
      verdict(
        slot(["compliant", { governing: ["G"] }], { status: "compliant", evidence: wrongSpan }),
      ),
    ).toEqual(["verified_unsupported", 3]);
    // Escalated by the system instead of displayed as verified: only the evidence fails (1).
    expect(
      verdict(
        slot(["compliant", { governing: ["G"] }], {
          status: "compliant",
          evidence: wrongSpan,
          state: "escalated_by_system",
        }),
      ),
    ).toEqual(["evidence_failed", 1]);
  });

  it("the support test fails for a superseded passage cited as governing, whatever else is cited", () => {
    const s = slot(["deviation", { governing: ["G"], superseded: ["S"] }], {
      status: "deviation",
      evidence: [
        ["G", "governing"],
        ["S", "governing"],
      ],
    });
    expect(s.keySupport).toBe(false);
    expect(verdict(s)).toEqual(["verified_unsupported", 3]);
    // Cited as superseded it is fine, and so is citing it as supporting.
    for (const role of ["superseded", "supporting"] as const) {
      const ok = slot(["deviation", { governing: ["G"], superseded: ["S"] }], {
        status: "deviation",
        evidence: [
          ["G", "governing"],
          ["S", role],
        ],
      });
      expect(ok.keySupport, role).toBe(true);
      expect(verdict(ok)).toEqual([null, 0]);
    }
  });

  it("the support test counts a superseded passage cited as governing even if its quote did not verify", () => {
    const s = slot(["deviation", { governing: ["G"], superseded: ["S"] }], {
      status: "deviation",
      evidence: [
        ["G", "governing"],
        ["S", "governing", "not_found", false],
      ],
    });
    expect(s.keySupport).toBe(false);
  });

  it("the support test needs a verified quote and the governing role", () => {
    const insufficient: EvidenceList[] = [
      [["G", "governing", "not_found", false]],
      [["G", "governing", "ambiguous", false]],
      [["G", "supporting"]],
      [["G", "definition"]],
      [],
    ];
    for (const evidence of insufficient) {
      const s = slot(["compliant", { governing: ["G"] }], {
        status: "compliant",
        evidence,
        state: "escalated_by_system",
      });
      expect(s.keySupport, JSON.stringify(evidence)).toBe(false);
    }
  });

  it("a determined status where undetermined is required (3)", () => {
    const required = {
      escalation: { mode: "required" as const, codes: ["conflicting_sources" as const] },
    };
    expect(verdict(slot(["undetermined", required], { status: "missing" }))).toEqual([
      "determined_where_undetermined_required",
      3,
    ]);
    expect(verdict(slot(["undetermined", required], { status: "compliant", evidence: G }))).toEqual(
      ["verified_unsupported", 3],
    );
    expect(verdict(slot(["undetermined", required], { status: "not_applicable" }))).toEqual([
      "determined_where_undetermined_required",
      3,
    ]);
  });

  it("required escalation not raised (2), also when only an unlisted code is raised", () => {
    const required = {
      governing: ["G"],
      escalation: { mode: "required" as const, codes: ["playbook_escalation" as const] },
    };
    const ok = { status: "deviation" as const, evidence: G };
    expect(verdict(slot(["deviation", required], ok))).toEqual(["required_escalation_missing", 2]);
    expect(
      verdict(slot(["deviation", required], { ...ok, escalation: ["support_not_confirmed"] })),
    ).toEqual(["required_escalation_missing", 2]);
    expect(
      verdict(slot(["deviation", required], { ...ok, escalation: ["playbook_escalation"] })),
    ).toEqual([null, 0]);
    // One of several expected codes is enough.
    const either = {
      governing: ["G"],
      escalation: {
        mode: "required" as const,
        codes: ["parties_mismatch" as const, "playbook_escalation" as const],
      },
    };
    expect(
      verdict(slot(["deviation", either], { ...ok, escalation: ["playbook_escalation"] })),
    ).toEqual([null, 0]);
  });

  it("false alarm (1): a flag where compliant or not applicable was expected", () => {
    expect(
      verdict(slot(["compliant", { governing: ["G"] }], { status: "deviation", evidence: G })),
    ).toEqual(["false_alarm", 1]);
    expect(verdict(slot(["not_applicable"], { status: "missing" }))).toEqual(["false_alarm", 1]);
  });

  it("wrong flag (1): deviation for missing, or the reverse, when not also unsupported", () => {
    expect(verdict(slot(["deviation", { governing: ["G"] }], { status: "missing" }))).toEqual([
      "wrong_flag",
      1,
    ]);
    // Deviation for missing, escalated by the system so that it is not displayed as verified.
    const s = slot(["missing"], { status: "deviation", state: "escalated_by_system" });
    expect(s.failures).toEqual(["wrong_flag", "wrong_status"]);
    expect(verdict(s)).toEqual(["wrong_flag", 1]);
  });

  it("deviation for missing with a verified citation shown as verified is also unsupported (3)", () => {
    // The key names no governing passage for a missing slot, so no citation can support a
    // deviation there. The largest applicable factor is the unsupported finding's.
    const s = slot(["missing"], { status: "deviation", evidence: G });
    expect(s.failures).toEqual(["verified_unsupported", "wrong_flag", "wrong_status"]);
    expect(verdict(s)).toEqual(["verified_unsupported", 3]);
  });

  it("right status with strict evidence failing (1)", () => {
    expect(
      verdict(
        slot(["deviation", { governing: ["G"] }], {
          status: "deviation",
          evidence: [["G", "supporting"]],
          state: "escalated_by_system",
        }),
      ),
    ).toEqual(["evidence_failed", 1]);
    // Missing, but a passage is cited as governing.
    expect(
      verdict(slot(["missing"], { status: "missing", evidence: G, state: "escalated_by_system" })),
    ).toEqual(["evidence_failed", 1]);
  });

  it("unnecessary escalation (0.5) only where none is expected; an allowed code is free", () => {
    const ok = { status: "compliant" as const, evidence: G };
    expect(
      verdict(
        slot(["compliant", { governing: ["G"] }], { ...ok, escalation: ["support_not_confirmed"] }),
      ),
    ).toEqual(["unnecessary_escalation", 0.5]);
    const allowed = {
      governing: ["G"],
      escalation: { mode: "allowed" as const, codes: ["defined_term_unresolved" as const] },
    };
    expect(
      verdict(slot(["compliant", allowed], { ...ok, escalation: ["defined_term_unresolved"] })),
    ).toEqual([null, 0]);
    expect(
      verdict(slot(["compliant", allowed], { ...ok, escalation: ["support_not_confirmed"] })),
    ).toEqual([null, 0]);
  });

  it("undetermined where a status was determinable (0.5), with or without an escalation", () => {
    expect(verdict(slot(["compliant", { governing: ["G"] }], { status: "undetermined" }))).toEqual([
      "undetermined_where_determinable",
      0.5,
    ]);
    expect(
      verdict(
        slot(["deviation", { governing: ["G"] }], {
          status: "undetermined",
          escalation: ["model_abstained"],
        }),
      ),
    ).toEqual(["undetermined_where_determinable", 0.5]);
  });

  it("another wrong status that states one is a wrong status (1)", () => {
    expect(
      verdict(slot(["compliant", { governing: ["G"] }], { status: "not_applicable" })),
    ).toEqual(["wrong_status", 1]);
    expect(
      verdict(slot(["not_applicable"], { status: "compliant", state: "escalated_by_system" })),
    ).toEqual(["wrong_status", 1]);
  });

  it("takes the largest factor that applies, and lists all of them in table order", () => {
    // Expected compliant, given deviation with an escalation: a false alarm (1) and a wrong
    // status (1) and an unnecessary escalation (0.5). The factor is 1.
    const s = slot(["compliant", { governing: ["G"] }], {
      status: "deviation",
      evidence: G,
      escalation: ["support_not_confirmed"],
    });
    expect(s.failures).toEqual(["false_alarm", "wrong_status", "unnecessary_escalation"]);
    expect(verdict(s)).toEqual(["false_alarm", 1]);
  });

  it("accepts an alternative status, and does not penalise it", () => {
    const alt = {
      governing: ["G"],
      acceptable: ["undetermined" as const],
      escalation: { mode: "allowed" as const, codes: ["defined_term_unresolved" as const] },
    };
    const s = slot(["deviation", alt], {
      status: "undetermined",
      escalation: ["defined_term_unresolved"],
      state: "escalated_by_system",
    });
    expect(s.statusCorrect).toBe(true);
    expect(verdict(s)).toEqual([null, 0]);
    // The primary answer is just as good.
    expect(verdict(slot(["deviation", alt], { status: "deviation", evidence: G }))).toEqual([
      null,
      0,
    ]);
    // Something else is still wrong: compliant for a deviation that allows undetermined.
    expect(verdict(slot(["deviation", alt], { status: "compliant" }))).toEqual(["silent_miss", 3]);
  });

  it("an alternative is not a strict true positive, because it is not the same flag", () => {
    const alt = { governing: ["G"], acceptable: ["undetermined" as const] };
    const s = slot(["deviation", alt], { status: "undetermined", escalation: ["model_abstained"] });
    expect(s.expectedFlag).toBe(true);
    expect(s.strictTruePositive).toBe(false);
    expect(s.lenientTruePositive).toBe(false);
  });

  it("a silent miss is not one when the key accepts the answer given", () => {
    const alt = { governing: ["G"], acceptable: ["compliant" as const] };
    const s = slot(["deviation", alt], { status: "compliant", evidence: G });
    expect(s.silentMiss).toBe(false);
    expect(s.statusCorrect).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------

describe("the observations are checked, because a harness bug is not a poor score", () => {
  const base = () => tinyObservations(0, "base");
  const score = (slots: SlotObservation[], extractions = base().extractions) =>
    scoreRepeat({ key: tinyKey(), repeat: 0, slots, extractions, resolver: tinyResolver });

  it("refuses a missing observation, naming the case, the rule and the repeat", () => {
    const slots = base().slots.filter((s) => !(s.caseKey === "CASE-B" && s.ruleKey === "pds-2"));
    expect(() => score(slots)).toThrow("CASE-B pds-2: no observation for repeat 0");
  });

  it("refuses a missing twin observation", () => {
    const slots = base().slots.filter((s) => s.caseKey !== "CASE-C-twin");
    expect(() => score(slots)).toThrow("CASE-C-twin exc-1: no observation for repeat 0");
  });

  it("refuses two observations for one slot", () => {
    const slots = base().slots;
    expect(() => score([...slots, slots[0]!])).toThrow(
      "CASE-A exc-1: two observations for repeat 0",
    );
  });

  it("refuses an observation of another repeat, of a rule or case the key lacks", () => {
    const slots = base().slots;
    expect(() => score([{ ...slots[0]!, repeat: 1 }, ...slots.slice(1)])).toThrow(
      "observation is for repeat 1, not 0",
    );
    expect(() => score([...slots, { ...slots[0]!, ruleKey: "zzz-9" }])).toThrow(
      "the rule is not in the key's playbook",
    );
    expect(() => score([...slots, { ...slots[0]!, caseKey: "CASE-Z" }])).toThrow(
      "the case is not in this split of the key",
    );
  });

  it("refuses a missing extraction or category", () => {
    const { extractions } = base();
    expect(() => score(base().slots, extractions.slice(1))).toThrow(
      "CASE-A: no extraction for repeat 0",
    );
    const noCategory = extractions.map((e) =>
      e.caseKey === "CASE-B"
        ? { ...e, categories: { exclusions: e.categories["exclusions"]! } }
        : e,
    );
    expect(() => score(base().slots, noCategory)).toThrow(
      "CASE-B permitted-disclosures: the extraction has no such category",
    );
    expect(() => score(base().slots, [...extractions, extractions[0]!])).toThrow(
      "CASE-A: two extractions for repeat 0",
    );
    expect(() =>
      score(
        base().slots,
        extractions.map((e) => ({ ...e, repeat: 3 })),
      ),
    ).toThrow("extraction is for repeat 3, not 0");
  });

  it("lets a resolver failure through, with the case in it, so a drifted document is not scored", () => {
    const failing = () => {
      throw new Error("anchor in CASE-A D1 clause 1: it occurs 0 times, expected once");
    };
    expect(() => scoreRepeat({ key: tinyKey(), repeat: 0, ...base(), resolver: failing })).toThrow(
      "anchor in CASE-A D1 clause 1",
    );
  });

  it("refuses a key with no expectation for one of its rules, or with a case twice", () => {
    const key = tinyKey();
    delete key.cases[0]!.expect["ret-1"];
    expect(() => scoreRepeat({ key, repeat: 0, ...base(), resolver: tinyResolver })).toThrow(
      "CASE-A ret-1: the key has no expectation",
    );
    const once = tinyKey();
    const twice = { ...once, cases: [...once.cases, once.cases[0]!] };
    expect(() => scoreRepeat({ key: twice, repeat: 0, ...base(), resolver: tinyResolver })).toThrow(
      ScoringError,
    );
  });

  it("counts a degraded extraction and still scores it", () => {
    const { slots, extractions } = base();
    const degraded = extractions.map((e) =>
      e.caseKey === "CASE-A" ? { ...e, degraded: true } : e,
    );
    expect(score(slots, degraded).extraction.degradedCases).toBe(1);
  });

  it("takes a located span twice in the same category as one", () => {
    const { slots, extractions } = base();
    const doubled = extractions.map((e) =>
      e.caseKey === "CASE-A"
        ? {
            ...e,
            categories: {
              ...e.categories,
              exclusions: { located: ["CASE-A:A1", "CASE-A:A1"], notFound: false },
            },
          }
        : e,
    );
    expect(score(slots, doubled).extraction.precision).toMatchObject({
      numerator: 9,
      denominator: 12,
    });
  });
});

describe("a rate type check", () => {
  it("rate() is what the metrics return", () => {
    expect(run().statusAccuracy).toEqual(rate(8, 12));
  });
});
