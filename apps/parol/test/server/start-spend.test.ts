import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedGenerator } from "@clausewise/llm/testing";
import type { LlmConfig, ObjectGenerator } from "@clausewise/llm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, parseEnv, start, type RunningServer } from "../../src/main.js";
import type { ServiceDeps } from "../../src/services/deps.js";
import { anthropicConfig } from "../usage/support.js";

/**
 * What a server that calls a model needs before it starts: limits for what a review and a day may
 * cost, a price file, a price for its model, a provider whose usage can be counted (or the choice
 * not to count it), and no fallback model. Each missing piece stops the start before anything is
 * opened, with a message that names the variable and the fix and never prints a value. A stand-in
 * reader needs none of it. Nothing here calls a provider: the live generator is replaced by a
 * scripted one that remembers how it was asked for, and the prices and limits are invented.
 */

const seen = vi.hoisted(() => ({
  deps: [] as unknown[],
  llm: [] as unknown[],
  guards: [] as unknown[],
}));

vi.mock("../../src/services/index.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/services/index.js")>();
  return {
    ...real,
    createServices: (deps: ServiceDeps) => {
      seen.deps.push(deps);
      return real.createServices(deps);
    },
  };
});

vi.mock("../../src/usage/live.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/usage/live.js")>();
  const { createScriptedGenerator: scripted } = await import("@clausewise/llm/testing");
  return {
    ...real,
    createLiveGenerator: (llm: LlmConfig, options: { guard?: unknown } = {}) => {
      seen.llm.push(llm);
      seen.guards.push(options.guard);
      return scripted(async () => ({}), {
        provider: llm.provider,
        model: llm.model,
        disclosure: "a scripted stand-in for the provider",
      });
    },
  };
});

const SECRET = "start-spend-secret-start-spend-0000001";
const roots: string[] = [];
const running: RunningServer[] = [];

beforeEach(() => {
  seen.deps.length = 0;
  seen.llm.length = 0;
  seen.guards.length = 0;
});
afterEach(async () => {
  for (const server of running.splice(0)) await server.close();
});
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "parol-spend-"));
  roots.push(root);
  return root;
}

// Invented rates, USD per million tokens.
const PRICE = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
const priceFile = (body: unknown = { "model-a": PRICE }): string => {
  const path = join(folder(), "prices.json");
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
};

const LIMITS = { PAROL_MAX_REVIEW_COST_USD: "2", PAROL_MAX_DAILY_COST_USD: "10" };
const base = (dataDir: string): Record<string, string> => ({
  PAROL_DEMO_IDENTITY: "1",
  PAROL_PORT: "0",
  PAROL_DATA_DIR: dataDir,
  PAROL_COOKIE_SECRET: SECRET,
});
/** The environment of a live server whose generator is built from it. */
const LIVE_ENV = {
  CLAUSEWISE_PROVIDER: "anthropic",
  ANTHROPIC_API_KEY: "test-key-not-real",
  CLAUSEWISE_MODEL: "model-a",
};

const scriptedLive = (config: LlmConfig): ObjectGenerator =>
  createScriptedGenerator(async () => ({}), {
    provider: config.provider,
    model: config.model,
    disclosure: "a scripted stand-in for the provider",
  });

interface Boot {
  env?: Record<string, string>;
  config?: LlmConfig | null;
  generator?: ObjectGenerator | null;
}

/** A start with an injected generator that is not a stand-in (unless `generator: null`). */
async function boot(over: Boot = {}) {
  const dataDir = join(folder(), "data");
  const notices: string[] = [];
  const config = over.config === undefined ? anthropicConfig() : over.config;
  const generator =
    over.generator === undefined ? scriptedLive(config ?? anthropicConfig()) : over.generator;
  const options = {
    log: () => undefined,
    notice: (line: string) => void notices.push(line),
    ...(generator === null ? {} : { generator }),
    ...(config === null ? {} : { llmConfig: config }),
  };
  const server = await start({ ...base(dataDir), ...over.env }, options);
  running.push(server);
  return { server, dataDir, notices };
}

