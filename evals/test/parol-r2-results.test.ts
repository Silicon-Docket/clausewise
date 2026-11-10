import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareResults } from "../src/parol/compare.js";
import { renderReport } from "../src/parol/report.js";
import { parseResults, serialiseResults, type ResultsFile } from "../src/parol/results.js";
import { makeTempDir, removeDir, run } from "../src/parol/testing-run.js";

/**
 * What the reader of a results file accepts: counts that are whole numbers, rates that agree with
 * the calls behind them, and records that say everything a gate reads. The files here are a real
 * selftest file edited to hold the supplementary suites, FABRICATED FOR A TEST: no model produced
 * any number in them.
 */

let dir = "";
let template: ResultsFile;
beforeAll(async () => {
  dir = await makeTempDir();
  const out = await run(["--selftest"], { resultsDir: `${dir}/base` });
  expect(out.code, out.stderr).toBe(0);
  const [name] = await readdir(`${dir}/base`);
  template = parseResults(await readFile(`${dir}/base/${name}`, "utf8"));
});
afterAll(async () => {
  await removeDir(dir);
});

// A results file as plain JSON, to be edited into shapes the types do not allow.
type Json = Record<string, any>;

const rateOf = (numerator: number, denominator: number): Json => ({
  numerator,
  denominator,
  value: denominator === 0 ? null : numerator / denominator,
  ci: denominator === 0 ? null : { low: 0.1, high: 0.9 },
});

const exposure = (): Json => ({
  workflow: { label: template.pins.workflow.label, sha256: template.pins.workflow.sha256 },
  probesRun: 504,
  artefactsScanned: 200,
  probesAnsweredWithData: 0,
  canaryHits: 0,
  foreignSpanIdHits: 0,
  letInNotReached: 0,
  mismatches: 0,
  factSightings: 0,
  suites: ["a sentence"],
});

