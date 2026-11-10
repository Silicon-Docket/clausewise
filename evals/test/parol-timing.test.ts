import { describe, expect, it } from "vitest";
import {
  CORRECTION_FIELDS,
  correctionRate,
  exposureCount,
  normalizedEditDistance,
  scoreCalibration,
  type CalibrationPair,
  type DecisionRecord,
} from "../src/parol/suites.js";
import {
  STAGES,
  summarizeCost,
  summarizeLatency,
  type CostRecord,
  type LatencyRecord,
} from "../src/parol/timing.js";

const latency = (
  caseKey: string,
  totalMs: number,
  outcome: "succeeded" | "failed" = "succeeded",
  stagesMs: LatencyRecord["stagesMs"] = {},
): LatencyRecord => ({ caseKey, repeat: 0, outcome, totalMs, stagesMs });

describe("latency", () => {
  // Ten completed runs of 100 ms to 1000 ms, and one failed run that must not count.
  const records = [
    ...Array.from({ length: 10 }, (_, i) => latency(`C${i}`, (i + 1) * 100)),
    latency("FAILED", 99_999, "failed"),
  ];

  it("summarises completed runs: p50, p95, mean, max", () => {
    const { total, completed } = summarizeLatency(records);
    expect(completed).toBe(10);
    // Nearest rank: p50 is the ceil(0.5 x 10) = 5th value, 500. p95 is the ceil(9.5) = 10th, 1000.
    expect(total).toEqual({ n: 10, min: 100, mean: 550, p50: 500, p95: 1000, max: 1000 });
  });

  it("lists failed runs apart and keeps them out of every percentile", () => {
    const summary = summarizeLatency(records);
    expect(summary.failed).toEqual([{ caseKey: "FAILED", repeat: 0 }]);
    expect(summary.total.max).toBe(1000);
  });

  it("summarises each stage over the completed runs that report it", () => {
    const summary = summarizeLatency([
      latency("A", 1000, "succeeded", { ingest: 10, extract: 400, analyze: 500 }),
      latency("B", 2000, "succeeded", { ingest: 30, extract: 800, analyze: 1100 }),
      latency("C", 3000, "succeeded", { ingest: 20, analyze: 1900 }),
      latency("D", 9000, "failed", { ingest: 5000 }),
    ]);
    expect(summary.stages.ingest).toEqual({ n: 3, min: 10, mean: 20, p50: 20, p95: 30, max: 30 });
    expect(summary.stages.extract).toEqual({
      n: 2,
      min: 400,
      mean: 600,
      p50: 400,
      p95: 800,
      max: 800,
    });
    expect(summary.stages.analyze?.p50).toBe(1100);
    expect(summary.stages.retrieve).toBeUndefined();
    expect(summary.stages.verify).toBeUndefined();
    expect([...STAGES]).toEqual(["ingest", "extract", "retrieve", "analyze", "verify"]);
  });

  it("has no values when no run completed", () => {
    expect(summarizeLatency([]).total).toEqual({
      n: 0,
      min: null,
      mean: null,
      p50: null,
      p95: null,
      max: null,
    });
    const onlyFailed = summarizeLatency([latency("X", 5, "failed")]);
    expect(onlyFailed.completed).toBe(0);
    expect(onlyFailed.total.p95).toBeNull();
    expect(onlyFailed.failed).toHaveLength(1);
  });

  it("takes the 19th of 20 as the p95, so one slow run in 20 does not move it", () => {
    const twenty = [
      ...Array.from({ length: 19 }, (_, i) => latency(`C${i}`, 1000)),
      latency("S", 60_000),
    ];
    expect(summarizeLatency(twenty).total.p95).toBe(1000);
    expect(summarizeLatency(twenty).total.max).toBe(60_000);
  });
});

const cost = (
  usd: number,
  tokens: [input: number, cacheRead: number, cacheWrite: number],
  outcome: "succeeded" | "failed" = "succeeded",
): CostRecord => ({
  caseKey: "C",
  repeat: 0,
  outcome,
  inputTokens: tokens[0],
  outputTokens: 50,
  cacheReadTokens: tokens[1],
  cacheWriteTokens: tokens[2],
  costUsd: usd,
});

