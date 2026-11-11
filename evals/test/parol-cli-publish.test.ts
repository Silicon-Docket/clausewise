import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSimulatedModel } from "../../apps/parol/src/demo/simulated-model.js";
import {
  parseComparisonPage,
  type ComparisonPage,
} from "../../apps/parol/src/evaluations/index.js";
import { UsageError } from "../src/errors.js";
import { USAGE, parseParolArgs, type ParolIo } from "../src/parol/cli.js";
import { serialiseResults } from "../src/parol/results.js";
import {
  REPO_ROOT,
  changeKey,
  copyRoot,
  filePath,
  makeTempDir,
  readResults,
  rehash,
  removeDir,
  run,
  type Captured,
} from "../src/parol/testing-run.js";
import {
  DASHES,
  GIT,
  HELDOUT_ALLOW,
  scriptedHeldoutRun,
  simulatedRun,
} from "./parol-page-support.js";

/**
 * `--publish`, `--baseline`, `--candidate` and `--open-heldout-trails`, through the real command.
 * The results files are real ones written by the command: SIMULATED runs of the worked example and
 * a SIMULATED and a SELFTEST run of one held-out case, all scripted stand-ins whose numbers say
 * nothing about any model. A test that edits a copy of a file says FABRICATED FOR A TEST where it
 * does. No model is called and nothing is sent.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let dir = "";
let n = 0;
let a = "";
let b = "";
let heldSim = "";
let heldSelf = "";

beforeAll(async () => {
  dir = await makeTempDir();
  a = await simulatedRun(dir, "sim-v1.json", "v1");
  b = await simulatedRun(dir, "sim-v2.json", "v2");
  heldSim = await scriptedHeldoutRun(dir, "held-sim.json", "simulate");
  heldSelf = await scriptedHeldoutRun(dir, "held-self.json", "selftest");
});
afterAll(async () => {
  await removeDir(dir);
});

/** A folder of its own for one test. */
const fresh = (): string => join(dir, `case-${++n}`);

/** A model must never be asked for on the paths that compare files that exist already. */
const forbidden = (): never => {
  throw new Error("a generator was requested on a path that must run nothing");
};

/** The command with a clock and a commit that do not depend on the checkout. */
function cli(args: string[], io: Partial<ParolIo> = {}): Promise<Captured> {
  return run(args, {
    resultsDir: join(fresh(), "results"),
    gitInfo: GIT,
    now: () => new Date("2026-11-05T09:00:00.000Z"),
    ...io,
  });
}

/** The comparison of two files that exist, which runs nothing. */
const compareFiles = (extra: string[], io: Partial<ParolIo> = {}): Promise<Captured> =>
  cli(["--baseline", a, "--candidate", b, ...extra], { generatorFactory: forbidden, ...io });

const idOf = (stderr: string): string => /cmp_[0-9a-f]{16}/.exec(stderr)?.[0] ?? "";

const folder = (data: string): string => join(data, "evaluations");
const names = (data: string): Promise<string[]> => readdir(folder(data)).catch(() => []);

async function onlyPage(
  data: string,
): Promise<{ name: string; text: string; page: ComparisonPage }> {
  const found = await names(data);
  expect(found).toHaveLength(1);
  const name = found[0]!;
  const text = await readFile(join(folder(data), name), "utf8");
  const parsed = parseComparisonPage(text, name);
  if (!parsed.ok)
    throw new Error(`the published file is not accepted by the application: ${parsed.problem}`);
  return { name, text, page: parsed.page };
}

const bad = (args: string[]): string => {
  try {
    parseParolArgs(args);
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return (error as Error).message;
  }
  throw new Error(`expected ${args.join(" ")} to be refused`);
};

