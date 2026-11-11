import { readdir, readFile } from "node:fs/promises";
import { createScriptedGenerator } from "@clausewise/llm/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { workflowFor } from "../../apps/parol/src/prompts/workflows.js";
import { EvalError } from "../src/errors.js";
import { compareResults } from "../src/parol/compare.js";
import type { Dataset } from "../src/parol/dataset.js";
import { runAuthorizationProbes } from "../src/parol/exposure/authorization.js";
import { runCanaryScan } from "../src/parol/exposure/canary.js";
import { runExposureSuite } from "../src/parol/exposure/index.js";
import {
  DEFAULT_EXPOSURE_WORKFLOW,
  createExposureSite,
  type SiteHooks,
} from "../src/parol/exposure/site.js";
import { evaluateGates } from "../src/parol/gates.js";
import { renderReport } from "../src/parol/report.js";
import {
  exposureMismatch,
  gateSubjectOf,
  parseResults,
  serialiseResults,
  workflowPin,
  type ResultsFile,
} from "../src/parol/results.js";
import { makeTempDir, removeDir, run } from "../src/parol/testing-run.js";
import { completeDataset, never, playbook, reviewedUnder, ROOT } from "./parol-exposure-support.js";

/**
 * The exposure suite reviews under the workflow the run is of, records which one it was, and gate
 * G1 is read from the record only for a run of that workflow. Before this, every run was reviewed
 * under v2 whatever --workflow said, so a v1 or v3 file carried a G1 pass that was about v2.
 *
 * Nothing here calls a model. The model of the suite is the scripted key oracle.
 */

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

let dataset: Dataset;
beforeAll(async () => {
  dataset = await completeDataset();
});

const inert = createScriptedGenerator(
  () => {
    throw new Error("not called");
  },
  { disclosure: "a scripted generator that is never called" },
);

const D10 = ["dev"] as const;
const common = () => ({ dataset, root: ROOT, playbook, signal: never() });

/** Collects the labels of the workflow versions the runs of a site were started under, as requests go by. */
const recordWorkflows = (into: Set<string>): SiteHooks => ({
  beforeRoutes: (app, deps) =>
    void app.use("*", async (_c, next) => {
      await next();
      const rows = deps.repo.db
        .prepare(
          "SELECT DISTINCT w.label AS label FROM runs r JOIN workflow_versions w ON w.id = r.workflow_version_id",
        )
        .all() as { label: string }[];
      for (const row of rows) into.add(row.label);
    }),
});

describe("the canary scan reviews under the workflow it is given", () => {
  it("sends the nine requests of v2 by default, and the seventeen of v3 (the support check adds eight) when v3 is asked", async () => {
    const byDefault = await runCanaryScan({ ...common(), splits: [...D10] });
    expect(byDefault.byKind.prompt).toBe(9);
    expect(byDefault.byKind.model_response).toBe(9);

    const v3 = await runCanaryScan({ ...common(), splits: [...D10], workflow: "v3" });
    expect(v3.byKind.prompt).toBe(17);
    expect(v3.byKind.model_response).toBe(17);
    // The sixteen more artefacts are the whole difference: nothing else in the scan depends on the workflow.
    expect(v3.artefactsScanned - byDefault.artefactsScanned).toBe(16);
    expect(v3.canaryHits).toBe(0);
    expect(v3.foreignSpanIdHits).toBe(0);
    expect(v3.factSightings).toBe(0);
  });

  it("reviews under v1 when v1 is asked, and stops for a version that is not registered", async () => {
    const v1 = await runCanaryScan({ ...common(), splits: [...D10], workflow: "v1" });
    expect(v1.canaryHits).toBe(0);
    expect(v1.byKind.prompt).toBe(9);
    await expect(runCanaryScan({ ...common(), workflow: "v9" })).rejects.toThrow();
  });
});

describe("the authorization probes review under the workflow they are given", () => {
  it("start the review the records are read from under that workflow, and under the newest shipped one by default", async () => {
    const asked = new Set<string>();
    const result = await runAuthorizationProbes({
      ...common(),
      // The lists read the reviewed matter, and the writes of the matrix are tried on a reviewed scratch matter:
      // both starts of a review, and none may be of another version.
      groups: ["matrix", "effects", "lists"],
      workflow: "v3",
      hooks: recordWorkflows(asked),
    });
    expect(result.probesAnsweredWithData).toBe(0);
    expect([...asked]).toEqual(["v3"]);

    const byDefault = new Set<string>();
    await runAuthorizationProbes({
      ...common(),
      groups: ["matrix", "effects", "lists"],
      hooks: recordWorkflows(byDefault),
    });
    expect([...byDefault]).toEqual([DEFAULT_EXPOSURE_WORKFLOW]);
    expect(DEFAULT_EXPOSURE_WORKFLOW).toBe("v2");
  });
});

