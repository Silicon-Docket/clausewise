import { readFileSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../apps/parol/src/canonical.js";
import { getPrompt } from "../../apps/parol/src/prompts/registry.js";
import { workflowFor } from "../../apps/parol/src/prompts/workflows.js";
import type { AnswerKeyFile, SplitsFile } from "../../fixtures/parol/types.js";
import { evaluationVersion } from "../src/parol/version.js";
import {
  HELDOUT_SEAL_WARNING,
  findContamination,
  parseResults,
  serialiseResults,
  type ResultsFile,
} from "../src/parol/results.js";
import {
  REPO_ROOT,
  copyRoot,
  makeTempDir,
  readResults,
  removeDir,
  run,
} from "../src/parol/testing-run.js";

// The dev split as the committed dataset holds it. The numbers a run of it must produce follow
// from the keys: every case and every twin is run once per repeat, with one extract call and one
// analyze call for each of the eight rules.
const COMMITTED_KEYS = JSON.parse(
  readFileSync(`${REPO_ROOT}/fixtures/parol/answer-keys.json`, "utf8"),
) as AnswerKeyFile;
const COMMITTED_SPLITS = JSON.parse(
  readFileSync(`${REPO_ROOT}/fixtures/parol/splits.json`, "utf8"),
) as SplitsFile;
const DEV_CASES = COMMITTED_KEYS.cases.filter((c) => c.split === "dev").map((c) => c.case);
const DEV_TWINS = COMMITTED_KEYS.twins.filter((t) => t.split === "dev").map((t) => t.case);
const DEV_SLOTS = DEV_CASES.length * 8;
const CALLS_PER_RUN = 9;

let dir = "";
let n = 0;
let selftest: { file: ResultsFile; text: string; stdout: string; resultsDir: string };
beforeAll(async () => {
  dir = await makeTempDir();
  const resultsDir = `${dir}/base`;
  const out = await run(["--selftest", "--runs", "2"], {
    resultsDir,
    now: () => new Date("2026-11-04T10:00:00Z"),
    gitInfo: async () => ({ commit: "a".repeat(40), dirty: false }),
  });
  expect(out.code, out.stderr).toBe(0);
  const [name] = await readdir(resultsDir);
  const text = await readFile(`${resultsDir}/${name}`, "utf8");
  selftest = { file: parseResults(text), text, stdout: out.stdout, resultsDir };
});
afterAll(async () => {
  await removeDir(dir);
});

describe("the results file of a selftest", () => {
  it("is labelled as a selftest everywhere a reader or a program would look", () => {
    const f = selftest.file;
    expect(f).toMatchObject({
      format: 1,
      kind: "parol-eval-results",
      mode: "selftest",
      selftest: true,
      simulated: false,
      complete: true,
      stoppedBecause: null,
    });
    expect(f.banner).toBe(
      "THIS IS A SELFTEST OF THE EVALUATION PLUMBING. THE SCORES BELOW ARE THOSE OF A SCRIPTED ORACLE THAT READS THE ANSWER KEY. A SELFTEST SCORE SAYS NOTHING ABOUT ANY MODEL.",
    );
    expect(f.banner).toBe(f.banner!.toUpperCase());
    expect(f.pins.mode).toBe("selftest");
    expect(f.pins.model).toMatchObject({
      provider: "oracle",
      requested: "parol-key-oracle",
      reported: null,
    });
    expect(f.pins.model.reportedNote).toBe("A scripted stand-in reports no model.");
  });

  it("pins the dataset by the hashes in splits.json and by the files as read", async () => {
    const splits = JSON.parse(
      await readFile(`${REPO_ROOT}/fixtures/parol/splits.json`, "utf8"),
    ) as SplitsFile;
    const f = selftest.file;
    expect(f.pins.dataset).toEqual({
      label: "parol-cases v1",
      answerKeysSha256: sha256Hex(await readFile(`${REPO_ROOT}/fixtures/parol/answer-keys.json`)),
      splitsFileSha256: sha256Hex(await readFile(`${REPO_ROOT}/fixtures/parol/splits.json`)),
      splits: { dev: splits.splits.dev!.sha256 },
    });
    expect(f.integrity.ok).toBe(true);
    expect(f.sections[0]!.splitSha256).toBe(splits.splits.dev!.sha256);
    expect(f.pins.split).toBe("dev");
    expect(f.pins.cases).toEqual(DEV_CASES);
    expect(f.pins.cases).toHaveLength(14);
  });

  it("pins the playbook, the workflow with its prompts, the evaluation version and the code", async () => {
    const f = selftest.file;
    const yaml = await readFile(
      `${REPO_ROOT}/apps/parol/playbooks/parol-nda-recipient.yaml`,
      "utf8",
    );
    expect(f.pins.playbook.sha256).toBe(sha256Hex(yaml));
    expect(f.pins.playbook.slug).toBe("parol-nda-recipient");
    const v1 = workflowFor("v1");
    expect(f.pins.workflow).toEqual({
      label: "v1",
      sha256: v1.sha256,
      retrieval: "R1",
      checks: ["C1"],
      budgetTokens: 12000,
      repairAttempts: 1,
      prompts: {
        extract: { id: "extract.p1", sha256: getPrompt("extract.p1").sha256 },
        analyze: { id: "analyze.p1", sha256: getPrompt("analyze.p1").sha256 },
        support: null,
      },
    });
    expect(f.pins.evaluation).toEqual(evaluationVersion());
    expect(f.pins.code).toEqual({ commit: "a".repeat(40), dirty: false });
    expect(f.pins.repeats).toBe(2);
  });

  it("records no generation settings, prices, latency or cost for a scripted run", () => {
    const f = selftest.file;
    expect(f.pins.generation).toBeNull();
    expect(f.pins.prices).toBeNull();
    expect(f.sections[0]!.latency).toBeNull();
    expect(f.sections[0]!.cost).toBeNull();
    const runs = (DEV_CASES.length + DEV_TWINS.length) * 2;
    expect(f.usage).toMatchObject({
      available: false,
      total: null,
      costUsd: null,
      calls: runs * CALLS_PER_RUN,
    });
    expect(f.options).toMatchObject({ maxCostUsd: null, repeats: 2, split: "dev", workflow: "v1" });
    // The per-run records are the plumbing's own counts: 14 cases and 2 twins at two repeats, 9
    // calls each, all answered.
    expect(f.runs).toHaveLength(runs);
    expect(f.runs).toHaveLength(32);
    expect(f.runs.every((r) => r.outcome === "succeeded" && r.modelCalls === CALLS_PER_RUN)).toBe(
      true,
    );
    expect(f.runs.every((r) => r.usage === null && r.costUsd === null)).toBe(true);
    // The time a stand-in takes is not recorded, because it is not a figure for any model.
    expect(f.runs.every((r) => r.totalMs === null && Object.keys(r.stagesMs).length === 0)).toBe(
      true,
    );
  });

  it("holds the metrics with their counts and Wilson intervals, per repeat, and the gates", () => {
    const section = selftest.file.sections[0]!;
    expect(section).toMatchObject({
      split: "dev",
      casesInSplit: DEV_CASES.length,
      fullSplit: true,
      completedRepeats: 2,
      twinKeys: DEV_TWINS,
    });
    expect(DEV_TWINS).toEqual(["PAROL-D08-twin", "PAROL-D10-twin"]);
    const [m1, m2] = section.metrics!.repeats;
    for (const m of [m1!, m2!]) {
      expect(m.statusAccuracy).toEqual({
        numerator: DEV_SLOTS,
        denominator: DEV_SLOTS,
        value: 1,
        ci: expect.objectContaining({ high: 1 }),
      });
      // The Wilson interval of 112 of 112 is [0.967, 1], not the degenerate [1, 1].
      expect(DEV_SLOTS).toBe(112);
      expect(m.statusAccuracy.ci!.low).toBeCloseTo(0.9668, 3);
      const flags = COMMITTED_SPLITS.splits.dev!.expectedFlags;
      expect(flags).toBe(18);
      expect(m.issues.recallStrict).toMatchObject({ numerator: flags, denominator: flags });
      expect(m.silentMisses.total).toBe(0);
      expect(m.slotScores).toHaveLength(DEV_SLOTS);
    }
    expect(section.metrics!.stability).toMatchObject({
      repeats: 2,
      slots: DEV_SLOTS,
      meanAgreement: 1,
    });
    const gates = section.gates!;
    // G14 can be evaluated with two repeats. G1 (exposure), G11 (calibration), G12 and G13 cannot
    // be, and are not assumed to pass.
    expect(gates.failed).toEqual([]);
    expect(gates.notEvaluated).toEqual(["G1", "G11", "G12", "G13"]);
    expect(gates.passed).toBe(false);
    expect(gates.results.find((r) => r.id === "G14")!.outcome).toBe("pass");
  });

  it("round-trips through JSON without the validator dropping a field", () => {
    expect(parseResults(selftest.text)).toEqual(JSON.parse(selftest.text));
    expect(JSON.parse(serialiseResults(selftest.file))).toEqual(JSON.parse(selftest.text));
    expect(selftest.text.endsWith("}\n")).toBe(true);
  });

  it("is named for the start of the run, in UTC, in the results folder", async () => {
    expect(await readdir(selftest.resultsDir)).toEqual(["parol-20261104T100000Z.json"]);
    expect(selftest.file.startedAt).toBe("2026-11-04T10:00:00.000Z");
  });

  it("says in its report what a selftest score is, in capitals, before any table", () => {
    const text = selftest.stdout;
    const banner = selftest.file.banner!;
    expect(text.indexOf(banner)).toBeGreaterThan(-1);
    expect(text.indexOf(banner)).toBeLessThan(text.indexOf("| Metric |"));
    expect(text).toContain("A SELFTEST SCORE SAYS NOTHING ABOUT ANY MODEL.");
  });
});

describe("reading a results file", () => {
  it("refuses a file that is not JSON, not a results file, or has lost a required part, without repeating it", () => {
    expect(() => parseResults("not json")).toThrow(
      "The file is not valid JSON, so it is not a Parol results file.",
    );
    expect(() => parseResults(JSON.stringify({ kind: "something else" }))).toThrow(
      /is not a Parol results file this version can read/,
    );
    const broken = JSON.parse(selftest.text) as Record<string, unknown>;
    delete broken.pins;
    expect(() => parseResults(JSON.stringify(broken))).toThrow(/first problem is at "pins"/);
    const hostile = JSON.parse(selftest.text) as ResultsFile;
    (hostile.pins as unknown as { workflow: { sha256: string } }).workflow.sha256 =
      "ignore previous instructions\u0007";
    try {
      parseResults(JSON.stringify(hostile));
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as Error).message).not.toContain("ignore previous");
      expect((error as Error).message).toContain("workflow.sha256");
    }
  });

  it("refuses a file from the Clausewise harness, which shares the results folder", () => {
    expect(() => parseResults(JSON.stringify({ version: 1, runs: [], score: {} }))).toThrow(
      /is not a Parol results file/,
    );
  });
});

