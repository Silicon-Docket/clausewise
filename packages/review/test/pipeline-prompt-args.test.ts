import { beforeAll, describe, expect, it, vi } from "vitest";
import { reviewContract } from "../src/pipeline.js";
import { createOracleGenerator } from "../src/testing.js";
import type { Clause } from "../src/types.js";
import {
  aggressiveScript,
  budgetFor,
  clausesOf,
  expectedWindows,
  fixture,
  loadPlaybook,
  padded,
} from "./pipeline-support.js";

type BuildArgs = Parameters<typeof import("../src/prompt.js").buildRulePrompt>[0];

// Records what the pipeline asks the prompt builder for, so what it passes on is checked without
// depending on how the prompt words it.
const asked = vi.hoisted(() => ({ calls: [] as BuildArgs[] }));

vi.mock("../src/prompt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/prompt.js")>();
  return {
    ...actual,
    buildRulePrompt: (args: BuildArgs) => {
      asked.calls.push(args);
      return actual.buildRulePrompt(args);
    },
  };
});

const playbook = loadPlaybook();
const CLIENT = "Fabrikam Labs LLC, the Recipient";

let input: Uint8Array;
let clauses: Clause[];

beforeAll(async () => {
  input = await padded(fixture("nda-aggressive.docx"));
  clauses = await clausesOf(input);
});

/** The calls that build a prompt for the model, not the ones that only measure the overhead. */
const built = (): BuildArgs[] => asked.calls.filter((args) => args.clauses.length > 0);

async function run(options: Parameters<typeof reviewContract>[2]) {
  asked.calls.length = 0;
  const oracle = createOracleGenerator(aggressiveScript());
  const { report } = await reviewContract({ docx: input, playbook }, oracle, options);
  return { report, oracle };
}

describe("the client", () => {
  it("goes to the prompt builder for every call", async () => {
    await run({ client: CLIENT });
    expect(built()).toHaveLength(playbook.rules.length);
    expect(asked.calls.every((args) => args.client === CLIENT)).toBe(true);
  });

  it("is left out when it was not given, or is blank", async () => {
    for (const client of [undefined, "", "   \n"]) {
      await run(client === undefined ? {} : { client });
      expect(asked.calls.some((args) => "client" in args)).toBe(false);
    }
  });

  it("is trimmed", async () => {
    await run({ client: `  ${CLIENT}\n` });
    expect(asked.calls.every((args) => args.client === CLIENT)).toBe(true);
  });
});

describe("the window", () => {
  it("is left out when the contract goes in one piece", async () => {
    await run({});
    expect(built().some((args) => "window" in args)).toBe(false);
  });

  it("tells every call which part of the contract it holds, and how many there are", async () => {
    const maxContextTokens = budgetFor(playbook, clauses, 3, CLIENT);
    const windows = expectedWindows(playbook, clauses, maxContextTokens, CLIENT);
    expect(windows.length).toBeGreaterThan(2);
    const { report } = await run({ client: CLIENT, maxContextTokens });

    expect(report.stats.windows).toBe(windows.length);
    const real = built();
    expect(real).toHaveLength(playbook.rules.length * windows.length);
    windows.forEach((window, index) => {
      const forWindow = real.filter((args) => args.window?.index === index);
      expect(forWindow).toHaveLength(playbook.rules.length);
      for (const args of forWindow) {
        expect(args.window).toEqual({ index, total: windows.length });
        expect(args.clauses.map((c) => c.id)).toEqual(window.map((c) => c.id));
        expect(args.client).toBe(CLIENT);
      }
      expect(new Set(forWindow.map((args) => args.rule.id))).toEqual(
        new Set(playbook.rules.map((rule) => rule.id)),
      );
    });
  });
});
