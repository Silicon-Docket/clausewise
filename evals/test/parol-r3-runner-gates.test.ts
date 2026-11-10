import { readdir, readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workflowFor } from "../../apps/parol/src/prompts/workflows.js";
import type { CaseGroup } from "../src/parol/dataset.js";
import { renderReport } from "../src/parol/report.js";
import {
  assembleResults,
  buildSection,
  exposureMismatch,
  parseResults,
  type AssembleInput,
  type ExposureRecord,
  type ResultsFile,
} from "../src/parol/results.js";
import { makeTempDir, removeDir, run } from "../src/parol/testing-run.js";

/**
 * Gate G1 is read from the exposure record only for a run of the workflow the record's reviews ran
 * under. The command cannot make a file whose record is of another workflow, so these tests build
 * the sections the way the command does, from a record of their own, and render what comes out.
 * Nothing here calls a model: the base file is a selftest, answered by the key oracle.
 */

let dir = "";
let base: ResultsFile;
beforeAll(async () => {
  dir = await makeTempDir();
  const out = await run(["--selftest", "--workflow", "v1", "--case", "PAROL-D01"], {
    resultsDir: dir,
  });
  expect(out.code, out.stderr).toBe(0);
  const [name] = await readdir(dir);
  base = parseResults(await readFile(`${dir}/${name}`, "utf8"));
}, 60_000);
afterAll(async () => removeDir(dir));

/** A group with nothing in it: its one repeat is scored from no slots, which leaves G1 to the record. */
const group: CaseGroup = { split: "dev", cases: [], twins: [], splitCases: 0 };

const record = (label: string, over: Partial<ExposureRecord> = {}): ExposureRecord => ({
  workflow: { label, sha256: workflowFor(label).sha256 },
  probesRun: 504,
  artefactsScanned: 402,
  probesAnsweredWithData: 0,
  canaryHits: 0,
  foreignSpanIdHits: 0,
  letInNotReached: 0,
  mismatches: 0,
  factSightings: 0,
  suites: ["a sentence of the suites"],
  ...over,
});

const input = (exposure: ExposureRecord | null): AssembleInput => ({
  mode: base.mode,
  startedAt: new Date(base.startedAt),
  finishedAt: new Date(base.finishedAt),
  complete: true,
  stoppedBecause: null,
  pins: base.pins,
  options: base.options,
  integrity: base.integrity.splits,
  groups: [group],
  rules: {},
  observed: [],
  runs: [],
  usage: base.usage,
  priced: false,
  contamination: null,
  suites: { exposure, calibration: null },
  recording: null,
  notes: [],
});

const g1Of = (file: ResultsFile) => file.sections[0]!.gates!.results.find((r) => r.id === "G1")!;
const g1Row = (text: string): string => /^\| G1 \|.*$/m.exec(text)![0];
/** The two lists under the table: the gates that failed and the gates that were not evaluated. */
const lists = (text: string): { failed: string; open: string } => {
  const found = /Gates failed: (.*?)\. Gates not evaluated: (.*?)\./.exec(text)!;
  return { failed: found[1]!, open: found[2]! };
};

