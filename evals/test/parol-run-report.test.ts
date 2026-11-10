import { readdir, readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workflowFor } from "../../apps/parol/src/prompts/workflows.js";
import { compareResults, renderComparison } from "../src/parol/compare.js";
import { evaluateGates } from "../src/parol/gates.js";
import { md, rateCell, table } from "../src/parol/format.js";
import { renderReport } from "../src/parol/report.js";
import {
  SUITE_SENTENCE_MAX,
  parseResults,
  runHealth,
  type ResultsFile,
} from "../src/parol/results.js";
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

/**
 * The workflow an exposure record of these fixtures reviewed under: v1, which is the workflow of
 * the selftest file the fixtures are made from (the command's default).
 */
const reviewedUnder = (): { label: string; sha256: string } => ({
  label: "v1",
  sha256: workflowFor("v1").sha256,
});

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
      "G1 needs the authorization probes and the canary scan, which were not run (give --exposure), so it is not evaluated and not assumed to be 0.",
    );
    // A selftest cannot take --calibration, so the report does not tell its reader to give it.
    expect(text).toContain(
      "G11 cannot be evaluated in a scripted run: --calibration needs a live run or a replay, because a scripted stand-in is not the support checker.",
    );
    expect(text).not.toContain("give --calibration");
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
    workflow: reviewedUnder(),
    probesRun: 1008,
    artefactsScanned: 41,
    probesAnsweredWithData: 0,
    canaryHits: 0,
    foreignSpanIdHits: 0,
    letInNotReached: 0,
    mismatches: 0,
    factSightings: 0,
    suites: ["Authorization probes: 36 routes as 7 callers, in 2 modes."],
  };
  const calibration = {
    result: {
      catchRate: rate(19, 20),
      falseAlarmRate: rate(1, 20),
      catchByKind: { wrong_clause: rate(4, 4) },
      failed: { supported: 0, unsupported: 0 },
    },
    setSha256: "a".repeat(64),
    prompt: { id: "support.p1", sha256: "b".repeat(64) },
    supportedPairs: 20,
    unsupportedPairs: 20,
    failedPairs: 0,
    callOutcomes: { ok: 40 },
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
    expect(text).toContain("has no result in this file");
    expect(text).toContain("Gate G11 is not evaluated.");
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

describe("what the report says about where the answers came from, and what the suites found", () => {
  const exposureRecord = (over: Record<string, unknown> = {}) => ({
    workflow: reviewedUnder(),
    probesRun: 504,
    artefactsScanned: 200,
    probesAnsweredWithData: 0,
    canaryHits: 0,
    foreignSpanIdHits: 0,
    letInNotReached: 0,
    mismatches: 0,
    factSightings: 0,
    suites: ["a sentence"],
    ...over,
  });
  const calibrationRecord = (over: Record<string, unknown> = {}) => ({
    result: {
      catchRate: rate(19, 20),
      falseAlarmRate: rate(1, 20),
      catchByKind: {},
      failed: { supported: 0, unsupported: 0 },
    },
    setSha256: "a".repeat(64),
    prompt: { id: "support.p1", sha256: "b".repeat(64) },
    supportedPairs: 20,
    unsupportedPairs: 20,
    failedPairs: 0,
    callOutcomes: { ok: 40 },
    modelCalls: 40,
    note: null,
    ...over,
  });
  const asReplay = (file: ResultsFile): ResultsFile => {
    file.mode = "replay";
    file.selftest = false;
    file.pins.mode = "replay";
    file.usage = { available: false, note: null, calls: 9, total: null, costUsd: null };
    return file;
  };

  it("does not say a replay called a model or sent the calibration pairs to one", () => {
    const file = asReplay(clone());
    file.suites = { exposure: null, calibration: calibrationRecord() };
    const text = renderReport(file);
    expect(text).toContain(
      "answered from the recording of an earlier run (no model was called now)",
    );
    expect(text).not.toContain("sent to the model of this run");
    expect(text).toContain("Answers re-scored from the recording: 9.");
    expect(text).not.toContain("Model calls made");
  });

  it("says it when a replay is scored against answer keys that are not the recorded ones", () => {
    const file = asReplay(clone());
    file.recording = {
      role: "replayed",
      file: "run.responses.jsonl",
      calls: 9,
      recordedAt: "2026-11-09T10:00:00.000Z",
      recordedResults: "run.json",
      recordedCommit: "a".repeat(40),
      datasetChanged: true,
    };
    const text = renderReport(file);
    expect(text).toContain("**Recording.** The answers were read from run.responses.jsonl");
    expect(text).toContain("recorded at 2026-11-09T10:00:00.000Z by the run that wrote run.json");
    expect(text).toContain(
      "THE ANSWER KEYS OR CASE FILES DIFFER FROM THOSE THE RECORDING WAS MADE AGAINST",
    );
    asReplay(file);
    file.recording!.datasetChanged = false;
    expect(renderReport(file)).not.toContain("DIFFER FROM THOSE");
  });

  it("does not say a run was recorded when the recording could not be written", () => {
    const file = clone();
    file.recording = { role: "recorded", file: "run.responses.jsonl", calls: 4, failed: true };
    const text = renderReport(file);
    expect(text).toContain("could not be recorded completely (4 calls written");
    expect(text).toContain("cannot be replayed");
    expect(text).not.toContain("Replay them with --replay");
  });

  it("prints the whole sentence of a suite, down to the mismatches and the first exposed probe", () => {
    const file = clone();
    const sentence = `${"x".repeat(700)} 12 answers differed from the expected one without exposing anything. First exposed: GET /matters/:matterId as outsider.`;
    file.suites = { exposure: exposureRecord({ suites: [sentence] }), calibration: null };
    const text = renderReport(file);
    expect(text).toContain("12 answers differed from the expected one");
    expect(text).toContain("First exposed: GET /matters/:matterId as outsider.");
  });

  it("shows the probes that never reached their handler, and says G1 is not a pass while there are any", () => {
    const file = clone();
    file.suites = {
      exposure: exposureRecord({ letInNotReached: 3, mismatches: 5 }),
      calibration: null,
    };
    const text = renderReport(file);
    expect(text).toMatch(/Probes whose caller should have been let in and was not .* \| 3 \|/);
    expect(text).toMatch(
      /Probes answered otherwise than expected, without exposing data .* \| 5 \|/,
    );
  });

  it("says plainly that a record which checked nothing is not a clean result", () => {
    const file = clone();
    file.suites = {
      exposure: exposureRecord({ probesRun: 0, artefactsScanned: 0 }),
      calibration: null,
    };
    expect(renderReport(file)).toContain("This record checked nothing");
  });

  it("names the outcomes of the calibration calls that returned no verdict", () => {
    const file = clone();
    file.suites = {
      exposure: null,
      calibration: calibrationRecord({
        failedPairs: 3,
        callOutcomes: { ok: 37, refusal: 1, transport: 2 },
      }),
    };
    expect(renderReport(file)).toContain("(3 here: refusal 1, transport 2)");
  });
});

describe("a calibration outage makes the run unclean", () => {
  const withCalibrationOutcomes = (callOutcomes: Record<string, number>): ResultsFile => {
    const file = clone();
    file.suites = {
      exposure: null,
      calibration: {
        result: {
          catchRate: rate(0, 20),
          falseAlarmRate: rate(20, 20),
          catchByKind: {},
          failed: { supported: 20, unsupported: 20 },
        },
        setSha256: "a".repeat(64),
        prompt: { id: "support.p1", sha256: "b".repeat(64) },
        supportedPairs: 20,
        unsupportedPairs: 20,
        failedPairs: 40,
        callOutcomes,
        modelCalls: 40,
        note: "x",
      },
    };
    return file;
  };

  it("when its calls were lost on the wire", () => {
    const health = runHealth(withCalibrationOutcomes({ transport: 40 }));
    expect(health.clean).toBe(false);
    expect(health.transportCalls).toBe(40);
    expect(health.problems.join(" ")).toMatch(/40 calibration calls failed on the wire/);
    expect(renderReport(withCalibrationOutcomes({ transport: 40 }))).not.toContain(
      "No call failed on the wire",
    );
  });

  it("but not when the model refused or answered badly, which are the checker's own results", () => {
    const health = runHealth(withCalibrationOutcomes({ refusal: 20, schema_error: 20 }));
    expect(health.clean).toBe(true);
  });
});

describe("a cell cannot be broken by a backslash before a pipe", () => {
  it("never leaves a pipe that a table reader would take for a cell border", () => {
    for (const hostile of ["a\\|b", "a\\\\|b", "ends with a backslash\\", "| \\| \\\\| x"]) {
      const cell = md(hostile);
      // Every pipe is preceded by an odd number of backslashes: it is escaped.
      for (const match of cell.matchAll(/(\\*)\|/g)) {
        expect(match[1]!.length % 2, hostile).toBe(1);
      }
      expect(table(["h"], [[cell]]).split("\n")).toHaveLength(3);
    }
  });
});

describe("what the report tells its reader to do about a gate that needs a suite", () => {
  const exposureRecord = (over: Record<string, unknown> = {}) => ({
    workflow: reviewedUnder(),
    probesRun: 504,
    artefactsScanned: 200,
    probesAnsweredWithData: 0,
    canaryHits: 0,
    foreignSpanIdHits: 0,
    letInNotReached: 0,
    mismatches: 0,
    factSightings: 0,
    suites: ["a sentence"],
    ...over,
  });
  /** A record of a calibration set that ran with `unsupported` and `supported` pairs, FABRICATED FOR A TEST. */
  const calibrationRecord = (
    unsupported: number,
    supported: number,
    over: Record<string, unknown> = {},
  ) => ({
    result: {
      catchRate: rate(unsupported, unsupported),
      falseAlarmRate: rate(0, supported),
      catchByKind: {},
      failed: { supported: 0, unsupported: 0 },
    },
    setSha256: "a".repeat(64),
    prompt: { id: "support.p1", sha256: "b".repeat(64) },
    supportedPairs: supported,
    unsupportedPairs: unsupported,
    failedPairs: 0,
    callOutcomes: { ok: unsupported + supported },
    modelCalls: unsupported + supported,
    note: null,
    ...over,
  });
  /** The gates of the first section, worked out again from the suites the file now holds. */
  const regated = (file: ResultsFile): ResultsFile => {
    const section = file.sections[0]!;
    const run = { repeats: section.metrics!.repeats, stability: section.metrics!.stability };
    section.gates = evaluateGates({
      run,
      ...(file.suites.exposure === null ? {} : { exposure: file.suites.exposure }),
      ...(file.suites.calibration === null ? {} : { calibration: file.suites.calibration.result }),
    });
    return file;
  };
  const live = (): ResultsFile => withMetrics([repeatMetrics(1, NOTHING)]);

  it("tells a scripted run that G11 needs a live run or a replay, and never to give --calibration", () => {
    for (const report of [selftestReport, simulatedReport]) {
      expect(report).toContain("G11 cannot be evaluated in a scripted run");
      expect(report).not.toContain("give --calibration");
    }
  });

  it("tells a live run to give --calibration, or to look at the notes if the set did not finish", () => {
    const text = renderReport(live());
    expect(text).toContain("give --calibration, with a workflow that has the support check");
    expect(text).toContain("or the run stopped before the set finished: see the notes");
    expect(text).not.toContain("cannot be evaluated in a scripted run");
  });

  it("tells a replay that the recording must have been made with the calibration set", () => {
    const file = live();
    file.mode = "replay";
    file.pins.mode = "replay";
    const text = renderReport(file);
    expect(text).toContain("give --calibration, and a recording that was made with it");
    expect(text).not.toContain("cannot be evaluated in a scripted run");
  });

  it("points G11 at its own row when a calibration set ran and is not 20 pairs of each label", () => {
    const file = live();
    file.suites = { exposure: null, calibration: calibrationRecord(4, 4) };
    const text = renderReport(regated(file));
    expect(text).toContain("G11 is not evaluated for the reason in its row above");
    // It does not say the set was not run, which the row above it contradicts.
    expect(text).not.toContain("give --calibration");
    expect(text).not.toContain("which has no result in this file");
    expect(text).not.toContain("cannot be evaluated in a scripted run");
    expect(text).toMatch(/\| G11 \|[^\n]*\| not evaluated \|[^\n]*20 supported and 20 unsupported/);
  });

  it("points G1 at its own row when the exposure suites ran and could not say the application is clean", () => {
    for (const record of [
      exposureRecord({ probesRun: 0, artefactsScanned: 0 }),
      exposureRecord({ letInNotReached: 2 }),
    ]) {
      const file = live();
      file.suites = { exposure: record, calibration: null };
      const text = renderReport(regated(file));
      expect(text).toContain("G1 is not evaluated for the reason in its row above");
      expect(text).not.toContain("give --exposure");
      expect(text).not.toContain("which were not run");
    }
    // And a run without the suites is told to give them.
    expect(renderReport(live())).toContain("which were not run (give --exposure)");
  });
});

describe("the labels of the exposure counts", () => {
  const exposure = {
    workflow: reviewedUnder(),
    probesRun: 504,
    artefactsScanned: 804,
    probesAnsweredWithData: 0,
    canaryHits: 0,
    foreignSpanIdHits: 2,
    letInNotReached: 0,
    mismatches: 0,
    factSightings: 0,
    suites: ["a sentence"],
  };

  it("say what the counts count: every kind of artefact scanned, and every kind of id of another matter", () => {
    const file = clone();
    file.suites = { exposure, calibration: null };
    const text = renderReport(file);
    expect(text).toMatch(
      /\| Artefacts scanned \(prompts, answers, response bodies, memos, tables of stored rows, log\) \| 804 \|/,
    );
    expect(text).toMatch(
      /\| Ids of another matter found \(matter, document, version, span\) \| 2 \|/,
    );
    expect(text).toContain("the scans for canary strings and for ids of another matter");
    // The old labels named fewer kinds than the scans cover.
    expect(text).not.toContain("Span ids of another matter found");
    expect(text).not.toContain("Prompts, answers, response bodies and memos scanned");
  });

  it("prints a suite sentence of the longest length the results file holds, whole", () => {
    const file = clone();
    const longest = `${"y".repeat(SUITE_SENTENCE_MAX - 5)} END.`;
    expect(longest).toHaveLength(SUITE_SENTENCE_MAX);
    file.suites = { exposure: { ...exposure, suites: [longest] }, calibration: null };
    expect(renderReport(file)).toContain(`- ${longest}\n`);
    // One character more is not a sentence the file can hold, and the report cuts it.
    file.suites = { exposure: { ...exposure, suites: [`${longest}!`] }, calibration: null };
    const cut = renderReport(file);
    expect(cut).not.toContain("END.!");
    expect(cut).toContain("...\n");
  });
});

describe("the calibration calls in the list of calls and degraded stages", () => {
  const outage = (callOutcomes: Record<string, number>): ResultsFile => {
    const file = clone();
    file.mode = "live";
    file.selftest = false;
    file.banner = null;
    file.pins.mode = "live";
    const failed = Object.entries(callOutcomes)
      .filter(([outcome]) => outcome !== "ok")
      .reduce((total, [, count]) => total + count, 0);
    file.suites = {
      exposure: null,
      calibration: {
        result: {
          catchRate: rate(20, 20),
          falseAlarmRate: rate(0, 20),
          catchByKind: {},
          failed: { supported: 0, unsupported: 0 },
        },
        setSha256: "a".repeat(64),
        prompt: { id: "support.p1", sha256: "b".repeat(64) },
        supportedPairs: 20,
        unsupportedPairs: 20,
        failedPairs: failed,
        callOutcomes,
        modelCalls: 40,
        note: null,
      },
    };
    return file;
  };

  it("names them where the pointer of every split sends the reader, when they are why the run is unclean", () => {
    const text = renderReport(outage({ ok: 37, transport: 3 }));
    // The runs of the split are clean: the only cause is the calibration calls.
    expect(text).toContain('see "Calls and degraded stages" below');
    const target = text.slice(text.indexOf("## Calls and degraded stages"));
    expect(target).toContain(
      "Calibration calls, which are in no run and in no split, by outcome: ok 37, transport 3.",
    );
    expect(target).not.toContain("No call failed on the wire");
  });

  it("lists them when all went well too, and not at all when there was no calibration set", () => {
    const clean = renderReport(outage({ ok: 40 }));
    expect(clean).toContain("by outcome: ok 40.");
    expect(clean).toContain("No call failed on the wire");
    expect(selftestReport).not.toContain("Calibration calls, which are in no run");
  });
});
