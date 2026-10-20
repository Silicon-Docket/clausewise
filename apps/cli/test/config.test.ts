import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ModelRequestError,
  createObjectGenerator,
  type AnthropicUsage,
  type LlmConfig,
  type ObjectGenerator,
} from "@clausewise/llm";
import type { ReviewReport } from "@clausewise/review";
import { createOracleGenerator } from "@clausewise/review/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/index.js";
import {
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

  // The review refuses a limit with no room for a clause and says how much it needs, so the
  // smallest limit that splits this contract is read from that refusal.
  async function smallestWorkableLimit(): Promise<number> {
    const dir = await makeDir();
    const input = await stage(dir, "nda-balanced.docx");
    build.mockReturnValue(measured());
    const { io, stderr } = makeIo({ env: { ...ENV, CLAUSEWISE_MAX_CONTEXT_TOKENS: "1" } });

    expect(await run(["review", input, "--playbook", PLAYBOOK], io)).toBe(1);

    const floor = /must be above (\d+)/.exec(stderr())?.[1];
    expect(floor).toBeDefined();
    return Number(floor) + 1;
  }

  it("splits the contract into parts when CLAUSEWISE_MAX_CONTEXT_TOKENS is small", async () => {
    const whole = await review(ENV, measured(expectedScript("nda-balanced.docx")));
    const parts = await review(
      { ...ENV, CLAUSEWISE_MAX_CONTEXT_TOKENS: String(await smallestWorkableLimit()) },
      measured(expectedScript("nda-balanced.docx")),
    );

    expect(whole.report.stats.windows).toBe(1);
    expect(whole.stderr).not.toContain("overlapping parts");
    expect(parts.report.stats.windows).toBeGreaterThan(1);
    expect(parts.stderr).toMatch(/Checking \d+ clauses against 10 rules, in \d+ overlapping parts/);
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
    expect(stderr()).toContain("Error: The model provider answered HTTP 401");
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
