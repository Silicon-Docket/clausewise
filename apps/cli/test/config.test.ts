import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  ModelRequestError,
  createObjectGenerator,
  type AnthropicUsage,
  type LlmConfig,
  type ObjectGenerator,
} from "@clausewise/llm";
import { loadPlaybookFile } from "@clausewise/playbook/node";
import { contextFloor, type ReviewReport } from "@clausewise/review";
import { createOracleGenerator } from "@clausewise/review/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/index.js";
import {
  buildDocx,
  compliantScript,
  expectedScript,
  listing,
  makeIo,
  playbookPath,
  stage,
  tempDirs,
} from "./support.js";

// The real adapters are replaced so that no test can reach a network. Everything else in the
// package, loadLlmConfig included, is the real thing.
vi.mock("@clausewise/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clausewise/llm")>();
  return { ...actual, createObjectGenerator: vi.fn() };
});

const PLAYBOOK = playbookPath("nda-mutual.yaml");
const build = vi.mocked(createObjectGenerator);

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The oracle, slowed down so that calls overlap, with a count of the most that ever did. */
function measured(script = compliantScript()): ObjectGenerator & { readonly peak: number } {
  const inner = createOracleGenerator(script);
  let inFlight = 0;
  let peak = 0;
  return {
    provider: inner.provider,
    model: inner.model,
    disclosure: inner.disclosure,
    get peak() {
      return peak;
    },
    async generate(request) {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await tick(5);
        return await inner.generate(request);
      } finally {
        inFlight -= 1;
      }
    },
  };
}

describe("a model built from the environment", () => {
  const makeDir = tempDirs();
  const ENV = { ANTHROPIC_API_KEY: "sk-test-not-a-real-key" };

  beforeEach(() => {
    build.mockReset();
  });

  async function review(env: Record<string, string>, generator: ObjectGenerator) {
    const dir = await makeDir();
    const input = await stage(dir, "nda-balanced.docx");
    build.mockReturnValue(generator);
    const { io, stderr } = makeIo({ env });

    const code = await run(["review", input, "--playbook", PLAYBOOK], io);

    const report: ReviewReport = JSON.parse(
      await readFile(join(dir, "nda-balanced.report.json"), "utf8"),
    );
    return { code, report, stderr: stderr() };
  }

  it("is made from the configuration the environment describes", async () => {
    const generator = measured();

    const { code } = await review(
      { ...ENV, CLAUSEWISE_MODEL: "my-model", CLAUSEWISE_MAX_RETRIES: "5" },
      generator,
    );

    expect(code).toBe(0);
    expect(build).toHaveBeenCalledTimes(1);
    const config = build.mock.calls[0]?.[0] as LlmConfig;
    expect(config).toMatchObject({
      provider: "anthropic",
      model: "my-model",
      apiKey: "sk-test-not-a-real-key",
      maxRetries: 5,
      concurrency: 4,
    });
  });

  it("announces the destination the generator reports", async () => {
    const generator = measured();

    const { stderr } = await review(ENV, generator);

    expect(stderr).toContain(`Sending the contract text to: ${generator.disclosure}\n`);
  });

  it("runs as many rule checks at once as CLAUSEWISE_CONCURRENCY allows", async () => {
    const one = measured();
    await review({ ...ENV, CLAUSEWISE_CONCURRENCY: "1" }, one);
    const two = measured();
    await review({ ...ENV, CLAUSEWISE_CONCURRENCY: "2" }, two);
    const defaulted = measured();
    await review(ENV, defaulted);

    expect(one.peak).toBe(1);
    expect(two.peak).toBe(2);
    expect(defaulted.peak).toBe(4);
  });

  it("prefers a factory that is passed in over the environment", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-balanced.docx");
    const { io } = makeIo({
      env: ENV,
      generator: createOracleGenerator(compliantScript()),
    });

    expect(await run(["review", input, "--playbook", PLAYBOOK], io)).toBe(0);

    expect(build).not.toHaveBeenCalled();
  });
});

