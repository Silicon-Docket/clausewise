import { readFile, readdir, writeFile } from "node:fs/promises";
import { ModelOutputError, ModelRefusalError, ModelRequestError } from "@clausewise/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contracts } from "../../fixtures/contracts.js";
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

const tokens = (
  inputTokens: number,
  outputTokens = 0,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
});

describe("a rule that cannot be checked", () => {
  it("is counted as an error and never stops the run, whatever went wrong with it", async () => {
    const model = routedModel(fixtures, {
      before: ({ ruleId }) => {
        if (ruleId === "term") throw new ModelOutputError("no usable output");
        if (ruleId === "remedies") throw new ModelRefusalError("declined", "cyber");
        if (ruleId === "mutuality") throw new Error("secret clause text");
      },
    });
    const out = `${dir}/errors.json`;
    const { code, stdout, stderr } = await run(["--yes", "--out", out], {
      dir,
      generatorFactory: () => model,
    });
    expect(code).toBe(0);

    const result = await readResult(out);
    // term, remedies and mutuality exist in both NDAs, and in neither is there more than one.
    expect(result.score.errored).toBe(6);
    expect(result.score).toMatchObject({ total: 30, correct: 24 });
    // Three of the six were expected to be deviations, so those are misses. The other three were
    // expected to be compliant, and a rule that was not checked raises no false alarm.
    expect(result.score.flag).toMatchObject({ truePositives: 15, misses: 3, falseAlarms: 0 });
    expect(result.score.flag.f1).toBeCloseTo(30 / 33, 12);
    expect(stdout).toContain("| Rules that errored | 6 |");
    // Two fixtures, three causes, each rule in both.
    expect(result.score.errorReasons).toEqual([
      { reason: "The check failed unexpectedly (Error).", count: 2 },
      {
        reason: "The model declined to check this rule (refusal category: cyber).",
        count: 2,
      },
      {
        reason: "The model did not return an answer in the expected format for this rule.",
        count: 2,
      },
    ]);
    expect(stdout).toContain("## Rules that errored");
    expect(stdout).toContain("| The check failed unexpectedly (Error). | 2 |");
    expect(stdout).not.toContain("EVERY RULE ERRORED");

    const errors = result.runs.flatMap((record) =>
      record.report.results.filter((item) => item.status === "error"),
    );
    expect(errors.map((item) => item.error)).toContain(
      "The model did not return an answer in the expected format for this rule.",
    );
    expect(errors.map((item) => item.error)).toContain(
      "The model declined to check this rule (refusal category: cyber).",
    );
    expect(errors.map((item) => item.error)).toContain("The check failed unexpectedly (Error).");
    // The text of an unknown error can hold the contract, so it goes nowhere.
    for (const text of [stdout, stderr, JSON.stringify(result)]) {
      expect(text).not.toContain("secret clause text");
    }
  });
});

describe("a run in which nothing could be checked", () => {
  it("says so at the top, though a rule that cannot be checked is only data", async () => {
    const model = routedModel(fixtures, {
      before: () => {
        throw new ModelRequestError("no connection", undefined);
      },
    });
    const { code, stdout } = await run(["--yes", "--out", `${dir}/nothing.json`], {
      dir,
      generatorFactory: () => model,
    });
    expect(code).toBe(0);
    expect(stdout.startsWith("**EVERY RULE ERRORED.**")).toBe(true);
    expect(stdout).toContain("| The request to the model failed. | 30 |");
  });
});