const calibration = (): Json => ({
  result: {
    catchRate: rateOf(18, 20),
    falseAlarmRate: rateOf(1, 20),
    catchByKind: { superseded: rateOf(4, 4) },
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
});

/** The template as JSON with both suites in it, changed by `edit`. */
const withSuites = (edit: (file: Json) => void = () => undefined): string => {
  const file = JSON.parse(serialiseResults(template)) as Json;
  file["suites"] = { exposure: exposure(), calibration: calibration() };
  edit(file);
  return JSON.stringify(file);
};

/** What parsing says about the file, or "parsed" when it reads. */
const verdictOn = (source: string): string => {
  try {
    parseResults(source);
    return "parsed";
  } catch (error) {
    return (error as Error).message;
  }
};

describe("the records of the exposure suites and the calibration set", () => {
  it("are read when they are whole", () => {
    expect(verdictOn(withSuites())).toBe("parsed");
  });

  it("are refused, naming the field, when a count that a gate reads is missing", () => {
    // A record written before these counts existed would read as a clean one with their zeros.
    const missing: [string, (file: Json) => void][] = [
      ["suites.exposure.letInNotReached", (f) => delete f["suites"].exposure.letInNotReached],
      ["suites.exposure.mismatches", (f) => delete f["suites"].exposure.mismatches],
      ["suites.exposure.factSightings", (f) => delete f["suites"].exposure.factSightings],
      ["suites.exposure.workflow", (f) => delete f["suites"].exposure.workflow],
      ["suites.calibration.callOutcomes", (f) => delete f["suites"].calibration.callOutcomes],
      ["suites.calibration.result.failed", (f) => delete f["suites"].calibration.result.failed],
    ];
    for (const [path, edit] of missing) {
      expect(verdictOn(withSuites(edit)), path).toContain(`the first problem is at "${path}"`);
    }
  });

  it("still read when the file has none of them, which is what a file written before them recorded", () => {
    const without = JSON.parse(serialiseResults(template)) as Json;
    delete without["suites"];
    delete without["recording"];
    const parsed = parseResults(JSON.stringify(without));
    expect(parsed.suites).toEqual({ exposure: null, calibration: null });
    expect(parsed.recording).toBeNull();
  });

  it("are refused when a count is negative or not a whole number", () => {
    const damaged: [string, (file: Json) => void][] = [
      ["suites.exposure.probesRun", (f) => (f["suites"].exposure.probesRun = -1)],
      ["suites.exposure.canaryHits", (f) => (f["suites"].exposure.canaryHits = 0.5)],
      ["suites.calibration.failedPairs", (f) => (f["suites"].calibration.failedPairs = 0.5)],
      ["suites.calibration.supportedPairs", (f) => (f["suites"].calibration.supportedPairs = -20)],
      ["suites.calibration.callOutcomes.ok", (f) => (f["suites"].calibration.callOutcomes.ok = -1)],
      [
        "suites.calibration.result.failed.supported",
        (f) => (f["suites"].calibration.result.failed.supported = 1.5),
      ],
      [
        "suites.calibration.result.catchRate.numerator",
        (f) => (f["suites"].calibration.result.catchRate.numerator = 17.5),
      ],
      [
        "suites.calibration.result.falseAlarmRate.denominator",
        (f) => (f["suites"].calibration.result.falseAlarmRate.denominator = -20),
      ],
    ];
    for (const [path, edit] of damaged) {
      expect(verdictOn(withSuites(edit)), path).toContain(`the first problem is at "${path}"`);
    }
  });

  it("are refused when a rate counts more than it is out of", () => {
    const excess: [string, (file: Json) => void][] = [
      [
        "suites.calibration.result.falseAlarmRate",
        (f) => Object.assign(f["suites"].calibration.result.falseAlarmRate, { numerator: 25 }),
      ],
      [
        "suites.calibration.result.catchRate",
        (f) => Object.assign(f["suites"].calibration.result.catchRate, { numerator: 21 }),
      ],
      [
        "suites.calibration.result.catchByKind.superseded",
        (f) =>
          Object.assign(f["suites"].calibration.result.catchByKind.superseded, { numerator: 5 }),
      ],
    ];
    for (const [path, edit] of excess) {
      expect(verdictOn(withSuites(edit)), path).toContain(`the first problem is at "${path}"`);
    }
  });

  it("are refused when the calls without a verdict do not fit inside the pairs they were for", () => {
    // A call without a verdict counts as flagged if its pair is supported and as not caught if it
    // is unsupported, so the failed calls of a label are inside those counts.
    const inconsistent: Record<string, (file: Json) => void> = {
      "more supported calls without a verdict than pairs flagged": (f) =>
        (f["suites"].calibration.result.failed = { supported: 5, unsupported: 0 }),
      "more unsupported calls without a verdict than pairs not caught": (f) =>
        (f["suites"].calibration.result.failed = { supported: 0, unsupported: 3 }),
    };
    for (const [name, edit] of Object.entries(inconsistent)) {
      expect(verdictOn(withSuites(edit)), name).toContain(
        'the first problem is at "suites.calibration.result"',
      );
    }
    // The edge: 2 unsupported calls without a verdict are exactly the 2 pairs not caught.
    const edge = (f: Json): void => {
      f["suites"].calibration.result.failed = { supported: 1, unsupported: 2 };
      f["suites"].calibration.failedPairs = 3;
      f["suites"].calibration.callOutcomes = { ok: 37, transport: 3 };
    };
    expect(verdictOn(withSuites(edge))).toBe("parsed");
  });

  it("do not make a comparison throw, whatever the file holds", () => {
    // The file that used to make compareResults throw is refused where it is read.
    const hand = (): ResultsFile => {
      const file = JSON.parse(withSuites()) as Json;
      file["suites"].calibration.result.catchRate = rateOf(14, 20);
      file["suites"].calibration.result.failed = { supported: 5, unsupported: 0 };
      return file as unknown as ResultsFile;
    };
    expect(() => parseResults(JSON.stringify(hand()))).toThrow(/suites\.calibration\.result/);
    // A comparison made of files built by hand, without the reader, still has no verdict to give.
    const base = JSON.parse(serialiseResults(template)) as ResultsFile;
    expect(() => compareResults(base, hand())).not.toThrow();
  });
});

describe("a results file with every optional part filled", () => {
  const full = (recording: Json | null): ResultsFile => {
    const file = JSON.parse(withSuites()) as Json;
    file["recording"] = recording;
    return file as unknown as ResultsFile;
  };

  it("comes back from the reader as it went in, the recording of a run that could not be completed", () => {
    const file = full({ role: "recorded", file: "run.responses.jsonl", calls: 4, failed: true });
    const back = parseResults(serialiseResults(file));
    expect(back).toEqual(file);
    expect(back.recording).toEqual({
      role: "recorded",
      file: "run.responses.jsonl",
      calls: 4,
      failed: true,
    });
    // The flag is what the report reads, so it must survive the reader.
    const text = renderReport(back);
    expect(text).toContain("could not be recorded completely (4 calls written to");
    expect(text).not.toContain("Replay them with --replay");
  });

  it("comes back as it went in, the recording of a replay", () => {
    const file = full({
      role: "replayed",
      file: "run.responses.jsonl",
      calls: 9,
      recordedAt: "2026-11-09T10:00:00.000Z",
      recordedResults: "run.json",
      recordedCommit: "a".repeat(40),
      datasetChanged: true,
    });
    expect(parseResults(serialiseResults(file))).toEqual(file);
    expect(
      parseResults(
        serialiseResults(full({ role: "replayed", file: "x", calls: 1, recordedCommit: null })),
      ).recording,
    ).toEqual({ role: "replayed", file: "x", calls: 1, recordedCommit: null });
  });

  it("carries both suites through the reader without losing a field", () => {
    const file = full(null);
    expect(parseResults(serialiseResults(file))).toEqual(file);
    expect(parseResults(serialiseResults(file)).suites.calibration?.result.failed).toEqual({
      supported: 0,
      unsupported: 0,
    });
  });
});
