import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import type { ObjectGenerator } from "@clausewise/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnswerKeyFile } from "../../fixtures/parol/types.js";
import { loadPlaybook } from "../../apps/parol/src/playbooks/load.js";
import { workflowFor } from "../../apps/parol/src/prompts/workflows.js";
import { loadDataset, selectCases } from "../src/parol/dataset.js";
import { buildParolPlan, costBounds } from "../src/parol/plan.js";
import { runnableCases } from "../src/parol/runner.js";
import { usd } from "../src/guard.js";
import {
  REPO_ROOT,
  changeKey,
  copyRoot,
  makeTempDir,
  oracleFactory,
  readResults,
  relabelAsHeldout,
  removeDir,
  run,
} from "../src/parol/testing-run.js";

/**
 * Tests written from the findings of the independent review of the runner. Each one first failed
 * against the code as reviewed, with the reproduction the reviewer gave. The live paths here run
 * against scripted stand-ins that report usage the way the Anthropic adapter does, and were never
 * run against a real model: there was no key.
 */

let dir = "";
let n = 0;
beforeAll(async () => {
  dir = await makeTempDir();
});
afterAll(async () => {
  await removeDir(dir);
});

const fresh = (): string => `${dir}/${++n}`;
const files = async (folder: string): Promise<string[]> => readdir(folder).catch(() => []);

/** A factory that fails the test if a model is ever asked for: nothing may be sent on these paths. */
const forbidden = (): never => {
  throw new Error("a generator was requested on a path that must send nothing");
};

const LIVE = { ANTHROPIC_API_KEY: "sk-test-not-a-real-key", CLAUSEWISE_MAX_RETRIES: "0" };
const liveEnv = (baseUrl?: string): Record<string, string> =>
  baseUrl === undefined ? { ...LIVE } : { ...LIVE, CLAUSEWISE_BASE_URL: baseUrl };

// ---------------------------------------------------------------------------------------------
// Finding 1: the facts of the playbook rules are not covered by the hashes
// ---------------------------------------------------------------------------------------------

