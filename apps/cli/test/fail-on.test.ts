import { createOracleGenerator, type OracleRule } from "@clausewise/review/testing";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.js";
import { compliantScript, listing, makeIo, playbookPath, stage, tempDirs } from "./support.js";

const PLAYBOOK = playbookPath("nda-mutual.yaml");
const SEVERITIES = ["high", "medium", "low"] as const;

// Rule severities in the NDA playbook: term is high, definition and compelled-disclosure are
// medium, governing-law is low. Compelled disclosure is required, so "missing" stands.
const deviation: OracleRule = { status: "deviation" };
const missing: OracleRule = { status: "missing" };

const scenarios: { name: string; open: Record<string, OracleRule>; exit: number[] }[] = [
  { name: "nothing open", open: {}, exit: [0, 0, 0] },
  { name: "one low deviation", open: { "governing-law": deviation }, exit: [0, 0, 2] },
  { name: "one medium deviation", open: { definition: deviation }, exit: [0, 2, 2] },
  { name: "one medium missing clause", open: { "compelled-disclosure": missing }, exit: [0, 2, 2] },
  { name: "one high deviation", open: { term: deviation }, exit: [2, 2, 2] },
  {
    name: "a high and a low deviation",
    open: { term: deviation, "governing-law": deviation },
    exit: [2, 2, 2],
  },
];

describe("--fail-on", () => {
  const makeDir = tempDirs();

  const cases = scenarios.flatMap(({ name, open, exit }) =>
    SEVERITIES.map((severity, i) => ({ name, open, severity, exit: exit[i] ?? -1 })),
  );

  it.each(cases)("with $name and --fail-on $severity exits $exit", async (scenario) => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-aggressive.docx");
    const generator = createOracleGenerator(compliantScript(scenario.open));
    const { io, stderr, stdout } = makeIo({ generator });

    const code = await run(
      ["review", input, "--playbook", PLAYBOOK, "--fail-on", scenario.severity],
      io,
    );

    expect(code).toBe(scenario.exit);
    // A gate that fails still leaves the review behind for the person to read.
    expect(await listing(dir)).toHaveLength(4);
    expect(stdout()).toContain("Written:");
    if (scenario.exit === 2) {
      expect(stderr()).toContain("Exiting with code 2");
      expect(stderr()).toContain(`--fail-on ${scenario.severity}`);
    } else {
      expect(stderr()).not.toContain("Exiting with code");
    }
  });

  it("does not look at severity without --fail-on", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-aggressive.docx");
    const generator = createOracleGenerator(compliantScript({ term: deviation }));
    const { io } = makeIo({ generator });

    expect(await run(["review", input, "--playbook", PLAYBOOK], io)).toBe(0);
  });

  it("accepts the --fail-on=value form", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-aggressive.docx");
    const generator = createOracleGenerator(compliantScript({ term: deviation }));
    const { io } = makeIo({ generator });

    expect(await run(["review", input, "--playbook", PLAYBOOK, "--fail-on=high"], io)).toBe(2);
  });

  it("counts a deviation and a missing clause together", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-aggressive.docx");
    const open = { definition: deviation, "compelled-disclosure": missing };
    const generator = createOracleGenerator(compliantScript(open));
    const { io, stderr } = makeIo({ generator });

    await run(["review", input, "--playbook", PLAYBOOK, "--fail-on", "medium"], io);

    expect(stderr()).toContain("2 open items at medium severity or above");
  });

  it("rejects a severity that does not exist before anything is read or sent", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-aggressive.docx");
    const generator = createOracleGenerator(compliantScript());
    const { io, stderr } = makeIo({ generator });

    const code = await run(["review", input, "--playbook", PLAYBOOK, "--fail-on", "urgent"], io);

    expect(code).toBe(1);
    expect(stderr()).toContain("--fail-on must be one of: high, medium, low.");
    expect(generator.calls).toHaveLength(0);
    expect(await listing(dir)).toEqual(["nda-aggressive.docx"]);
  });
});