describe("the options", () => {
  it("reads --publish, --baseline, --candidate and --open-heldout-trails", () => {
    expect(parseParolArgs(["--baseline", "a.json", "--candidate", "b.json"])).toMatchObject({
      baseline: "a.json",
      candidate: "b.json",
      publish: undefined,
      openHeldoutTrails: false,
    });
    expect(
      parseParolArgs([
        "--baseline",
        "a.json",
        "--candidate",
        "b.json",
        "--publish",
        "./data/parol",
        "--open-heldout-trails",
        "--allow-differences",
        "code",
        "--playbook",
        "pb.yaml",
      ]),
    ).toMatchObject({
      baseline: "a.json",
      candidate: "b.json",
      publish: "./data/parol",
      openHeldoutTrails: true,
      allowDifferences: ["code"],
      playbook: "pb.yaml",
    });
    // With a run, --publish goes with --compare.
    expect(parseParolArgs(["--simulate", "--compare", "a.json", "--publish", "d"])).toMatchObject({
      simulate: true,
      compare: "a.json",
      publish: "d",
    });
  });

  it("refuses --publish with nothing to publish, and names the option", () => {
    expect(bad(["--publish", "d"])).toMatch(/^--publish needs a comparison to publish/);
    expect(bad(["--selftest", "--publish", "d"])).toMatch(/^--publish needs a comparison/);
  });

  it("refuses one of --baseline and --candidate without the other", () => {
    expect(bad(["--baseline", "a.json"])).toBe(
      "--baseline and --candidate go together: give both, or neither.",
    );
    expect(bad(["--candidate", "b.json"])).toBe(
      "--baseline and --candidate go together: give both, or neither.",
    );
  });

  it("refuses every option that runs something when two files are compared, even at its default value", () => {
    const files = ["--baseline", "a.json", "--candidate", "b.json"];
    const running: string[][] = [
      ["--selftest"],
      ["--simulate"],
      ["--replay", "r.jsonl"],
      ["--calibration"],
      ["--exposure"],
      ["--no-record"],
      ["--split", "dev"],
      ["--allow-heldout"],
      ["--workflow", "v1"],
      ["--runs", "1"],
      ["--case", "PAROL-D05"],
      ["--yes"],
      ["--max-cost", "2"],
      ["--assumed-output-tokens", "1500"],
      ["--prices", "p.json"],
      ["--out", "o.json"],
      ["--compare", "c.json"],
    ];
    for (const extra of running) {
      const message = bad([...files, ...extra]);
      expect(message, extra.join(" ")).toBe(
        `${extra[0]} cannot be used with --baseline and --candidate, which compare two results files that already exist and run nothing.`,
      );
    }
    // What a comparison of files can use.
    for (const extra of [
      ["--allow-differences", "model"],
      ["--playbook", "pb.yaml"],
      ["--publish", "d"],
      ["--publish", "d", "--open-heldout-trails"],
    ]) {
      expect(() => parseParolArgs([...files, ...extra]), extra.join(" ")).not.toThrow();
    }
  });

  it("refuses --open-heldout-trails without --publish, an empty value and a repeated option", () => {
    expect(bad(["--open-heldout-trails"])).toBe("--open-heldout-trails needs --publish.");
    expect(bad(["--baseline", "a", "--candidate", "b", "--open-heldout-trails"])).toBe(
      "--open-heldout-trails needs --publish.",
    );
    for (const name of ["publish", "baseline", "candidate"]) {
      expect(bad([`--${name}`, ""])).toBe(`Option --${name} needs a value.`);
    }
    expect(bad(["--publish", "d", "--publish", "e"])).toBe(
      "Option --publish was given more than once.",
    );
  });

  it("is documented in the usage text, which holds no dash", () => {
    expect(USAGE).toContain("pnpm eval:parol --baseline <a.json> --candidate <b.json>");
    for (const name of ["--publish", "--baseline", "--candidate", "--open-heldout-trails"]) {
      expect(USAGE).toContain(name);
    }
    expect(USAGE).toContain("<data-folder>/evaluations");
    expect(USAGE).not.toMatch(DASHES);
  });

  it("answers a mistake with exit code 1, the message and the usage hint", async () => {
    const out = await cli(["--baseline", a, "--candidate", b, "--selftest"], {
      generatorFactory: forbidden,
    });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("--selftest cannot be used with --baseline and --candidate");
    expect(out.stderr).toContain('Run "pnpm eval:parol --help" for usage.');
    expect(out.stdout).toBe("");
  });
});

