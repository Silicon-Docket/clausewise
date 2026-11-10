import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { defineMatterRoute } from "../../apps/parol/src/server/matter-route.js";
import { EvalError } from "../src/errors.js";
import type { Dataset } from "../src/parol/dataset.js";
import {
  composeExposureRecord,
  runAuthorizationProbes,
  runCanaryScan,
  runExposureSuite,
  runUploadReplay,
  type AuthorizationResult,
  type CanaryResult,
  type UploadReplayResult,
} from "../src/parol/exposure/index.js";
import { FORGED_PROBES, LIST_PROBES, MATTER_PROBES } from "../src/parol/exposure/probes.js";
import { exposureChecked, exposureCount } from "../src/parol/suites.js";
import {
  CANARY_SHAPE,
  DASHES,
  ID_SHAPE,
  completeDataset,
  never,
  playbook,
  ROOT,
} from "./parol-exposure-support.js";
import type { ExposureRecord } from "../src/parol/results.js";

/**
 * The exposure suite on the real application, with nothing planted: all zeros out of nonzero
 * denominators. The faults that make these numbers move are in parol-exposure-faults.test.ts.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let dataset: Dataset;
let authorization: AuthorizationResult;
let canary: CanaryResult;
let uploads: UploadReplayResult;
let record: ExposureRecord;
let again: ExposureRecord;
let seconds: number;
let printed = "";
let leftBehind: string[] = [];

beforeAll(async () => {
  dataset = await completeDataset();
  // The suite makes its temporary folders under the system's temporary folder. This run gets one of
  // its own, so that other tests running at the same time cannot be mistaken for what it left.
  const outside = process.env.TMPDIR;
  const own = mkdtempSync(join(tmpdir(), "parol-exposure-test-tmp-"));
  process.env.TMPDIR = own;
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    printed += String(chunk);
    return true;
  });
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    printed += args.join(" ");
  });
  const started = performance.now();
  try {
    const args = { root: ROOT, dataset, playbook, signal: never() };
    authorization = await runAuthorizationProbes(args);
    canary = await runCanaryScan(args);
    uploads = await runUploadReplay(args);
    record = await runExposureSuite(args);
    seconds = (performance.now() - started) / 1000;
    again = await runExposureSuite(args);
  } finally {
    write.mockRestore();
    log.mockRestore();
    if (outside === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = outside;
  }
  leftBehind = readdirSync(own);
  rmSync(own, { recursive: true, force: true });
});

describe("the real application", () => {
  it("answers every cell of the matrix, the forged ids and the lists, and none with data or with a revealing refusal", () => {
    // 36 routes, 7 callers, 2 modes; every forged request in 2 modes; every list route as 7 callers in 2 modes.
    expect(authorization.matrixCells).toBe(MATTER_PROBES.length * 7 * 2);
    expect(authorization.forgedCells).toBe(FORGED_PROBES.length * 2);
    expect(authorization.listCells).toBe(LIST_PROBES.length * 7 * 2);
    expect(authorization.probesRun).toBe(
      authorization.matrixCells + authorization.forgedCells + authorization.listCells,
    );
    expect(authorization.routes).toBe(36);
    expect(authorization.callers).toBe(7);
    expect(authorization.probesAnsweredWithData).toBe(0);
    expect(authorization.byReason).toEqual({
      handler_answered: 0,
      carried_data: 0,
      refusal_differs: 0,
      changed_state: 0,
    });
    expect(authorization.exposed).toEqual([]);
    // The matrix is not empty on either side: callers are let in, callers are refused, refusals are compared.
    expect(authorization.shouldBeLetIn).toBeGreaterThan(100);
    expect(authorization.mustBeRefused).toBeGreaterThan(300);
    expect(authorization.shouldBeLetIn + authorization.mustBeRefused).toBe(
      authorization.matrixCells,
    );
    expect(authorization.comparedWithMissing).toBeGreaterThan(200);
    expect(authorization.tableDrift).toBe(0);
  });

  it("puts an id of another matter into every route that takes an id, and the places outside a path", () => {
    // 20 ids in a path, 4 in a body (three in the PATCH body, one in a form), 1 in a query string.
    expect(FORGED_PROBES.filter((probe) => probe.via === "path")).toHaveLength(20);
    expect(FORGED_PROBES.filter((probe) => probe.via === "body")).toHaveLength(4);
    expect(FORGED_PROBES.filter((probe) => probe.via === "query")).toHaveLength(1);
    expect(new Set(FORGED_PROBES.map((probe) => probe.position))).toEqual(
      new Set(["document", "version", "run", "finding", "memo"]),
    );
    expect(authorization.forgedRequests).toBe(FORGED_PROBES.length);
  });

  it("sends the callers who must be refused a body that changes the store, on every write route that can be changed", () => {
    expect(authorization.writeRoutes).toBe(MATTER_PROBES.filter((p) => p.method !== "GET").length);
    // The rest are the resume and the cancel of a finished run, which are 409 whoever sends them.
    expect(authorization.writesWithEffect).toBe(authorization.writeRoutes - 4);
  });

  it("answers every cell as the table says: no mismatch either, and every let-in caller reached its handler", () => {
    expect(authorization.mismatches).toBe(0);
    expect(authorization.letInNotReached).toBe(0);
    expect(authorization.mismatched).toEqual([]);
  });

  it("finds no canary string and no foreign id in a nonzero number of artefacts", () => {
    expect(canary.canaryHits).toBe(0);
    expect(canary.foreignSpanIdHits).toBe(0);
    expect(canary.hits).toEqual([]);
    // D10: nine model requests (extract, then one per rule), nine answers, a memo, the rows of both
    // matters, the services' log, and every page and route as every role.
    expect(canary.cases.map((entry) => entry.caseKey)).toEqual(["PAROL-D10"]);
    expect(canary.byKind.prompt).toBe(9);
    expect(canary.byKind.model_response).toBe(9);
    expect(canary.byKind.memo).toBe(1);
    expect(canary.byKind.log).toBe(1);
    expect(canary.byKind.store_rows).toBeGreaterThanOrEqual(2 * 17);
    expect(canary.byKind.http_body).toBeGreaterThan(100);
    expect(canary.artefactsScanned).toBe(Object.values(canary.byKind).reduce((a, b) => a + b, 0));
  });

  it("shows no sign of the other matter's distinctive fact either", () => {
    expect(canary.factSightings).toBe(0);
  });

  it("replays the upload steps of the cases that have them, and the application does what the key says", () => {
    expect(uploads.cases).toEqual(["PAROL-D09"]);
    expect(uploads.steps).toBe(3);
  });

  it("gives a record that gate G1 reads as zero out of a nonzero number checked", () => {
    expect(record).toMatchObject({
      probesRun: authorization.probesRun,
      probesAnsweredWithData: 0,
      canaryHits: 0,
      foreignSpanIdHits: 0,
      letInNotReached: 0,
      mismatches: 0,
    });
    expect(record.artefactsScanned).toBe(canary.artefactsScanned);
    expect(exposureCount(record)).toBe(0);
    expect(exposureChecked(record)).toBe(authorization.probesRun + canary.artefactsScanned);
    expect(exposureChecked(record)).toBeGreaterThan(600);
  });

  it("is the record the sub-suites compose", () => {
    expect(record).toEqual(composeExposureRecord({ authorization, canary, uploads }));
  });

  it("is deterministic: the same record, sentences included, on a second run", () => {
    expect(again).toEqual(record);
  });

  it("says in one plain sentence per sub-suite what it did and its counts, with no dash and no canary string", () => {
    expect(record.suites).toHaveLength(3);
    expect(record.suites[0]).toMatch(/^Authorization probes: sent \d+ cells /);
    // The sentence counts cells and says so: the reference requests are not cells, and the counts are this run's.
    expect(record.suites[0]).not.toMatch(/\d+ requests/);
    expect(record.suites[0]).toContain(`sent ${authorization.probesRun} cells`);
    expect(record.suites[0]).toContain(
      `${authorization.matrixCells} for ${authorization.routes} routes`,
    );
    expect(record.suites[0]).toContain("not a language model");
    expect(record.suites[0]).toContain(
      "every cell whose caller should have been let in reached its handler",
    );
    expect(record.suites[1]).toMatch(/^Canary scan: .*PAROL-D10/);
    expect(record.suites[2]).toMatch(/^Upload replay: .*PAROL-D09/);
    for (const sentence of record.suites) {
      expect(sentence).not.toMatch(DASHES);
      expect(sentence).not.toMatch(CANARY_SHAPE);
      expect(sentence).not.toMatch(ID_SHAPE);
      expect(sentence).toMatch(/\.$/);
      expect(sentence).not.toContain("\n");
    }
    expect(record.suites[1]).toContain(`${canary.artefactsScanned} artefacts`);
  });

  it("sends nothing to a model or a network, prints nothing, and removes its temporary folders", () => {
    expect(printed).toBe("");
    expect(leftBehind).toEqual([]);
  });

  it("takes seconds, not minutes", () => {
    expect(seconds).toBeLessThan(60);
  });
});

describe("the temporary folder", () => {
  it("is made under the system's temporary folder while a site is open, and removed when it is closed", async () => {
    const { createExposureSite } = await import("../src/parol/exposure/site.js");
    const { createCaseOracle } = await import("../src/parol/exposure/model.js");
    const outside = process.env.TMPDIR;
    const own = mkdtempSync(join(tmpdir(), "parol-exposure-test-tmp-"));
    process.env.TMPDIR = own;
    try {
      const key = dataset.keys.cases.find((entry) => entry.case === "PAROL-D05")!;
      const oracle = await createCaseOracle({
        key,
        playbook,
        files: (name) => dataset.files.get(name)!,
      });
      const site = createExposureSite({ playbook, generator: oracle });
      expect(readdirSync(own).filter((name) => name.startsWith("parol-exposure-"))).toHaveLength(1);
      site.close();
      site.close();
      expect(readdirSync(own)).toEqual([]);
    } finally {
      if (outside === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = outside;
      rmSync(own, { recursive: true, force: true });
    }
  });
});

describe("the choice of splits", () => {
  it("leaves the held-out cases alone unless the split is named", async () => {
    expect(canary.cases.map((entry) => entry.caseKey)).not.toContain("PAROL-H09");
    expect(uploads.cases).not.toContain("PAROL-H08");
  });

  it("scans and replays the held-out cases when the caller names the split", async () => {
    const args = { root: ROOT, dataset, playbook, signal: never() };
    const both = await runCanaryScan({ ...args, splits: ["dev", "heldout"] });
    expect(both.cases.map((entry) => entry.caseKey)).toEqual(["PAROL-D10", "PAROL-H09"]);
    expect(both.canaryHits + both.foreignSpanIdHits).toBe(0);
    expect(both.artefactsScanned).toBeGreaterThan(canary.artefactsScanned);
    const only = await runCanaryScan({ ...args, splits: ["heldout"] });
    expect(only.cases.map((entry) => entry.caseKey)).toEqual(["PAROL-H09"]);
    const replay = await runUploadReplay({ ...args, splits: ["dev", "heldout"] });
    expect(replay.cases).toEqual(["PAROL-D09", "PAROL-H08"]);
    expect(replay.steps).toBe(6);
  });

  it("refuses a canary matter of the other split, with an integrity exit code", async () => {
    const crossed = await completeDataset();
    crossed.keys.cases.find((entry) => entry.case === "PAROL-D10")!.canaryMatters = ["saltmarsh"];
    await expect(
      runCanaryScan({ root: ROOT, dataset: crossed, playbook, signal: never() }),
    ).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe("a suite that cannot run says so and does not return zeros", () => {
  const args = (data: Dataset) => ({ root: ROOT, dataset: data, playbook, signal: never() });
  const names = (data: Dataset) => data.keys.cases.map((entry) => entry.case);

  async function without(
    drop: (key: Dataset["keys"]["cases"][number]) => boolean,
  ): Promise<Dataset> {
    const data = await completeDataset();
    data.keys.cases = data.keys.cases.filter((entry) => !drop(entry));
    return data;
  }

  async function failure(run: Promise<unknown>): Promise<EvalError> {
    const error = await run.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(EvalError);
    expect((error as Error).message).not.toMatch(CANARY_SHAPE);
    expect((error as Error).message).not.toMatch(DASHES);
    return error as EvalError;
  }

  it("throws when the dataset has no case for the authorization probes", async () => {
    const data = await without((entry) => entry.case === "PAROL-D05");
    expect(names(data)).not.toContain("PAROL-D05");
    const error = await failure(runAuthorizationProbes(args(data)));
    expect(error.name).toBe("ExposureSuiteUnavailable");
    expect(error.message).toContain("PAROL-D05");
    await expect(runExposureSuite(args(data))).rejects.toMatchObject({
      name: "ExposureSuiteUnavailable",
    });
  });

  it("throws when no selected case names a canary matter", async () => {
    const data = await without((entry) => entry.case === "PAROL-D10");
    const error = await failure(runCanaryScan(args(data)));
    expect(error.name).toBe("ExposureSuiteUnavailable");
    // The held-out split has one, and is not selected: it is not scanned in place of the dev one.
    await expect(runCanaryScan(args(data))).rejects.toThrow(/Nothing was scanned/);
  });

  it("throws when a case names a canary matter that the key does not hold", async () => {
    const data = await completeDataset();
    delete data.keys.canary;
    const error = await failure(runCanaryScan(args(data)));
    expect(error.name).toBe("ExposureSuiteUnavailable");
  });

  it("throws when no selected case has upload steps", async () => {
    const data = await without((entry) => entry.uploads !== undefined && entry.split === "dev");
    const error = await failure(runUploadReplay(args(data)));
    expect(error.name).toBe("ExposureSuiteUnavailable");
    expect(error.message).toMatch(/Nothing was replayed/);
  });

  it("throws when the application has a route that names a matter and the table has no probe for it", async () => {
    const error = await failure(
      runAuthorizationProbes({
        ...args(dataset),
        hooks: {
          beforeRoutes: (app) =>
            defineMatterRoute(app, {
              method: "GET",
              path: "/api/matters/:matterId/extra",
              action: "matter.read",
              handler: (c) => c.json({}),
            }),
        },
      }),
    );
    expect(error.name).toBe("ExposureSuiteUnavailable");
    expect(error.message).toContain("GET /api/matters/:matterId/extra");
  });

  it("throws, and says what to do, when the application's pages do not render in this process", async () => {
    const error = await failure(
      runAuthorizationProbes({
        ...args(dataset),
        hooks: { beforeRoutes: (app) => void app.get("/matters", (c) => c.text("broken", 500)) },
      }),
    );
    expect(error.message).toMatch(/did not render/);
    expect(error.message).toContain("--tsconfig apps/parol/tsconfig.json");
  });

  it("stops when the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stopped by the test"));
    await expect(
      runExposureSuite({ root: ROOT, dataset, playbook, signal: controller.signal }),
    ).rejects.toThrow("stopped by the test");
  });

  it("refuses to compose a record from nothing", () => {
    expect(() =>
      composeExposureRecord({
        authorization: {
          probesRun: 0,
          probesAnsweredWithData: 0,
          letInNotReached: 0,
          mismatches: 0,
          sentence: "x.",
        },
        canary: {
          artefactsScanned: 0,
          canaryHits: 0,
          foreignSpanIdHits: 0,
          factSightings: 0,
          sentence: "x.",
        },
        uploads: { sentence: "x." },
      }),
    ).toThrow(/checked nothing/);
  });
});
