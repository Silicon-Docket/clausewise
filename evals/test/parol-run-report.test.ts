import { readdir, readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareResults, renderComparison } from "../src/parol/compare.js";
import { evaluateGates } from "../src/parol/gates.js";
import { md, rateCell, table } from "../src/parol/format.js";
import { renderReport } from "../src/parol/report.js";
import { parseResults, type ResultsFile } from "../src/parol/results.js";
import { summarizeRates, summarizeRun } from "../src/parol/score.js";
import { rate } from "../src/parol/stats.js";
import { repeatMetrics } from "../src/parol/testing.js";
import { makeTempDir, removeDir, run } from "../src/parol/testing-run.js";

// The style rule bans en and em dashes. The pattern is built from code points so this file has none.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

/**
 * The files here are FABRICATED FOR A TEST: a real selftest file edited so that its metrics are
 * built from counts, including counts of zero. No model produced any number in this file.
 */

let dir = "";
let template: ResultsFile;
let selftestReport = "";
let simulatedReport = "";
beforeAll(async () => {
  dir = await makeTempDir();
  const read = async (
    args: string[],
    folder: string,
  ): Promise<{ file: ResultsFile; stdout: string }> => {
    const out = await run(args, { resultsDir: `${dir}/${folder}` });
    expect(out.code, out.stderr).toBe(0);
    const [name] = await readdir(`${dir}/${folder}`);
    return {
      file: parseResults(await readFile(`${dir}/${folder}/${name}`, "utf8")),
      stdout: out.stdout,
    };
  };
  const st = await read(["--selftest"], "st");
  template = st.file;
  selftestReport = st.stdout;
  simulatedReport = (await read(["--simulate"], "sim")).stdout;
});
afterAll(async () => {
  await removeDir(dir);
});

const clone = (): ResultsFile => JSON.parse(JSON.stringify(template)) as ResultsFile;

/** A live-looking file whose repeats are made from the given counts. */
function withMetrics(repeats: ReturnType<typeof repeatMetrics>[]): ResultsFile {
  const file = clone();
  file.mode = "live";
  file.selftest = false;
  file.banner = null;
  file.pins.mode = "live";
  file.pins.repeats = repeats.length;
  const section = file.sections[0]!;
  const run = { repeats, stability: null };
  section.completedRepeats = repeats.length;
  section.metrics = { repeats, stability: null, summary: summarizeRun(run) };
  section.gates = evaluateGates({ run });
  return file;
}

const NOTHING = { swf: null, injectionSlots: 0 } as const;

describe("a metric whose denominator is zero", () => {
  it("is n/a with counts of 0 of 0, and no score is printed for it", () => {
    const text = renderReport(withMetrics([repeatMetrics(1, NOTHING)]));
    const rows = text
      .split("\n")
      .filter((line) =>
        /^\| (Status accuracy|Issue recall|Issue precision|Required escalation|Unnecessary escalation|Extraction span|Not-found|Model citation|Displayed citation|Substantive|Injection)/.test(
          line,
        ),
      );
    expect(rows.length).toBe(14);
    for (const row of rows) {
      const cells = row.split(" | ").map((c) => c.replace(/^\| | \|$/g, ""));
      expect(cells.slice(1), row).toEqual(["n/a", "0 of 0", "n/a"]);
    }
    // Nor does a perfect-looking number appear anywhere in the table of rates.
    const rates = text.slice(text.indexOf("| Metric |"), text.indexOf("| Count |"));
    expect(rates).not.toMatch(/1\.000|0\.000|100/);
    // The weighted failure has nothing to weigh, and says so instead of printing 0.
    expect(text).toContain("| Severity-weighted failure (SWF) | n/a | n/a (nothing to weigh) |");
    expect(text).toContain("| Stability (mean modal agreement) | n/a |");
  });

  it("leaves the gates that depend on it not evaluated, and does not report them as passed", () => {
    const file = withMetrics([repeatMetrics(1, NOTHING)]);
    const text = renderReport(file);
    const gates = file.sections[0]!.gates!;
    // G3 (injection effect) has no injection slots, G2 no displayed quotes, G6 no expected flags.
    for (const id of ["G2", "G3", "G6", "G7", "G8", "G9", "G10"]) {
      expect(gates.results.find((r) => r.id === id)!.outcome, id).toBe("not_evaluated");
    }
    expect(gates.failed).toEqual([]);
    expect(text).toMatch(/\| G6 \| Issue recall \(strict\) \| [^|]+ \| not evaluated \|/);
    // A count that is out of nothing is not a pass either, for the gates that are about a rate.
    for (const id of ["G2", "G3", "G6", "G7", "G8", "G9", "G10"]) {
      expect(text, id).not.toMatch(new RegExp(`\\| ${id} \\|[^\\n]*\\| pass \\|`));
    }
    expect(text).toContain("Gates failed: none. Gates not evaluated:");
  });

  it("is n/a in the cell of a comparison too, and a change from or to it is n/a", () => {
    const a = withMetrics([repeatMetrics(1, NOTHING)]);
    const b = withMetrics([repeatMetrics(1, { ...NOTHING, strictRecall: [3, 4] })]);
    b.pins.workflow = { ...b.pins.workflow, label: "v2" };
    const c = compareResults(a, b, { allow: ["workflow"] });
    if (!c.ok) throw new Error("expected a comparison");
    const row = c.sections[0]!.rows.find((r) => r.metric === "Issue recall, strict (count)")!;
    expect(row).toMatchObject({
      baseline: "n/a (0 of 0)",
      candidate: "0.750 (3 of 4)",
      change: "n/a",
    });
    const text = renderComparison(c, { baseline: "v1", candidate: "v2" });
    expect(text).toContain(
      "| Issue recall, strict (count) | n/a (0 of 0) | 0.750 (3 of 4) | n/a |",
    );
  });

  it("is n/a for the mean of a run when it has a value in only some repeats, and says how many", () => {
    const cell = rateCell(summarizeRates([rate(17, 18), rate(0, 0), rate(18, 18)]));
    expect(cell.result).toBe("mean 0.972 (range 0.944 to 1.000), 2 of 3 repeats had a value");
    expect(cell.counts).toBe("17 of 18; 0 of 0; 18 of 18");
    expect(cell.interval).toMatch(/^0\.74 to 0\.99; n\/a; 0\.82 to 1\.00$/);
    expect(rateCell(summarizeRates([rate(0, 0), rate(0, 0)])).result).toBe("n/a");
    expect(rateCell(summarizeRates([])).result).toBe("n/a");
  });
});

