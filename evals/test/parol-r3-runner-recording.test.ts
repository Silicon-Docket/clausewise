import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ModelRequestError } from "@clausewise/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RECORDING_SUFFIX } from "../src/parol/replay.js";
import {
  makeTempDir,
  oracleFactory,
  readResults,
  removeDir,
  run,
} from "../src/parol/testing-run.js";

/**
 * A recording that holds no answer. A first call that started and then failed for good, or was
 * cut off, leaves a header and a trailer and no call, which no replay can use. It is not kept,
 * the results do not name it, and neither the messages nor the report advise replaying it. Every
 * answer here comes from the scripted key oracle: no model produced any of it, and nothing is sent
 * anywhere.
 */

let dir = "";
let n = 0;
beforeAll(async () => {
  dir = await makeTempDir();
});
afterAll(async () => {
  await removeDir(dir);
});
const freshDir = async (): Promise<string> => {
  const path = join(dir, String(++n));
  await mkdir(path, { recursive: true });
  return path;
};

const LEDGER = "parol-heldout-runs.jsonl";
const recordingsIn = async (folder: string): Promise<string[]> =>
  (await readdir(folder)).filter((name) => name.endsWith(RECORDING_SUFFIX));
const resultsIn = async (folder: string) => {
  const names = (await readdir(folder)).filter((name) => name.endsWith(".json"));
  expect(names).toHaveLength(1);
  return readResults(join(folder, names[0]!));
};

const NONE = "No model answer was recorded, so there is nothing to replay.";
const rejected = (): ModelRequestError => new ModelRequestError("a rejected key", 401);

describe("a first call that started and gave no answer", () => {
  it("keeps no recording and does not advise a replay, in stderr, in the results or in the report, when the provider rejects it", async () => {
    const resultsDir = await freshDir();
    const stand = oracleFactory({ failFrom: { call: 1, error: rejected() } });
    const result = await run(["--yes", "--case", "PAROL-D01"], {
      resultsDir,
      generatorFactory: stand.factory,
    });
    expect(result.code, result.stderr).toBe(1);
    expect(stand.calls()).toBe(1);
    expect(result.stderr).toContain(NONE);
    expect(result.stderr).not.toContain("Replay them");
    expect(result.stderr).not.toContain("(0 calls)");
    // The file would hold a header and an incomplete trailer, and the next --replay would stop on it.
    expect(await recordingsIn(resultsDir)).toEqual([]);
    const file = await resultsIn(resultsDir);
    expect(file.recording).toBeNull();
    // The run itself is on record, with what stopped it.
    expect(file.complete).toBe(false);
    expect(file.stoppedBecause).toContain("The provider rejected the API key");
    expect(result.stdout).not.toContain("Replay them");
    expect(result.stdout).not.toContain("**Recording.**");
  });

  it("does the same for a held-out run, whose ledger line stays because a request may have left", async () => {
    const resultsDir = await freshDir();
    const stand = oracleFactory({ failFrom: { call: 1, error: rejected() } });
    const result = await run(
      ["--yes", "--split", "heldout", "--allow-heldout", "--case", "PAROL-H01"],
      { resultsDir, generatorFactory: stand.factory },
    );
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain(NONE);
    expect(result.stderr).not.toContain("Replay them");
    expect(await recordingsIn(resultsDir)).toEqual([]);
    expect((await readFile(join(resultsDir, LEDGER), "utf8")).trim().split("\n")).toHaveLength(1);
    expect((await resultsIn(resultsDir)).recording).toBeNull();
  });

  it("does the same when the run is interrupted during the first call", async () => {
    const resultsDir = await freshDir();
    const controller = new AbortController();
    const stand = oracleFactory({});
    const result = await run(["--yes", "--case", "PAROL-D01"], {
      resultsDir,
      signal: controller.signal,
      generatorFactory: (request) => ({
        ...stand.factory(request),
        // The call is under way when the signal comes, and it ends as an aborted call does.
        generate: () => {
          controller.abort();
          return Promise.reject(new DOMException("aborted", "AbortError"));
        },
      }),
    });
    expect(result.code, result.stderr).toBe(130);
    expect(result.stderr).toContain(NONE);
    expect(result.stderr).not.toContain("Replay them");
    expect(await recordingsIn(resultsDir)).toEqual([]);
    const file = await resultsIn(resultsDir);
    expect(file.recording).toBeNull();
    expect(file.stoppedBecause).toBe("Interrupted.");
    expect(result.stdout).not.toContain("Replay them");
  });

  it("leaves nothing of the failed run in the folder for a later run to find beside its own recording", async () => {
    const resultsDir = await freshDir();
    const first = await run(["--yes", "--case", "PAROL-D01", "--out", join(resultsDir, "a.json")], {
      resultsDir,
      generatorFactory: oracleFactory({ failFrom: { call: 1, error: rejected() } }).factory,
    });
    expect(first.code, first.stderr).toBe(1);
    const second = await run(
      ["--yes", "--case", "PAROL-D01", "--out", join(resultsDir, "b.json")],
      {
        resultsDir,
        generatorFactory: oracleFactory({}).factory,
      },
    );
    expect(second.code, second.stderr).toBe(0);
    // Only the run that was answered has a recording.
    expect(await recordingsIn(resultsDir)).toEqual(["b.responses.jsonl"]);
  });
});

describe("a recording that holds an answer, or that is incomplete for another reason", () => {
  it("is kept and offered for a replay when the run stopped after a call was answered", async () => {
    const resultsDir = await freshDir();
    // Call 1 is answered and recorded, and call 2 is rejected for good.
    const stand = oracleFactory({ failFrom: { call: 2, error: rejected() } });
    const result = await run(["--yes", "--case", "PAROL-D01"], {
      resultsDir,
      generatorFactory: stand.factory,
    });
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).not.toContain(NONE);
    expect(result.stderr).toContain("(1 calls). Replay them with --replay.");
    expect(await recordingsIn(resultsDir)).toHaveLength(1);
    const file = await resultsIn(resultsDir);
    expect(file.recording).toMatchObject({ role: "recorded", calls: 1 });
    expect(file.recording!.failed).toBeUndefined();
    expect(result.stdout).toContain("Replay them with --replay");
  });

  it("is kept and said to be incomplete when every call was lost to a bug and none has a line", async () => {
    const resultsDir = await freshDir();
    // Neither a model's answer nor an abort: the stages score each call as failed and the
    // recording cannot hold a line for it. No line was written, and the file is not "empty" in the
    // sense of the case above: it is a recording that lost calls.
    const stand = oracleFactory({});
    const result = await run(["--yes", "--case", "PAROL-D01"], {
      resultsDir,
      generatorFactory: (request) => ({
        ...stand.factory(request),
        generate: () => Promise.reject(new TypeError("a bug")),
      }),
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).not.toContain(NONE);
    expect(result.stderr).toContain("could not be recorded, so a replay will stop at");
    expect(await recordingsIn(resultsDir)).toHaveLength(1);
    const file = await resultsIn(resultsDir);
    expect(file.recording).toMatchObject({ role: "recorded", calls: 0, failed: true });
    expect(result.stdout).toContain("could not be recorded completely");
  });
});