describe("a fatal error from the provider", () => {
  const unauthorised = () => new ModelRequestError("The request failed with HTTP 401.", 401);

  it("aborts with exit 1 and still prints what was spent so far", async () => {
    // The first fixture's ten calls succeed and each reports 1000 input and 100 output tokens.
    // The eleventh, the first call for the second fixture, is refused with a 401.
    const factory = ({ onUsage }: GeneratorRequest) =>
      routedModel(fixtures, {
        before: ({ n }) => {
          if (n > 10) throw unauthorised();
          onUsage(tokens(1000, 100));
        },
      });
    const out = `${dir}/fatal.json`;
    const { code, stderr, stdout } = await run(["--yes", "--out", out], {
      dir,
      generatorFactory: factory,
    });
    expect(code).toBe(1);
    expect(stderr).toContain("The model provider answered HTTP 401, so no rule can be checked.");
    expect(stderr).toContain("Check the API key");
    // 10 x 1000 input and 10 x 100 output at 2 and 10 USD per million: 0.02 + 0.01.
    expect(stderr).toContain(
      "Spent so far: 10,000 input, 1,000 output, 0 cache read and 0 cache write tokens over 11 calls, which is $0.0300.",
    );
    expect(stderr.indexOf("Spent so far")).toBeLessThan(
      stderr.indexOf("Error: The model provider"),
    );

    // What finished is kept, and the report says that it is not the whole run.
    const result = await readResult(out);
    expect(result.complete).toBe(false);
    expect(result.stoppedBecause).toContain("HTTP 401");
    expect(result.runs.map((record) => record.fixture)).toEqual(["nda-aggressive.docx"]);
    expect(stdout).toContain("**INCOMPLETE: the run stopped early.**");
  });

  it("aborts on the very first call with nothing spent and nothing written", async () => {
    const empty = await makeTempDir();
    try {
      const model = routedModel(fixtures, {
        before: () => {
          throw unauthorised();
        },
      });
      const { code, stderr, stdout } = await run(["--yes"], {
        dir: empty,
        generatorFactory: () => model,
      });
      expect(code).toBe(1);
      expect(stderr).toContain("HTTP 401");
      expect(stderr).toContain(
        "Spent so far: 0 input, 0 output, 0 cache read and 0 cache write tokens over 1 calls",
      );
      expect(stdout).toBe("");
      expect(await readdir(empty)).toEqual([]);
      // The calls that had not started were not started.
      expect(model.requests).toHaveLength(1);
    } finally {
      await removeDir(empty);
    }
  });

  it.each([403, 404])("treats an HTTP %i the same way", async (status) => {
    const model = routedModel(fixtures, {
      before: () => {
        throw new ModelRequestError(`The request failed with HTTP ${status}.`, status);
      },
    });
    const { code, stderr } = await run(["--yes"], { dir, generatorFactory: () => model });
    expect(code).toBe(1);
    expect(stderr).toContain(`HTTP ${status}`);
  });

  it("does not treat a rate limit as fatal", async () => {
    const model = routedModel(fixtures, {
      before: ({ ruleId }) => {
        if (ruleId === "term") throw new ModelRequestError("rate limited", 429);
      },
    });
    const out = `${dir}/rate.json`;
    const { code } = await run(["--yes", "--fixture", "nda-balanced.docx", "--out", out], {
      dir,
      generatorFactory: () => model,
    });
    expect(code).toBe(0);
    const result = await readResult(out);
    expect(result.score.errored).toBe(1);
    expect(result.runs[0]?.report.results.find((item) => item.ruleId === "term")?.error).toBe(
      "The request to the model failed (HTTP 429).",
    );
  });
});

describe("an interrupt", () => {
  it("stops the run with exit 130 and starts no further call", async () => {
    const controller = new AbortController();
    const model = routedModel(fixtures, {
      before: ({ n }) => {
        if (n === 3) controller.abort(new Error("Interrupted"));
      },
    });
    const { code, stderr } = await run(["--yes"], {
      dir,
      signal: controller.signal,
      generatorFactory: () => model,
    });
    expect(code).toBe(130);
    expect(stderr).toContain("Stopped: Interrupted.");
    expect(model.requests.length).toBeLessThan(10);
  });
});

