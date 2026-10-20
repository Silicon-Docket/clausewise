import { readFile } from "node:fs/promises";
import type { Playbook } from "@clausewise/playbook";
import type { ReviewReport, RuleResult, RuleStatus } from "@clausewise/review";
import { createOracleGenerator, type OracleRule } from "@clausewise/review/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExpectedStatus, Fixture } from "../src/fixtures.js";
import type { EvalResult } from "../src/result.js";
import { computeScore, type RunRecord } from "../src/score.js";
import { oracleScripts } from "../src/selftest.js";
import { failingRules, makeTempDir, removeDir, run } from "./support.js";

let dir = "";
beforeAll(async () => {
  dir = await makeTempDir();
});
afterAll(async () => {
  await removeDir(dir);
});

async function selftest(
  name: string,
  extra: string[] = [],
  io: Omit<Parameters<typeof run>[1], "dir"> = {},
): Promise<{ result: EvalResult; stdout: string; stderr: string; code: number }> {
  const out = `${dir}/${name}.json`;
  const captured = await run(["--selftest", "--out", out, ...extra], { dir, ...io });
  const result = JSON.parse(await readFile(out, "utf8")) as EvalResult;
  return { result, ...captured };
}

describe("a perfect oracle", () => {
  it("scores every rule, and flagging, perfectly", async () => {
    const { result, stdout, code } = await selftest("perfect");
    expect(code).toBe(0);
    expect(result.score).toMatchObject({
      total: 32,
      correct: 32,
      accuracy: 1,
      errored: 0,
      flag: {
        truePositives: 20,
        falseAlarms: 0,
        misses: 0,
        trueNegatives: 12,
        precision: 1,
        recall: 1,
        f1: 1,
      },
    });
    // Counted by hand from fixtures/expected.json: 11 compliant, 18 deviation, 2 missing, 1 n/a.
    expect(result.score.confusion).toEqual({
      compliant: { compliant: 11, deviation: 0, missing: 0, not_applicable: 0, error: 0 },
      deviation: { compliant: 0, deviation: 18, missing: 0, not_applicable: 0, error: 0 },
      missing: { compliant: 0, deviation: 0, missing: 2, not_applicable: 0, error: 0 },
      not_applicable: { compliant: 0, deviation: 0, missing: 0, not_applicable: 1, error: 0 },
    });
    expect(result.score.integrityFailures).toEqual([]);
    expect(stdout).toContain("| Exact status accuracy | 32/32 (100.0%) |");
    expect(stdout).toContain("| Flag F1 | 100.0% |");
  });

  it("maps n/a to not_applicable and reports the status the model gave for every rule", async () => {
    const { result } = await selftest("mapping");
    const rule = result.score.rules.find(
      (item) => item.fixture === "nda-balanced.docx" && item.ruleId === "return-or-destroy",
    );
    expect(rule).toMatchObject({
      expected: "not_applicable",
      got: ["not_applicable"],
      accuracy: 1,
    });
  });

  it("applies the scripted edits as tracked changes", async () => {
    const { result } = await selftest("edits");
    expect(result.score.edits).toEqual({
      deviations: 18,
      proposed: 18,
      applied: 18,
      commentOnly: 0,
      fallbackReasons: [],
    });
  });
});

// ---------------------------------------------------------------------------------------------
// A noisy oracle. Everything below is counted by hand from fixtures/expected.json.
//
//   nda-aggressive.docx, 9 deviation and 1 missing
//     mutuality             deviation => compliant   (a miss)
//     term                  deviation => missing     (still flagged, wrong kind)
//     compelled-disclosure  missing   => compliant   (a miss)
//   nda-balanced.docx, 9 compliant and 1 not applicable
//     governing-law         compliant => deviation   (a false alarm)
//     term                  compliant => missing     (a false alarm)
//     return-or-destroy     n/a       => deviation   (a false alarm)
//   saas-vendor-friendly.docx, 9 deviation, 2 compliant and 1 missing
//     suspension            compliant => deviation   (a false alarm)
//     data-return           missing   => deviation   (still flagged, wrong kind)
//     ip-indemnity          deviation => error       (the model call fails: a miss)
// ---------------------------------------------------------------------------------------------

const FLIPS: Record<string, Record<string, RuleStatus>> = {
  "nda-aggressive.docx": {
    mutuality: "compliant",
    term: "missing",
    "compelled-disclosure": "compliant",
  },
  "nda-balanced.docx": {
    "governing-law": "deviation",
    term: "missing",
    "return-or-destroy": "deviation",
  },
  "saas-vendor-friendly.docx": { suspension: "deviation", "data-return": "deviation" },
};

