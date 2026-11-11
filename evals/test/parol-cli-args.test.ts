import { describe, expect, it } from "vitest";
import { UsageError } from "../src/errors.js";
import { PIN_NAMES, parseAllowDifferences } from "../src/parol/compare.js";
import { USAGE, parseParolArgs } from "../src/parol/cli.js";

// The style rule bans en and em dashes. The pattern is built from code points so this file has none.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

const bad = (args: string[]): string => {
  try {
    parseParolArgs(args);
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return (error as Error).message;
  }
  throw new Error(`expected ${args.join(" ")} to be refused`);
};

describe("the argument parser", () => {
  it("has defaults that run nothing risky: dev split, workflow v1, one repeat, no --yes", () => {
    expect(parseParolArgs([])).toEqual({
      selftest: false,
      simulate: false,
      replay: undefined,
      record: true,
      calibration: false,
      exposure: false,
      split: "dev",
      allowHeldout: false,
      workflow: "v1",
      runs: 1,
      cases: [],
      yes: false,
      maxCostUsd: 2,
      assumedOutputTokens: 1500,
      prices: undefined,
      out: undefined,
      compare: undefined,
      allowDifferences: [],
      playbook: undefined,
      publish: undefined,
      baseline: undefined,
      candidate: undefined,
      openHeldoutTrails: false,
      help: false,
    });
  });

  it("reads every option", () => {
    expect(
      parseParolArgs([
        "--split",
        "all",
        "--allow-heldout",
        "--workflow",
        "v2",
        "--runs",
        "3",
        "--case",
        "PAROL-D05",
        "--case",
        "PAROL-D08",
        "--yes",
        "--calibration",
        "--max-cost",
        "7.5",
        "--assumed-output-tokens",
        "2500",
        "--prices",
        "p.json",
        "--out",
        "o.json",
        "--compare",
        "c.json",
        "--allow-differences",
        "model,prices",
        "--allow-differences",
        "code",
        "--playbook",
        "pb.yaml",
      ]),
    ).toEqual({
      selftest: false,
      simulate: false,
      replay: undefined,
      record: true,
      calibration: true,
      exposure: false,
      split: "all",
      allowHeldout: true,
      workflow: "v2",
      runs: 3,
      cases: ["PAROL-D05", "PAROL-D08"],
      yes: true,
      maxCostUsd: 7.5,
      assumedOutputTokens: 2500,
      prices: "p.json",
      out: "o.json",
      compare: "c.json",
      allowDifferences: ["model", "prices", "code"],
      playbook: "pb.yaml",
      publish: undefined,
      baseline: undefined,
      candidate: undefined,
      openHeldoutTrails: false,
      help: false,
    });
    expect(parseParolArgs(["--selftest"]).selftest).toBe(true);
    expect(parseParolArgs(["--simulate"]).simulate).toBe(true);
    expect(parseParolArgs(["--exposure"]).exposure).toBe(true);
    expect(parseParolArgs(["-h"]).help).toBe(true);
    expect(parseParolArgs(["--help", "--runs", "0"]).help).toBe(true);
  });

  it("refuses the choices it cannot make sense of", () => {
    expect(bad(["--split", "test"])).toBe("--split must be dev, heldout or all.");
    expect(bad(["--workflow", "v9"])).toContain("--workflow must be one of: v1, v2, v3.");
    expect(bad(["--runs", "0"])).toBe("--runs must be a positive whole number.");
    expect(bad(["--runs", "2.5"])).toBe("--runs must be a positive whole number.");
    expect(bad(["--runs", "-1"])).toContain("--runs");
    expect(bad(["--max-cost", "0"])).toBe("--max-cost must be a number above 0.");
    expect(bad(["--max-cost", "free"])).toBe("--max-cost must be a number above 0.");
    expect(bad(["--assumed-output-tokens", "0"])).toBe(
      "--assumed-output-tokens must be a positive whole number.",
    );
    expect(bad(["--selftest", "--simulate"])).toBe(
      "--selftest and --simulate cannot be used together.",
    );
    expect(bad(["extra"])).toBe("Unexpected argument: extra");
    expect(bad(["--no-such-option"])).toContain("--no-such-option");
  });

  it("refuses an empty value and a repeated single-valued option, which would silently keep the last", () => {
    for (const name of ["split", "workflow", "prices", "out", "compare", "playbook"]) {
      expect(bad([`--${name}`, ""])).toBe(`Option --${name} needs a value.`);
    }
    expect(bad(["--case", ""])).toBe("Option --case needs a value.");
    expect(bad(["--runs", "2", "--runs", "3"])).toBe("Option --runs was given more than once.");
    expect(bad(["--max-cost", "1", "--max-cost", "2"])).toBe(
      "Option --max-cost was given more than once.",
    );
    // --case and --allow-differences are meant to be repeated.
    expect(parseParolArgs(["--case", "A", "--case", "B"]).cases).toEqual(["A", "B"]);
  });

  it("does not repeat a workflow name it does not know if it does not look like a name", () => {
    const message = bad(["--workflow", "sk-ant-api03-this-looks-like-a-key"]);
    expect(message).not.toContain("sk-ant");
  });

  it("documents every option in the help text", () => {
    for (const name of [
      "--selftest",
      "--simulate",
      "--split",
      "--allow-heldout",
      "--workflow",
      "--runs",
      "--case",
      "--yes",
      "--max-cost",
      "--prices",
      "--out",
      "--compare",
      "--allow-differences",
      "--playbook",
      "--publish",
      "--baseline",
      "--candidate",
      "--open-heldout-trails",
    ]) {
      expect(USAGE, name).toContain(name);
    }
    for (const code of ["  0 ", "  1 ", "  2 ", "  3 ", "  130 "]) expect(USAGE).toContain(code);
    expect(USAGE).not.toMatch(DASHES);
  });
});