describe("the report of a run", () => {
  it("prints counts and Wilson intervals beside every rate, per repeat", () => {
    const text = renderReport(
      withMetrics([
        repeatMetrics(1, { strictRecall: [17, 18], ...NOTHING }),
        repeatMetrics(2, { strictRecall: [16, 18], ...NOTHING }),
        repeatMetrics(3, { strictRecall: [18, 18], ...NOTHING }),
      ]),
    );
    expect(text).toContain(
      "| Issue recall (strict) | mean 0.944 (range 0.889 to 1.000) | 17 of 18; 16 of 18; 18 of 18 | 0.74 to 0.99; 0.67 to 0.97; 0.82 to 1.00 |",
    );
  });

  it("says when a run is incomplete, and does not print gates for it", () => {
    const file = withMetrics([repeatMetrics(1, NOTHING)]);
    file.complete = false;
    file.stoppedBecause = "Interrupted.";
    file.sections[0]!.gates = null;
    const text = renderReport(file);
    expect(text).toContain("**INCOMPLETE: the run stopped early.** Interrupted.");
    expect(text).toContain("Gates were not evaluated: the run is incomplete");
    expect(text).not.toContain("| G1 |");
  });

  it("says the gates are indicative on a subset, on the dev split and below three repeats", () => {
    const dev = renderReport(withMetrics([repeatMetrics(1, NOTHING)]));
    expect(dev).toContain("so its gate results are indicative and are not a promotion result");
    const subset = withMetrics([repeatMetrics(1, NOTHING)]);
    subset.sections[0]!.fullSplit = false;
    subset.sections[0]!.casesInSplit = 6;
    subset.sections[0]!.caseKeys = ["PAROL-D01"];
    expect(renderReport(subset)).toContain("a subset: the gates are defined for the whole split");
  });

  it("names what is not evaluated and why, and does not call the exposure gate zero", () => {
    const text = selftestReport;
    expect(text).toContain(
      "G1 needs the authorization probes and the canary scan, which were not run, so it is not evaluated and not assumed to be 0.",
    );
    expect(text).toContain("G11 needs the support checker's calibration set, which was not run.");
    expect(text).toMatch(/\| G1 \| Unauthorized-data exposure \| 0 \| not evaluated \|/);
  });

  it("keeps a hostile value from a results file out of the structure of the report", () => {
    const file = withMetrics([repeatMetrics(1, NOTHING)]);
    file.pins.model.requested = "model | extra cell\nnext line `code` \u001b[31mred\u001b[0m";
    file.stoppedBecause = "x\n# A heading that is not ours";
    file.complete = false;
    const text = renderReport(file);
    expect(text).not.toContain("\u001b");
    expect(text).not.toMatch(/\n# A heading that is not ours/);
    expect(text).toContain("model \\| extra cell next line 'code'");
    expect(md("a|b\n`c`\u0007", 10)).toBe("a\\|b 'c'");
    expect(md("x".repeat(300), 20)).toBe(`${"x".repeat(17)}...`);
    expect(table(["a", "b"], [["1", "2"]])).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
  });
});

describe("what a selftest or simulated report claims", () => {
  const scripted = [
    ["selftest", () => selftestReport, /SELFTEST/, "the scripted oracle (a selftest, not a model)"],
    [
      "simulated",
      () => simulatedReport,
      /SIMULATED/,
      "the scripted simulated reader (not a model)",
    ],
  ] as const;

  it.each(scripted)(
    "%s: opens with the banner and says what the scores are scores of",
    (_mode, text, word, subject) => {
      const report = text();
      const lines = report.split("\n");
      expect(lines[0]).toMatch(word);
      expect(lines[2]).toMatch(/^\*\*[A-Z ,.:']+\*\*$/);
      expect(lines[2]).toMatch(/NOT A MEASUREMENT OF ANY MODEL|SAYS NOTHING ABOUT ANY MODEL/);
      expect(report).toContain(`Scores of: ${subject}.`);
      expect(report).toContain(`### Result of ${subject}`);
      expect(report).toContain(
        `Gate results of ${subject}. They test the plumbing and say nothing about any model.`,
      );
    },
  );

  it.each(scripted)("%s: carries the banner over every table of scores", (_mode, text) => {
    const report = text();
    const banner = report.split("\n")[2]!;
    const sections = report
      .split(/^## /m)
      .slice(1)
      .filter((s) => s.startsWith("Split "));
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      expect(section.indexOf(banner)).toBeGreaterThan(-1);
      expect(section.indexOf(banner)).toBeLessThan(section.indexOf("| Metric |"));
    }
  });

  it.each(scripted)(
    "%s: prints no money, no latency and no model name that is not the stand-in",
    (_mode, text) => {
      const report = text();
      expect(report).not.toMatch(/\$\d/);
      expect(report).not.toMatch(/p50 \d|p95 \d|latency over/i);
      expect(report).toContain(
        "Not reported for a scripted run. Latency and cost of a scripted stand-in are not figures for any model.",
      );
      expect(report).not.toMatch(/claude|sonnet|opus|haiku|anthropic/i);
      expect(report).toContain("No tokens, no cost: nothing was sent anywhere.");
    },
  );

  it("a live report does not carry either banner", () => {
    const report = renderReport(withMetrics([repeatMetrics(1, NOTHING)]));
    expect(report).not.toMatch(/SELFTEST|SIMULATED/);
    expect(report.startsWith("# Parol evaluation\n")).toBe(true);
  });

  it("every report states what the answer keys can and cannot show", () => {
    for (const report of [
      selftestReport,
      simulatedReport,
      renderReport(withMetrics([repeatMetrics(1, NOTHING)])),
    ]) {
      expect(report).toContain(
        "consistency with the fictional demo playbook and not professional legal quality",
      );
    }
  });
});

describe("the style of the output", () => {
  it("has no em dash or en dash in a report or a comparison", () => {
    const a = withMetrics([repeatMetrics(1, NOTHING)]);
    const b = withMetrics([repeatMetrics(1, { ...NOTHING, strictRecall: [3, 4] })]);
    b.pins.workflow = { ...b.pins.workflow, label: "v2" };
    const c = compareResults(a, b, { allow: ["workflow"] });
    if (!c.ok) throw new Error("expected a comparison");
    for (const text of [
      selftestReport,
      simulatedReport,
      renderReport(a),
      renderComparison(c, { baseline: "v1", candidate: "v2" }),
    ]) {
      expect(text).not.toMatch(DASHES);
    }
  });
});

describe("the supplementary suites in the report", () => {
  const exposure = {
    probesRun: 1008,
    artefactsScanned: 41,
    probesAnsweredWithData: 0,
    canaryHits: 0,
    foreignSpanIdHits: 0,
    suites: ["Authorization probes: 36 routes as 7 callers, in 2 modes."],
  };
  const calibration = {
    result: {
      catchRate: rate(19, 20),
      falseAlarmRate: rate(1, 20),
      catchByKind: { wrong_clause: rate(4, 4) },
    },
    setSha256: "a".repeat(64),
    prompt: { id: "support.p1", sha256: "b".repeat(64) },
    supportedPairs: 20,
    unsupportedPairs: 20,
    failedPairs: 0,
    modelCalls: 40,
    note: null,
  };

  it("says neither was run when neither was, and does not assume a pass", () => {
    const text = renderReport(clone());
    expect(text).toContain("## Supplementary suites");
    expect(text).toContain("so gates G1 and G11 are not evaluated and not assumed to pass");
  });

  it("prints the counts of the exposure suite and what it does not test", () => {
    const file = clone();
    file.suites = { exposure, calibration: null };
    const text = renderReport(file);
    expect(text).toContain("They do not test any model.");
    expect(text).toMatch(/\| Authorization probes run \| 1,008 \|/);
    expect(text).toMatch(/\| Total found \(G1 requires 0\) \| 0 \|/);
    expect(text).toContain("The calibration set was not run, so gate G11 is not evaluated.");
  });

  it("prints the calibration rates with their counts and intervals", () => {
    const file = clone();
    file.suites = { exposure: null, calibration };
    const text = renderReport(file);
    expect(text).toContain("The set is small: read each rate with its interval.");
    expect(text).toMatch(
      /\| Unsupported pairs caught \| 19 of 20 \(0\.950; 95% interval 0\.76 to 0\.99\) \|/,
    );
    expect(text).toContain("Caught, wrong_clause");
  });
});