describe("cost", () => {
  it("sums, averages and finds the maximum over the runs started, a failed run included", () => {
    const summary = summarizeCost([
      cost(0.1, [1000, 3000, 0]),
      cost(0.2, [2000, 0, 2000]),
      cost(0.3, [500, 1500, 0]),
      cost(0.4, [4000, 0, 0], "failed"),
    ]);
    expect(summary.runs).toBe(4);
    expect(summary.failedRuns).toBe(1);
    expect(summary.totalUsd).toBeCloseTo(1.0, 12);
    expect(summary.meanUsd).toBeCloseTo(0.25, 12);
    expect(summary.maxUsd).toBe(0.4);
  });

  it("reports the share of prompt tokens read from the cache", () => {
    // Prompt tokens are input + cache read + cache write: 4000 + 4000 + 2000 + 4000 = 14000.
    // Read from the cache: 3000 + 0 + 1500 + 0 = 4500. 4500 / 14000.
    const summary = summarizeCost([
      cost(0.1, [1000, 3000, 0]),
      cost(0.2, [2000, 0, 2000]),
      cost(0.3, [500, 1500, 0]),
      cost(0.4, [4000, 0, 0], "failed"),
    ]);
    expect(summary.promptTokens).toBe(1000 + 3000 + 2000 + 2000 + 500 + 1500 + 4000);
    expect(summary.cacheReadTokens).toBe(4500);
    expect(summary.cacheReadShare).toBeCloseTo(4500 / 14000, 12);
  });

  it("has no mean, maximum or share for no runs, or for runs without prompt tokens", () => {
    expect(summarizeCost([])).toEqual({
      runs: 0,
      failedRuns: 0,
      totalUsd: 0,
      meanUsd: null,
      maxUsd: null,
      promptTokens: 0,
      cacheReadTokens: 0,
      cacheReadShare: null,
    });
    expect(summarizeCost([cost(0, [0, 0, 0])]).cacheReadShare).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

describe("support checker calibration", () => {
  const pair = (
    label: CalibrationPair["label"],
    verdict: CalibrationPair["verdict"],
    kind?: string,
  ): CalibrationPair => ({ label, verdict, ...(kind === undefined ? {} : { kind }) });

  it("counts unsupported pairs caught as not_supported or insufficient, and false alarms", () => {
    const result = scoreCalibration([
      pair("unsupported", "not_supported"),
      pair("unsupported", "insufficient"),
      pair("unsupported", "supported"),
      pair("unsupported", "not_supported"),
      pair("supported", "supported"),
      pair("supported", "supported"),
      pair("supported", "insufficient"),
    ]);
    expect(result.catchRate).toMatchObject({ numerator: 3, denominator: 4 });
    expect(result.falseAlarmRate).toMatchObject({ numerator: 1, denominator: 3 });
    expect(result.catchRate.value).toBe(0.75);
  });

  it("breaks the catch rate down by kind of unsupported pair", () => {
    const result = scoreCalibration([
      pair("unsupported", "not_supported", "superseded"),
      pair("unsupported", "supported", "superseded"),
      pair("unsupported", "insufficient", "other_party"),
      pair("supported", "supported"),
    ]);
    expect(Object.keys(result.catchByKind)).toEqual(["other_party", "superseded"]);
    expect(result.catchByKind["superseded"]).toMatchObject({ numerator: 1, denominator: 2 });
    expect(result.catchByKind["other_party"]).toMatchObject({ numerator: 1, denominator: 1 });
  });

  it("counts a call that returned no verdict against the checker on both sides", () => {
    const result = scoreCalibration([
      pair("unsupported", "failed"),
      pair("unsupported", "not_supported"),
      pair("supported", "failed"),
      pair("supported", "supported"),
    ]);
    // The failed call on the unsupported pair is not a catch, and on the supported pair it is an alarm.
    expect(result.catchRate).toMatchObject({ numerator: 1, denominator: 2 });
    expect(result.falseAlarmRate).toMatchObject({ numerator: 1, denominator: 2 });
  });

  it("has no rate for a half that is empty", () => {
    const result = scoreCalibration([pair("supported", "supported")]);
    expect(result.catchRate.value).toBeNull();
    expect(result.falseAlarmRate).toMatchObject({ numerator: 0, denominator: 1, value: 0 });
    expect(scoreCalibration([]).falseAlarmRate.value).toBeNull();
  });
});

describe("unauthorized-data exposure", () => {
  it("is the sum of probes answered with data, canary strings and ids of another matter", () => {
    const ran = {
      probesRun: 64,
      artefactsScanned: 200,
      letInNotReached: 0,
      mismatches: 0,
      factSightings: 0,
    };
    expect(
      exposureCount({ ...ran, probesAnsweredWithData: 0, canaryHits: 0, foreignSpanIdHits: 0 }),
    ).toBe(0);
    expect(
      exposureCount({ ...ran, probesAnsweredWithData: 2, canaryHits: 3, foreignSpanIdHits: 1 }),
    ).toBe(6);
  });

  it("does not count the probes run and artefacts scanned as exposure", () => {
    // They are the denominator of the gate, not a fault.
    expect(
      exposureCount({
        probesRun: 64,
        artefactsScanned: 200,
        probesAnsweredWithData: 0,
        canaryHits: 0,
        foreignSpanIdHits: 0,
        letInNotReached: 0,
        mismatches: 0,
        factSightings: 0,
      }),
    ).toBe(0);
  });
});

describe("reviewer correction rate", () => {
  it("measures edits and rejects over decided findings, and the fields edited", () => {
    const decisions: DecisionRecord[] = [
      ...Array.from({ length: 5 }, (): DecisionRecord => ({ decision: "accept" })),
      { decision: "edit", editedFields: ["status"] },
      {
        decision: "edit",
        editedFields: ["evidence", "fallback"],
        fallback: { before: "abcd", after: "abxd" },
      },
      {
        decision: "edit",
        editedFields: ["fallback"],
        fallback: { before: "abcd", after: "abcdefgh" },
      },
      { decision: "reject" },
      { decision: "escalate" },
    ];
    const result = correctionRate(decisions);
    // 10 decided; 3 edits and 1 reject are corrections; an escalation is not.
    expect(result.overall).toMatchObject({ numerator: 4, denominator: 10 });
    expect(result.byField.status).toMatchObject({ numerator: 1, denominator: 10 });
    expect(result.byField.evidence).toMatchObject({ numerator: 1, denominator: 10 });
    expect(result.byField.fallback).toMatchObject({ numerator: 2, denominator: 10 });
    expect(result.byField.discrepancy).toMatchObject({ numerator: 0, denominator: 10 });
    expect(Object.keys(result.byField)).toEqual([...CORRECTION_FIELDS]);
    // abcd to abxd: one substitution over 4 = 0.25. abcd to abcdefgh: four insertions over 8 = 0.5.
    expect(result.fallbackEditDistance.n).toBe(2);
    expect(result.fallbackEditDistance.mean).toBeCloseTo(0.375, 12);
  });

  it("has no rate with no decisions and no distance with no fallback edit", () => {
    const empty = correctionRate([]);
    expect(empty.overall.value).toBeNull();
    expect(empty.fallbackEditDistance).toEqual({ n: 0, mean: null });
  });

  it("normalises the edit distance by the longer text", () => {
    expect(normalizedEditDistance("kitten", "sitting")).toBeCloseTo(3 / 7, 12);
    expect(normalizedEditDistance("abc", "abc")).toBe(0);
    expect(normalizedEditDistance("", "")).toBe(0);
    expect(normalizedEditDistance("abc", "")).toBe(1);
    expect(normalizedEditDistance("", "abcd")).toBe(1);
    expect(normalizedEditDistance("flaw", "lawn")).toBeCloseTo(2 / 4, 12);
  });
});