describe("the facts of the playbook rules in the answer key", () => {
  const edits: [string, (keys: AnswerKeyFile) => void][] = [
    // exc-1 has no expected flag in the dev split, so the high-severity count does not move.
    [
      "a severity that moves no flag count (exc-1, high to low)",
      (keys) => {
        keys.playbook.rules["exc-1"]!.severity = "low";
      },
    ],
    [
      "a severity (gov-1, medium to low)",
      (keys) => {
        keys.playbook.rules["gov-1"]!.severity = "low";
      },
    ],
    [
      "a required flag (ret-1, false to true)",
      (keys) => {
        keys.playbook.rules["ret-1"]!.required = true;
      },
    ],
    [
      "a category (gov-1, to duration)",
      (keys) => {
        keys.playbook.rules["gov-1"]!.category = "duration";
      },
    ],
  ];

  it.each(edits)(
    "stops a selftest with exit 2 and sends nothing when the key holds %s",
    async (_name, edit) => {
      const base = fresh();
      const root = await copyRoot(base);
      await changeKey(root, edit);
      const out = `${base}/out.json`;
      const { code, stderr, stdout } = await run(["--selftest", "--out", out], {
        resultsDir: `${base}/results`,
        root,
        generatorFactory: forbidden,
      });
      expect(stderr).toContain("INTEGRITY FAILURE");
      expect(stderr).toMatch(/the playbook/);
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(await files(base)).not.toContain("out.json");
    },
  );

  it("names the rule and the fact, and never repeats a value of the key", async () => {
    const base = fresh();
    const root = await copyRoot(base);
    await changeKey(root, (keys) => {
      keys.playbook.rules["exc-1"]!.severity = "low";
    });
    const { stderr } = await run(["--selftest", "--out", `${base}/out.json`], {
      resultsDir: `${base}/results`,
      root,
    });
    expect(stderr).toContain(
      "rule exc-1: the severity in the answer key differs from the playbook",
    );
  });

  it("stops a live run the same way, before a plan or a call", async () => {
    const base = fresh();
    const root = await copyRoot(base);
    await changeKey(root, (keys) => {
      keys.playbook.rules["exc-1"]!.severity = "low";
    });
    const { code, stderr } = await run(["--yes", "--case", "PAROL-D01", "--max-cost", "5"], {
      resultsDir: `${base}/results`,
      root,
      generatorFactory: forbidden,
    });
    expect(code).toBe(2);
    expect(stderr).not.toContain("Evaluation plan");
  });

  it("does not stop the committed dataset", async () => {
    const base = fresh();
    const { code, stderr } = await run(["--selftest", "--case", "PAROL-D01"], {
      resultsDir: `${base}/results`,
    });
    expect(code, stderr).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Finding 2: the endpoint is not pinned
// ---------------------------------------------------------------------------------------------

describe("the endpoint of a live run", () => {
  it("is pinned as a host only, shown in the report, and flagged when it is not the provider's own", async () => {
    const base = fresh();
    const stand = oracleFactory({});
    const out = `${base}/first.json`;
    const { code, stdout, stderr } = await run(
      ["--yes", "--case", "PAROL-D01", "--max-cost", "5", "--out", out],
      {
        resultsDir: `${base}/results`,
        env: liveEnv("https://gateway.example.com:8443/team-secret-path/v1"),
        generatorFactory: stand.factory,
      },
    );
    expect(code, stderr).toBe(0);
    const text = await readFile(out, "utf8");
    const results = await readResults(out);
    expect(results.pins.model.endpoint).toBe("gateway.example.com:8443");
    // Nothing but the host: no path, which can carry a token, and no credential.
    expect(text).not.toContain("team-secret-path");
    expect(stdout).toContain("gateway.example.com:8443");
    expect(stdout).toMatch(/not at the provider's own API host \(api\.anthropic\.com\)/);
  });

  it("is the provider's own host when none is configured, and says nothing about it", async () => {
    const base = fresh();
    const out = `${base}/default.json`;
    const { code, stdout } = await run(
      ["--yes", "--case", "PAROL-D01", "--max-cost", "5", "--out", out],
      {
        resultsDir: `${base}/results`,
        env: liveEnv(),
        generatorFactory: oracleFactory({}).factory,
      },
    );
    expect(code).toBe(0);
    expect((await readResults(out)).pins.model.endpoint).toBe("api.anthropic.com");
    expect(stdout).not.toContain("not at the provider's own API host");
  });

  it("is null for a scripted run, which reaches no endpoint", async () => {
    const base = fresh();
    const out = `${base}/selftest.json`;
    await run(["--selftest", "--case", "PAROL-D01", "--out", out], {
      resultsDir: `${base}/results`,
    });
    expect((await readResults(out)).pins.model.endpoint).toBeNull();
  });

  it("makes two runs against different endpoints refuse to compare, before anything is sent", async () => {
    const base = fresh();
    const resultsDir = `${base}/results`;
    const first = `${base}/first.json`;
    const a = await run(["--yes", "--case", "PAROL-D01", "--max-cost", "5", "--out", first], {
      resultsDir,
      env: liveEnv("http://127.0.0.1:9"),
      generatorFactory: oracleFactory({}).factory,
    });
    expect(a.code, a.stderr).toBe(0);

    const second = oracleFactory({});
    const b = await run(
      [
        "--yes",
        "--case",
        "PAROL-D01",
        "--max-cost",
        "5",
        "--compare",
        first,
        "--out",
        `${base}/second.json`,
      ],
      { resultsDir, env: liveEnv(), generatorFactory: second.factory },
    );
    expect(b.code).toBe(1);
    expect(b.stderr).toContain("Refusing to compare");
    expect(b.stderr).toContain("model.endpoint");
    expect(b.stderr).toContain("Nothing was sent.");
    expect(second.calls()).toBe(0);
    expect(await files(base)).not.toContain("second.json");

    // The difference can be named, and then it is printed in the comparison.
    const c = await run(
      [
        "--yes",
        "--case",
        "PAROL-D01",
        "--max-cost",
        "5",
        "--compare",
        first,
        "--allow-differences",
        "model",
        "--out",
        `${base}/third.json`,
      ],
      { resultsDir, env: liveEnv(), generatorFactory: oracleFactory({}).factory },
    );
    expect(c.code, c.stderr).toBe(0);
    expect(c.stdout).toContain("model.endpoint");
  });
});

// ---------------------------------------------------------------------------------------------
// Finding 3: failures of the infrastructure are scored as the model's answers
// ---------------------------------------------------------------------------------------------

/** FABRICATED FOR A TEST: the key oracle, except that chosen requests fail on the wire. */
function failing(
  stand: ReturnType<typeof oracleFactory>,
  fails: (call: { prompt: string; schemaName?: string }) => boolean,
): (request: Parameters<ReturnType<typeof oracleFactory>["factory"]>[0]) => ObjectGenerator {
  return (request) => {
    const inner = stand.factory(request);
    return {
      ...inner,
      async generate(call) {
        if (fails(call)) throw new Error("socket hang up");
        return inner.generate(call);
      },
    };
  };
}

describe("a live run in which calls failed on the wire", () => {
  it("says so in the report, with the count by outcome, instead of reading as the model abstaining", async () => {
    const base = fresh();
    const stand = oracleFactory({});
    const out = `${base}/out.json`;
    const { code, stdout, stderr } = await run(
      ["--yes", "--case", "PAROL-D05", "--max-cost", "5", "--out", out],
      {
        resultsDir: `${base}/results`,
        env: liveEnv(),
        generatorFactory: failing(stand, (call) => /Rule ID: (dur-1|exc-1)\b/.test(call.prompt)),
      },
    );
    expect(code, stderr).toBe(0);
    const results = await readResults(out);
    // The runner recorded it already; the report is what did not say it.
    expect(results.runs[0]!.callOutcomes).toMatchObject({ transport: 2 });
    expect(stdout).toContain("NOT A CLEAN MEASUREMENT");
    expect(stdout).toMatch(/2 model calls failed on the wire/);
    expect(stdout).toMatch(/\| transport \| 2 \|/);
    expect(stdout).toMatch(/\| ok \| 7 \|/);
    // A slot whose call failed is scored undetermined, which reads as an abstention.
    expect(stdout).toContain("scored as undetermined");
    // The heading of the scores carries the warning too, not only a section further down.
    const scores = stdout.indexOf("### Result of");
    expect(stdout.lastIndexOf("NOT A CLEAN MEASUREMENT", scores)).toBeGreaterThan(-1);
    expect(stderr).toContain("2 model calls failed on the wire");
  });

  it("says so when the extract call failed and the whole document was read instead", async () => {
    const base = fresh();
    const stand = oracleFactory({});
    const out = `${base}/out.json`;
    const { code, stdout } = await run(
      ["--yes", "--case", "PAROL-D01", "--max-cost", "5", "--out", out],
      {
        resultsDir: `${base}/results`,
        env: liveEnv(),
        generatorFactory: failing(stand, (call) => call.schemaName === "locate_passages"),
      },
    );
    expect(code).toBe(0);
    expect((await readResults(out)).runs[0]!.extractDegraded).toBe(true);
    expect(stdout).toContain("NOT A CLEAN MEASUREMENT");
    expect(stdout).toMatch(/Extraction degraded in 1 of 1 runs/);
  });

  it("does not warn about a clean run, and lists its calls all as ok", async () => {
    const base = fresh();
    const { code, stdout } = await run(
      ["--yes", "--case", "PAROL-D01", "--max-cost", "5", "--out", `${base}/out.json`],
      {
        resultsDir: `${base}/results`,
        env: liveEnv(),
        generatorFactory: oracleFactory({}).factory,
      },
    );
    expect(code).toBe(0);
    expect(stdout).not.toContain("NOT A CLEAN MEASUREMENT");
    expect(stdout).toMatch(/\| ok \| 9 \|/);
  });

  it("is carried into a comparison, which does not apply the decision rule to it", async () => {
    const base = fresh();
    const resultsDir = `${base}/results`;
    const first = `${base}/first.json`;
    const a = await run(["--yes", "--case", "PAROL-D05", "--max-cost", "5", "--out", first], {
      resultsDir,
      env: liveEnv(),
      generatorFactory: oracleFactory({}).factory,
    });
    expect(a.code, a.stderr).toBe(0);
    const stand = oracleFactory({});
    const b = await run(
      [
        "--yes",
        "--case",
        "PAROL-D05",
        "--max-cost",
        "5",
        "--workflow",
        "v2",
        "--compare",
        first,
        "--out",
        `${base}/second.json`,
      ],
      {
        resultsDir,
        env: liveEnv(),
        generatorFactory: failing(stand, (call) => /Rule ID: dur-1\b/.test(call.prompt)),
      },
    );
    expect(b.code, b.stderr).toBe(0);
    const comparison = b.stdout.slice(b.stdout.indexOf("# Comparison"));
    expect(comparison).toContain("NOT A CLEAN MEASUREMENT");
    expect(comparison).toMatch(/candidate/i);
    expect(comparison).toContain("The decision rule is not applied");
  });
});

// ---------------------------------------------------------------------------------------------
// Finding 4: the contamination note reads one folder and one kind of file
// ---------------------------------------------------------------------------------------------

describe("the contamination note of the held-out split", () => {
  const heldoutArgs = (extra: string[]): string[] => [
    "--yes",
    "--split",
    "heldout",
    "--allow-heldout",
    "--case",
    "PAROL-D01",
    "--max-cost",
    "5",
    ...extra,
  ];

  async function heldoutRoot(base: string): Promise<string> {
    const root = await copyRoot(base);
    // FABRICATED FOR A TEST: the dev cases relabelled as held-out, because the dataset has none yet.
    await relabelAsHeldout(root);
    return root;
  }

  it("remembers a held-out run whose results were written elsewhere with --out", async () => {
    const base = fresh();
    const root = await heldoutRoot(base);
    const resultsDir = `${base}/results`;
    const first = await run(heldoutArgs(["--out", `${base}/elsewhere/first.json`]), {
      resultsDir,
      root,
      env: liveEnv(),
      generatorFactory: oracleFactory({}).factory,
    });
    expect(first.code, first.stderr).toBe(0);

    const second = await run(heldoutArgs([]), {
      resultsDir,
      root,
      env: liveEnv(),
      generatorFactory: oracleFactory({}).factory,
    });
    expect(second.code, second.stderr).toBe(0);
    expect(second.stderr).toContain("The held-out split was run once before with workflow v1");
    expect(second.stderr).toContain("first.json");
    const names = (await files(resultsDir)).filter((name) => name.endsWith(".json"));
    expect(names).toHaveLength(1);
    const results = await readResults(`${resultsDir}/${names[0]!}`);
    expect(results.contamination).toMatchObject({
      split: "heldout",
      priorRuns: [{ file: "first.json", model: "claude-sonnet-5-5" }],
    });
  });

  it("writes nothing when the run is refused before it starts, and nothing for a scripted run", async () => {
    const base = fresh();
    const root = await heldoutRoot(base);
    const resultsDir = `${base}/results`;
    // No --yes: the plan is printed and nothing is sent, so the split was not touched.
    const refused = await run(
      heldoutArgs([]).filter((arg) => arg !== "--yes"),
      { resultsDir, root, env: liveEnv(), generatorFactory: forbidden },
    );
    expect(refused.code).toBe(3);
    // A selftest of the split teaches nothing about a model.
    const selftest = await run(
      ["--selftest", "--split", "heldout", "--allow-heldout", "--out", `${base}/else/self.json`],
      { resultsDir, root },
    );
    expect(selftest.code, selftest.stderr).toBe(0);
    const live = await run(heldoutArgs(["--out", `${base}/else/live.json`]), {
      resultsDir,
      root,
      env: liveEnv(),
      generatorFactory: oracleFactory({}).factory,
    });
    expect(live.code, live.stderr).toBe(0);
    expect((await readResults(`${base}/else/live.json`)).contamination).toBeNull();
  });

  it("records a dev run of nothing: only a run that touches the held-out split is remembered", async () => {
    const base = fresh();
    const resultsDir = `${base}/results`;
    const { code } = await run(
      ["--yes", "--case", "PAROL-D01", "--max-cost", "5", "--out", `${base}/else/dev.json`],
      {
        resultsDir,
        env: liveEnv(),
        generatorFactory: oracleFactory({}).factory,
      },
    );
    expect(code).toBe(0);
    expect((await files(resultsDir)).filter((name) => !name.endsWith(".json"))).toEqual([]);
  });

  it("reads the checkpoint a killed run leaves behind", async () => {
    const base = fresh();
    const root = await heldoutRoot(base);
    const resultsDir = `${base}/results`;
    const out = `${base}/else/first.json`;
    const first = await run(heldoutArgs(["--out", out]), {
      resultsDir,
      root,
      env: liveEnv(),
      generatorFactory: oracleFactory({}).factory,
    });
    expect(first.code, first.stderr).toBe(0);
    // A hard kill leaves only the checkpoint, which is what a finished file looked like before it
    // was linked into place. FABRICATED FOR A TEST: the finished file copied to the checkpoint name.
    const finished = await readFile(out, "utf8");
    const folder = `${base}/killed`;
    await mkdir(folder, { recursive: true });
    await writeFile(`${folder}/parol-20261104T100000Z.json.partial`, finished);
    const second = await run(heldoutArgs([]), {
      resultsDir: folder,
      root,
      env: liveEnv(),
      generatorFactory: oracleFactory({}).factory,
    });
    expect(second.code, second.stderr).toBe(0);
    expect(second.stderr).toContain("parol-20261104T100000Z.json.partial");
  });
});

// ---------------------------------------------------------------------------------------------
// Finding 5: G4 and G5 pass with nothing at risk
// ---------------------------------------------------------------------------------------------

describe("a run that holds nothing for G4 to count", () => {
  it("shows G4 as not evaluated, like G3, on a case with no expected flag", async () => {
    const base = fresh();
    const out = `${base}/out.json`;
    const { code, stdout } = await run(["--selftest", "--case", "PAROL-D01", "--out", out], {
      resultsDir: `${base}/results`,
    });
    expect(code).toBe(0);
    const gates = (await readResults(out)).sections[0]!.gates!;
    const outcome = (id: string): string => gates.results.find((r) => r.id === id)!.outcome;
    expect(outcome("G3")).toBe("not_evaluated");
    expect(outcome("G4")).toBe("not_evaluated");
    expect(gates.results.find((r) => r.id === "G4")!.detail).toContain("0 of 0");
    expect(stdout).toMatch(/\| G4 \|[^\n]*\| not evaluated \|/);
  });

  it("still passes G4 on the whole dev split, where there are high-severity flags to miss", async () => {
    const base = fresh();
    const out = `${base}/out.json`;
    const { code } = await run(["--selftest", "--out", out], { resultsDir: `${base}/results` });
    expect(code).toBe(0);
    const gates = (await readResults(out)).sections[0]!.gates!;
    const g4 = gates.results.find((r) => r.id === "G4")!;
    expect(g4.outcome).toBe("pass");
    expect(g4.evidence[0]!.denominator).toBeGreaterThan(0);
    expect(gates.results.find((r) => r.id === "G5")!.outcome).toBe("pass");
  });
});

// ---------------------------------------------------------------------------------------------
// Finding 6: the cost bound that is compared with --max-cost
// ---------------------------------------------------------------------------------------------

describe("the cost bound of a live run", () => {
  it("compares the figure that includes every repair call with --max-cost, and names it", async () => {
    const loaded = await loadDataset(REPO_ROOT);
    if (!loaded.ok) throw new Error("the dataset did not load");
    const { readFileSync } = await import("node:fs");
    const playbook = loadPlaybook({
      yaml: readFileSync(`${REPO_ROOT}/apps/parol/playbooks/parol-nda-recipient.yaml`, "utf8"),
      slug: "parol-nda-recipient",
    });
    const [group] = selectCases(loaded.dataset, "dev", ["PAROL-D01"]);
    const plan = await buildParolPlan({
      dataset: loaded.dataset,
      runnables: runnableCases(group!),
      playbook,
      workflow: workflowFor("v1"),
      repeats: 1,
      assumedOutputTokens: 1500,
    });
    const bounds = costBounds(
      plan,
      { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      { maxOutputTokens: 16_000, maxRetries: 0 },
    );
    expect(bounds.withRepairsUsd).toBeGreaterThan(bounds.upperBoundUsd);
    // A limit between the two: the figure without repairs is under it, the figure with them over.
    const limit = ((bounds.upperBoundUsd + bounds.withRepairsUsd) / 2).toFixed(6);

    const base = fresh();
    const stand = oracleFactory({});
    const { code, stderr } = await run(
      ["--yes", "--case", "PAROL-D01", "--max-cost", limit, "--assumed-output-tokens", "1500"],
      { resultsDir: `${base}/results`, env: liveEnv(), generatorFactory: stand.factory },
    );
    expect(code).toBe(3);
    expect(stand.calls()).toBe(0);
    expect(stderr).toContain(
      `Refusing to run: the cost upper bound of ${usd(bounds.withRepairsUsd)} is above --max-cost`,
    );
    // The plan names each figure for what it is, and none of them contradicts another.
    expect(stderr).toContain(
      `Cost with one attempt per call and no repair call: ${usd(bounds.upperBoundUsd)}`,
    );
    expect(stderr).toContain(
      `Cost upper bound, if every rule needed its repair call: ${usd(bounds.withRepairsUsd)}`,
    );
    expect(stderr).not.toMatch(/Cost upper bound: \$/);
    expect(stderr).not.toContain("cost at most");
  });

  it("says, without --yes, that the calls and the cost are at most these figures", async () => {
    const base = fresh();
    const { code, stderr } = await run(["--case", "PAROL-D01"], {
      resultsDir: `${base}/results`,
      env: liveEnv(),
      generatorFactory: forbidden,
    });
    expect(code).toBe(3);
    expect(stderr).toMatch(
      /Nothing was sent\. This evaluation would make up to \d+ model calls and cost at most \$\d+\.\d{4}\./,
    );
  });
});
