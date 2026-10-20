import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelOutputError, ModelRefusalError, ModelRequestError } from "@clausewise/llm";
import { loadPlaybookFile } from "@clausewise/playbook/node";
import { createOracleGenerator, type OracleRule } from "@clausewise/review/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { run } from "../src/index.js";
import {
  compliantScript,
  failingRules,
  listing,
  makeIo,
  playbookPath,
  ruleIds,
  stage,
  tempDirs,
} from "./support.js";

const PLAYBOOK = playbookPath("nda-mutual.yaml");
const SENTINEL = "an earlier file that must survive";
const GATES = [undefined, "high", "medium", "low"] as const;
type Gate = (typeof GATES)[number];

// What each way of failing looks like to the pipeline. All of them leave the rule unchecked and let
// the others run, except a fatal request error, which ends the review.
const FAILURES: [string, () => unknown][] = [
  ["a reply that does not fit the schema", () => new ModelOutputError("no valid output")],
  ["a refusal", () => new ModelRefusalError("declined", "cyber")],
  ["a request that failed with HTTP 500", () => new ModelRequestError("HTTP 500", 500)],
];
const FATAL = () => new ModelRequestError("HTTP 401", 401, true);

// Severities in the NDA playbook: term is high, definition is medium, governing-law is low.
const deviation: OracleRule = { status: "deviation" };
const ALL = ruleIds("nda-aggressive.docx");

interface Scenario {
  name: string;
  /** Rules the model fails on. */
  unchecked: string[];
  /** Rules that come back as deviations. */
  open?: Record<string, OracleRule>;
  /** The exit code with no --fail-on, then with high, medium and low. */
  exit: [number, number, number, number];
}

const scenarios: Scenario[] = [
  { name: "every rule checked", unchecked: [], exit: [0, 0, 0, 0] },
  { name: "only a low rule unchecked", unchecked: ["governing-law"], exit: [0, 0, 0, 2] },
  { name: "only a medium rule unchecked", unchecked: ["definition"], exit: [0, 0, 2, 2] },
  { name: "only the high rule unchecked", unchecked: ["term"], exit: [0, 2, 2, 2] },
  {
    name: "a high and a low rule unchecked",
    unchecked: ["term", "governing-law"],
    exit: [0, 2, 2, 2],
  },
  {
    name: "a low rule unchecked beside a medium deviation",
    unchecked: ["governing-law"],
    open: { definition: deviation },
    exit: [0, 0, 2, 2],
  },
  {
    name: "a high rule unchecked beside a low deviation",
    unchecked: ["term"],
    open: { "governing-law": deviation },
    exit: [0, 2, 2, 2],
  },
  {
    name: "nine rules unchecked and a low one fine",
    unchecked: ALL.filter((id) => id !== "governing-law"),
    exit: [0, 2, 2, 2],
  },
  { name: "every rule unchecked", unchecked: ALL, exit: [1, 1, 1, 1] },
  {
    name: "every medium and low rule unchecked, the high ones fine",
    unchecked: [
      "definition",
      "permitted-use",
      "compelled-disclosure",
      "return-or-destroy",
      "remedies",
      "governing-law",
    ],
    exit: [0, 0, 2, 2],
  },
];

