import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedGenerator } from "@clausewise/llm/testing";
import type { LlmConfig } from "@clausewise/llm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, parseEnv, start, type RunningServer } from "../../src/main.js";
import type { ServiceDeps } from "../../src/services/deps.js";
import type { CallRecord } from "../../src/contracts.js";

/**
 * How the server learns the prices it prices its calls with (PAROL_PRICES_FILE), and that it builds
 * a live generator through the one function that meters it. Nothing here calls a provider: the
 * live generator is replaced by a scripted one that remembers the configuration it was asked for.
 */

const seen = vi.hoisted(() => ({
  deps: [] as unknown[],
  llm: [] as unknown[],
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

vi.mock("../../src/usage/live.js", async () => {
  const { createScriptedGenerator: scripted } = await import("@clausewise/llm/testing");
  return {
    createLiveGenerator: (llm: LlmConfig) => {
      seen.llm.push(llm);
      return scripted(async () => ({}), {
        provider: "anthropic",
        model: llm.model,
        disclosure: "a scripted stand-in for the provider",
      });
    },
  };
});

const SECRET = "start-pricing-secret-start-pricing-0001";
const roots: string[] = [];
const running: RunningServer[] = [];

beforeEach(() => {
  seen.deps.length = 0;
  seen.llm.length = 0;
});
afterEach(async () => {
  for (const server of running.splice(0)) await server.close();
});
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "parol-pricing-"));
  roots.push(root);
  return root;
}

const PRICE = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
const priceFile = (body: string): string => {
  const path = join(folder(), "prices.json");
  writeFileSync(path, body);
  return path;
};

function env(dataDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PAROL_DEMO_IDENTITY: "1",
    PAROL_PORT: "0",
    PAROL_DATA_DIR: dataDir,
    PAROL_COOKIE_SECRET: SECRET,
    ...extra,
  };
}

async function boot(extra: Record<string, string>, injected = false) {
  const dataDir = join(folder(), "data");
  const notices: string[] = [];
  const options = {
    log: () => undefined,
    notice: (line: string) => void notices.push(line),
    ...(injected
      ? {
          generator: createScriptedGenerator(async () => ({}), {
            provider: "anthropic",
            model: "model-a",
            disclosure: "a scripted stand-in for the provider",
          }),
        }
      : {}),
  };
  const server = await start(env(dataDir, extra), options);
  running.push(server);
  return { server, dataDir, notices };
}

const call = (over: Partial<CallRecord> = {}): CallRecord => ({
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
  ...over,
});

describe("the setting", () => {
  it("is read as an absolute path, and is null when it is not set", () => {
    expect(parseEnv({}).pricesFile).toBeNull();
    expect(parseEnv({ PAROL_PRICES_FILE: "  " }).pricesFile).toBeNull();
    const parsed = parseEnv({ PAROL_PRICES_FILE: "relative/prices.json" }).pricesFile;
    expect(parsed).toMatch(/^\//);
    expect(parsed).toMatch(/relative\/prices\.json$/);
  });
});

describe("a server with a price file", () => {
  it("prices the calls of a provider that is not a stand-in with the table of the file", async () => {
    const path = priceFile(JSON.stringify({ "model-a": PRICE }));
    await boot({ PAROL_PRICES_FILE: path }, true);
    const pricing = (seen.deps[0] as ServiceDeps).pricing;
    expect(pricing).toBeDefined();
    const [priced] = pricing!.priceCalls([call()], "model-a");
    expect(priced?.costUsdEstimate).toBeCloseTo(2, 10);
    expect(priced?.priceTableSha256).toMatch(/^[0-9a-f]{64}$/);
    // A model the file does not name is not priced.
    expect(pricing!.priceCalls([call()], "model-b")[0]?.costUsdEstimate).toBeNull();
  });

  it("gives the services no pricing when no file is named", async () => {
    await boot({}, true);
    expect((seen.deps[0] as ServiceDeps).pricing).toBeUndefined();
  });

  it("ignores the file for a stand-in reader, and says so", async () => {
    const path = priceFile(JSON.stringify({ "model-a": PRICE }));
    const { notices } = await boot({ PAROL_PRICES_FILE: path, PAROL_SCRIPTED: "1" });
    expect((seen.deps[0] as ServiceDeps).pricing).toBeUndefined();
    expect(notices.some((n) => n.includes("PAROL_PRICES_FILE is ignored"))).toBe(true);
    expect(notices.join("\n")).not.toContain(path);
  });

  it("does not start with a file that cannot be used, and opens nothing", async () => {
    const secret = "SECRET-IN-THE-PRICE-FILE";
    const cases: [string, string][] = [
      ["not json", `{ "model-a": "${secret}`],
      ["a bad entry", JSON.stringify({ "model-a": { input: secret } })],
      ["not an object", JSON.stringify([secret])],
    ];
    for (const [name, body] of cases) {
      const path = priceFile(body);
      const dataDir = join(folder(), "data");
      const promise = start(env(dataDir, { PAROL_PRICES_FILE: path }), {
        generator: createScriptedGenerator(async () => ({}), {
          provider: "anthropic",
          model: "model-a",
          disclosure: "a scripted stand-in for the provider",
        }),
        log: () => undefined,
        notice: () => undefined,
      });
      await expect(promise, name).rejects.toBeInstanceOf(ConfigError);
      const message = await promise.catch((error: Error) => error.message);
      expect(message, name).toContain("PAROL_PRICES_FILE");
      expect(message, name).not.toContain(secret);
      expect(message, name).not.toContain(path);
      // The data folder was not made: the check comes before anything is opened.
      expect(existsSync(dataDir), name).toBe(false);
    }
    const missing = join(folder(), "nothing.json");
    await expect(
      start(env(join(folder(), "data"), { PAROL_PRICES_FILE: missing }), {
        generator: createScriptedGenerator(async () => ({}), {
          provider: "anthropic",
          model: "model-a",
          disclosure: "a scripted stand-in for the provider",
        }),
        log: () => undefined,
        notice: () => undefined,
      }),
    ).rejects.toThrow(/PAROL_PRICES_FILE names a file that cannot be read/);
  });
});

describe("the generator of a server that is not a stand-in", () => {
  it("is built by createLiveGenerator, from the configuration of the environment", async () => {
    await boot({
      CLAUSEWISE_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "test-key-not-real",
      CLAUSEWISE_MODEL: "model-a",
    });
    expect(seen.llm).toHaveLength(1);
    expect(seen.llm[0]).toMatchObject({ provider: "anthropic", model: "model-a" });
  });

  it("is not built at all for a stand-in reader", async () => {
    await boot({ PAROL_SCRIPTED: "1" });
    expect(seen.llm).toEqual([]);
  });
});