describe("the gates stored in a section are read from a record of the run's own workflow", () => {
  it("passes G1 for a record of the workflow of the run, as a control", () => {
    expect(base.pins.workflow.label).toBe("v1");
    const file = assembleResults(input(record("v1")));
    expect(g1Of(file).outcome).toBe("pass");
    expect(exposureMismatch(file.suites.exposure, file.pins.workflow)).toBeNull();
  });

  it("does not evaluate G1 for a record of another workflow, whatever its counts, and says why", () => {
    const quiet = assembleResults(input(record("v2")));
    const gate = g1Of(quiet);
    expect(gate.outcome).toBe("not_evaluated");
    expect(gate.detail).toBe(exposureMismatch(quiet.suites.exposure, quiet.pins.workflow));
    expect(gate.detail).toMatch(/reviewed under workflow v2 and this run is of workflow v1/);
    // A hit found in reviews of another workflow is not a failure of this run.
    const loud = assembleResults(input(record("v3", { canaryHits: 4 })));
    expect(g1Of(loud).outcome).toBe("not_evaluated");
    expect(loud.sections[0]!.gates!.failed).not.toContain("G1");
    expect(loud.sections[0]!.gates!.notEvaluated).toContain("G1");
  });

  it("does not evaluate G1 for a record of the right label and another definition of it", () => {
    const other = record("v1");
    other.workflow = { label: "v1", sha256: "0".repeat(64) };
    const gate = g1Of(assembleResults(input(other)));
    expect(gate.outcome).toBe("not_evaluated");
    expect(gate.detail).toMatch(/a definition of workflow v1 that is not the one of this run/);
  });

  it("does the same through buildSection, which the command calls for each split", () => {
    const section = (
      exposure: ExposureRecord,
      workflow: { label: string; sha256: string } = base.pins.workflow,
    ) =>
      buildSection({
        group,
        rules: {},
        repeats: 1,
        observed: [],
        runs: [],
        mode: base.mode,
        complete: true,
        splitSha256: "",
        priced: false,
        workflow,
        suites: { exposure, calibration: null },
      });
    const gate = (s: ReturnType<typeof section>) => s.gates!.results.find((r) => r.id === "G1")!;
    expect(gate(section(record("v1"))).outcome).toBe("pass");
    expect(gate(section(record("v2"))).outcome).toBe("not_evaluated");
    // The workflow handed in is the one the record is compared with: v2 is read for a run of v2.
    const v2 = { label: "v2", sha256: workflowFor("v2").sha256 };
    expect(gate(section(record("v2"), v2)).outcome).toBe("pass");
    expect(gate(section(record("v1"), v2)).outcome).toBe("not_evaluated");
  });
});

describe("the report agrees with itself about G1 for a record of another workflow", () => {
  it("shows G1 as not evaluated in the gates table and in the suites section of a file the command's own assembly made", () => {
    const text = renderReport(assembleResults(input(record("v2"))));
    expect(g1Row(text)).toContain("| not evaluated |");
    expect(g1Row(text)).toMatch(/reviewed under workflow v2 and this run is of workflow v1/);
    expect(text).toMatch(
      /Gate G1 is not evaluated for this run: the exposure suites reviewed under workflow v2 and this run is of workflow v1/,
    );
    expect(lists(text).failed).not.toContain("G1");
    expect(lists(text).open).toContain("G1");
  });

  it("shows G1 as not evaluated, and not as a pass, when the record of a file was changed to another workflow after the gates were stored", () => {
    const file = assembleResults(input(record("v1")));
    expect(g1Of(file).outcome).toBe("pass");
    expect(g1Row(renderReport(file))).toContain("| pass |");
    // A file that was edited, or put together from two: its stored G1 is a pass, its record is not of this run.
    const moved = structuredClone(file);
    moved.suites.exposure!.workflow = { label: "v2", sha256: workflowFor("v2").sha256 };
    expect(g1Of(moved).outcome).toBe("pass");
    const text = renderReport(moved);
    expect(g1Row(text)).toContain("| not evaluated |");
    expect(g1Row(text)).not.toContain("| pass |");
    expect(g1Row(text)).not.toContain("0 of");
    expect(text).toContain("Gate G1 is not evaluated for this run");
    expect(lists(text).open).toContain("G1");
    expect(text).toContain("G1 is not evaluated for the reason in its row above");
  });

  it("does not list G1 among the gates that failed when the stored G1 was a failure of a record that is not of this run", () => {
    const file = assembleResults(input(record("v1", { canaryHits: 3 })));
    expect(g1Of(file).outcome).toBe("fail");
    expect(lists(renderReport(file)).failed).toBe("G1");
    const moved = structuredClone(file);
    moved.suites.exposure!.workflow = { label: "v3", sha256: workflowFor("v3").sha256 };
    const text = renderReport(moved);
    expect(g1Row(text)).toContain("| not evaluated |");
    expect(lists(text).failed).toBe("none");
    expect(lists(text).open).toContain("G1");
  });

  it("changes nothing else in the gates table", () => {
    const file = assembleResults(input(record("v1")));
    const moved = structuredClone(file);
    moved.suites.exposure!.workflow = { label: "v2", sha256: workflowFor("v2").sha256 };
    const rows = (f: ResultsFile) =>
      renderReport(f)
        .split("\n")
        .filter((l) => /^\| G(?:[2-9]|1[0-4]) \|/.test(l));
    expect(rows(moved)).toEqual(rows(file));
    expect(rows(file)).toHaveLength(13);
  });
});
