import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Fixture } from "../src/fixtures.js";
import type { GeneratorRequest } from "../src/harness.js";
import type { EvalResult } from "../src/result.js";
import {
  allFixtures,
  forbiddenFactory,
  makeTempDir,
  removeDir,
  routedModel,
  run,
} from "./support.js";

const state = vi.hoisted(() => ({ corrupt: false }));

// The pipeline is real. Only its output is damaged on the way to the harness.
vi.mock("@clausewise/review", async (importOriginal) => {
  const original = await importOriginal<typeof import("@clausewise/review")>();
  return {
    ...original,
    reviewContract: async (...args: Parameters<typeof original.reviewContract>) => {
      const output = await original.reviewContract(...args);
      if (!state.corrupt) return output;
      const { corruptText } = await import("./support.js");
      try {
        return { ...output, redlined: await corruptText(output.redlined) };
      } catch {
        return output;
      }
    },
  };
});

let dir = "";
let fixtures: Fixture[] = [];
beforeAll(async () => {
  dir = await makeTempDir();
  fixtures = await allFixtures();
});
afterAll(async () => {
  await removeDir(dir);
});

const huge = { inputTokens: 5_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const TWO = ["--fixture", "nda-aggressive.docx", "--fixture", "nda-balanced.docx"];

describe("the exit code of a run that failed its integrity check and also stopped", () => {
  it("is 2 when the spend guard stopped it", async () => {
    state.corrupt = true;
    const factory = ({ onUsage }: GeneratorRequest) =>
      routedModel(fixtures, {
        before: ({ n }) => {
          if (n > 10) onUsage(huge);
        },
      });
    const { code, stdout } = await run(
      ["--yes", "--max-cost", "1.5", ...TWO, "--out", `${dir}/guard.json`],
      { dir, generatorFactory: factory },
    );
    state.corrupt = false;
    expect(code).toBe(2);
    expect(stdout.startsWith("**INTEGRITY FAILURE")).toBe(true);
  });

  it("is 2 when Ctrl-C stopped it", async () => {
    state.corrupt = true;
    const controller = new AbortController();
    const factory = () =>
      routedModel(fixtures, {
        before: ({ n }) => {
          if (n === 11) controller.abort(new Error("Interrupted"));
        },
      });
    const { code } = await run(["--yes", ...TWO, "--out", `${dir}/ctrlc.json`], {
      dir,
      generatorFactory: factory,
      signal: controller.signal,
    });
    state.corrupt = false;
    expect(code).toBe(2);
  });
});

describe("what a stopped run leaves", () => {
  it("keeps the usage and the report when the limit stops it inside the first review", async () => {
    const out = `${dir}/first.json`;
    const factory = ({ onUsage }: GeneratorRequest) =>
      routedModel(fixtures, { before: () => onUsage(huge) });
    const { code, stdout, stderr } = await run(
      ["--yes", "--max-cost", "1.5", "--fixture", "nda-balanced.docx", "--out", out],
      { dir, generatorFactory: factory },
    );
    expect(code).toBe(3);
    expect(stderr).toContain(`Results written to ${out}`);
    expect(stdout).toContain("**INCOMPLETE: the run stopped early.**");
    const result = JSON.parse(await readFile(out, "utf8")) as EvalResult;
    expect(result.complete).toBe(false);
    expect(result.runs).toHaveLength(0);
    expect(result.usage.total?.inputTokens).toBeGreaterThanOrEqual(500_000);
  });

  it("leaves a checkpoint after every review, and removes it once the results are written", async () => {
    const out = `${dir}/checkpoint.json`;
    let seen: string[] = [];
    const factory = () =>
      routedModel(fixtures, {
        before: ({ n }) => {
          // The first call of the second fixture: the first review is done.
          if (n === 11) void readdir(dir).then((names) => (seen = names));
        },
      });
    const { code } = await run(["--yes", ...TWO, "--out", out], { dir, generatorFactory: factory });
    expect(code).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toContain("checkpoint.json.partial");
    expect(await readdir(dir)).not.toContain("checkpoint.json.partial");
    expect(await readdir(dir)).not.toContain(`checkpoint.json.${process.pid}.tmp`);
  });
});

describe("a results file that cannot be written", () => {
  it("is found out before any model is called", async () => {
    const factory = forbiddenFactory();
    const { code, stderr } = await run(["--yes", "--out", "/dev/null/results.json"], {
      dir,
      generatorFactory: factory,
    });
    expect(code).toBe(1);
    expect(stderr).toContain("is not a directory");
    expect(factory.used()).toBe(false);
  });
});

describe("the default results file", () => {
  it("gets a number added when a run started in the same second already took the name", async () => {
    const same = await makeTempDir();
    try {
      const now = () => new Date("2026-03-04T05:06:07.890Z");
      const first = await run(["--selftest"], { dir: same, now });
      const second = await run(["--selftest"], { dir: same, now });
      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      expect((await readdir(same)).sort()).toEqual([
        "20260304T050607Z-2.json",
        "20260304T050607Z.json",
      ]);
    } finally {
      await removeDir(same);
    }
  });
});
