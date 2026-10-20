import { writeFile } from "node:fs/promises";
import { loadPlaybookFile } from "@clausewise/playbook/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boundTokens, buildPlan } from "../src/plan.js";
import { buildDocx, doc, text } from "./raw-docx.js";
import { ROOT, forbiddenFactory, makeTempDir, removeDir, run } from "./support.js";

let dir = "";
beforeAll(async () => {
  dir = await makeTempDir();
});
afterAll(async () => {
  await removeDir(dir);
});

const KEY = "sk-test-not-a-real-key";
// Characters that take three bytes each in UTF-8, written as code points to keep this file ASCII.
const CHINESE = [
  0x63a5, 0x6536, 0x65b9, 0x5e94, 0x5f53, 0x5bf9, 0x4fdd, 0x5bc6, 0x4fe1, 0x606f, 0x4e25, 0x683c,
  0x4fdd, 0x5bc6,
];

describe("a model name that may be a key", () => {
  it("is not repeated in the error about the price table", async () => {
    const secret = "sk-ant-api03-ThisIsAMistypedSecretKey0123456789";
    const { code, stderr } = await run(["--yes"], {
      dir,
      env: { ANTHROPIC_API_KEY: KEY, CLAUSEWISE_MODEL: secret },
      generatorFactory: forbiddenFactory(),
    });
    expect(code).toBe(1);
    expect(stderr).toContain("is not in the price table");
    expect(stderr).not.toContain(secret);
  });

  it("is not repeated when it holds terminal control codes", async () => {
    const { stderr } = await run(["--yes"], {
      dir,
      env: { ANTHROPIC_API_KEY: KEY, CLAUSEWISE_MODEL: "claude-sonnet-5-5\u001b[2J" },
      generatorFactory: forbiddenFactory(),
    });
    expect(stderr).not.toContain("\u001b");
  });
});

describe("a price of zero", () => {
  it("is refused for a hosted provider, because it would switch off the guard", async () => {
    const path = `${dir}/zero.json`;
    await writeFile(
      path,
      JSON.stringify({ "claude-sonnet-5-5": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    );
    const factory = forbiddenFactory();
    const { code, stderr } = await run(["--yes", "--prices", path], {
      dir,
      env: { ANTHROPIC_API_KEY: KEY },
      generatorFactory: factory,
    });
    expect(code).toBe(1);
    expect(stderr).toContain("would switch off the spend guard");
    expect(factory.used()).toBe(false);
  });

  it("is fine for a server on this machine", async () => {
    const path = `${dir}/local.json`;
    await writeFile(
      path,
      JSON.stringify({ "llama-local": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    );
    const { code, stderr } = await run(["--prices", path], {
      dir,
      env: {
        CLAUSEWISE_PROVIDER: "openai-compatible",
        CLAUSEWISE_MODEL: "llama-local",
        CLAUSEWISE_BASE_URL: "http://localhost:11434/v1",
      },
      generatorFactory: forbiddenFactory(),
    });
    expect(code).toBe(3);
    expect(stderr).toContain("Cost upper bound: $0.0000");
  });
});

describe("fallback to another model", () => {
  it("is refused with --yes, because the price of the other model is not in the table", async () => {
    const factory = forbiddenFactory();
    const { code, stderr } = await run(["--yes", "--fixture", "nda-balanced.docx"], {
      dir,
      env: { ANTHROPIC_API_KEY: KEY, CLAUSEWISE_FALLBACK: "default" },
      generatorFactory: factory,
    });
    expect(code).toBe(3);
    expect(stderr).toContain("Refusing to run: CLAUSEWISE_FALLBACK is on");
    expect(factory.used()).toBe(false);
  });
});

describe("the input bound for text that needs several bytes per character", () => {
  it("takes the byte count into account", async () => {
    const chinese = String.fromCodePoint(...CHINESE);
    const sample = chinese.repeat(30);
    expect(boundTokens(sample)).toBe(Math.ceil(Buffer.byteLength(sample) / 3));
    expect(boundTokens(sample)).toBeGreaterThanOrEqual(sample.length);
    expect(boundTokens("plain English text".repeat(10))).toBe(Math.ceil(180 / 3));
  });

  it("makes a Chinese contract cost at least a token a character in the plan", async () => {
    const playbook = await loadPlaybookFile(`${ROOT}playbooks/nda-mutual.yaml`);
    const chinese = String.fromCodePoint(...CHINESE);
    const body = Array.from({ length: 30 }, (_, i) => text(`${i + 1}.1 ${chinese.repeat(5)}`)).join(
      "",
    );
    const docx = await buildDocx(doc(body));
    const plan = await buildPlan(
      [{ name: "zh.docx", playbookPath: "p", playbook, docx, expected: {} }],
      {
        runs: 1,
        assumedOutputTokens: 1500,
        limits: { concurrency: 4, maxContextTokens: undefined },
      },
    );
    const characters = chinese.length * 5 * 30;
    expect(plan.fixtures[0]?.inputTokensPerRun).toBeGreaterThan(characters * plan.calls);
  });
});