/** The refusal of a start: the message, and whether the data folder was made. */
async function refused(over: Boot) {
  const dataDir = join(folder(), "data");
  const config = over.config === undefined ? anthropicConfig() : over.config;
  const generator =
    over.generator === undefined ? scriptedLive(config ?? anthropicConfig()) : over.generator;
  const promise = start(
    { ...base(dataDir), ...over.env },
    {
      log: () => undefined,
      notice: () => undefined,
      ...(generator === null ? {} : { generator }),
      ...(config === null ? {} : { llmConfig: config }),
    },
  );
  await expect(promise).rejects.toBeInstanceOf(ConfigError);
  const message = await promise.catch((error: Error) => error.message);
  return { message, opened: existsSync(dataDir) };
}

describe("the settings", () => {
  it("read the price file as an absolute path, and the limits as dollars", () => {
    expect(parseEnv({}).pricesFile).toBeNull();
    expect(parseEnv({ PAROL_PRICES_FILE: "  " }).pricesFile).toBeNull();
    expect(parseEnv({ PAROL_PRICES_FILE: "relative/prices.json" }).pricesFile).toMatch(
      /^\/.*relative\/prices\.json$/,
    );
    expect(parseEnv({}).maxReviewCostUsd).toBeNull();
    expect(parseEnv({}).maxDailyCostUsd).toBeNull();
    expect(parseEnv(LIMITS)).toMatchObject({ maxReviewCostUsd: 2, maxDailyCostUsd: 10 });
    expect(
      parseEnv({ PAROL_MAX_REVIEW_COST_USD: "0.50", PAROL_MAX_DAILY_COST_USD: "100000" }),
    ).toMatchObject({ maxReviewCostUsd: 0.5, maxDailyCostUsd: 100_000 });
  });

  it("have no default limit, and 1500 output tokens assumed for each call unless it is said", () => {
    const settings = parseEnv({});
    expect(settings.assumedOutputTokens).toBe(1500);
    expect(settings.spendBoundOnly).toBe(false);
    expect(settings.spendVariables).toEqual([]);
    expect(parseEnv({ PAROL_ASSUMED_OUTPUT_TOKENS: "4000" }).assumedOutputTokens).toBe(4000);
    expect(parseEnv({ PAROL_SPEND_BOUND_ONLY: "1" }).spendBoundOnly).toBe(true);
    expect(parseEnv({ ...LIMITS, PAROL_PRICES_FILE: "p.json" }).spendVariables).toEqual([
      "PAROL_MAX_REVIEW_COST_USD",
      "PAROL_MAX_DAILY_COST_USD",
      "PAROL_PRICES_FILE",
    ]);
  });

  it("refuse an amount that is not a positive number of dollars, with a message that is the same for every value", () => {
    for (const name of ["PAROL_MAX_REVIEW_COST_USD", "PAROL_MAX_DAILY_COST_USD"]) {
      const messages = new Set<string>();
      for (const value of [
        "0",
        "-1",
        "1e3",
        "two",
        "2.1234567",
        "100000.5",
        "100001",
        "7331-SECRET",
        "$2",
        "2,5",
      ]) {
        let message = "";
        try {
          parseEnv({ [name]: value });
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message, `${name}=${value}`).toContain(name);
        messages.add(message);
      }
      // One fixed sentence, whatever was typed: no value can have been copied into it.
      expect([...messages]).toEqual([
        `${name} must be a positive amount in US dollars, such as 2 or 0.50, and at most 100000. Fix the value, or unset it.`,
      ]);
    }
  });

  it("refuse a limit for a day that is below the limit for one review", () => {
    expect(() =>
      parseEnv({ PAROL_MAX_REVIEW_COST_USD: "5", PAROL_MAX_DAILY_COST_USD: "4" }),
    ).toThrow(/PAROL_MAX_DAILY_COST_USD must be at least PAROL_MAX_REVIEW_COST_USD/);
    // Equal is allowed, and so is one limit alone (the server decides whether it needs both).
    expect(() =>
      parseEnv({ PAROL_MAX_REVIEW_COST_USD: "5", PAROL_MAX_DAILY_COST_USD: "5" }),
    ).not.toThrow();
    expect(() => parseEnv({ PAROL_MAX_DAILY_COST_USD: "1" })).not.toThrow();
  });

  it("refuse an assumed output that is not a whole number from 1 to 200000, and a flag that is not 1 or 0", () => {
    for (const value of ["0", "1.5", "200001", "many", "-3"])
      expect(() => parseEnv({ PAROL_ASSUMED_OUTPUT_TOKENS: value }), value).toThrow(ConfigError);
    expect(() => parseEnv({ PAROL_SPEND_BOUND_ONLY: "maybe" })).toThrow(ConfigError);
  });
});

