import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createObjectGenerator, type LlmConfig, type ObjectGenerator } from "@clausewise/llm";
import type { ReviewReport } from "@clausewise/review";
import { createOracleGenerator } from "@clausewise/review/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/index.js";
import {
  compliantScript,
  expectedScript,
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

  it("splits the contract into parts when CLAUSEWISE_MAX_CONTEXT_TOKENS is small", async () => {
    const whole = await review(ENV, measured(expectedScript("nda-balanced.docx")));
    const parts = await review(
      { ...ENV, CLAUSEWISE_MAX_CONTEXT_TOKENS: "1" },
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
