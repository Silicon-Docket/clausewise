import { readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AnchorResolutionError } from "../src/parol/anchors.js";
import { ScoringError } from "../src/parol/score.js";
import {
  makeTempDir,
  oracleFactory,
  readResults,
  removeDir,
  run,
} from "../src/parol/testing-run.js";

/**
 * Scoring happens after a live run has been paid for, so a failure in it must not lose the run.
 * The scorer is replaced here by one that fails on demand, which is the only way to reach the
 * paths, since the checks before the run are there to make a scoring failure impossible.
 */

const state = vi.hoisted(() => ({ fail: null as null | "scoring" | "anchor" | "unexpected" }));

vi.mock("../src/parol/score.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/parol/score.js")>();
  const { AnchorResolutionError } = await import("../src/parol/anchors.js");
  return {
    ...original,
    scoreRepeat: (...args: Parameters<typeof original.scoreRepeat>) => {
      if (state.fail === "scoring")
        throw new original.ScoringError("PAROL-D01 dur-1: no observation for repeat 1");
      if (state.fail === "anchor") {
        throw new AnchorResolutionError(
          "anchor in PAROL-D01 D1 clause 6.1: it occurs 0 times, expected once",
        );
      }
      if (state.fail === "unexpected")
        throw new Error("a sentence from a contract that must not be shown");
      return original.scoreRepeat(...args);
    },
  };
});

let dir = "";
let n = 0;
beforeAll(async () => {
  dir = await makeTempDir();
});
afterAll(async () => {
  await removeDir(dir);
  state.fail = null;
});

const usage = () => ({
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

describe("a failure in scoring after the run", () => {
  it("keeps the run and its usage, writes the file without scores, and exits 1", async () => {
    state.fail = "scoring";
    const resultsDir = `${dir}/${++n}`;
    const stand = oracleFactory({ usage });
    const { code, stderr, stdout } = await run(["--yes", "--case", "PAROL-D01"], {
      resultsDir,
      generatorFactory: stand.factory,
    });
    state.fail = null;
    expect(code).toBe(1);
    expect(stderr).toContain(
      "Error: the scores could not be worked out (PAROL-D01 dur-1: no observation for repeat 1)",
    );
    const [name] = await readdir(resultsDir);
    const results = await readResults(`${resultsDir}/${name}`);
    expect(results.complete).toBe(false);
    expect(results.stoppedBecause).toContain(
      "Scoring failed (PAROL-D01 dur-1: no observation for repeat 1).",
    );
    expect(results.usage.total).toMatchObject({ responses: 9, inputTokens: 9000 });
    expect(results.runs).toHaveLength(1);
    expect(results.sections[0]!.metrics).toBeNull();
    expect(stdout).toContain("**INCOMPLETE: the run stopped early.** Scoring failed");
  });

  it("is an integrity failure when an anchor of the key does not resolve, exit 2", async () => {
    state.fail = "anchor";
    const resultsDir = `${dir}/${++n}`;
    const { code, stderr } = await run(["--selftest", "--case", "PAROL-D01"], { resultsDir });
    state.fail = null;
    expect(code).toBe(2);
    expect(stderr).toContain(
      "INTEGRITY FAILURE: anchor in PAROL-D01 D1 clause 6.1: it occurs 0 times, expected once.",
    );
    expect((await readdir(resultsDir)).length).toBe(1);
  });

  it("shows nothing of an error it does not know, which could hold contract text", async () => {
    state.fail = "unexpected";
    const resultsDir = `${dir}/${++n}`;
    const { code, stderr, stdout } = await run(["--selftest", "--case", "PAROL-D01"], {
      resultsDir,
    });
    state.fail = null;
    expect(code).toBe(1);
    expect(stderr).toContain("Unexpected error (Error). This is a bug in the evaluation runner.");
    expect(stderr).not.toContain("a sentence from a contract");
    expect(stdout).not.toContain("a sentence from a contract");
    const [name] = await readdir(resultsDir);
    expect(JSON.stringify(await readResults(`${resultsDir}/${name}`))).not.toContain(
      "a sentence from a contract",
    );
  });

  it("scores normally once the fault is gone", async () => {
    state.fail = null;
    const { code } = await run(["--selftest", "--case", "PAROL-D01"], {
      resultsDir: `${dir}/${++n}`,
    });
    expect(code).toBe(0);
    expect(ScoringError.name).toBe("ScoringError");
    expect(AnchorResolutionError.name).toBe("AnchorResolutionError");
  });
});
