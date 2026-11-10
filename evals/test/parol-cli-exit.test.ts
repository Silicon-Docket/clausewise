import { readFile, readdir, writeFile } from "node:fs/promises";
import { createScriptedGenerator } from "@clausewise/llm/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { USAGE } from "../src/parol/cli.js";
import { createKeyOracle } from "../src/parol/oracle.js";
import {
  REPO_ROOT,
  changeKey,
  committedRunShape,
  copyRoot,
  editJson,
  filePath,
  makeTempDir,
  oracleFactory,
  readResults,
  rehash,
  removeDir,
  run,
} from "../src/parol/testing-run.js";
import type { SplitsFile } from "../../fixtures/parol/types.js";

let dir = "";
let n = 0;
beforeAll(async () => {
  dir = await makeTempDir();
});
afterAll(async () => {
  await removeDir(dir);
});

/** A results folder and a root of its own for one test. */
async function fresh(tamper = false): Promise<{ resultsDir: string; root: string }> {
  const base = `${dir}/${++n}`;
  return { resultsDir: `${base}/results`, root: tamper ? await copyRoot(base) : REPO_ROOT };
}

const DEV = committedRunShape("dev");
const HELDOUT = committedRunShape("heldout");

const NOW = (): Date => new Date("2026-11-04T10:00:00Z");
const files = async (resultsDir: string): Promise<string[]> => readdir(resultsDir).catch(() => []);

/** A factory that fails the test if a model is ever asked for: nothing may be sent on these paths. */
const forbidden = () => {
  throw new Error("a generator was requested on a path that must send nothing");
};

describe("exit code 0", () => {
  it("is the code of a selftest that finished, which writes its results and prints its report", async () => {
    const { resultsDir } = await fresh();
    const { code, stdout, stderr } = await run(["--selftest"], { resultsDir, now: NOW });
    expect(code).toBe(0);
    expect(stdout.startsWith("# Parol evaluation, SELFTEST")).toBe(true);
    expect(stderr).toContain("Selftest plan (no model will be called)");
    // 14 cases and 2 twins, one extract call and eight analyze calls each.
    expect(DEV.calls).toBe(144);
    expect(stderr).toContain(`Model calls made to the scripted stand-in: ${DEV.calls}`);
    // The name is the start of the run in UTC, and a second run in the same second does not overwrite it.
    expect(await files(resultsDir)).toEqual(["parol-20261104T100000Z.json"]);
    await run(["--selftest"], { resultsDir, now: NOW });
    expect((await files(resultsDir)).sort()).toEqual([
      "parol-20261104T100000Z-2.json",
      "parol-20261104T100000Z.json",
    ]);
  });

  it("is the code of --help, which prints the usage and does nothing else", async () => {
    const { resultsDir } = await fresh();
    const { code, stdout, stderr } = await run(["--help"], {
      resultsDir,
      generatorFactory: forbidden,
    });
    expect(code).toBe(0);
    expect(stdout).toBe(USAGE);
    expect(stderr).toBe("");
    expect(await files(resultsDir)).toEqual([]);
  });

  it("is the code of a run whose gates fail: a failed gate is a result and not an error", async () => {
    const { resultsDir } = await fresh();
    // A stand-in that gets every rule of every case wrong in the same way. It is the oracle with
    // its answers replaced, FABRICATED FOR A TEST, and is run as if live.
    const { code, stdout } = await run(["--yes", "--case", "PAROL-D01", "--max-cost", "5"], {
      resultsDir,
      now: NOW,
      generatorFactory: (request) =>
        createScriptedGenerator(
          (call) =>
            call.schemaName === "locate_passages"
              ? {
                  categories: [
                    "parties",
                    "ci-definition",
                    "exclusions",
                    "permitted-disclosures",
                    "duration",
                    "return-destruction",
                    "governing-law",
                  ].map((category) => ({ category, passages: [], notFoundReason: "none" })),
                }
              : {
                  status: "deviation",
                  evidence: [],
                  discrepancy: "x",
                  explanation: "x",
                  fallbackLanguage: null,
                  escalateWhenMatched: [],
                  conflict: null,
                  abstainReason: null,
                },
          { provider: "anthropic", model: request.config!.model },
        ),
    });
    expect(code).toBe(0);
    expect(stdout).toContain("| Status accuracy |");
    expect(stdout).toContain("Gates failed:");
  });
});