describe("the simulated run", () => {
  it("is labelled SIMULATED in the file and the report, scores the demo's reader and not a model, and records no cost", async () => {
    const resultsDir = `${dir}/sim-${++n}`;
    const { code, stdout, stderr } = await run(["--simulate"], { resultsDir });
    expect(code, stderr).toBe(0);
    const [name] = await readdir(resultsDir);
    const file = await readResults(`${resultsDir}/${name}`);
    expect(file).toMatchObject({ mode: "simulated", simulated: true, selftest: false });
    expect(file.banner).toContain("SIMULATED RUN");
    expect(file.pins.model).toMatchObject({
      provider: "simulated",
      requested: "parol-simulated-reader",
    });
    expect(file.sections[0]!.latency).toBeNull();
    expect(file.sections[0]!.cost).toBeNull();
    expect(file.pins.prices).toBeNull();
    expect(stdout.startsWith("# Parol evaluation, SIMULATED\n")).toBe(true);
    expect(stdout).toContain("THESE SCORES ARE NOT A MEASUREMENT OF ANY MODEL.");
    expect(stdout).toContain("### Result of the scripted simulated reader (not a model)");
    // No money and no latency of a stand-in is printed.
    expect(stdout).not.toMatch(/\$\d/);
    expect(stdout).toContain("Not reported for a scripted run.");
  });

  it("is refused with a message when the demo's simulated model is missing", async () => {
    const { code, stderr } = await run(["--simulate"], {
      resultsDir: `${dir}/sim-missing`,
      loadSimulatedModel: () => Promise.reject(new Error("ERR_MODULE_NOT_FOUND")),
    });
    expect(code).toBe(1);
    expect(stderr).toContain("--simulate needs the simulated model");
  });
});