describe("the exit code of a review that could not check every rule", () => {
  const makeDir = tempDirs();
  let titles: Map<string, string>;

  beforeAll(async () => {
    titles = new Map(
      (await loadPlaybookFile(PLAYBOOK)).rules.map((rule) => [rule.id, rule.title] as const),
    );
  });
  const title = (id: string): string => titles.get(id) ?? `(no rule ${id})`;

  const cases = scenarios.flatMap((scenario) =>
    GATES.flatMap((gate, i) =>
      FAILURES.map(([failure, thrown]) => ({
        scenario,
        gate,
        failure,
        thrown,
        exit: scenario.exit[i] ?? -1,
      })),
    ),
  );

  async function review(
    scenario: Scenario,
    gate: Gate,
    thrown: () => unknown,
    extra: string[] = [],
  ) {
    const dir = await makeDir();
    const input = await stage(dir, "nda-aggressive.docx");
    const failures = Object.fromEntries(scenario.unchecked.map((id) => [id, thrown] as const));
    const generator = failingRules(createOracleGenerator(compliantScript(scenario.open)), failures);
    const harness = makeIo({ generator });
    const gateArgs = gate === undefined ? [] : ["--fail-on", gate];
    const code = await run(
      ["review", input, "--playbook", PLAYBOOK, ...gateArgs, ...extra],
      harness.io,
    );
    return { dir, code, generator, ...harness };
  }

  it.each(cases)(
    "$scenario.name, $failure, --fail-on $gate: exits $exit",
    async ({ scenario, gate, thrown, exit }) => {
      const { dir, code, stdout, stderr, generator } = await review(scenario, gate, thrown);

      expect(code).toBe(exit);
      // Every rule was asked about, so a rule that could not be checked is never a rule skipped.
      expect(generator.calls).toHaveLength(ALL.length);

      if (exit === 1) {
        expect(stderr()).toContain("Error: No rule could be checked, so nothing was reviewed.");
        expect(stderr()).toContain("No output files were written.");
        expect(stdout()).toBe("");
        expect(await listing(dir)).toEqual(["nda-aggressive.docx"]);
        return;
      }

      expect(await listing(dir)).toHaveLength(4);
      if (scenario.unchecked.length === 0) {
        expect(stderr()).not.toContain("WARNING");
        expect(stdout()).not.toContain("could not be checked");
        return;
      }
      // Loud, and naming each rule that was not checked, whatever the gate says.
      expect(stderr()).toMatch(
        new RegExp(`WARNING: ${scenario.unchecked.length} of 10 rules could not be checked`),
      );
      for (const id of scenario.unchecked.slice(0, 8)) expect(stderr()).toContain(title(id));
      expect(stdout()).toMatch(new RegExp(`Could not be checked:\\s+${scenario.unchecked.length}`));
      // Said of a review with holes in it, "no deviations" would read as a clean contract.
      expect(stdout()).not.toMatch(/^No deviations or missing clauses\.$/m);
      if (exit === 2) expect(stderr()).toContain("Exiting with code 2");
      else expect(stderr()).not.toContain("Exiting with code");
    },
  );

  it("says in the summary that an unchecked rule is treated as open, only from the gate up", async () => {
    const scenario = scenarios[4] as Scenario; // term (high) and governing-law (low)
    const { stdout, stderr } = await review(scenario, "high", FAILURES[0]?.[1] as () => unknown);

    expect(stdout()).toContain(
      `[high] ${title("term")}: could not be checked, treated as open (--fail-on high): `,
    );
    expect(stdout()).toContain(`[low] ${title("governing-law")}: `);
    expect(stdout()).not.toMatch(/\[low\] .*treated as open/);
    expect(stdout()).toContain("among the 8 rules that were checked.");
    expect(stderr()).toContain(
      "Exiting with code 2: 1 open item at high severity or above (--fail-on high), including 1 rule " +
        "that could not be checked.",
    );
    expect(stderr()).toContain("Rules at high severity or above count as open for --fail-on high.");
  });

  it("does not call a rule open when there is no --fail-on", async () => {
    const scenario = scenarios[4] as Scenario;
    const { stdout, stderr } = await review(scenario, undefined, FAILURES[1]?.[1] as () => unknown);

    expect(stdout()).not.toContain("treated as open");
    expect(stderr()).not.toContain("count as open");
    expect(stderr()).toContain(`${title("term")} (high)`);
    expect(stderr()).toContain(`${title("governing-law")} (low)`);
  });

  it("names the first eight rules and counts the rest", async () => {
    const scenario = scenarios[7] as Scenario;
    const { stderr } = await review(scenario, undefined, FAILURES[2]?.[1] as () => unknown);

    expect(stderr()).toContain("WARNING: 9 of 10 rules could not be checked");
    expect(stderr()).toMatch(/, and 1 more\./);
  });

  it("groups the reasons when no rule could be checked", async () => {
    const scenario = scenarios[8] as Scenario;
    const { stderr } = await review(scenario, undefined, FAILURES[2]?.[1] as () => unknown);

    expect(stderr()).toMatch(/Why:\n {2}10 rules: /);
    expect(stderr().match(/^ {2}\d+ rules?: /gm)).toHaveLength(1);
  });

  it("stops with exit 1 and no files when a fatal request error comes after some rules", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-aggressive.docx");
    const generator = failingRules(createOracleGenerator(compliantScript()), { term: FATAL });
    const { io, stderr, stdout } = makeIo({ generator });

    const code = await run(["review", input, "--playbook", PLAYBOOK, "--fail-on", "low"], io);

    expect(code).toBe(1);
    expect(stderr()).toContain("Error: ");
    expect(stdout()).toBe("");
    expect(await listing(dir)).toEqual(["nda-aggressive.docx"]);
  });
});