describe("exit code 1", () => {
  it("is the code of a live run with no credentials, which says how to try without a key", async () => {
    const { resultsDir } = await fresh();
    const { code, stderr, stdout } = await run(["--yes"], {
      resultsDir,
      env: {},
      generatorFactory: forbidden,
    });
    expect(code).toBe(1);
    expect(stderr).toContain("ANTHROPIC_API_KEY is required");
    expect(stderr).toContain("No model credentials are configured, so a live run cannot start.");
    expect(stderr).toContain("pnpm eval:parol --selftest");
    expect(stdout).toBe("");
    expect(await files(resultsDir)).toEqual([]);
  });

  it("is the code of a model with no price, which is refused as the Clausewise harness refuses it", async () => {
    const { resultsDir } = await fresh();
    const { code, stderr } = await run(["--yes"], {
      resultsDir,
      env: { ANTHROPIC_API_KEY: "sk-test-not-a-real-key", CLAUSEWISE_MODEL: "claude-unpriced-9" },
      generatorFactory: forbidden,
    });
    expect(code).toBe(1);
    expect(stderr).toContain('The model "claude-unpriced-9" is not in the price table');
    expect(stderr).toContain("--prices");
    expect(await files(resultsDir)).toEqual([]);
  });

  it("is the code of a price of zero for a hosted model, which would switch the spend guard off", async () => {
    const { resultsDir } = await fresh();
    const prices = `${dir}/zero-prices.json`;
    await writeFile(
      prices,
      JSON.stringify({ "claude-sonnet-5-5": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    );
    const { code, stderr } = await run(["--yes", "--prices", prices], {
      resultsDir,
      generatorFactory: forbidden,
    });
    expect(code).toBe(1);
    expect(stderr).toContain("would switch off the spend guard");
  });

  it("is the code of the held-out split without --allow-heldout, which prints the seal warning of document 5", async () => {
    const { resultsDir } = await fresh();
    for (const split of ["heldout", "all"]) {
      const { code, stderr } = await run(["--selftest", "--split", split], {
        resultsDir,
        generatorFactory: forbidden,
      });
      expect(code).toBe(1);
      expect(stderr).toContain("Refusing to run the held-out split without --allow-heldout.");
      expect(stderr).toContain("The held-out set is sealed");
      expect(stderr).toContain("each candidate gets one held-out run");
    }
    expect(await files(resultsDir)).toEqual([]);
    // The flag lifts the refusal: the dataset has a held-out split, and a selftest of it runs.
    const flagged = await run(["--selftest", "--split", "heldout", "--allow-heldout"], {
      resultsDir,
    });
    expect(flagged.code, flagged.stderr).toBe(0);
    expect(flagged.stderr).toContain("HELD-OUT SPLIT. The held-out set is sealed");
    expect(flagged.stderr).toContain(`Model calls made to the scripted stand-in: ${HELDOUT.calls}`);
    expect(flagged.stderr).not.toContain("has no cases in this dataset");
  });

  it("is the code of a case that is not in the split, a results file that exists, and a playbook that cannot be read", async () => {
    const { resultsDir } = await fresh();
    const unknown = await run(["--selftest", "--case", "PAROL-D99"], { resultsDir });
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("A case you named is not in the chosen split");

    const out = `${dir}/exists.json`;
    await writeFile(out, "{}");
    const exists = await run(["--selftest", "--out", out], { resultsDir });
    expect(exists.code).toBe(1);
    expect(exists.stderr).toContain("already exists. Choose another file with --out.");
    expect(await readFile(out, "utf8")).toBe("{}");

    const missing = await run(["--selftest", "--playbook", `${dir}/no-such.yaml`], { resultsDir });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("Cannot read the playbook");
  });

  it("does not repeat a value from the command line that looks like a key, in any message", async () => {
    const { resultsDir } = await fresh();
    const key = "sk-ant-api03-not-a-real-key.json";
    const playbook = await run(["--selftest", "--playbook", key], { resultsDir });
    expect(playbook.code).toBe(1);
    expect(playbook.stderr).toContain("Cannot read the playbook (ENOENT).");
    const compare = await run(["--selftest", "--compare", key], { resultsDir });
    expect(compare.code).toBe(1);
    expect(compare.stderr).toContain("Cannot read the results file (ENOENT).");
    await writeFile(`${dir}/${key}`, "{}");
    const out = await run(["--selftest", "--out", `${dir}/${key}`], { resultsDir });
    expect(out.stderr).toContain("The results file already exists.");
    for (const text of [playbook.stderr, compare.stderr, out.stderr]) {
      expect(text).not.toContain("sk-ant");
    }
    // A plain name is repeated, because it helps and cannot hurt.
    const plain = await run(["--selftest", "--playbook", "no-such.yaml"], { resultsDir });
    expect(plain.stderr).toContain("Cannot read the playbook no-such.yaml (ENOENT).");
  });

  it("is the code of a playbook that is not the version the keys were built for", async () => {
    const { resultsDir } = await fresh();
    const path = `${dir}/other-playbook.yaml`;
    await writeFile(
      path,
      `${await readFile(`${REPO_ROOT}/apps/parol/playbooks/parol-nda-recipient.yaml`, "utf8")}\n# one more comment\n`,
    );
    const { code, stderr } = await run(["--selftest", "--playbook", path], { resultsDir });
    expect(code).toBe(1);
    expect(stderr).toContain("The playbook is not the version the answer keys were built for");
    expect(await files(resultsDir)).toEqual([]);
  });

  it("is the code of --simulate when the simulated model cannot be loaded, which says so before anything runs", async () => {
    const { resultsDir } = await fresh();
    const { code, stderr, stdout } = await run(["--simulate"], {
      resultsDir,
      loadSimulatedModel: () => Promise.reject(new Error("Cannot find module")),
    });
    expect(code).toBe(1);
    expect(stderr).toContain(
      "--simulate needs the simulated model at apps/parol/src/demo/simulated-model.ts",
    );
    expect(stderr).toContain("could not be loaded");
    // The error of the loader is not repeated, and nothing was planned or run.
    expect(stderr).not.toContain("Cannot find module");
    expect(stderr).not.toContain("plan");
    expect(stdout).toBe("");
    expect(await files(resultsDir)).toEqual([]);
  });

  it("is the code of a selftest that fails: an oracle that is not perfect shows the plumbing disagrees", async () => {
    const { resultsDir } = await fresh();
    // FABRICATED FOR A TEST: the oracle, except that it calls every duration rule compliant.
    const { code, stderr, stdout } = await run(["--selftest"], {
      resultsDir,
      generatorFactory: ({ prepared, playbook }) => {
        const oracle = createKeyOracle({
          caseKey: prepared.runnable.caseKey,
          expect: prepared.runnable.expect,
          spans: prepared.ingest.spans,
          rules: playbook.rules,
        });
        return createScriptedGenerator(
          async (call) => {
            const answer = (await oracle.generate(call as never)) as Record<string, unknown>;
            return call.schemaName === "analyze_rule" && call.prompt.includes("Rule ID: dur-1")
              ? { ...answer, status: "compliant", discrepancy: "" }
              : answer;
          },
          { provider: "oracle", model: "parol-key-oracle" },
        );
      },
    });
    expect(code).toBe(1);
    expect(stderr).toContain("SELFTEST FAILED");
    // The oracle's dur-1 answers are wrong in every case whose key does not say compliant.
    const keys = JSON.parse(
      await readFile(`${REPO_ROOT}/fixtures/parol/answer-keys.json`, "utf8"),
    ) as { cases: { split: string; expect: Record<string, { status: string }> }[] };
    const wrong = keys.cases.filter(
      (c) => c.split === "dev" && c.expect["dur-1"]!.status !== "compliant",
    ).length;
    expect(wrong).toBeGreaterThan(0);
    expect(stderr).toContain(`status accuracy is ${DEV.slots - wrong} of ${DEV.slots}, not all`);
    expect(stderr).toMatch(/silent misses, not none/);
    // The results and the report are still produced, so the failure can be read.
    expect(stdout).toContain("# Parol evaluation, SELFTEST");
    expect(await files(resultsDir)).toHaveLength(1);
  });

  it("is the code of a comparison file that is not a results file", async () => {
    const { resultsDir } = await fresh();
    const bad = `${dir}/not-results.json`;
    await writeFile(bad, JSON.stringify({ hello: "world" }));
    const { code, stderr } = await run(["--selftest", "--compare", bad], { resultsDir });
    expect(code).toBe(1);
    expect(stderr).toContain("is not a Parol results file this version can read");
    await writeFile(bad, "not json");
    expect((await run(["--selftest", "--compare", bad], { resultsDir })).stderr).toContain(
      "not valid JSON",
    );
    expect(
      (await run(["--selftest", "--compare", `${dir}/missing.json`], { resultsDir })).stderr,
    ).toContain("Cannot read the results file");
  });
});

describe("exit code 2", () => {
  const nothingRan = async (resultsDir: string, stderr: string, stdout: string): Promise<void> => {
    expect(stderr).toContain("INTEGRITY FAILURE");
    expect(stderr).toContain("Nothing was run and nothing was sent.");
    expect(stdout).toBe("");
    expect(await files(resultsDir)).toEqual([]);
  };

  it("is the code of an answer key with one entry altered, for a selftest and for a live run alike", async () => {
    for (const args of [["--selftest"], ["--yes"]]) {
      const { resultsDir, root } = await fresh(true);
      await changeKey(root, (keys) => {
        keys.cases.find((c) => c.case === "PAROL-D03")!.expect["gov-1"]!.note = "changed";
      });
      const { code, stderr, stdout } = await run(args, {
        resultsDir,
        root,
        generatorFactory: forbidden,
      });
      expect(code).toBe(2);
      expect(stderr).toContain("split dev: the answer keys and files hash to");
      await nothingRan(resultsDir, stderr, stdout);
    }
  });

  it("is the code of a document with one byte altered, and the message names the case and the file", async () => {
    const { resultsDir, root } = await fresh(true);
    const path = filePath(root, "parol-d01-nda.docx");
    const bytes = await readFile(path);
    bytes[bytes.length - 20] = bytes[bytes.length - 20]! ^ 0xff;
    await writeFile(path, bytes);
    const { code, stderr, stdout } = await run(["--selftest"], {
      resultsDir,
      root,
      generatorFactory: forbidden,
    });
    expect(code).toBe(2);
    expect(stderr).toContain(
      "PAROL-D01 parol-d01-nda.docx: the file differs from the hash in the answer key",
    );
    await nothingRan(resultsDir, stderr, stdout);
  });

  it("is the code of a splits file that records another hash", async () => {
    const { resultsDir, root } = await fresh(true);
    await editJson<SplitsFile>(`${root}/fixtures/parol/splits.json`, (splits) => {
      splits.splits.dev!.sha256 = "f".repeat(64);
    });
    const { code, stderr, stdout } = await run(["--selftest"], {
      resultsDir,
      root,
      generatorFactory: forbidden,
    });
    expect(code).toBe(2);
    expect(stderr).toMatch(/but splits\.json records ffffffffffff/);
    await nothingRan(resultsDir, stderr, stdout);
  });

  it("is the code of an answer key whose anchors no longer resolve, even when the hashes were rewritten to match", async () => {
    const { resultsDir, root } = await fresh(true);
    await changeKey(root, (keys) => {
      keys.cases.find((c) => c.case === "PAROL-D05")!.expect["dur-1"]!.governing[0]!.anchor =
        "words the amendment does not contain";
    });
    await rehash(root);
    const { code, stderr, stdout } = await run(["--selftest"], {
      resultsDir,
      root,
      generatorFactory: forbidden,
    });
    expect(code).toBe(2);
    expect(stderr).toContain(
      "the answer keys do not match the documents as this version of the code reads them",
    );
    expect(stderr).toMatch(
      /PAROL-D05 dur-1 governing anchor 1 \(D2, clause \S+\): it occurs 0 times, expected once/,
    );
    // The anchor is not repeated in the message.
    expect(stderr).not.toContain("the amendment does not contain");
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(await files(resultsDir)).toEqual([]);
  });
});

describe("exit code 3", () => {
  it("is the code of a live run without --yes, which prints the plan and sends nothing", async () => {
    const { resultsDir } = await fresh();
    const { code, stderr, stdout } = await run([], { resultsDir, generatorFactory: forbidden });
    expect(code).toBe(3);
    expect(stderr).toContain("Evaluation plan (nothing has been sent yet)");
    expect(stderr).toContain(`Model calls in total: ${DEV.calls}`);
    // The bound that is compared with --max-cost includes the repair call of every rule, and the
    // figure for one attempt per call is named for what it is. (Before, the smaller figure was
    // called "Cost upper bound" and the message said "cost at most" it.)
    expect(stderr).toMatch(/Cost with one attempt per call and no repair call: \$\d+\.\d{4}/);
    expect(stderr).toMatch(
      /Cost upper bound, if every rule needed its repair call: \$\d+\.\d{4}\. --max-cost is checked against this figure\./,
    );
    expect(stderr).toMatch(
      /Nothing was sent\. This evaluation would make up to \d+ model calls and cost at most \$\d+\.\d{4}\./,
    );
    // With every repair call counted, the whole dev split is over the default limit of $2, and
    // the message says so instead of offering a run that could stop part-way.
    expect(stderr).toContain(
      "That is above the current limit of $2.0000. Raise the limit with --max-cost <usd>, or do less with --case or --runs. Then add --yes to run it.",
    );
    expect(stdout).toBe("");
    expect(await files(resultsDir)).toEqual([]);
  });

  it("is the code of a run whose cost bound is above --max-cost, even with --yes", async () => {
    const { resultsDir } = await fresh();
    const { code, stderr } = await run(["--yes", "--max-cost", "0.01"], {
      resultsDir,
      generatorFactory: forbidden,
    });
    expect(code).toBe(3);
    expect(stderr).toMatch(
      /Refusing to run: the cost upper bound of \$\d+\.\d{4} is above --max-cost \$0\.0100\./,
    );
    // The shared wording of the Clausewise harness offers --fixture. Here the choice is --case.
    expect(stderr).toContain("or do less with --case or --runs");
    expect(stderr).not.toContain("--fixture");
    expect(await files(resultsDir)).toEqual([]);
  });

  it("is the code of CLAUSEWISE_FALLBACK, whose second model the price table does not cover", async () => {
    const { resultsDir } = await fresh();
    const { code, stderr } = await run(["--yes", "--max-cost", "50"], {
      resultsDir,
      env: { ANTHROPIC_API_KEY: "sk-test-not-a-real-key", CLAUSEWISE_FALLBACK: "default" },
      generatorFactory: forbidden,
    });
    expect(code).toBe(3);
    expect(stderr).toContain("CLAUSEWISE_FALLBACK is on");
  });
});

describe("exit code 130", () => {
  it("is the code of a run interrupted before it starts, which leaves nothing behind", async () => {
    const { resultsDir } = await fresh();
    const controller = new AbortController();
    controller.abort(new Error("Interrupted"));
    const { code, stdout } = await run(["--selftest"], { resultsDir, signal: controller.signal });
    expect(code).toBe(130);
    expect(stdout).toBe("");
    expect(await files(resultsDir)).toEqual([]);
  });

  it("is the code of a run interrupted part-way, which keeps what finished and says it is incomplete", async () => {
    const { resultsDir } = await fresh();
    const controller = new AbortController();
    const stand = oracleFactory({});
    let calls = 0;
    const { code, stdout, stderr } = await run(["--selftest", "--runs", "2"], {
      resultsDir,
      signal: controller.signal,
      now: NOW,
      generatorFactory: (request) => {
        const inner = stand.factory(request);
        return {
          ...inner,
          generate: (call) => {
            // The first case of the second repeat starts after one whole repeat: 16 runs (14 cases
            // and 2 twins) of 9 calls each. The run is stopped five calls into it.
            if (++calls === DEV.calls + 5) controller.abort(new Error("Interrupted"));
            return inner.generate(call);
          },
        };
      },
    });
    expect(code).toBe(130);
    expect(stderr).toContain("Stopped: Interrupted.");
    expect(stdout).toContain("**INCOMPLETE: the run stopped early.** Interrupted.");
    const [name] = await files(resultsDir);
    const results = await readResults(`${resultsDir}/${name}`);
    expect(results.complete).toBe(false);
    // The first repeat finished whole and is scored; the second did not, and its run is on record.
    expect(results.sections[0]!.completedRepeats).toBe(1);
    expect(results.sections[0]!.metrics!.repeats).toHaveLength(1);
    expect(results.sections[0]!.gates).toBeNull();
    expect(results.runs.filter((r) => r.outcome === "failed")).toHaveLength(1);
    expect(results.runs.filter((r) => r.outcome === "succeeded")).toHaveLength(DEV.runs);
  });
});

describe("both splits at once", () => {
  it("runs each split as its own section, with its own hash and gates, and refuses without --allow-heldout", async () => {
    const resultsDir = `${dir}/${++n}/results`;
    const refused = await run(["--selftest", "--split", "all"], { resultsDir });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("Refusing to run the held-out split without --allow-heldout.");
    expect(await files(resultsDir)).toEqual([]);

    const { code, stdout, stderr } = await run(
      ["--selftest", "--split", "all", "--allow-heldout"],
      { resultsDir },
    );
    expect(code, stderr).toBe(0);
    const [name] = await files(resultsDir);
    const results = await readResults(`${resultsDir}/${name}`);
    expect(results.sections.map((s) => [s.split, s.caseKeys.length, s.completedRepeats])).toEqual([
      ["dev", 14, 1],
      ["heldout", 12, 1],
    ]);
    expect(Object.keys(results.pins.dataset.splits)).toEqual(["dev", "heldout"]);
    expect(results.pins.split).toBe("all");
    const keys = JSON.parse(
      await readFile(`${REPO_ROOT}/fixtures/parol/answer-keys.json`, "utf8"),
    ) as { cases: { case: string; split: string }[] };
    expect(results.pins.cases).toEqual(keys.cases.map((c) => c.case));
    expect(results.pins.cases).toHaveLength(26);
    // Each split is scored on its own cases: 14 cases of 8 rules, and 12 cases of 8 rules.
    expect(results.sections.map((s) => s.metrics!.repeats[0]!.statusAccuracy.denominator)).toEqual([
      112, 96,
    ]);
    expect([DEV.slots, HELDOUT.slots]).toEqual([112, 96]);
    expect(results.sections.every((s) => s.metrics!.repeats[0]!.statusAccuracy.value === 1)).toBe(
      true,
    );
    // The two splits have their own hashes in the pins, and they differ.
    const hashes = Object.values(results.pins.dataset.splits);
    expect(new Set(hashes).size).toBe(2);
    expect(stdout).toContain("## Split dev (SELFTEST)");
    expect(stdout).toContain("## Split heldout (SELFTEST)");
    expect(stdout).toContain("**Held-out set.** The held-out set is sealed");
  });

  it("runs a changed split against its own recorded hash, and the other split's hash is not consulted", async () => {
    // Two cases moved between splits and splits.json rewritten to agree: both splits still run,
    // each against its own hash and its own cases.
    const base = `${dir}/${++n}`;
    const root = await copyRoot(base);
    await changeKey(root, (keys) => {
      for (const entry of [...keys.cases, ...keys.twins]) {
        if (["PAROL-D05", "PAROL-D06"].includes(entry.case)) entry.split = "heldout";
      }
    });
    await rehash(root);
    const resultsDir = `${base}/results`;
    const { code, stderr } = await run(["--selftest", "--split", "all", "--allow-heldout"], {
      resultsDir,
      root,
    });
    expect(code, stderr).toBe(0);
    const [name] = await files(resultsDir);
    const results = await readResults(`${resultsDir}/${name}`);
    expect(results.sections.map((s) => [s.split, s.caseKeys.length])).toEqual([
      ["dev", 12],
      ["heldout", 14],
    ]);
  });
});

describe("a held-out run", () => {
  it("prints the seal warning, and a selftest of it does not count as an earlier run", async () => {
    const { resultsDir, root } = await fresh(true);
    const args = ["--selftest", "--split", "heldout", "--allow-heldout"];
    const first = await run(args, { resultsDir, root });
    expect(first.code).toBe(0);
    expect(first.stderr).toContain("HELD-OUT SPLIT. The held-out set is sealed");
    expect(first.stdout).toContain("**Held-out set.** The held-out set is sealed");
    // A selftest taught nothing about a model, so it does not contaminate anything.
    const [name] = await files(resultsDir);
    expect((await readResults(`${resultsDir}/${name}`)).contamination).toBeNull();
    // The held-out split was run whole: twelve cases, and the twins of H07 and H09.
    const results = await readResults(`${resultsDir}/${name}`);
    expect(results.sections.map((s) => [s.split, s.caseKeys.length, s.twinKeys])).toEqual([
      ["heldout", 12, ["PAROL-H07-twin", "PAROL-H09-twin"]],
    ]);
  });
});