describe("a context limit", () => {
  const makeDir = tempDirs();
  const ENV = { ANTHROPIC_API_KEY: "sk-test-not-a-real-key" };

  beforeEach(() => {
    build.mockReset();
  });

  /** The largest number the review refuses: with a limit above it a call has room for a clause. */
  const floor = async (): Promise<number> => contextFloor(await loadPlaybookFile(PLAYBOOK));

  async function review(file: string | Uint8Array, limit: number, generator: ObjectGenerator) {
    const dir = await makeDir();
    const input = typeof file === "string" ? await stage(dir, file) : join(dir, "long.docx");
    if (typeof file !== "string") await writeFile(input, file);
    build.mockReturnValue(generator);
    const { io, stderr, stdout } = makeIo({
      env: { ...ENV, CLAUSEWISE_MAX_CONTEXT_TOKENS: String(limit) },
    });

    const code = await run(["review", input, "--playbook", PLAYBOOK], io);

    const reportPath = join(dir, `${basename(input, ".docx")}.report.json`);
    const report: ReviewReport | undefined = await readFile(reportPath, "utf8").then(
      (text) => JSON.parse(text),
      () => undefined,
    );
    return { code, report, dir, stderr: stderr(), stdout: stdout() };
  }

  /** Three clauses of about 700 tokens each: one fits in a call at the smallest limit, two do not. */
  const longContract = (): Promise<Uint8Array> => {
    const words = (n: number): string =>
      Array.from({ length: 260 }, (_, i) => `term${n}x${i}`).join(" ");
    return buildDocx([
      `1.1 Confidentiality. ${words(1)}.`,
      `1.2 Use of information. ${words(2)}.`,
      `1.3 Return of materials. ${words(3)}.`,
    ]);
  };

  it("splits a contract that does not fit and says how many parts the report counts", async () => {
    const result = await review(
      "nda-balanced.docx",
      (await floor()) + 1,
      measured(expectedScript("nda-balanced.docx")),
    );

    expect(result.code).toBe(0);
    const windows = result.report?.stats.windows ?? 0;
    expect(windows).toBeGreaterThan(1);
    expect(result.stderr).toMatch(
      new RegExp(
        `^Checking \\d+ clauses against 10 rules, in ${windows} parts of the contract\\.$`,
        "m",
      ),
    );
  });

  it("says nothing about parts when the whole contract fits", async () => {
    const result = await review("nda-balanced.docx", 1_000_000, measured(compliantScript()));

    expect(result.report?.stats.windows).toBe(1);
    expect(result.stderr).toMatch(/^Checking \d+ clauses against 10 rules\.$/m);
    expect(result.stderr).not.toContain("parts");
  });

  it("does not call the parts overlapping when each clause is a part of its own", async () => {
    const result = await review(
      await longContract(),
      (await floor()) + 1,
      measured(compliantScript()),
    );

    // Three clauses in three parts share nothing, so there is no overlap to speak of.
    expect(result.report?.stats.clauses).toBe(3);
    expect(result.report?.stats.windows).toBe(3);
    expect(result.stderr).toContain(
      "Checking 3 clauses against 10 rules, in 3 parts of the contract.",
    );
    expect(result.stderr).not.toContain("overlapping");
  });

  it.each([
    ["is the smallest it refuses", 0],
    ["is below it", -1000],
  ])(
    "refuses a limit that %s, before any model call, naming the number to go above",
    async (_, shift) => {
      const limit = (await floor()) + shift;
      const generator = createOracleGenerator(compliantScript());

      const result = await review("nda-balanced.docx", limit, generator);

      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/^Error: .*CLAUSEWISE_MAX_CONTEXT_TOKENS/m);
      expect(result.stderr).toContain(`${await floor()}`);
      expect(result.stderr).not.toContain("    at ");
      expect(generator.calls).toHaveLength(0);
      expect(result.stdout).toBe("");
      expect(await listing(result.dir)).toEqual(["nda-balanced.docx"]);
    },
  );

  it("accepts the limit one above the smallest it refuses", async () => {
    const result = await review(
      "nda-balanced.docx",
      (await floor()) + 1,
      measured(compliantScript()),
    );

    expect(result.code).toBe(0);
  });
});

