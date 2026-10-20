import { readFile, writeFile } from "node:fs/promises";
import type { RuleStatus } from "@clausewise/review";
import { createOracleGenerator, type OracleRule } from "@clausewise/review/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareResults, loadPrevious, type Previous } from "../src/compare.js";
import type { Fixture } from "../src/fixtures.js";
import type { EvalResult } from "../src/result.js";
import { oracleScripts } from "../src/selftest.js";
import { forbiddenFactory, makeTempDir, removeDir, run } from "./support.js";

let dir = "";
beforeAll(async () => {
  dir = await makeTempDir();
});
afterAll(async () => {
  await removeDir(dir);
});

// The earlier run, made by hand: every rule right except nda-aggressive term, which it called
// compliant. Its accuracy is 31 of 32 and its flag F1 is 38/39 (19 flags right, 1 missed).
function previousFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    selftest: false,
    startedAt: "2026-10-01T09:00:00.000Z",
    model: { provider: "anthropic", model: "claude-sonnet-5-5" },
    score: {
      accuracy: 31 / 32,
      flag: { f1: 38 / 39 },
      rules: [
        ...rulesOf("nda-aggressive.docx", {
          mutuality: "deviation",
          definition: "deviation",
          exclusions: "deviation",
          term: "compliant",
          "permitted-use": "deviation",
          "compelled-disclosure": "missing",
          "return-or-destroy": "deviation",
          remedies: "deviation",
          "restrictive-covenants": "deviation",
          "governing-law": "deviation",
        }),
        ...rulesOf("nda-balanced.docx", {
          mutuality: "compliant",
          definition: "compliant",
          exclusions: "compliant",
          term: "compliant",
          "permitted-use": "compliant",
          "compelled-disclosure": "compliant",
          "return-or-destroy": "not_applicable",
          remedies: "compliant",
          "restrictive-covenants": "compliant",
          "governing-law": "compliant",
        }),
        ...rulesOf("saas-vendor-friendly.docx", {
          "liability-cap": "deviation",
          "ip-indemnity": "deviation",
          "data-ownership": "deviation",
          "security-controls": "deviation",
          "breach-notice": "deviation",
          availability: "compliant",
          "term-renewal": "deviation",
          "price-increase": "deviation",
          "termination-refund": "deviation",
          suspension: "compliant",
          "data-return": "missing",
          "governing-law": "deviation",
        }),
      ],
    },
    ...overrides,
  };
}

const EXPECTED = JSON.parse(
  await readFile(new URL("../../fixtures/expected.json", import.meta.url), "utf8"),
) as Record<string, { rules: Record<string, string> }>;

function rulesOf(fixture: string, modals: Record<string, string>) {
  return Object.entries(modals).map(([ruleId, modal]) => {
    const raw = EXPECTED[fixture]?.rules[ruleId] ?? "";
    const expected = raw === "n/a" ? "not_applicable" : raw;
    return { fixture, ruleId, expected, modal, accuracy: modal === expected ? 1 : 0 };
  });
}

// Today's run gets nda-aggressive term right again, and gets three rules wrong that the earlier
// run had right:
//   nda-balanced mutuality               compliant => deviation
//   saas ip-indemnity                    deviation => compliant
//   nda-aggressive compelled-disclosure  missing => deviation
const TODAY: Record<string, Record<string, RuleStatus>> = {
  "nda-balanced.docx": { mutuality: "deviation" },
  "saas-vendor-friendly.docx": { "ip-indemnity": "compliant" },
  "nda-aggressive.docx": { "compelled-disclosure": "deviation" },
};

const todaysModel = ({ fixture }: { fixture: Fixture }) => {
  const scripts: Record<string, OracleRule> = oracleScripts(fixture);
  for (const [ruleId, status] of Object.entries(TODAY[fixture.name] ?? {})) {
    scripts[ruleId] = { status: status as OracleRule["status"] };
  }
  return createOracleGenerator(scripts);
};