describe("--force and outputs that already exist, with rules that could not be checked", () => {
  const makeDir = tempDirs();
  const SUFFIXES = ["redlined.docx", "report.json", "summary.md"];

  async function setup(existing: boolean) {
    const dir = await makeDir();
    const input = await stage(dir, "nda-aggressive.docx");
    const paths = SUFFIXES.map((suffix) => join(dir, `nda-aggressive.${suffix}`));
    if (existing) for (const path of paths) await writeFile(path, SENTINEL);
    return { dir, input, paths };
  }

  const unchecked = (...ids: string[]) =>
    failingRules(
      createOracleGenerator(compliantScript()),
      Object.fromEntries(ids.map((id) => [id, () => new ModelOutputError("no valid output")])),
    );

  const table: {
    name: string;
    existing: boolean;
    force: boolean;
    unchecked: string[];
    exit: number;
    /** Whether the model is called at all. */
    reviewed: boolean;
    /** Whether the three outputs end up holding this run's results. */
    replaced: boolean;
  }[] = [
    {
      name: "no outputs yet, no --force",
      existing: false,
      force: false,
      unchecked: ["term"],
      exit: 2,
      reviewed: true,
      replaced: true,
    },
    {
      name: "no outputs yet, --force",
      existing: false,
      force: true,
      unchecked: ["term"],
      exit: 2,
      reviewed: true,
      replaced: true,
    },
    {
      name: "outputs there, no --force",
      existing: true,
      force: false,
      unchecked: ["term"],
      exit: 1,
      reviewed: false,
      replaced: false,
    },
    {
      name: "outputs there, --force",
      existing: true,
      force: true,
      unchecked: ["term"],
      exit: 2,
      reviewed: true,
      replaced: true,
    },
    {
      name: "outputs there, --force, only a low rule unchecked",
      existing: true,
      force: true,
      unchecked: ["governing-law"],
      exit: 0,
      reviewed: true,
      replaced: true,
    },
    {
      name: "outputs there, --force, every rule unchecked",
      existing: true,
      force: true,
      unchecked: ALL,
      exit: 1,
      reviewed: true,
      replaced: false,
    },
    {
      name: "no outputs yet, --force, every rule unchecked",
      existing: false,
      force: true,
      unchecked: ALL,
      exit: 1,
      reviewed: true,
      replaced: false,
    },
  ];

  it.each(table)("$name, --fail-on high: exits $exit", async (row) => {
    const { dir, input, paths } = await setup(row.existing);
    const generator = unchecked(...row.unchecked);
    const { io, stderr } = makeIo({ generator });

    const code = await run(
      [
        "review",
        input,
        "--playbook",
        PLAYBOOK,
        "--fail-on",
        "high",
        ...(row.force ? ["--force"] : []),
      ],
      io,
    );

    expect(code).toBe(row.exit);
    expect(generator.calls.length > 0).toBe(row.reviewed);
    if (!row.reviewed) expect(stderr()).not.toContain("Sending the contract text");
    for (const path of paths) {
      if (row.replaced) {
        expect(await readFile(path, "utf8")).not.toBe(SENTINEL);
      } else if (row.existing) {
        // A review that produced nothing must not eat the results of an earlier one.
        expect(await readFile(path, "utf8")).toBe(SENTINEL);
      }
    }
    if (!row.existing && !row.replaced) {
      expect(await listing(dir)).toEqual(["nda-aggressive.docx"]);
    }
  });
});

describe("every combination of existing outputs, --force, --fail-on and unchecked rules", () => {
  const makeDir = tempDirs();
  const SUFFIXES = ["redlined.docx", "report.json", "summary.md"];
  const NAMES = [
    "every rule checked",
    "only a low rule unchecked",
    "only the high rule unchecked",
    "every rule unchecked",
  ];
  const chosen = scenarios.filter((scenario) => NAMES.includes(scenario.name));

  const rows = chosen.flatMap((scenario) =>
    [false, true].flatMap((existing) =>
      [false, true].flatMap((force) =>
        (["high", "low", undefined] as const).map((gate) => {
          const column = gate === undefined ? 0 : GATES.indexOf(gate);
          // Outputs in the way and no --force is refused before a single rule is paid for.
          const refused = existing && !force;
          return {
            scenario,
            existing,
            force,
            gate,
            exit: refused ? 1 : (scenario.exit[column] ?? -1),
          };
        }),
      ),
    ),
  );

  it.each(rows)(
    "$scenario.name, outputs there: $existing, --force: $force, --fail-on $gate: exits $exit",
    async ({ scenario, existing, force, gate, exit }) => {
      const dir = await makeDir();
      const input = await stage(dir, "nda-aggressive.docx");
      const paths = SUFFIXES.map((suffix) => join(dir, `nda-aggressive.${suffix}`));
      if (existing) for (const path of paths) await writeFile(path, SENTINEL);
      const failures = Object.fromEntries(
        scenario.unchecked.map((id) => [id, () => new ModelRefusalError("declined")] as const),
      );
      const generator = failingRules(createOracleGenerator(compliantScript()), failures);
      const { io, stderr } = makeIo({ generator });

      const code = await run(
        [
          ...["review", input, "--playbook", PLAYBOOK],
          ...(gate === undefined ? [] : ["--fail-on", gate]),
          ...(force ? ["--force"] : []),
        ],
        io,
      );

      expect(code).toBe(exit);
      expect(generator.calls.length > 0).toBe(!(existing && !force));
      if (existing && !force) expect(stderr()).toContain("Refusing to overwrite");
      for (const path of paths) {
        if (exit === 1) {
          // Nothing was reviewed or nothing may be replaced: an earlier review is left as it was.
          if (existing) expect(await readFile(path, "utf8")).toBe(SENTINEL);
        } else {
          expect(await readFile(path, "utf8")).not.toBe(SENTINEL);
        }
      }
      if (exit === 1 && !existing) expect(await listing(dir)).toEqual(["nda-aggressive.docx"]);
    },
  );
});
