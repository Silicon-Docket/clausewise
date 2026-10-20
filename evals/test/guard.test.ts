import { readFile, readdir } from "node:fs/promises";
import { contextFloor, estimateTokens } from "@clausewise/review";
import { createOracleGenerator } from "@clausewise/review/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Fixture } from "../src/fixtures.js";
import type { GeneratorRequest } from "../src/harness.js";
import type { EvalResult } from "../src/result.js";
import { oracleScripts } from "../src/selftest.js";
import {
  allFixtures,
  forbiddenFactory,
  makeTempDir,
  removeDir,
  routedModel,
  run,
  type RoutedModel,
} from "./support.js";

let dir = "";
let fixtures: Fixture[] = [];
beforeAll(async () => {
  dir = await makeTempDir();
  fixtures = await allFixtures();
});
afterAll(async () => {
  await removeDir(dir);
});

const readResult = async (path: string): Promise<EvalResult> =>
  JSON.parse(await readFile(path, "utf8")) as EvalResult;

describe("the spend guard", () => {
  it("prints the plan and exits 3 without --yes, having called nothing", async () => {
    const factory = forbiddenFactory();
    const { code, stderr, stdout } = await run([], { dir, generatorFactory: factory });
    expect(code).toBe(3);
    expect(factory.used()).toBe(false);
    expect(stdout).toBe("");
    expect(stderr).toContain("Evaluation plan (nothing has been sent yet)");
    expect(stderr).toContain("nda-aggressive.docx");
    expect(stderr).toContain("saas-vendor-friendly.docx");
    expect(stderr).toContain("Model calls in total: 32");
    expect(stderr).toMatch(/Input tokens, upper bound: [\d,]+/);
    expect(stderr).toContain("Output tokens, upper bound: 48,000");
    expect(stderr).toMatch(/Cost upper bound: \$0\.\d{4}/);
    expect(stderr).toContain("Add --yes to run it.");
    expect(stderr).toContain("current price list");
    expect(stderr).not.toContain("Sending the contract text to");
  });

  it("writes nothing to the results directory when it refuses", async () => {
    const empty = await makeTempDir();
    try {
      await run([], { dir: empty, generatorFactory: forbiddenFactory() });
      expect(await readdir(empty)).toEqual([]);
    } finally {
      await removeDir(empty);
    }
  });

  it("refuses with --yes when the upper bound is above --max-cost, having called nothing", async () => {
    const factory = forbiddenFactory();
    const { code, stderr, stdout } = await run(["--yes", "--max-cost", "0.05"], {
      dir,
      generatorFactory: factory,
    });
    expect(code).toBe(3);
    expect(factory.used()).toBe(false);
    expect(stdout).toBe("");
    expect(stderr).toMatch(
      /Refusing to run: the cost upper bound of \$0\.\d{4} is above --max-cost \$0\.0500/,
    );
    expect(stderr).toContain("Raise the limit with --max-cost <usd>");
    expect(stderr).toContain("Nothing was sent.");
  });

  it("says how to raise the limit when --yes is missing and the bound is over it", async () => {
    const { code, stderr } = await run(["--max-cost", "0.05"], {
      dir,
      generatorFactory: forbiddenFactory(),
    });
    expect(code).toBe(3);
    expect(stderr).toContain("above the current limit of $0.0500");
    expect(stderr).toContain("--max-cost <usd>");
    expect(stderr).toContain("add --yes");
  });

  it("runs with --yes when the bound is within the default limit of 2 USD", async () => {
    const model = routedModel(fixtures);
    const out = `${dir}/within.json`;
    const { code, stderr } = await run(["--yes", "--out", out], {
      dir,
      generatorFactory: () => model,
    });
    expect(code).toBe(0);
    expect(model.requests).toHaveLength(32);
    expect(stderr).toContain("Sending the contract text to: a scripted test model");
    const result = await readResult(out);
    expect(result.options.maxCostUsd).toBe(2);
    expect(result.cost.upperBoundUsd).toBeLessThan(2);
  });

  it("accepts a limit equal to the bound and refuses one a hair below it", async () => {
    const probe = `${dir}/probe.json`;
    await run(["--yes", "--out", probe], { dir, generatorFactory: () => routedModel(fixtures) });
    const bound = (await readResult(probe)).cost.upperBoundUsd;
    expect(bound).not.toBeNull();

    const equal = routedModel(fixtures);
    const accepted = await run(
      ["--yes", "--max-cost", String(bound), "--out", `${dir}/equal.json`],
      {
        dir,
        generatorFactory: () => equal,
      },
    );
    expect(accepted.code).toBe(0);
    expect(equal.requests.length).toBe(32);

    const below = forbiddenFactory();
    const refused = await run(
      ["--yes", "--max-cost", ((bound ?? 0) - 0.0001).toFixed(4), "--out", `${dir}/below.json`],
      { dir, generatorFactory: below },
    );
    expect(refused.code).toBe(3);
    expect(below.used()).toBe(false);
  });

  it("stops a run whose recorded spend passes --max-cost, even though the bound said it would not", async () => {
    // The first fixture alone has a bound of about 0.22 USD, so --max-cost 1.5 lets it start. Each
    // reported response then costs one USD (500,000 input tokens at 2 USD per million).
    let model: RoutedModel | undefined;
    const factory = ({ onUsage }: GeneratorRequest): RoutedModel => {
      model = routedModel(fixtures, {
        before: () =>
          onUsage({
            inputTokens: 500_000,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          }),
      });
      return model;
    };
    const { code, stderr } = await run(
      ["--yes", "--fixture", "nda-balanced.docx", "--max-cost", "1.5"],
      { dir, generatorFactory: factory },
    );
    expect(code).toBe(3);
    expect(stderr).toContain("Recorded spend passed the --max-cost limit of $1.5000");
    expect(stderr).toMatch(/Spent so far: [\d,]+ input/);
    // Only the first call and the few that were already under way ran, not all ten.
    expect(model?.requests.length).toBeLessThan(10);
  });
});

