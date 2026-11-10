import { readdir, readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MATTER_ACTIONS } from "../../apps/parol/src/auth/actions.js";
import { MATTER_ROLES } from "../../apps/parol/src/contracts.js";
import type { Dataset } from "../src/parol/dataset.js";
import {
  AUTHORIZATION_SENTENCE_BUDGET,
  DOCUMENTED_ROLES,
  runAuthorizationProbes,
  sentenceOf,
  type AuthorizationResult,
} from "../src/parol/exposure/authorization.js";
import { composeExposureRecord } from "../src/parol/exposure/index.js";
import {
  SUITE_SENTENCE_MAX,
  parseResults,
  serialiseResults,
  type ExposureRecord,
  type ResultsFile,
} from "../src/parol/results.js";
import { makeTempDir, removeDir, run } from "../src/parol/testing-run.js";
import { worstResult } from "./parol-authz-support.js";
import {
  DASHES,
  completeDataset,
  never,
  playbook,
  reviewedUnder,
  ROOT,
} from "./parol-exposure-support.js";

/**
 * The sentence of the authorization half has to fit what the results file holds, whatever the run
 * found, so that the file of a run that failed can be read back (by `--compare`, among others).
 * Nothing here calls a model: the file is the one a selftest writes, with a scripted oracle.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let dir = "";
let base: ResultsFile;
let dataset: Dataset;
beforeAll(async () => {
  dir = await makeTempDir();
  const resultsDir = `${dir}/base`;
  const out = await run(["--selftest", "--runs", "1"], {
    resultsDir,
    now: () => new Date("2026-11-04T10:00:00Z"),
    gitInfo: async () => ({ commit: "a".repeat(40), dirty: false }),
  });
  expect(out.code, out.stderr).toBe(0);
  const [name] = await readdir(resultsDir);
  base = parseResults(await readFile(`${resultsDir}/${name}`, "utf8"));
  dataset = await completeDataset();
});
afterAll(async () => {
  await removeDir(dir);
});

/** The record of an authorization result and two short sentences for the other sub-suites, as the suite composes it. */
const recordOf = (
  authorization: Pick<
    AuthorizationResult,
    "probesRun" | "probesAnsweredWithData" | "letInNotReached" | "mismatches" | "sentence"
  >,
): ExposureRecord =>
  composeExposureRecord({
    workflow: reviewedUnder(),
    authorization,
    canary: {
      artefactsScanned: 1,
      canaryHits: 0,
      foreignSpanIdHits: 0,
      factSightings: 0,
      sentence: "Canary scan: x.",
    },
    uploads: { sentence: "Upload replay: x." },
  });

/** The file of a selftest with the given exposure record in it. */
const fileWith = (exposure: ExposureRecord): ResultsFile => {
  const file = structuredClone(base);
  file.suites = { ...file.suites, exposure };
  return file;
};

describe("the results file of a run whose authorization sentence is the longest it can be", () => {
  it("is read back: every field at its worst, from the longest names the tables have", () => {
    const worst = worstResult();
    const sentence = sentenceOf(worst);
    expect(sentence.length).toBeLessThanOrEqual(AUTHORIZATION_SENTENCE_BUDGET);
    expect(AUTHORIZATION_SENTENCE_BUDGET).toBeLessThan(SUITE_SENTENCE_MAX);
    const file = fileWith(recordOf({ ...worst, sentence }));
    const read = parseResults(serialiseResults(file));
    expect(read.suites.exposure?.suites[0]).toBe(sentence);
    expect(read.suites.exposure).toEqual(file.suites.exposure);
  });

  it("is what the limit exists for: one character over it is a file that cannot be read", () => {
    // The sentence is built to fit, and a longer one is refused when the record is made, so the
    // file is made by hand here to show what the refusal protects the reader of the file from.
    const file = fileWith(recordOf({ ...worstResult(), sentence: "x." }));
    file.suites.exposure!.suites[0] = `${"x".repeat(SUITE_SENTENCE_MAX)}.`;
    expect(() => parseResults(serialiseResults(file))).toThrow(/suites\.exposure\.suites\.0/);
    file.suites.exposure!.suites[0] = `${"x".repeat(SUITE_SENTENCE_MAX - 1)}.`;
    expect(() => parseResults(serialiseResults(file))).not.toThrow();
  });
});

describe("a run that finds an exposure and has two more things to say", () => {
  /** Opens the two actions that decide and export to every role, as a wrong edit to the table would. */
  async function widened<T>(body: () => Promise<T>): Promise<T> {
    const table = MATTER_ACTIONS as unknown as Record<string, readonly string[]>;
    const before = { decide: table["review.decide"], exportMemo: table["memo.export"] };
    table["review.decide"] = [...MATTER_ROLES];
    table["memo.export"] = [...MATTER_ROLES];
    try {
      return await body();
    } finally {
      table["review.decide"] = before.decide!;
      table["memo.export"] = before.exportMemo!;
    }
  }

  it("keeps its counts, the cells that did not reach, the drift and the first exposed cell under the budget, and the file is read back", async () => {
    // The table differs from the documented one in four places, so the cells where the application
    // lets in a role that the documentation refuses are exposures; and a rule before the guard
    // turns away the writes that carry a file, which do not reach their handler.
    const result = await widened(() =>
      runAuthorizationProbes({
        dataset,
        root: ROOT,
        playbook,
        signal: never(),
        hooks: {
          beforeRoutes: (app) =>
            void app.use("*", async (c, next) => {
              const type = c.req.header("content-type") ?? "";
              if (c.req.method !== "GET" && type.startsWith("multipart/"))
                return c.json({ error: { kind: "too_large" } }, 413);
              await next();
            }),
        },
      }),
    );
    // Each of the two actions was opened to every role: the roles the table did not name for it are the drift.
    const opened = ["review.decide", "memo.export"] as const;
    const drift = opened.reduce(
      (sum, action) => sum + (MATTER_ROLES.length - DOCUMENTED_ROLES[action].length),
      0,
    );
    expect(result.tableDrift).toBe(drift);
    expect(result.probesAnsweredWithData).toBeGreaterThan(0);
    expect(result.letInNotReached).toBeGreaterThan(0);
    expect(result.exposed.length).toBeGreaterThanOrEqual(3);
    const sentence = result.sentence;
    expect(sentence.length).toBeLessThanOrEqual(AUTHORIZATION_SENTENCE_BUDGET);
    expect(sentence).toContain(`sent ${result.probesRun} cells`);
    expect(sentence).toContain(`${result.probesAnsweredWithData} were answered with data`);
    expect(sentence).toContain(
      `${result.letInNotReached} of them cells whose caller should have been let in and was not`,
    );
    expect(sentence).toContain(
      `The action table differs from the documented one in ${drift} places.`,
    );
    expect(sentence).toContain("First exposed: ");
    expect(sentence).toContain("Not seen: ");
    expect(sentence).not.toMatch(DASHES);
    const read = parseResults(serialiseResults(fileWith(recordOf(result))));
    expect(read.suites.exposure?.suites[0]).toBe(sentence);
    expect(read.suites.exposure?.probesAnsweredWithData).toBe(result.probesAnsweredWithData);
    expect(read.suites.exposure?.letInNotReached).toBe(result.letInNotReached);
  });
});