describe("--allow-differences", () => {
  it("takes the names of pins, comma separated or repeated, once each", () => {
    expect(parseAllowDifferences(["model, prices", "code", "model"])).toEqual([
      "model",
      "prices",
      "code",
    ]);
    expect(parseAllowDifferences([])).toEqual([]);
    for (const name of PIN_NAMES.filter((n) => n !== "evaluation")) {
      expect(parseAllowDifferences([name])).toEqual([name]);
    }
  });

  it("refuses an unknown name, an empty one, and the evaluation version", () => {
    expect(() => parseAllowDifferences(["colour"])).toThrow(/does not know a pin with that name/);
    expect(() => parseAllowDifferences(["model,"])).toThrow(
      "Option --allow-differences needs a name.",
    );
    expect(() => parseAllowDifferences(["evaluation"])).toThrow(
      /evaluation version cannot be allowed/,
    );
    // The name that was refused is not repeated.
    try {
      parseAllowDifferences(["my-secret-looking-token"]);
    } catch (error) {
      expect((error as Error).message).not.toContain("my-secret-looking-token");
    }
  });

  it("reads --replay and --no-record, and refuses a replay that is mixed with a live or scripted run", () => {
    expect(parseParolArgs(["--replay", "r.responses.jsonl"])).toMatchObject({
      replay: "r.responses.jsonl",
      record: true,
    });
    expect(parseParolArgs(["--no-record"])).toMatchObject({ replay: undefined, record: false });
    expect(bad(["--replay", "r.jsonl", "--selftest"])).toMatch(/cannot be used with/);
    expect(bad(["--replay", "r.jsonl", "--simulate"])).toMatch(/cannot be used with/);
    expect(bad(["--replay", "r.jsonl", "--yes"])).toMatch(/sends nothing and spends nothing/);
    expect(bad(["--replay"])).toMatch(/--replay/);
    expect(bad(["--replay", ""])).toMatch(/needs a value/);
    expect(bad(["--calibration", "--selftest"])).toMatch(/needs a live run or a replay/);
    expect(bad(["--calibration", "--simulate"])).toMatch(/needs a live run or a replay/);
    expect(parseParolArgs(["--calibration", "--replay", "r.jsonl"])).toMatchObject({
      calibration: true,
      replay: "r.jsonl",
    });
  });
});