describe("--compare", () => {
  it("lists regressions first, then improvements, and gives the accuracy and F1 deltas", async () => {
    const previous = `${dir}/previous.json`;
    await writeFile(previous, JSON.stringify(previousFile()));
    const out = `${dir}/today.json`;
    const { code, stdout } = await run(["--selftest", "--compare", previous, "--out", out], {
      dir,
      generatorFactory: todaysModel,
    });
    expect(code).toBe(0);
    const today = JSON.parse(await readFile(out, "utf8")) as EvalResult;

    // 3 of 32 are wrong today, so 29 are right: 90.6%. The mutuality and ip-indemnity slips cost
    // one flag each and compelled-disclosure stays flagged (as a deviation instead of missing):
    //   flags right: 20 - 1 (ip-indemnity missed) = 19, false alarms: 1 (nda-balanced mutuality)
    //   F1 = 2 x 19 / (2 x 19 + 1 + 1) = 38/40
    expect(today.score.accuracy).toBeCloseTo(29 / 32, 12);
    expect(today.score.flag.f1).toBeCloseTo(38 / 40, 12);

    const regressions = stdout.indexOf("### Regressions (3)");
    const improvements = stdout.indexOf("### Improvements (1)");
    expect(regressions).toBeGreaterThan(-1);
    expect(improvements).toBeGreaterThan(regressions);

    expect(stdout).toContain(
      "| nda-balanced.docx | mutuality | compliant | compliant (100.0%) | deviation (0.0%) |",
    );
    expect(stdout).toContain(
      "| saas-vendor-friendly.docx | ip-indemnity | deviation | deviation (100.0%) | compliant (0.0%) |",
    );
    expect(stdout).toContain(
      "| nda-aggressive.docx | compelled-disclosure | missing | missing (100.0%) | deviation (0.0%) |",
    );
    expect(stdout).toContain(
      "| nda-aggressive.docx | term | deviation | compliant (0.0%) | deviation (100.0%) |",
    );

    // 31/32 => 29/32 is minus 6.3 points, and F1 from 38/39 (97.4%) to 38/40 (95.0%).
    expect(stdout).toContain("| Exact status accuracy | 96.9% | 90.6% | -6.3 points |");
    expect(stdout).toContain("| Flag F1 | 97.4% | 95.0% | -2.4 points |");
    expect(stdout).toContain("Unchanged: 28. Only in this run: 0. Only in the earlier run: 0.");
  });

  it("separates a rule that gives a different wrong answer from one that got worse", () => {
    const previous = previousFile() as unknown as Previous;
    const current = {
      score: {
        accuracy: 0.5,
        flag: { f1: 0.5 },
        rules: [
          {
            fixture: "nda-aggressive.docx",
            ruleId: "term",
            expected: "deviation",
            modal: "missing",
            accuracy: 0,
          },
          {
            fixture: "nda-aggressive.docx",
            ruleId: "mutuality",
            expected: "deviation",
            modal: "deviation",
            accuracy: 2 / 3,
          },
          {
            fixture: "extra.docx",
            ruleId: "new-rule",
            expected: "compliant",
            modal: "compliant",
            accuracy: 1,
          },
        ],
      },
    } as unknown as EvalResult;
    const comparison = compareResults(previous, current);
    // term was wrong before (compliant) and is wrong now (missing).
    expect(comparison.changed.map((item) => item.ruleId)).toEqual(["term"]);
    // mutuality was right every time and is now right two times in three.
    expect(comparison.regressions.map((item) => item.ruleId)).toEqual(["mutuality"]);
    expect(comparison.improvements).toEqual([]);
    expect(comparison.onlyNow).toBe(1);
    expect(comparison.onlyBefore).toBe(30);
    expect(comparison.accuracyDelta).toBeCloseTo(0.5 - 31 / 32, 12);
    expect(comparison.f1Delta).toBeCloseTo(0.5 - 38 / 39, 12);
  });

  it("has no delta when either side has no figure", () => {
    const previous = previousFile({
      score: { accuracy: null, flag: { f1: null }, rules: [] },
    }) as unknown as Previous;
    const current = {
      score: { accuracy: 0.5, flag: { f1: 0.5 }, rules: [] },
    } as unknown as EvalResult;
    expect(compareResults(previous, current)).toMatchObject({ accuracyDelta: null, f1Delta: null });
  });

  it("warns when one of the two runs is a selftest", async () => {
    const previous = `${dir}/real.json`;
    await writeFile(previous, JSON.stringify(previousFile()));
    const { stdout } = await run(
      ["--selftest", "--compare", previous, "--out", `${dir}/warn.json`],
      { dir },
    );
    expect(stdout).toContain(
      "One of the two runs is a selftest, so the comparison is not meaningful.",
    );
  });

  it("is checked before anything is planned or sent", async () => {
    const factory = forbiddenFactory();
    for (const [name, content] of [
      ["missing.json", undefined],
      ["garbage.json", "{ not json"],
      ["other.json", JSON.stringify({ hello: "world" })],
    ] as const) {
      const path = `${dir}/${name}`;
      if (content !== undefined) await writeFile(path, content);
      const { code, stderr } = await run(["--yes", "--compare", path], {
        dir,
        generatorFactory: factory,
      });
      expect(code).toBe(1);
      expect(stderr).toContain(`Cannot compare with ${path}`);
    }
    expect(factory.used()).toBe(false);
  });

  it("loads the file a previous run wrote", async () => {
    const out = `${dir}/roundtrip.json`;
    await run(["--selftest", "--out", out], { dir });
    const previous = await loadPrevious(out);
    expect(previous.selftest).toBe(true);
    expect(previous.score.accuracy).toBe(1);
    expect(previous.score.rules).toHaveLength(32);
  });
});