describe("a server that calls a model", () => {
  const path = priceFile();
  const good = { ...LIMITS, PAROL_PRICES_FILE: path };

  it("starts with the limits, a price file and a price for its model, and hands the services a guard", async () => {
    const { server } = await boot({ env: good });
    expect(server.spend).toBeDefined();
    expect(server.spend).toMatchObject({
      provider: "anthropic",
      model: "model-a",
      reportsUsage: true,
      limits: { perReviewUsd: 2, perDayUsd: 10, assumedOutputTokens: 1500 },
    });
    expect((seen.deps[0] as ServiceDeps).spend).toBe(server.spend);
    // The guard prices the calls with the table of the file, and not another model's.
    const [priced] = server.spend!.priceCalls(
      [
        {
          stage: "analyze",
          ruleKey: null,
          promptVersionId: "analyze.p1",
          requestSha256: "a".repeat(64),
          attempt: 1,
          outcome: "ok",
          latencyMs: 1,
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
      "model-a",
    );
    expect(priced?.costUsdEstimate).toBeCloseTo(2, 10);
    expect(priced?.priceTableSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("builds the generator of the environment through createLiveGenerator, with the guard in its hooks, after the database is open", async () => {
    const { server, notices } = await boot({
      env: { ...good, ...LIVE_ENV },
      generator: null,
      config: null,
    });
    expect(seen.llm).toHaveLength(1);
    expect(seen.llm[0]).toMatchObject({ provider: "anthropic", model: "model-a" });
    expect(seen.guards[0]).toBe(server.spend);
    expect(seen.guards[0]).toBeDefined();
    // It says where the text goes, as it always has, before it listens.
    const lines = notices.join("\n");
    expect(lines).toContain("Document text is sent to: a scripted stand-in for the provider");
    expect(lines.indexOf("Document text is sent to")).toBeLessThan(lines.indexOf("listening"));
  });

  it("keeps its limits and its ledger in the database it opened", async () => {
    const { server } = await boot({ env: good });
    expect(server.repo.spendToday()).toEqual({ costUsd: 0, responses: 0, unpricedResponses: 0 });
  });

  it("does not start without a limit, without either of the two, and says which is missing", async () => {
    const neither = await refused({ env: { PAROL_PRICES_FILE: path } });
    expect(neither.message).toContain(
      "PAROL_MAX_REVIEW_COST_USD and PAROL_MAX_DAILY_COST_USD are not set",
    );
    expect(neither.message).toContain("no default limits");
    const one = await refused({ env: { PAROL_MAX_DAILY_COST_USD: "10", PAROL_PRICES_FILE: path } });
    expect(one.message).toContain("PAROL_MAX_REVIEW_COST_USD is not set");
    expect(one.message).not.toContain("PAROL_MAX_DAILY_COST_USD is not set");
    const other = await refused({
      env: { PAROL_MAX_REVIEW_COST_USD: "2", PAROL_PRICES_FILE: path },
    });
    expect(other.message).toContain("PAROL_MAX_DAILY_COST_USD is not set");
    // Nothing was opened: the data folder was not made.
    for (const r of [neither, one, other]) expect(r.opened).toBe(false);
  });

  it("does not start without a price file", async () => {
    const r = await refused({ env: LIMITS });
    expect(r.message).toContain("PAROL_PRICES_FILE is not set");
    expect(r.message).toContain("never guesses");
    expect(r.opened).toBe(false);
  });

  it("does not start with a price file that cannot be used, and prints nothing from it", async () => {
    const secret = "SECRET-IN-THE-PRICE-FILE";
    const cases: [string, string][] = [
      ["not json", `{ "model-a": "${secret}`],
      ["a bad entry", JSON.stringify({ "model-a": { input: secret } })],
      ["an entry with a field too many", JSON.stringify({ "model-a": { ...PRICE, extra: 1 } })],
      ["not an object", JSON.stringify([secret])],
    ];
    for (const [name, body] of cases) {
      const file = priceFile(body);
      const r = await refused({ env: { ...LIMITS, PAROL_PRICES_FILE: file } });
      expect(r.message, name).toContain("PAROL_PRICES_FILE");
      expect(r.message, name).not.toContain(secret);
      expect(r.message, name).not.toContain(file);
      expect(r.opened, name).toBe(false);
    }
    const missing = join(folder(), "nothing.json");
    const r = await refused({ env: { ...LIMITS, PAROL_PRICES_FILE: missing } });
    expect(r.message).toMatch(/names a file that cannot be read/);
    expect(r.message).not.toContain(missing);
  });

  it("does not start when the file has no price for its model, and lists the models it has", async () => {
    const file = priceFile({ "model-b": PRICE, "model-c": PRICE, _note: "ignored" });
    const r = await refused({ env: { ...LIMITS, PAROL_PRICES_FILE: file } });
    expect(r.message).toContain("no price for the configured model");
    expect(r.message).toContain("never guesses a price");
    expect(r.message).toContain("model-b, model-c");
    expect(r.message).not.toContain("model-a-");
    expect(r.opened).toBe(false);
    // A near match is not a match.
    const near = priceFile({ "model-a-20260101": PRICE });
    expect((await refused({ env: { ...LIMITS, PAROL_PRICES_FILE: near } })).message).toContain(
      "no price for the configured model",
    );
  });

  it("does not start when a hosted provider is priced at nothing", async () => {
    const free = priceFile({ "model-a": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    const r = await refused({ env: { ...LIMITS, PAROL_PRICES_FILE: free } });
    expect(r.message).toContain("input and an output rate of 0");
    expect(r.message).toContain("switch off the spend guard");
    expect(r.opened).toBe(false);
    // A rate of 0 for one of the two is a price.
    const cheap = priceFile({ "model-a": { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 } });
    await boot({ env: { ...LIMITS, PAROL_PRICES_FILE: cheap } });
  });

  it("does not start with a fallback model, whose price the file cannot hold", async () => {
    const r = await refused({ env: good, config: anthropicConfig({ fallback: "default" }) });
    expect(r.message).toContain("CLAUSEWISE_FALLBACK is on");
    expect(r.message).toContain("Unset CLAUSEWISE_FALLBACK");
    expect(r.opened).toBe(false);
  });

  it("does not start when the limit for a day is below the limit for one review", async () => {
    const r = await refused({
      env: {
        PAROL_MAX_REVIEW_COST_USD: "5",
        PAROL_MAX_DAILY_COST_USD: "4",
        PAROL_PRICES_FILE: path,
      },
    });
    expect(r.message).toContain(
      "PAROL_MAX_DAILY_COST_USD must be at least PAROL_MAX_REVIEW_COST_USD",
    );
    expect(r.opened).toBe(false);
  });

  it("does not start with a generator that comes without its configuration, or with another's", async () => {
    const none = await refused({ env: good, config: null });
    expect(none.message).toContain("llmConfig");
    expect(none.opened).toBe(false);
    const another = await refused({
      env: good,
      generator: scriptedLive(anthropicConfig({ model: "model-b" })),
    });
    expect(another.message).toContain("different provider or model");
    expect(another.opened).toBe(false);
  });

  it("stops for a missing key before it looks at the limits, and before anything is opened", async () => {
    const dataDir = join(folder(), "data");
    await expect(
      start(
        { ...base(dataDir), CLAUSEWISE_PROVIDER: "anthropic" },
        { log: () => undefined, notice: () => undefined },
      ),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(existsSync(dataDir)).toBe(false);
    expect(seen.llm).toEqual([]);
  });

  it("stops for missing limits when the key is there, before anything is opened and before a generator is built", async () => {
    const dataDir = join(folder(), "data");
    await expect(
      start({ ...base(dataDir), ...LIVE_ENV }, { log: () => undefined, notice: () => undefined }),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(existsSync(dataDir)).toBe(false);
    expect(seen.llm).toEqual([]);
  });
});

describe("a provider that reports no usage", () => {
  const path = priceFile({ "model-b": PRICE });
  const openai = anthropicConfig({
    provider: "openai",
    model: "model-b",
    apiKey: "test-key-not-real",
  });

  it("is refused, and the message says why and what to do", async () => {
    const r = await refused({
      env: { ...LIMITS, PAROL_PRICES_FILE: path },
      config: openai,
    });
    expect(r.message).toContain("records usage only for the anthropic provider");
    expect(r.message).toContain("PAROL_SPEND_BOUND_ONLY=1");
    expect(r.opened).toBe(false);
  });

  it("starts when the operator has chosen to check only the bound, and the guard says it counts no usage", async () => {
    const { server } = await boot({
      env: { ...LIMITS, PAROL_PRICES_FILE: path, PAROL_SPEND_BOUND_ONLY: "1" },
      config: openai,
    });
    expect(server.spend).toMatchObject({
      provider: "openai",
      model: "model-b",
      reportsUsage: false,
    });
  });
});

describe("a stand-in reader", () => {
  it("needs no limit, no price file and no price, and has no guard", async () => {
    const { server, notices } = await boot({
      env: { PAROL_SCRIPTED: "1" },
      generator: null,
      config: null,
    });
    expect(server.spend).toBeUndefined();
    expect((seen.deps[0] as ServiceDeps).spend).toBeUndefined();
    expect(seen.llm).toEqual([]);
    expect(notices.join("\n")).not.toContain("ignored");
  });

  it("ignores the spend variables, says so in one line, and does not read the price file", async () => {
    const missing = join(folder(), "nothing.json");
    const { server, notices } = await boot({
      env: {
        PAROL_SCRIPTED: "1",
        ...LIMITS,
        PAROL_PRICES_FILE: missing,
        PAROL_SPEND_BOUND_ONLY: "1",
      },
      generator: null,
      config: null,
    });
    expect(server.spend).toBeUndefined();
    const line = notices.filter((n) => n.includes("ignored"));
    expect(line).toEqual([
      "notice: PAROL_MAX_REVIEW_COST_USD, PAROL_MAX_DAILY_COST_USD, PAROL_PRICES_FILE, PAROL_SPEND_BOUND_ONLY are ignored, because the reader is a stand-in and calls no model",
    ]);
    expect(notices.join("\n")).not.toContain(missing);
  });

  it("says is for a single variable", async () => {
    const { notices } = await boot({
      env: { PAROL_SCRIPTED: "1", PAROL_PRICES_FILE: priceFile() },
      generator: null,
      config: null,
    });
    expect(notices).toContain(
      "notice: PAROL_PRICES_FILE is ignored, because the reader is a stand-in and calls no model",
    );
  });

  it("is a stand-in when the injected generator names a provider of that kind, config or not", async () => {
    for (const provider of ["scripted", "simulated"]) {
      const generator = createScriptedGenerator(async () => ({}), {
        provider,
        model: "stand-in",
        disclosure: "a stand-in",
      });
      const { server } = await boot({ env: LIMITS, generator, config: null });
      expect(server.spend).toBeUndefined();
      await server.close();
      running.pop();
    }
  });

  it("is not metered: the generator of a stand-in is the one it was given", async () => {
    await boot({ env: { PAROL_SCRIPTED: "1" }, generator: null, config: null });
    expect(seen.guards).toEqual([]);
  });
});