describe("usage and cache accounting", () => {
  // Each fixture's first call writes a 10,000-token cache entry and the nine after it read it.
  // Every call is billed 300 uncached input tokens and 200 output tokens.
  const accounting = ({ onUsage }: GeneratorRequest) => {
    const seen = new Set<string>();
    return routedModel(fixtures, {
      before: ({ fixture }) => {
        const first = !seen.has(fixture);
        seen.add(fixture);
        onUsage(first ? tokens(300, 200, 0, 10_000) : tokens(300, 200, 10_000, 0));
      },
    });
  };

  it("sums input, output, cache read and cache write per fixture and in total", async () => {
    const out = `${dir}/usage.json`;
    const { code } = await run(["--yes", "--out", out], { dir, generatorFactory: accounting });
    expect(code).toBe(0);
    const result = await readResult(out);
    expect(result.usage.available).toBe(true);
    expect(result.usage.total).toEqual({
      responses: 30,
      inputTokens: 9000,
      outputTokens: 6000,
      cacheReadTokens: 270_000,
      cacheWriteTokens: 30_000,
    });
    expect(result.usage.byFixture.map((item) => [item.fixture, item.calls])).toEqual([
      ["nda-aggressive.docx", 10],
      ["nda-balanced.docx", 10],
      ["saas-vendor-friendly.docx", 10],
    ]);
    expect(result.usage.byFixture[0]?.usage).toEqual({
      responses: 10,
      inputTokens: 3000,
      outputTokens: 2000,
      cacheReadTokens: 90_000,
      cacheWriteTokens: 10_000,
    });
    // 9,000 x 2 + 6,000 x 10 + 270,000 x 0.2 + 30,000 x 2.5 = 18,000 + 60,000 + 54,000 + 75,000
    expect(result.cost.actualUsd).toBeCloseTo(0.207, 12);
    expect(result.cost.actualUsd).toBeLessThan(result.cost.upperBoundUsd ?? 0);
  });

  it("reports the table, the cache effectiveness and the warning about the prices", async () => {
    const { stdout, stderr } = await run(["--yes", "--out", `${dir}/usage-report.json`], {
      dir,
      generatorFactory: accounting,
    });
    expect(stdout).toContain(
      "| nda-aggressive.docx | 1 | 10 | 3,000 | 2,000 | 90,000 | 10,000 | $0.0690 |",
    );
    expect(stdout).toContain("| **Total** | 3 | 30 | 9,000 | 6,000 | 270,000 | 30,000 | $0.2070 |");
    // 270,000 of 309,000 prompt tokens were read. Without the cache they would have cost
    // 309,000 x 2 + 60,000 = 678,000 micro-dollars, against 207,000 with it.
    expect(stdout).toContain(
      "Cache effectiveness: 87.4% of 309,000 prompt tokens were read from the cache.",
    );
    expect(stdout).toContain("would have cost $0.6780, so the cache saved 69.5%.");
    expect(stdout).toContain("Check evals/prices.json against the provider's current price list");
    expect(stdout).toMatch(/\| Cost \| \$0\.2070 \(upper bound \$0\.\d{4}\) \|/);
    expect(stderr).toContain(
      "Spent: 9,000 input, 6,000 output, 270,000 cache read and 30,000 cache write",
    );
  });

  it("counts every response of a retried call and says that there were more than calls", async () => {
    const factory = ({ onUsage }: GeneratorRequest) =>
      routedModel(fixtures, {
        before: ({ n }) => {
          onUsage(tokens(100, 10));
          // The adapter answers a reply it cannot use with a second request.
          if (n === 1) onUsage(tokens(100, 10));
        },
      });
    const out = `${dir}/retried.json`;
    const { stdout } = await run(["--yes", "--fixture", "nda-balanced.docx", "--out", out], {
      dir,
      generatorFactory: factory,
    });
    const result = await readResult(out);
    expect(result.usage.total).toMatchObject({
      responses: 11,
      inputTokens: 1100,
      outputTokens: 110,
    });
    expect(result.usage.totalCalls).toBe(10);
    expect(stdout).toContain("Usage was reported for 11 API responses to 10 calls.");
  });

  it("is unavailable for a provider that does not report usage, and says so", async () => {
    const path = `${dir}/openai-prices.json`;
    await writeFile(
      path,
      JSON.stringify({ "gpt-test": { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 } }),
    );
    const model = routedModel(fixtures, { provider: "openai" });
    const out = `${dir}/openai.json`;
    const { code, stdout, stderr } = await run(["--yes", "--prices", path, "--out", out], {
      dir,
      env: {
        CLAUSEWISE_PROVIDER: "openai",
        OPENAI_API_KEY: "sk-test-secret-key",
        CLAUSEWISE_MODEL: "gpt-test",
      },
      generatorFactory: () => model,
    });
    expect(code).toBe(0);
    const result = await readResult(out);
    expect(result.usage).toMatchObject({
      available: false,
      totalCalls: 30,
      total: null,
      cache: null,
    });
    expect(result.cost.actualUsd).toBeNull();
    expect(result.cost.upperBoundUsd).not.toBeNull();
    expect(stdout).toContain("Token usage is not reported for the openai provider");
    expect(stdout).toContain("Model calls made: 30.");
    expect(stderr).toContain(
      "Model calls made: 30. Token usage is not reported for the openai provider",
    );
    for (const text of [stdout, stderr, JSON.stringify(result)]) {
      expect(text).not.toContain("sk-test-secret-key");
    }
  });
});