function noisyScripts(fixture: Fixture): Record<string, OracleRule> {
  const scripts = oracleScripts(fixture);
  for (const [ruleId, status] of Object.entries(FLIPS[fixture.name] ?? {})) {
    scripts[ruleId] = { status: status as OracleRule["status"] };
  }
  return scripts;
}

const noisyModel = ({ fixture }: { fixture: Fixture }) => {
  const oracle = createOracleGenerator(noisyScripts(fixture));
  return fixture.name === "saas-vendor-friendly.docx"
    ? failingRules(oracle, ["ip-indemnity"])
    : oracle;
};

describe("a noisy oracle", () => {
  it("gives exactly the hand-counted confusion matrix, precision, recall, misses and false alarms", async () => {
    const { result, stdout, code } = await selftest("noisy", [], { generatorFactory: noisyModel });
    expect(code).toBe(0);

    expect(result.score.confusion).toEqual({
      compliant: { compliant: 8, deviation: 2, missing: 1, not_applicable: 0, error: 0 },
      deviation: { compliant: 1, deviation: 15, missing: 1, not_applicable: 0, error: 1 },
      missing: { compliant: 1, deviation: 1, missing: 0, not_applicable: 0, error: 0 },
      not_applicable: { compliant: 0, deviation: 1, missing: 0, not_applicable: 0, error: 0 },
    });
    expect(result.score).toMatchObject({ total: 32, correct: 23, errored: 1 });
    expect(result.score.accuracy).toBeCloseTo(23 / 32, 12);

    // 17 flags were right (15 + 1 + 1), 3 were missed (1 + 1 error + 1), 4 were false alarms
    // (2 + 1 + 1), and 8 compliant or n/a rules were rightly left alone.
    expect(result.score.flag).toMatchObject({
      truePositives: 17,
      misses: 3,
      falseAlarms: 4,
      trueNegatives: 8,
    });
    expect(result.score.flag.precision).toBeCloseTo(17 / 21, 12);
    expect(result.score.flag.recall).toBeCloseTo(17 / 20, 12);
    expect(result.score.flag.f1).toBeCloseTo(34 / 41, 12);

    // The same numbers reach the report.
    expect(stdout).toContain("| Exact status accuracy | 23/32 (71.9%) |");
    expect(stdout).toContain("| Flag precision | 17/21 (81.0%) |");
    expect(stdout).toContain("| Flag recall | 17/20 (85.0%) |");
    expect(stdout).toContain("| False alarms | 4 |");
    expect(stdout).toContain("| Misses | 3 |");
    expect(stdout).toContain("| Rules that errored | 1 |");
  });

  it("counts a failed rule as an error and carries on", async () => {
    const { result, code } = await selftest("noisy-error", [], { generatorFactory: noisyModel });
    expect(code).toBe(0);
    const errored = result.runs
      .flatMap((record) => record.report.results)
      .filter((item) => item.status === "error");
    expect(errored.map((item) => item.ruleId)).toEqual(["ip-indemnity"]);
    expect(result.score.rules.find((rule) => rule.ruleId === "ip-indemnity")).toMatchObject({
      expected: "deviation",
      got: ["error"],
      accuracy: 0,
    });
  });

  it("counts edits only for the deviations that remain", async () => {
    const { result } = await selftest("noisy-edits", [], { generatorFactory: noisyModel });
    // 19 deviations: 7 in the first contract, 2 in the second and 10 in the third. The flipped
    // ones have no scripted edit, so 7 + 8 of them were applied.
    expect(result.score.edits).toMatchObject({
      deviations: 19,
      proposed: 15,
      applied: 15,
      commentOnly: 0,
    });
    expect(result.score.integrityFailures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Synthetic reports, to pin down the arithmetic of stability and of the edit fallbacks
// ---------------------------------------------------------------------------------------------

function fixtureWith(expected: Record<string, ExpectedStatus>): Fixture {
  const playbook: Playbook = {
    name: "Test playbook",
    contractTypes: ["test"],
    perspective: "Test.",
    rules: Object.keys(expected).map((id) => ({
      id,
      title: id,
      severity: "medium" as const,
      required: false,
      standard: "Test.",
    })),
  };
  return {
    name: "synthetic.docx",
    playbookPath: "synthetic.yaml",
    playbook,
    docx: new Uint8Array(),
    expected,
  };
}

function resultFor(ruleId: string, status: RuleStatus, edit?: RuleResult["edit"]): RuleResult {
  return {
    ruleId,
    title: ruleId,
    severity: "medium",
    required: false,
    status,
    clauseIds: [],
    clauseNumbers: [],
    explanation: "",
    comment: "",
    suggestedClause: null,
    edit: edit ?? { kind: "none" },
  };
}

function record(runNumber: number, results: RuleResult[]): RunRecord {
  const report = { results } as unknown as ReviewReport;
  return {
    fixture: "synthetic.docx",
    run: runNumber,
    report,
    integrity: { ok: true, problems: [], paragraphs: 0, trackedChanges: 0, reportedChanges: 0 },
    calls: results.length,
    usage: null,
  };
}

describe("stability over several runs", () => {
  const fixture = fixtureWith({
    a: "compliant",
    b: "deviation",
    c: "deviation",
    d: "compliant",
  });
  const runs = [
    record(1, [
      resultFor("a", "compliant"),
      resultFor("b", "deviation"),
      resultFor("c", "deviation"),
      resultFor("d", "error"),
    ]),
    record(2, [
      resultFor("a", "compliant"),
      resultFor("b", "deviation"),
      resultFor("c", "compliant"),
      resultFor("d", "compliant"),
    ]),
    record(3, [
      resultFor("a", "compliant"),
      resultFor("b", "compliant"),
      resultFor("c", "missing"),
      resultFor("d", "compliant"),
    ]),
  ];
  const score = computeScore([fixture], runs);
  const rule = (id: string) => score.rules.find((item) => item.ruleId === id);

  it("gives each rule the share of runs that agree with its most common status", () => {
    expect(rule("a")).toMatchObject({ modal: "compliant", agreement: 1, accuracy: 1 });
    expect(rule("b")).toMatchObject({ modal: "deviation", accuracy: 2 / 3 });
    expect(rule("b")?.agreement).toBeCloseTo(2 / 3, 12);
    expect(rule("d")).toMatchObject({
      modal: "compliant",
      got: ["error", "compliant", "compliant"],
    });
    expect(rule("d")?.agreement).toBeCloseTo(2 / 3, 12);
  });

  it("breaks a three-way tie towards the status listed first, whatever the agreement", () => {
    expect(rule("c")).toMatchObject({ modal: "compliant" });
    expect(rule("c")?.agreement).toBeCloseTo(1 / 3, 12);
    expect(rule("c")?.accuracy).toBeCloseTo(1 / 3, 12);
  });

  it("lists the unstable rules, least stable first, and the mean agreement", () => {
    expect(score.stability?.runs).toBe(3);
    expect(score.stability?.unstable.map((item) => item.ruleId)).toEqual(["c", "b", "d"]);
    expect(score.stability?.meanAgreement).toBeCloseTo((1 + 2 / 3 + 1 / 3 + 2 / 3) / 4, 12);
  });

  it("scores every review, not only the modal one", () => {
    // Twelve answers: a is right 3 times, b 2, c 1 and d 2.
    expect(score).toMatchObject({ total: 12, correct: 8, errored: 1 });
  });

  it("reports no stability for a single review", () => {
    expect(computeScore([fixture], [runs[0] as RunRecord]).stability).toBeNull();
  });
});

describe("edit fallbacks", () => {
  const fixture = fixtureWith({ a: "deviation", b: "deviation", c: "deviation", d: "deviation" });
  const proposed = { clauseId: "c1", quote: "x", replacement: "y" };
  const results = [
    resultFor("a", "deviation", {
      kind: "comment-only",
      proposed,
      reason:
        "the quote is ambiguous: it occurs 2 times in the clause, so it does not identify one span",
    }),
    resultFor("b", "deviation", {
      kind: "comment-only",
      proposed,
      reason:
        "the quote is ambiguous: it occurs 3 times in the clause, so it does not identify one span",
    }),
    resultFor("c", "deviation", {
      kind: "comment-only",
      proposed,
      reason: "the quote was not found within a single paragraph of the clause",
    }),
    resultFor("d", "deviation"),
  ];

  it("groups the reasons once their numbers are blurred", () => {
    const { edits } = computeScore([fixture], [record(1, results)]);
    expect(edits).toEqual({
      deviations: 4,
      proposed: 3,
      applied: 0,
      commentOnly: 3,
      fallbackReasons: [
        {
          reason:
            "the quote is ambiguous: it occurs N times in the clause, so it does not identify one span",
          count: 2,
        },
        { reason: "the quote was not found within a single paragraph of the clause", count: 1 },
      ],
    });
  });
});