describe("the exposure site", () => {
  it("registers the version under test beside the shipped ones, in its own store only", () => {
    const site = createExposureSite({
      playbook,
      generator: inert,
      workflow: "v3",
    });
    try {
      expect(site.workflowLabel).toBe("v3");
      const labels = site.repo.listWorkflowVersions().map((version) => version.label);
      expect(labels).toEqual(expect.arrayContaining(["v1", "v2", "v3"]));
    } finally {
      site.close();
    }
    const plain = createExposureSite({
      playbook,
      generator: inert,
    });
    try {
      expect(plain.workflowLabel).toBe("v2");
      expect(plain.repo.listWorkflowVersions().map((version) => version.label)).toEqual([
        "v1",
        "v2",
      ]);
    } finally {
      plain.close();
    }
  });
});

describe("the record says which workflow its reviews ran under", () => {
  it("is v3 with the hash of v3 when v3 was asked, and the newest shipped version when nothing was", async () => {
    const v3 = await runExposureSuite({ ...common(), workflow: "v3" });
    expect(v3.workflow).toEqual({ label: "v3", sha256: workflowFor("v3").sha256 });
    expect(v3.artefactsScanned).toBe(426);
    expect(v3.probesAnsweredWithData + v3.canaryHits + v3.foreignSpanIdHits).toBe(0);
    expect(v3.letInNotReached).toBe(0);

    const plain = await runExposureSuite(common());
    expect(plain.workflow).toEqual(reviewedUnder("v2"));
    expect(plain.artefactsScanned).toBe(410);
    // The authorization half does not depend on the version: the same cells either way.
    expect(plain.probesRun).toBe(v3.probesRun);
  });

  it("hands the workflow to both halves: the reviews of the authorization probes and of the canary scan start under it, and under the newest shipped one by default", async () => {
    // Nothing in the record depends on the version in the authorization half (the same cells either
    // way), so the label and the hash in the record would read the same if that half were left to
    // review under the default. What the sites started is what shows it.
    const authorization = new Set<string>();
    const canary = new Set<string>();
    await runExposureSuite(
      { ...common(), workflow: "v3" },
      { authorization: recordWorkflows(authorization), canary: recordWorkflows(canary) },
    );
    expect([...authorization]).toEqual(["v3"]);
    expect([...canary]).toEqual(["v3"]);

    const byDefaultAuthorization = new Set<string>();
    const byDefaultCanary = new Set<string>();
    await runExposureSuite(common(), {
      authorization: recordWorkflows(byDefaultAuthorization),
      canary: recordWorkflows(byDefaultCanary),
    });
    expect([...byDefaultAuthorization]).toEqual([DEFAULT_EXPOSURE_WORKFLOW]);
    expect([...byDefaultCanary]).toEqual([DEFAULT_EXPOSURE_WORKFLOW]);
  });

  it("refuses a version that is not registered, plainly and without echoing a long label", async () => {
    const error = await runExposureSuite({ ...common(), workflow: "z".repeat(200) }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(EvalError);
    expect((error as Error).message).toContain("no such version is registered");
    expect((error as Error).message.length).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------------------------
// Gate G1 is read only for the run the record belongs to
// ---------------------------------------------------------------------------------------------

let dir = "";
let v1File: ResultsFile;
beforeAll(async () => {
  dir = await makeTempDir();
  const out = await run(["--selftest", "--workflow", "v1", "--exposure"], { resultsDir: dir });
  expect(out.code, out.stderr).toBe(0);
  const [name] = await readdir(dir);
  v1File = parseResults(await readFile(`${dir}/${name}`, "utf8"));
}, 240_000);
afterAll(async () => removeDir(dir));

const clone = (): ResultsFile => JSON.parse(JSON.stringify(v1File)) as ResultsFile;
const g1 = (file: ResultsFile) => {
  const gates = file.sections[0]!.gates!;
  return gates.results.find((result) => result.id === "G1")!;
};

describe("gate G1 and the workflow of the record", () => {
  it("passes for a v1 run whose reviews ran under v1, and the record says v1", () => {
    expect(v1File.suites.exposure!.workflow).toEqual({
      label: "v1",
      sha256: v1File.pins.workflow.sha256,
    });
    expect(g1(v1File).outcome).toBe("pass");
    expect(exposureMismatch(v1File.suites.exposure, v1File.pins.workflow)).toBeNull();
    expect(renderReport(v1File)).toContain("The reviews they ran and scanned were of workflow v1.");
  });

  it("is not evaluated for a record of another workflow, whatever the counts, and says why", () => {
    const file = clone();
    file.suites.exposure!.workflow = reviewedUnder("v2");
    const section = file.sections[0]!;
    const subject = gateSubjectOf(
      { repeats: section.metrics!.repeats, stability: section.metrics!.stability },
      null,
      null,
      file.suites,
      file.pins.workflow,
    );
    expect(subject.exposure).toBeUndefined();
    expect(subject.exposureNotice).toMatch(
      /reviewed under workflow v2 and this run is of workflow v1/,
    );
    const gate = evaluateGates(subject).results.find((result) => result.id === "G1")!;
    expect(gate.outcome).toBe("not_evaluated");
    expect(gate.detail).toBe(subject.exposureNotice);
    // The same counts under the right workflow are read.
    const same = gateSubjectOf(
      { repeats: section.metrics!.repeats, stability: section.metrics!.stability },
      null,
      null,
      v1File.suites,
      v1File.pins.workflow,
    );
    expect(same.exposure).toBeDefined();
    expect(same.exposureNotice).toBeUndefined();
  });

  it("is not evaluated for a record of the right label and another definition of it", () => {
    const file = clone();
    file.suites.exposure!.workflow = { label: "v1", sha256: "0".repeat(64) };
    expect(exposureMismatch(file.suites.exposure, file.pins.workflow)).toMatch(
      /a definition of workflow v1 that is not the one of this run/,
    );
  });

  it("is not read, however bad the count, when the record is of another workflow: a hit does not fail a run it was not found in", () => {
    const file = clone();
    file.suites.exposure!.workflow = reviewedUnder("v3");
    file.suites.exposure!.canaryHits = 4;
    const section = file.sections[0]!;
    const subject = gateSubjectOf(
      { repeats: section.metrics!.repeats, stability: section.metrics!.stability },
      null,
      null,
      file.suites,
      file.pins.workflow,
    );
    expect(evaluateGates(subject).results.find((result) => result.id === "G1")!.outcome).toBe(
      "not_evaluated",
    );
  });

  it("is said in the report, with the reason, beside the counts", () => {
    const file = clone();
    file.suites.exposure!.workflow = reviewedUnder("v2");
    const text = renderReport(file);
    expect(text).toContain("The reviews they ran and scanned were of workflow v2.");
    expect(text).toContain(
      "Gate G1 is not evaluated for this run: the exposure suites reviewed under workflow v2 and this run is of workflow v1",
    );
  });

  it("is shown in the comparison with the workflow of the record, and not read for the candidate", () => {
    const baseline = clone();
    const candidate = clone();
    candidate.pins.workflow = workflowPin(workflowFor("v2"));
    // The candidate's record is still the v1 one, as if the suite had been run for the baseline.
    const outcome = compareResults(baseline, candidate, { allow: ["workflow"] });
    if (!outcome.ok) throw new Error("expected a comparison");
    const row = outcome.sections[0]!.rows.find((entry) =>
      entry.metric.startsWith("Unauthorized-data exposure"),
    )!;
    expect(row.baseline).toMatch(/^0 of \d+$/);
    expect(row.candidate).toContain(
      "reviews under workflow v1, not this run's, so not read for G1",
    );
    expect(row.pass).toBe("not evaluated");
  });
});

describe("the results file and the workflow of the record", () => {
  it("round trips the label and the hash", () => {
    const text = serialiseResults(v1File);
    expect(parseResults(text).suites.exposure!.workflow).toEqual(v1File.suites.exposure!.workflow);
  });

  it("refuses a record without one: it was made before the label was recorded, and its reviews cannot be tied to any run", () => {
    const file = JSON.parse(serialiseResults(v1File)) as {
      suites: { exposure: Record<string, unknown> };
    };
    delete file.suites.exposure.workflow;
    expect(() => parseResults(JSON.stringify(file))).toThrow(/workflow/);
  });

  it("refuses a label that is not a workflow label and a hash that is not a hash", () => {
    for (const bad of [
      { label: "v1\u001b[31m", sha256: "a".repeat(64) },
      { label: "v1", sha256: "xyz" },
      { label: "", sha256: "a".repeat(64) },
    ]) {
      const file = JSON.parse(serialiseResults(v1File)) as {
        suites: { exposure: Record<string, unknown> };
      };
      file.suites.exposure.workflow = bad;
      expect(() => parseResults(JSON.stringify(file))).toThrow();
    }
  });
});

describe("the command and the workflow of the reviews", () => {
  it("reviews under the workflow of the run for each of v1, v2 and v3, and G1 passes for each", async () => {
    for (const label of ["v2", "v3"]) {
      const folder = await makeTempDir();
      try {
        const out = await run(["--selftest", "--workflow", label, "--exposure"], {
          resultsDir: folder,
        });
        expect(out.code, out.stderr).toBe(0);
        const [name] = await readdir(folder);
        const file = parseResults(await readFile(`${folder}/${name}`, "utf8"));
        expect(file.suites.exposure!.workflow).toEqual({
          label,
          sha256: workflowFor(label).sha256,
        });
        expect(file.pins.workflow.label).toBe(label);
        expect(g1(file).outcome).toBe("pass");
        expect(file.suites.exposure!.artefactsScanned).toBe(label === "v3" ? 426 : 410);
      } finally {
        await removeDir(folder);
      }
    }
  });
});