describe("several reviews of the same fixture", () => {
  it("reports the rules whose status changed from one review to the next", async () => {
    // Ten calls per review, so call numbers 11 to 20 are the second review.
    const model = routedModel(fixtures, {
      answer: ({ n, ruleId }, check) =>
        ruleId === "term" && n > 10 && n <= 20 ? { ...check, status: "deviation" } : check,
    });
    const out = `${dir}/stable.json`;
    const { code, stdout } = await run(
      ["--yes", "--runs", "3", "--fixture", "nda-balanced.docx", "--out", out],
      { dir, generatorFactory: () => model },
    );
    expect(code).toBe(0);
    const result = await readResult(out);
    expect(model.requests).toHaveLength(30);
    expect(result.runs.map((record) => record.run)).toEqual([1, 2, 3]);

    const term = result.score.rules.find((rule) => rule.ruleId === "term");
    expect(term).toMatchObject({
      got: ["compliant", "deviation", "compliant"],
      modal: "compliant",
    });
    expect(term?.agreement).toBeCloseTo(2 / 3, 12);
    expect(result.score.stability?.unstable.map((rule) => rule.ruleId)).toEqual(["term"]);
    // Nine rules agree with themselves in every review and one in two reviews out of three.
    expect(result.score.stability?.meanAgreement).toBeCloseTo((9 + 2 / 3) / 10, 12);
    expect(result.score.accuracy).toBeCloseTo(29 / 30, 12);

    expect(stdout).toContain("## Stability");
    expect(stdout).toContain("1 unstable rule:");
    expect(stdout).toContain(
      "| nda-balanced.docx | term | compliant | compliant (2), deviation (1) | 66.7% |",
    );
    expect(stdout).toContain("| term | compliant | compliant (2), deviation (1) | 2/3 |");
  });

  it("says that every rule agreed when they did", async () => {
    const { stdout } = await run(
      ["--selftest", "--runs", "2", "--fixture", "nda-balanced.docx", "--out", `${dir}/agree.json`],
      { dir },
    );
    expect(stdout).toContain("Every rule gave the same status in every review.");
  });
});