describe("comparing two results files that exist", () => {
  it("prints the Markdown comparison and nothing else, runs nothing, and writes nothing, without --publish", async () => {
    const data = fresh();
    const resultsDir = join(fresh(), "results");
    const out = await compareFiles([], { resultsDir });
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout.startsWith("# Comparison: baseline v1 against candidate v2\n")).toBe(true);
    expect(out.stdout).toContain("THIS COMPARISON INVOLVES A SIMULATED RUN");
    expect(out.stdout).toContain("2 of 8 paired slots changed.");
    expect(out.stderr).toBe("");
    // No results file was written and no folder was made.
    expect(await readdir(resultsDir).catch(() => [])).toEqual([]);
    expect(await names(data)).toEqual([]);
  });

  it("prints the same comparison as the run that made the second file would have", async () => {
    const data = fresh();
    const files = await compareFiles(["--publish", data]);
    const live = await cli(
      [
        "--simulate",
        "--workflow",
        "v2",
        "--case",
        "PAROL-D05",
        "--compare",
        a,
        "--out",
        join(fresh(), "again.json"),
      ],
      {},
    );
    expect(live.code, live.stderr).toBe(0);
    // The run prints its report, then the comparison. The comparison part is the same text up to
    // the name of the candidate file.
    const comparisonOf = (text: string): string =>
      text
        .slice(text.indexOf("# Comparison:"))
        .replace(/again\.json|sim-v2\.json/g, "candidate.json");
    expect(comparisonOf(files.stdout)).toBe(comparisonOf(live.stdout));
  });

  it("refuses a comparison that cannot be made: pins differ, or a run is unfinished, and writes nothing", async () => {
    const data = fresh();
    // FABRICATED FOR A TEST: a copy of the candidate that names another model, so that the pins differ.
    const other = await readResults(b);
    other.pins.model.requested = "another-stand-in";
    const differs = join(dir, "differs.json");
    await writeFile(differs, serialiseResults(other));
    const refused = await cli(["--baseline", a, "--candidate", differs, "--publish", data], {
      generatorFactory: forbidden,
    });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("Refusing to compare");
    expect(refused.stderr).toContain("--allow-differences model");
    expect(refused.stdout).toBe("");
    expect(await names(data)).toEqual([]);
    await expect(stat(data)).rejects.toMatchObject({ code: "ENOENT" });

    // FABRICATED FOR A TEST: a copy of the candidate that says the run did not finish.
    const unfinished = await readResults(b);
    unfinished.complete = false;
    const path = join(dir, "unfinished.json");
    await writeFile(path, serialiseResults(unfinished));
    const incomplete = await cli(["--baseline", a, "--candidate", path, "--publish", data], {
      generatorFactory: forbidden,
    });
    expect(incomplete.code).toBe(1);
    expect(incomplete.stderr).toContain("The candidate run is incomplete");
    expect(incomplete.stdout).toBe("");
    await expect(stat(data)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts the difference that was named, as --compare does", async () => {
    // FABRICATED FOR A TEST: the candidate names another model.
    const other = await readResults(b);
    other.pins.model.requested = "another-stand-in";
    const path = join(dir, "allowed.json");
    await writeFile(path, serialiseResults(other));
    const data = fresh();
    const out = await cli(
      ["--baseline", a, "--candidate", path, "--allow-differences", "model", "--publish", data],
      { generatorFactory: forbidden },
    );
    expect(out.code, out.stderr).toBe(0);
    const { page } = await onlyPage(data);
    expect(page.differences.map((d) => `${d.name} ${d.field} ${d.status}`)).toContain(
      "model model.requested allowed",
    );
  });

  it("says when a file cannot be read, without repeating its content", async () => {
    const path = join(dir, "not-results.json");
    await writeFile(path, JSON.stringify({ secret: "PRIVATE WORDS" }));
    const out = await cli(["--baseline", a, "--candidate", path], { generatorFactory: forbidden });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("is not a Parol results file");
    expect(out.stderr).not.toContain("PRIVATE");
    const missing = await cli(["--baseline", a, "--candidate", join(dir, "missing.json")], {
      generatorFactory: forbidden,
    });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("Cannot read the results file");
  });
});