describe("the tokens a review used", () => {
  const makeDir = tempDirs();
  const ENV = { ANTHROPIC_API_KEY: "sk-test-not-a-real-key" };
  const LOCAL = {
    CLAUSEWISE_PROVIDER: "openai-compatible",
    CLAUSEWISE_MODEL: "local-model",
    CLAUSEWISE_BASE_URL: "http://localhost:11434/v1",
  };

  beforeEach(() => {
    build.mockReset();
  });

  /** A model that reports what one response used through the hook it was built with. */
  function reporting(
    onUsage: ((usage: AnthropicUsage) => void) | undefined,
    usage: AnthropicUsage,
    options: { failOnCall?: number } = {},
  ): ObjectGenerator {
    const inner = createOracleGenerator(compliantScript());
    let calls = 0;
    return {
      provider: inner.provider,
      model: inner.model,
      disclosure: inner.disclosure,
      async generate(request) {
        calls += 1;
        onUsage?.(usage);
        if (calls === options.failOnCall) throw new ModelRequestError("The key was revoked.", 401);
        return inner.generate(request);
      },
    };
  }

  // Ten calls of these make the line the help and the README talk about.
  const PER_CALL: AnthropicUsage = {
    inputTokens: 313,
    outputTokens: 398,
    cacheReadTokens: 3810,
    cacheWriteTokens: 0,
  };

  async function review(env: Record<string, string>, args: string[] = []) {
    const dir = await makeDir();
    const input = await stage(dir, "nda-balanced.docx");
    const harness = makeIo({ env });
    const code = await run(["review", input, "--playbook", PLAYBOOK, ...args], harness.io);
    return { code, dir, ...harness };
  }

  it("is added up for the anthropic provider and printed last, on stderr", async () => {
    build.mockImplementation((_, overrides) => reporting(overrides?.onUsage, PER_CALL));

    const { code, stderr, stdout } = await review(ENV, ["--fail-on", "low"]);

    expect(code).toBe(0);
    expect(typeof build.mock.calls[0]?.[1]?.onUsage).toBe("function");
    const lines = stderr().trimEnd().split("\n");
    expect(lines.at(-1)).toBe("Tokens: 41,230 input (38,100 from cache), 3,980 output");
    expect(stdout()).not.toContain("Tokens:");
  });

  it("comes after the gate's message, since it is the last thing printed", async () => {
    build.mockImplementation((_, overrides) => {
      const inner = createOracleGenerator(compliantScript({ term: { status: "deviation" } }));
      return {
        provider: inner.provider,
        model: inner.model,
        disclosure: inner.disclosure,
        async generate(request) {
          overrides?.onUsage?.(PER_CALL);
          return inner.generate(request);
        },
      };
    });

    const { code, stderr } = await review(ENV, ["--fail-on", "high"]);

    expect(code).toBe(2);
    expect(stderr().trimEnd().split("\n").at(-2)).toContain("Exiting with code 2");
    expect(stderr().trimEnd().split("\n").at(-1)).toMatch(/^Tokens: /);
  });

  it("names cache writes too, and leaves out a cache that was not used", async () => {
    build.mockImplementation((_, overrides) =>
      reporting(overrides?.onUsage, {
        inputTokens: 1000,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 500,
      }),
    );

    const { stderr } = await review(ENV);

    expect(stderr()).toContain("Tokens: 15,000 input (5,000 written to cache), 100 output\n");
  });

  it("is still printed when the review fails after the model was called", async () => {
    build.mockImplementation((_, overrides) =>
      reporting(overrides?.onUsage, PER_CALL, { failOnCall: 3 }),
    );

    const { code, stderr, dir } = await review(ENV);

    expect(code).toBe(1);
    expect(stderr()).toMatch(/^Error: .*HTTP 401/m);
    expect(stderr()).toMatch(/^Tokens: [\d,]+ input \([\d,]+ from cache\), [\d,]+ output$/m);
    expect(await listing(dir)).toEqual(["nda-balanced.docx"]);
  });

  it("is not printed when the provider reports nothing", async () => {
    build.mockImplementation(() => createOracleGenerator(compliantScript()));

    const { code, stderr } = await review(ENV);

    expect(code).toBe(0);
    expect(stderr()).not.toContain("Tokens:");
  });

  it("is left alone for providers whose adapters report nothing", async () => {
    build.mockImplementation(() => createOracleGenerator(compliantScript()));

    const { code, stderr } = await review(LOCAL);

    expect(code).toBe(0);
    expect(build).toHaveBeenCalledTimes(1);
    expect(build.mock.calls[0]).toHaveLength(1);
    expect(stderr()).not.toContain("Tokens:");
  });
});