describe("the plan", () => {
  it("makes as many calls as a selftest then makes", async () => {
    const oracles: ReturnType<typeof createOracleGenerator>[] = [];
    const out = `${dir}/plan-equals-calls.json`;
    const { code } = await run(["--selftest", "--out", out], {
      dir,
      generatorFactory: ({ fixture }) => {
        const oracle = createOracleGenerator(oracleScripts(fixture));
        oracles.push(oracle);
        return oracle;
      },
    });
    expect(code).toBe(0);
    const made = oracles.reduce((sum, oracle) => sum + oracle.calls.length, 0);
    const result = await readResult(out);
    expect(made).toBe(32);
    expect(result.plan.calls).toBe(made);
    expect(result.usage.totalCalls).toBe(made);
  });

  it("makes as many calls as a selftest then makes when the contract is split into windows", async () => {
    const oracles: ReturnType<typeof createOracleGenerator>[] = [];
    const out = `${dir}/plan-windows.json`;
    // Every call spends about 4,800 tokens before the first clause: the instructions, the rule and
    // room for the answer. The pipeline refuses a limit without room for a clause or two on top of
    // that, so the smallest limit it accepts for all three playbooks leaves about 1,000 tokens for
    // the contract. The two longer fixtures hold 1,300 and 1,400 and split in two. The shortest
    // holds 1,030, so it sits too close to that limit to say how many windows it gets.
    const limit = Math.max(...fixtures.map((fixture) => contextFloor(fixture.playbook))) + 1;
    const { code, stderr } = await run(
      [
        "--selftest",
        "--fixture",
        "nda-balanced.docx",
        "--fixture",
        "saas-vendor-friendly.docx",
        "--out",
        out,
      ],
      {
        dir,
        env: { CLAUSEWISE_MAX_CONTEXT_TOKENS: String(limit) },
        generatorFactory: ({ fixture }) => {
          const oracle = createOracleGenerator(oracleScripts(fixture));
          oracles.push(oracle);
          return oracle;
        },
      },
    );
    expect(code).toBe(0);
    const result = await readResult(out);
    // Two windows each, and every window is checked against every rule of its playbook: 2 x 10
    // and 2 x 12, which is twice the 22 calls of two unsplit contracts.
    expect(result.plan.fixtures.map((item) => item.windows)).toEqual([2, 2]);
    expect(result.plan.fixtures.map((item) => item.rules)).toEqual([10, 12]);
    expect(result.plan.fixtures.map((item) => item.callsPerRun)).toEqual([20, 24]);
    expect(result.plan.calls).toBe(44);
    expect(oracles.reduce((sum, oracle) => sum + oracle.calls.length, 0)).toBe(44);
    expect(stderr).toContain(
      `windows of at most ${limit.toLocaleString("en-US")} estimated tokens`,
    );
  });

  it("refuses a context limit with no room for the clauses, before any call", async () => {
    const factory = forbiddenFactory();
    const floor = Math.max(...fixtures.map((fixture) => contextFloor(fixture.playbook)));
    const { code, stderr } = await run(["--selftest", "--out", `${dir}/too-small.json`], {
      dir,
      env: { CLAUSEWISE_MAX_CONTEXT_TOKENS: String(floor) },
      generatorFactory: factory,
    });
    expect(code).toBe(1);
    expect(factory.used()).toBe(false);
    expect(stderr).toContain(`must be above ${floor}`);
  });

  it("makes as many calls as a real run then makes, several reviews included", async () => {
    const model = routedModel(fixtures);
    const out = `${dir}/plan-real.json`;
    const { code } = await run(["--yes", "--runs", "2", "--out", out], {
      dir,
      generatorFactory: () => model,
    });
    expect(code).toBe(0);
    const result = await readResult(out);
    expect(result.plan.calls).toBe(64);
    expect(model.requests).toHaveLength(64);
    expect(result.runs).toHaveLength(6);
    expect(result.runs.map((record) => record.calls)).toEqual([10, 10, 10, 10, 12, 12]);
  });

  it("bounds the input by the prompts the pipeline really sends", async () => {
    const model = routedModel(fixtures);
    const out = `${dir}/plan-bound.json`;
    await run(["--yes", "--out", out], { dir, generatorFactory: () => model });
    const result = await readResult(out);
    const sent = model.requests.reduce(
      (sum, request) => sum + estimateTokens(request.system) + estimateTokens(request.prompt),
      0,
    );
    expect(result.plan.inputTokens).toBeGreaterThan(sent);
    // The only thing added is the response schema, a few hundred tokens per call.
    expect((result.plan.inputTokens - sent) / result.plan.calls).toBeLessThan(1000);
  });

  it("prices the bound at the table's rates with the stated output assumption", async () => {
    const out = `${dir}/plan-price.json`;
    await run(["--yes", "--out", out], { dir, generatorFactory: () => routedModel(fixtures) });
    const { plan, cost } = await readResult(out);
    expect(plan.assumedOutputTokens).toBe(1500);
    expect(plan.outputTokens).toBe(plan.calls * 1500);
    // claude-sonnet-5-5: 2.00 USD per million input tokens, 10.00 per million output tokens.
    expect(cost.upperBoundUsd).toBeCloseTo(
      (plan.inputTokens * 2 + plan.outputTokens * 10) / 1e6,
      10,
    );
    expect(cost.price).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
  });

  it("takes the output assumption from --assumed-output-tokens", async () => {
    const { code, stderr } = await run(
      ["--assumed-output-tokens", "3000", "--fixture", "nda-balanced.docx"],
      {
        dir,
        generatorFactory: forbiddenFactory(),
      },
    );
    expect(code).toBe(3);
    expect(stderr).toContain("Output tokens, upper bound: 30,000 (10 calls x 3,000 tokens assumed");
  });

  it("warns, in the plan, when a declined request would be rerun on another model", async () => {
    const { stderr } = await run(["--fixture", "nda-balanced.docx"], {
      dir,
      env: { ANTHROPIC_API_KEY: "sk-test-not-a-real-key", CLAUSEWISE_FALLBACK: "default" },
      generatorFactory: forbiddenFactory(),
    });
    expect(stderr).toContain("CLAUSEWISE_FALLBACK is on");
  });

  it("covers only the fixtures named", async () => {
    const { stderr } = await run(
      [
        "--fixture",
        "nda-balanced.docx",
        "--fixture",
        "fixtures/nda-aggressive.docx",
        "--runs",
        "3",
      ],
      { dir, generatorFactory: forbiddenFactory() },
    );
    expect(stderr).toContain("Model calls in total: 60");
    expect(stderr).toContain("2 fixtures, 3 reviews of each");
    expect(stderr).not.toContain("saas-vendor-friendly.docx");
  });
});

describe("a selftest", () => {
  it("needs no --yes and no key, and never builds a real model", async () => {
    const { code, stderr, stdout } = await run(["--selftest", "--out", `${dir}/no-key.json`], {
      dir,
      env: {},
    });
    expect(code).toBe(0);
    expect(stderr).toContain("Selftest plan (no model will be called)");
    expect(stderr).not.toContain("Cost upper bound");
    expect(stdout).toContain("SELFTEST: no model was called");
  });

  it("still reads the same limits from the environment as a real run", async () => {
    const { code, stderr } = await run(["--selftest", "--out", `${dir}/limit.json`], {
      dir,
      env: { CLAUSEWISE_CONCURRENCY: "0" },
    });
    expect(code).toBe(1);
    expect(stderr).toContain("CLAUSEWISE_CONCURRENCY");
  });
});