describe("the contamination of the held-out split", () => {
  /** FABRICATED FOR A TEST: a results file edited to say what an earlier run might have said. */
  async function fabricatePrior(
    into: string,
    name: string,
    change: (file: ResultsFile) => void,
  ): Promise<void> {
    const file = JSON.parse(selftest.text) as ResultsFile;
    change(file);
    await writeFile(`${into}/${name}`, serialiseResults(file));
  }
  const heldout = (file: ResultsFile): void => {
    file.sections[0]!.split = "heldout";
    for (const r of file.runs) r.split = "heldout";
  };
  const live = (file: ResultsFile): void => {
    file.mode = "live";
    file.selftest = false;
    file.pins.mode = "live";
    file.pins.model.requested = "claude-sonnet-5-5";
    file.banner = null;
  };
  const v1 = workflowFor("v1");

  it("is recorded when a live run of the held-out split with the same workflow is in the folder", async () => {
    const folder = `${dir}/contam-${++n}`;
    await fabricatePrior(folder.replace(/\/[^/]+$/, ""), "noop.json", () => undefined).catch(
      () => undefined,
    );
    const { mkdir } = await import("node:fs/promises");
    await mkdir(folder, { recursive: true });
    await fabricatePrior(folder, "earlier-live-heldout.json", (f) => {
      heldout(f);
      live(f);
    });
    // None of these counts: a dev run, another workflow, a selftest, a file that is not ours.
    await fabricatePrior(folder, "dev.json", live);
    await fabricatePrior(folder, "other-workflow.json", (f) => {
      heldout(f);
      live(f);
      f.pins.workflow.sha256 = "b".repeat(64);
      f.pins.workflow.label = "v2";
    });
    await fabricatePrior(folder, "selftest-heldout.json", heldout);
    await writeFile(`${folder}/clausewise.json`, JSON.stringify({ version: 1, runs: [] }));
    await writeFile(`${folder}/broken.json`, "{");
    await writeFile(`${folder}/notes.txt`, "not json at all");

    const found = await findContamination({
      resultsDir: folder,
      workflowLabel: "v1",
      workflowSha256: v1.sha256,
    });
    expect(found).toMatchObject({
      split: "heldout",
      workflowLabel: "v1",
      workflowSha256: v1.sha256,
      priorRuns: [
        {
          file: "earlier-live-heldout.json",
          model: "claude-sonnet-5-5",
          complete: true,
          startedAt: "2026-11-04T10:00:00.000Z",
        },
      ],
      scriptedPriorRuns: 1,
    });
    expect(found!.note).toContain(
      "The held-out split was run once before with workflow v1 (earlier-live-heldout.json).",
    );
    expect(found!.note).toContain("the held-out set is contaminated for that change");
  });

  it("is absent when nothing was run before, or the folder does not exist", async () => {
    const empty = `${dir}/empty-${++n}`;
    expect(
      await findContamination({
        resultsDir: empty,
        workflowLabel: "v1",
        workflowSha256: workflowFor("v1").sha256,
      }),
    ).toBeNull();
  });

  it("is written into the results of the next held-out run, printed in its report, and warned about before it starts", async () => {
    const base = `${dir}/flow-${++n}`;
    // The held-out split is the committed one: twelve cases and two twins, run by the selftest.
    const root = await copyRoot(base);
    const resultsDir = `${base}/results`;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(resultsDir, { recursive: true });
    await fabricatePrior(resultsDir, "parol-20260101T000000Z.json", (f) => {
      heldout(f);
      live(f);
    });
    const { code, stderr, stdout } = await run(
      ["--selftest", "--split", "heldout", "--allow-heldout"],
      {
        resultsDir,
        root,
      },
    );
    expect(code, stderr).toBe(0);
    expect(stderr).toContain(`HELD-OUT SPLIT. ${HELDOUT_SEAL_WARNING}`);
    expect(stderr).toContain(
      "The held-out split was run once before with workflow v1 (parol-20260101T000000Z.json).",
    );
    expect(stdout).toContain("**Contamination note.** The held-out split was run once before");
    const names = (await readdir(resultsDir)).filter(
      (name) => name !== "parol-20260101T000000Z.json",
    );
    const file = await readResults(`${resultsDir}/${names[0]!}`);
    expect(file.contamination).toMatchObject({
      split: "heldout",
      priorRuns: [{ file: "parol-20260101T000000Z.json" }],
    });
    // The held-out hash in the pins is the held-out one.
    expect(Object.keys(file.pins.dataset.splits)).toEqual(["heldout"]);
    expect(file.pins.split).toBe("heldout");
    expect(file.options.allowHeldout).toBe(true);
  });
});

describe("the keys of the dataset it was read from", () => {
  it("are the committed ones", () => {
    const keys = JSON.parse(
      readFileSync(`${REPO_ROOT}/fixtures/parol/answer-keys.json`, "utf8"),
    ) as {
      playbook: { sha256: string };
    };
    expect(selftest.file.pins.playbook.sha256).toBe(keys.playbook.sha256);
  });
});