describe("--publish with --baseline and --candidate", () => {
  it("writes exactly one page document, says its id on stderr, and the Markdown goes to stdout", async () => {
    const data = fresh();
    const resultsDir = join(fresh(), "results");
    const out = await compareFiles(["--publish", data], { resultsDir });
    expect(out.code, out.stderr).toBe(0);
    const { name, page } = await onlyPage(data);
    expect(name).toMatch(/^cmp_[0-9a-f]{16}\.json$/);
    expect(page.id).toBe(name.replace(".json", ""));
    expect(out.stderr).toBe(
      `Published comparison ${page.id} to ${join(folder(data), name)}. Open /evaluations?comparison=${page.id} as a legal engineer or an administrator.\n`,
    );
    expect(out.stdout.startsWith("# Comparison: baseline v1 against candidate v2\n")).toBe(true);
    expect(page.files).toEqual({ baseline: "sim-v1.json", candidate: "sim-v2.json" });
    expect(page.sides.baseline.mode).toBe("simulated");
    // Nothing else is written: no results file, no temporary file in the folder.
    expect(await readdir(resultsDir).catch(() => [])).toEqual([]);
    expect(await readdir(data)).toEqual(["evaluations"]);
    // The folder is the owner's alone.
    expect((await stat(folder(data))).mode & 0o777).toBe(0o700);
  });

  it("is accepted by the application's reader, whole, under the name of its id", async () => {
    const data = fresh();
    await compareFiles(["--publish", data]);
    const { name, text, page } = await onlyPage(data);
    expect(parseComparisonPage(text, name)).toEqual({ ok: true, page });
    expect(text).not.toMatch(DASHES);
    expect(text.endsWith("}\n")).toBe(true);
  });

  it("publishes the same comparison once: a second time says so, exits 0 and leaves the bytes alone", async () => {
    const data = fresh();
    const first = await compareFiles(["--publish", data]);
    const before = await onlyPage(data);
    const second = await compareFiles(["--publish", data]);
    expect(first.code).toBe(0);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stderr).toContain(`Comparison ${before.page.id} is already published`);
    expect(second.stderr).toContain("the file was left as it is");
    expect(second.stderr).not.toContain("Published comparison");
    const after = await onlyPage(data);
    expect(after.text).toBe(before.text);
    expect(await names(data)).toEqual([before.name]);
  });

  it("stops when another file holds the name, and leaves that file alone", async () => {
    const data = fresh();
    await compareFiles(["--publish", data]);
    const { name, text } = await onlyPage(data);

    // Another file under the same name, in another folder.
    const other = fresh();
    await mkdir(folder(other), { recursive: true });
    await writeFile(join(folder(other), name), "not a page document\n");
    const foreign = await compareFiles(["--publish", other]);
    expect(foreign.code).toBe(1);
    expect(foreign.stderr).toContain("A different file already holds the name of this comparison");
    expect(await readFile(join(folder(other), name), "utf8")).toBe("not a page document\n");
    // The Markdown had been printed: the comparison is the reader's even when publishing fails.
    expect(foreign.stdout).toContain("# Comparison:");

    // The same document with one byte changed is another file, and is not taken for a repeat.
    const edited = fresh();
    await mkdir(folder(edited), { recursive: true });
    await writeFile(join(folder(edited), name), text.replace('"v1"', '"v9"'));
    const changed = await compareFiles(["--publish", edited]);
    expect(changed.code).toBe(1);
    expect(changed.stderr).toContain("A different file already holds the name");
  });

  it("says why a data folder cannot be used, by the error code alone, after the Markdown", async () => {
    // A file where the data folder should be.
    const notAFolder = join(dir, `file-${++n}`);
    await writeFile(notAFolder, "x");
    const out = await compareFiles(["--publish", notAFolder]);
    expect(out.code).toBe(1);
    expect(out.stderr).toBe(
      "Error: The folder for published comparisons could not be made (ENOTDIR).\n",
    );
    expect(out.stdout).toContain("# Comparison:");
  });

  it("stops at the integrity of the dataset with exit code 2, after the Markdown, and writes nothing", async () => {
    const base = fresh();
    const root = await copyRoot(base);
    // FABRICATED FOR A TEST: a case file of the copy has a byte more than the committed one.
    await appendFile(filePath(root, "parol-d05-amendment-1.txt"), "\n");
    const data = join(base, "data");
    const out = await compareFiles(["--publish", data], { root });
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("INTEGRITY FAILURE");
    expect(out.stdout).toContain("# Comparison:");
    await expect(stat(data)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses answer keys that are not the ones the files were made with, saying nothing of the key", async () => {
    const base = fresh();
    const root = await copyRoot(base);
    // FABRICATED FOR A TEST: a copy of the dataset whose key for one slot has another note, with its
    // hashes brought up to date so that the dataset loads. The runs were made with the other key.
    await changeKey(root, (keys) => {
      keys.cases.find((entry) => entry.case === "PAROL-D05")!.expect["dur-1"]!.note += " Changed.";
    });
    await rehash(root);
    const data = join(base, "data");
    const out = await compareFiles(["--publish", data], { root });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain(
      "answer keys on disk are not the ones the baseline run was made with",
    );
    expect(out.stderr).not.toContain("Changed.");
    expect(out.stdout).toContain("# Comparison:");
    await expect(stat(data)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads the playbook given with --playbook, and stops when it cannot be read", async () => {
    const data = fresh();
    const playbook = join(REPO_ROOT, "apps", "parol", "playbooks", "parol-nda-recipient.yaml");
    const ok = await compareFiles(["--publish", data, "--playbook", playbook]);
    expect(ok.code, ok.stderr).toBe(0);
    const missing = await compareFiles([
      "--publish",
      fresh(),
      "--playbook",
      join(dir, "none.yaml"),
    ]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("Cannot read the playbook");
  });

  it("names the files by their base name only, whatever folder they are in", async () => {
    const deep = join(dir, "deep", "er");
    await mkdir(deep, { recursive: true });
    const copy = join(deep, "candidate-copy.json");
    await writeFile(copy, await readFile(b, "utf8"));
    const data = fresh();
    const out = await cli(["--baseline", a, "--candidate", copy, "--publish", data], {
      generatorFactory: forbidden,
    });
    expect(out.code, out.stderr).toBe(0);
    const { page, text } = await onlyPage(data);
    expect(page.files.candidate).toBe("candidate-copy.json");
    expect(text).not.toContain(dir);
  });
});

describe("--open-heldout-trails (a SIMULATED baseline and a SELFTEST candidate of one held-out case)", () => {
  const held = (extra: string[]): Promise<Captured> =>
    cli(
      [
        "--baseline",
        heldSim,
        "--candidate",
        heldSelf,
        "--allow-differences",
        HELDOUT_ALLOW.join(","),
        ...extra,
      ],
      { generatorFactory: forbidden },
    );

  it("seals the held-out split by default and says nothing about opening it", async () => {
    const data = fresh();
    const out = await held(["--publish", data]);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).not.toContain("HELD-OUT TRAILS OPENED");
    const { page } = await onlyPage(data);
    expect(page.heldoutTrailsOpened).toBe(false);
    expect(page.sections[0]!.split).toBe("heldout");
    expect(page.sections[0]!.changes.every((change) => "sealed" in change.trail)).toBe(true);
    expect(page.cases).toEqual({});
  });

  it("opens it only with the flag, prints the seal warning, and records that it did", async () => {
    const data = fresh();
    const out = await held(["--publish", data, "--open-heldout-trails"]);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toContain("HELD-OUT TRAILS OPENED FOR THE PAGE. The held-out set is sealed");
    expect(out.stderr).toContain("the held-out set is contaminated for that change");
    const { page } = await onlyPage(data);
    expect(page.heldoutTrailsOpened).toBe(true);
    expect(page.sections[0]!.changes.every((change) => !("sealed" in change.trail))).toBe(true);
    expect(Object.keys(page.cases)).toEqual(["PAROL-H01"]);
    // The warning is about a file that is in the folder, so it comes with the report of the write.
    expect(out.stderr.indexOf("HELD-OUT TRAILS OPENED")).toBeLessThan(
      out.stderr.indexOf("Published comparison"),
    );
  });

  it("does not warn of an opened held-out set for a comparison without a held-out split, and records none", async () => {
    // Two SIMULATED dev runs and the flag: the document has no held-out section.
    const data = fresh();
    const out = await compareFiles(["--publish", data, "--open-heldout-trails"]);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).not.toContain("HELD-OUT TRAILS OPENED");
    expect(out.stderr).not.toContain("contaminated");
    const { page } = await onlyPage(data);
    expect(page.sections.map((section) => section.split)).toEqual(["dev"]);
    expect(page.heldoutTrailsOpened).toBe(false);
  });

  it("does not warn when the held-out runs agree on every slot, so that nothing of the split is in the file", async () => {
    // The same SIMULATED held-out run on both sides: no slot changed, so no key, passage or trail.
    const data = fresh();
    const out = await cli(
      ["--baseline", heldSim, "--candidate", heldSim, "--publish", data, "--open-heldout-trails"],
      { generatorFactory: forbidden },
    );
    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).not.toContain("HELD-OUT TRAILS OPENED");
    const { page } = await onlyPage(data);
    expect(page.sections.map((section) => section.split)).toEqual(["heldout"]);
    expect(page.sections[0]!.changes).toEqual([]);
    expect(page.cases).toEqual({});
    expect(page.heldoutTrailsOpened).toBe(false);
  });

  it("does not warn when the page could not be written", async () => {
    // A file where the data folder should be: the page is built and nothing can be written.
    const notAFolder = join(dir, `file-${++n}`);
    await writeFile(notAFolder, "x");
    const out = await held(["--publish", notAFolder, "--open-heldout-trails"]);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("could not be made (ENOTDIR)");
    expect(out.stderr).not.toContain("HELD-OUT TRAILS OPENED");
  });

  it("does not warn when the page cannot be built, and writes nothing", async () => {
    const base = fresh();
    const root = await copyRoot(base);
    // FABRICATED FOR A TEST: a copy of the dataset whose key for one slot has another note, with its
    // hashes brought up to date so that it loads. The runs were made with the other key, so the
    // page is refused after the flag was read and before any held-out material could be written.
    await changeKey(root, (keys) => {
      keys.cases.find((entry) => entry.case === "PAROL-H01")!.expect["dur-1"]!.note += " Changed.";
    });
    await rehash(root);
    const data = join(base, "data");
    const out = await cli(
      [
        "--baseline",
        heldSim,
        "--candidate",
        heldSelf,
        "--allow-differences",
        HELDOUT_ALLOW.join(","),
        "--publish",
        data,
        "--open-heldout-trails",
      ],
      { generatorFactory: forbidden, root },
    );
    expect(out.code).toBe(1);
    expect(out.stderr).toContain(
      "answer keys on disk are not the ones the baseline run was made with",
    );
    expect(out.stderr).not.toContain("HELD-OUT TRAILS OPENED");
    await expect(stat(data)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("--publish with a run", () => {
  it("publishes the comparison that follows the run, after the report, naming the file the run wrote", async () => {
    const data = fresh();
    const out = join(fresh(), "again.json");
    const result = await cli(
      [
        "--simulate",
        "--workflow",
        "v2",
        "--case",
        "PAROL-D05",
        "--compare",
        a,
        "--out",
        out,
        "--publish",
        data,
      ],
      {},
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.startsWith("# Parol evaluation, SIMULATED")).toBe(true);
    expect(result.stdout).toContain("# Comparison: baseline v1 against candidate v2");
    const { page } = await onlyPage(data);
    expect(page.files).toEqual({ baseline: "sim-v1.json", candidate: "again.json" });
    expect(page.sections[0]!.changes.map((c) => c.ruleKey)).toEqual(["dur-1", "ret-1"]);
    expect(result.stderr).toContain(`Published comparison ${page.id} to `);
    // The page names a results file that exists.
    expect((await readResults(out)).pins.workflow.label).toBe("v2");
  });

  it("publishes nothing when the comparison is refused before the run, and sends nothing", async () => {
    const data = fresh();
    const resultsDir = join(fresh(), "results");
    // Two cases against a baseline of one: the runs differ in more than the workflow.
    const result = await cli(
      [
        "--simulate",
        "--workflow",
        "v2",
        "--case",
        "PAROL-D05",
        "--case",
        "PAROL-D06",
        "--compare",
        a,
        "--publish",
        data,
      ],
      { resultsDir },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Refusing to compare");
    expect(result.stderr).toContain("Nothing was sent.");
    expect(await names(data)).toEqual([]);
    expect(await readdir(resultsDir).catch(() => [])).toEqual([]);
  });

  it("publishes nothing when the comparison is refused after the run, and keeps the results", async () => {
    // FABRICATED FOR A TEST: a copy of the baseline that says the provider named a model. That pin
    // cannot be checked before a run, so the run is made and the comparison is refused after it.
    const reported = await readResults(a);
    reported.pins.model.reported = ["a-model-named-by-the-provider"];
    const baseline = join(dir, "reported.json");
    await writeFile(baseline, serialiseResults(reported));
    const data = fresh();
    const out = join(fresh(), "kept.json");
    const result = await cli(
      [
        "--simulate",
        "--workflow",
        "v2",
        "--case",
        "PAROL-D05",
        "--compare",
        baseline,
        "--out",
        out,
        "--publish",
        data,
      ],
      {},
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Refusing to compare");
    expect(result.stderr).toContain("model-reported");
    expect(await names(data)).toEqual([]);
    expect((await readResults(out)).complete).toBe(true);
  });

  it("publishes nothing when the file the page would name was not written whole", async () => {
    // FABRICATED FOR A TEST: a stand-in whose model name is too long for the results reader. The
    // run finishes and its file is kept, and the command says that a later reader cannot read it.
    const longName = "m".repeat(2500);
    const data = fresh();
    const out = join(fresh(), "unreadable.json");
    const result = await cli(
      [
        "--simulate",
        "--workflow",
        "v2",
        "--case",
        "PAROL-D05",
        "--compare",
        a,
        "--allow-differences",
        "model",
        "--out",
        out,
        "--publish",
        data,
      ],
      {
        loadSimulatedModel: async () => ({
          createSimulatedModel,
          SIMULATED_PROVIDER: "simulated",
          SIMULATED_MODEL: longName,
        }),
      },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("too long or malformed for its own reader");
    expect(result.stderr).toContain(
      "Not published: the results file of this run was not written whole",
    );
    expect(await names(data)).toEqual([]);
    expect((await stat(out)).isFile()).toBe(true);
  });

  it("keeps the results and says how to publish them when the page could not be written", async () => {
    const notAFolder = join(dir, `file-${++n}`);
    await writeFile(notAFolder, "x");
    const out = join(fresh(), "kept-too.json");
    const result = await cli(
      [
        "--simulate",
        "--workflow",
        "v2",
        "--case",
        "PAROL-D05",
        "--compare",
        a,
        "--out",
        out,
        "--publish",
        notAFolder,
      ],
      {},
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("could not be made (ENOTDIR)");
    expect(result.stderr).toContain(
      "The results were kept. Publish them again with --baseline and --candidate",
    );
    // The report and the comparison were printed all the same.
    expect(result.stdout).toContain("# Comparison:");
    expect((await readResults(out)).complete).toBe(true);
  });
});

describe("the written file and the files it came from", () => {
  it("does not change the results files it read", async () => {
    const before = await Promise.all([readFile(a, "utf8"), readFile(b, "utf8")]);
    await compareFiles(["--publish", fresh()]);
    expect(await Promise.all([readFile(a, "utf8"), readFile(b, "utf8")])).toEqual(before);
  });
});
