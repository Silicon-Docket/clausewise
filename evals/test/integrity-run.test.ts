import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EvalResult } from "../src/result.js";
import { makeTempDir, removeDir, run } from "./support.js";

const state = vi.hoisted(() => ({ corrupt: false }));

// The pipeline is real. Only its output is damaged on the way to the harness, which is the one
// way to show what the harness does when the redline engine misbehaves.
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
        // Only nda-aggressive.docx has the title that is changed, so the others stay whole.
        return output;
      }
    },
  };
});

let dir = "";
beforeAll(async () => {
  dir = await makeTempDir();
});
afterAll(async () => {
  await removeDir(dir);
});

describe("an integrity failure in a run", () => {
  it("is printed first and in capitals, and the run exits 2", async () => {
    state.corrupt = true;
    const out = `${dir}/damaged.json`;
    const { code, stdout, stderr } = await run(["--selftest", "--out", out], { dir });
    state.corrupt = false;

    expect(code).toBe(2);
    expect(
      stdout.startsWith("**INTEGRITY FAILURE: 1 OF 3 REDLINED FILES CAN NOT BE TRUSTED."),
    ).toBe(true);
    expect(stdout.indexOf("INTEGRITY FAILURE")).toBeLessThan(
      stdout.indexOf("# Clausewise evaluation"),
    );
    expect(stdout).toContain("- nda-aggressive.docx, run 1:");
    expect(stdout).toContain("does not reject back to the original text");
    expect(stdout).toContain("| Integrity | **FAIL** (1 of 3) |");
    expect(stdout).toContain("| nda-aggressive.docx | 1 | 9 | 9 | **FAIL** |");
    expect(stdout).toContain("| nda-balanced.docx | 1 | 0 | 0 | pass |");
    expect(stderr).toContain("INTEGRITY FAILURE:");

    const result = JSON.parse(await readFile(out, "utf8")) as EvalResult;
    expect(result.score.integrityFailures).toHaveLength(1);
    expect(result.score.integrityFailures[0]).toMatchObject({
      fixture: "nda-aggressive.docx",
      run: 1,
    });
    // The scores are not touched by it: the answers were right, the file was not.
    expect(result.score.accuracy).toBe(1);
  });

  it("fails a run of the one damaged fixture alone", async () => {
    state.corrupt = true;
    const { code } = await run(
      ["--selftest", "--out", `${dir}/damaged-2.json`, "--fixture", "nda-aggressive.docx"],
      {
        dir,
      },
    );
    state.corrupt = false;
    expect(code).toBe(2);
  });

  it("is absent from a clean run", async () => {
    const { code, stdout, stderr } = await run(["--selftest", "--out", `${dir}/clean.json`], {
      dir,
    });
    expect(code).toBe(0);
    expect(stdout).not.toContain("INTEGRITY FAILURE");
    expect(stderr).not.toContain("INTEGRITY FAILURE");
    expect(stdout).toContain("| Integrity | pass (3 redlined files checked) |");
  });
});