describe("what is written", () => {
  it("holds no contract text beyond what the pipeline's reports hold", async () => {
    const out = `${dir}/text.json`;
    const { stdout, stderr } = await run(["--selftest", "--out", out], { dir });
    const json = await readFile(out, "utf8");
    const paragraphs = contracts.flatMap((contract) => [
      ...contract.intro,
      ...contract.sections.flatMap((section) => section.clauses),
    ]);
    expect(paragraphs.length).toBeGreaterThan(30);
    for (const paragraph of paragraphs) {
      // JSON escapes quotes, so the escaped form is looked for as well as the plain one.
      const escaped = JSON.stringify(paragraph).slice(1, -1);
      for (const text of [json, stdout, stderr]) {
        expect(text).not.toContain(paragraph);
        expect(text).not.toContain(escaped);
      }
    }
    // A report holds the words an edit changes, and so may the results.
    expect(json).toContain("perpetual and shall continue indefinitely");
  });

  it("holds the settings of a real run but neither the key nor the address", async () => {
    const model = routedModel(fixtures);
    const out = `${dir}/settings.json`;
    const env = {
      ANTHROPIC_API_KEY: "sk-test-secret-key",
      CLAUSEWISE_BASE_URL: "https://user:password@gateway.example.com/v1",
      CLAUSEWISE_MAX_CONTEXT_TOKENS: "100000",
      CLAUSEWISE_CONCURRENCY: "2",
      CLAUSEWISE_EFFORT: "low",
    };
    const { code } = await run(["--yes", "--fixture", "nda-balanced.docx", "--out", out], {
      dir,
      env,
      generatorFactory: () => model,
    });
    expect(code).toBe(0);
    const json = await readFile(out, "utf8");
    expect(JSON.parse(json).config).toEqual({
      maxOutputTokens: 16000,
      effort: "low",
      concurrency: 2,
      maxContextTokens: 100000,
      maxRetries: 2,
      fallback: null,
    });
    expect(json).not.toContain("sk-test-secret-key");
    expect(json).not.toContain("password");
  });

  it("creates the results directory and names the file by UTC time", async () => {
    const nested = `${dir}/nested/results`;
    const { code, stderr } = await run(["--selftest"], {
      dir: nested,
      now: () => new Date("2026-03-04T05:06:07.890Z"),
    });
    expect(code).toBe(0);
    expect(await readdir(nested)).toEqual(["20260304T050607Z.json"]);
    expect(stderr).toContain("20260304T050607Z.json");
  });

  it("refuses to replace a results file, before spending anything", async () => {
    const out = `${dir}/taken.json`;
    await writeFile(out, "{}");
    const factory = forbiddenFactory();
    const { code, stderr } = await run(["--yes", "--out", out], { dir, generatorFactory: factory });
    expect(code).toBe(1);
    expect(stderr).toContain("already exists");
    expect(factory.used()).toBe(false);
    expect(await readFile(out, "utf8")).toBe("{}");
  });
});

describe("the command line", () => {
  it("prints the usage for --help and exits 0", async () => {
    const { code, stdout } = await run(["--help"], { dir, generatorFactory: forbiddenFactory() });
    expect(code).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("--max-cost <usd>");
    expect(stdout).toContain("Exit codes:");
  });

  it.each([
    [["--runs", "0"], "--runs must be a positive whole number"],
    [["--runs", "x"], "--runs must be a positive whole number"],
    [["--runs", "1.5"], "--runs must be a positive whole number"],
    [["--max-cost", "abc"], "--max-cost must be a number above 0"],
    [["--max-cost", "0"], "--max-cost must be a number above 0"],
    [["--max-cost", "-1"], "--max-cost"],
    [["--assumed-output-tokens", "0"], "--assumed-output-tokens must be a positive whole number"],
    [["--bogus"], "--bogus"],
    [["extra"], "Unexpected argument: extra"],
    [["--runs", "1", "--runs", "2"], "Option --runs was given more than once."],
    [["--out"], "--out"],
    [["--fixture", ""], "Option --fixture needs a value."],
  ])("rejects %j", async (args, message) => {
    const factory = forbiddenFactory();
    const { code, stderr } = await run(args, { dir, generatorFactory: factory });
    expect(code).toBe(1);
    expect(stderr).toContain(message);
    expect(stderr).toContain('Run "pnpm eval --help" for usage.');
    expect(factory.used()).toBe(false);
  });

  it("names the fixtures it knows when asked for one it does not", async () => {
    const { code, stderr } = await run(["--fixture", "nope.docx"], {
      dir,
      generatorFactory: forbiddenFactory(),
    });
    expect(code).toBe(1);
    expect(stderr).toContain(
      "Unknown fixture: nope.docx. Known fixtures: nda-aggressive.docx, nda-balanced.docx, saas-vendor-friendly.docx",
    );
  });

  it("will not take a path to a document that is not a fixture", async () => {
    const { code, stderr } = await run(["--fixture", "/etc/passwd"], {
      dir,
      generatorFactory: forbiddenFactory(),
    });
    expect(code).toBe(1);
    expect(stderr).toContain("Unknown fixture: passwd");
  });

  it("asks for a key, and points to --selftest, before building any model", async () => {
    const factory = forbiddenFactory();
    const { code, stderr } = await run(["--yes"], { dir, env: {}, generatorFactory: factory });
    expect(code).toBe(1);
    expect(stderr).toContain("ANTHROPIC_API_KEY is required");
    expect(stderr).toContain("pnpm eval --selftest");
    expect(factory.used()).toBe(false);
  });
});
