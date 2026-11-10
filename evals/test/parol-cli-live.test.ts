import { readdir, readFile, writeFile } from "node:fs/promises";
import { ModelRequestError } from "@clausewise/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { costOf } from "../src/prices.js";
import { loadDataset, selectCases } from "../src/parol/dataset.js";
import { prepareCase, runnableCases } from "../src/parol/runner.js";
import {
  REPO_ROOT,
  committedRunShape,
  containsDocumentText,
  documentWindows,
  makeTempDir,
  oracleFactory,
  readResults,
  removeDir,
  run,
} from "../src/parol/testing-run.js";
import { loadPlaybook } from "../../apps/parol/src/playbooks/load.js";
import { workflowFor } from "../../apps/parol/src/prompts/workflows.js";
import { readFileSync } from "node:fs";

/**
 * The live path of the runner against scripted stand-ins that report usage the way the Anthropic
 * adapter does. The live paths were never run against a real model: there was no key. These tests
 * are what stands in for that, and the report of the work says so.
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
const PRICE = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };

/** The usage each call reports in these tests. FABRICATED FOR A TEST: no model produced it. */
const EACH = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 0 };

describe("a live run with a scripted model that reports usage", () => {
  it("adds up the usage, prices it with the table, and summarises latency and cost per run", async () => {
    const resultsDir = fresh();
    const stand = oracleFactory({ usage: () => EACH });
    let t = 0;
    const { code, stdout, stderr } = await run(["--yes", "--case", "PAROL-D01"], {
      resultsDir,
      generatorFactory: stand.factory,
      // Every reading of the clock advances it by 5 ms.
      clock: () => (t += 5),
    });
    expect(code, stderr).toBe(0);
    const [name] = await readdir(resultsDir);
    const results = await readResults(`${resultsDir}/${name}`);

    // Nine calls (one extract, eight rules), each reporting the same usage.
    expect(stand.calls()).toBe(9);
    expect(results.usage).toEqual({
      available: true,
      note: null,
      calls: 9,
      total: {
        responses: 9,
        inputTokens: 9000,
        outputTokens: 1800,
        cacheReadTokens: 27000,
        cacheWriteTokens: 0,
      },
      // (9,000 x 2 + 1,800 x 10 + 27,000 x 0.2) / 1,000,000 = 0.018 + 0.018 + 0.0054
      costUsd: expect.closeTo(0.0414, 12),
    });
    expect(
      costOf(
        { inputTokens: 9000, outputTokens: 1800, cacheReadTokens: 27000, cacheWriteTokens: 0 },
        PRICE,
      ),
    ).toBeCloseTo(0.0414, 12);
    expect(results.runs).toHaveLength(1);
    expect(results.runs[0]).toMatchObject({
      split: "dev",
      caseKey: "PAROL-D01",
      twinOf: null,
      repeat: 1,
      outcome: "succeeded",
      modelCalls: 9,
      callOutcomes: { ok: 9 },
      rulesOverBudget: 0,
      extractDegraded: false,
      usage: { responses: 9, inputTokens: 9000 },
    });
    expect(results.runs[0]!.costUsd).toBeCloseTo(0.0414, 12);

    // The clock was read once before the run, then six times inside it: started, the mark, four
    // stages and the total make seven. Each reading is 5 ms later than the one before.
    expect(results.runs[0]!.totalMs).toBe(30);
    expect(results.runs[0]!.stagesMs).toEqual({ extract: 5, retrieve: 5, analyze: 5, verify: 5 });
    const section = results.sections[0]!;
    expect(section.latency).toMatchObject({
      completed: 1,
      failed: [],
      total: { n: 1, min: 30, mean: 30, p50: 30, p95: 30, max: 30 },
    });
    expect(section.cost).toEqual({
      runs: 1,
      failedRuns: 0,
      totalUsd: expect.closeTo(0.0414, 12),
      meanUsd: expect.closeTo(0.0414, 12),
      maxUsd: expect.closeTo(0.0414, 12),
      promptTokens: 36000,
      cacheReadTokens: 27000,
      cacheReadShare: 0.75,
    });
    expect(stdout).toContain(
      "Run latency over 1 completed runs: p50 0.03 s, p95 0.03 s, max 0.03 s. 0 failed.",
    );
    expect(stdout).toContain("Prompt tokens read from the cache: 75.0 percent of 36,000.");
    // G13 has no baseline and no budget on a single run, so it stays not evaluated and says why.
    const g13 = section.gates!.results.find((r) => r.id === "G13")!;
    expect(g13.outcome).toBe("not_evaluated");
    expect(stderr).toContain(
      "Spent: 9000 input, 1800 output, 27000 cache read and 0 cache write tokens over 9 calls, which is $0.0414.",
    );
  });

  it("says usage is unavailable for a provider that does not report it, and records no cost", async () => {
    const resultsDir = fresh();
    const prices = `${dir}/local-prices.json`;
    await writeFile(
      prices,
      JSON.stringify({ "local-model": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    );
    const stand = oracleFactory({});
    const { code, stdout, stderr } = await run(
      ["--yes", "--case", "PAROL-D01", "--prices", prices],
      {
        resultsDir,
        env: {
          CLAUSEWISE_PROVIDER: "openai-compatible",
          CLAUSEWISE_MODEL: "local-model",
          CLAUSEWISE_BASE_URL: "http://127.0.0.1:9/v1",
        },
        generatorFactory: stand.factory,
      },
    );
    expect(code, stderr).toBe(0);
    const [name] = await readdir(resultsDir);
    const results = await readResults(`${resultsDir}/${name}`);
    expect(results.usage).toMatchObject({ available: false, total: null, costUsd: null, calls: 9 });
    expect(results.usage.note).toContain(
      "Token usage is not reported for the openai-compatible provider",
    );
    expect(results.runs[0]).toMatchObject({ usage: null, costUsd: null });
    expect(results.sections[0]!.cost).toBeNull();
    expect(results.sections[0]!.latency).not.toBeNull();
    expect(results.pins.generation!.temperature).toBe(0);
    expect(stderr).toContain(
      "Model calls made: 9. Token usage is not reported for the openai-compatible provider",
    );
    expect(stdout).toContain("Cost: not available. Token usage is not reported");
    // Without usage the runtime limit cannot see spend, and the user is told so before the run.
    expect(stderr).toContain(
      "The runtime spend limit therefore cannot see spend: only the cost bound above is checked against --max-cost",
    );
    expect(stdout).not.toMatch(/Cost over/);
  });

  it("stops a scripted generator whose reported usage keeps growing, with exit 3, and keeps what finished", async () => {
    const resultsDir = fresh();
    // The nth call reports n x 100,000 input tokens: $0.20, $0.40, $0.60 and so on at $2 per
    // million. FABRICATED FOR A TEST. The cumulative spend passes the $2.00 limit at call 5
    // ($3.00), after four calls at exactly $2.00, which is not above it.
    const stand = oracleFactory({
      usage: (call) => ({
        inputTokens: call * 100_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    });
    const { code, stderr, stdout } = await run(
      ["--yes", "--case", "PAROL-D01", "--max-cost", "2"],
      {
        resultsDir,
        generatorFactory: stand.factory,
      },
    );
    expect(code).toBe(3);
    expect(stderr).toContain(
      "Stopped: Recorded spend passed the --max-cost limit of $2.0000, so no further model calls were started.",
    );
    expect(stderr).toContain("Spent so far: 1500000 input");
    // Five calls were made and no sixth: the call that passed the limit aborted the rest.
    expect(stand.calls()).toBe(5);
    expect(stdout).toContain(
      "**INCOMPLETE: the run stopped early.** Recorded spend passed the --max-cost limit",
    );
    const [name] = await readdir(resultsDir);
    const results = await readResults(`${resultsDir}/${name}`);
    expect(results.complete).toBe(false);
    expect(results.usage.total!.inputTokens).toBe(1_500_000);
    expect(results.usage.costUsd).toBeCloseTo(3, 10);
    expect(results.runs).toHaveLength(1);
    expect(results.runs[0]).toMatchObject({ outcome: "failed", modelCalls: 5 });
    // A stopped run has no latency or cost summary: those would describe a different set of runs
    // from the one the gates ask about.
    expect(results.sections[0]!.latency).toBeNull();
    expect(results.sections[0]!.cost).toBeNull();
  });

  it("does not stop at a spend of exactly the limit", async () => {
    const resultsDir = fresh();
    // Nine calls of $0.20 each is $1.80, under a limit of $1.80 + a cent.
    const stand = oracleFactory({
      usage: () => ({
        inputTokens: 100_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    });
    const { code } = await run(["--yes", "--case", "PAROL-D01", "--max-cost", "1.8"], {
      resultsDir,
      generatorFactory: stand.factory,
    });
    expect(code).toBe(0);
    expect(stand.calls()).toBe(9);
  });

  it("ends the run with exit 1 when the provider rejects the key, naming the cause and recording the usage so far", async () => {
    const resultsDir = fresh();
    const stand = oracleFactory({
      usage: () => EACH,
      failFrom: {
        call: 3,
        error: new ModelRequestError("rejected with a message that must not be shown", 401),
      },
    });
    const { code, stderr, stdout } = await run(["--yes", "--case", "PAROL-D01"], {
      resultsDir,
      generatorFactory: stand.factory,
    });
    expect(code).toBe(1);
    expect(stderr).toContain(
      "Error: The provider rejected the API key (HTTP 401). Check ANTHROPIC_API_KEY",
    );
    expect(stderr).not.toContain("must not be shown");
    expect(stdout).not.toContain("must not be shown");
    const [name] = await readdir(resultsDir);
    const results = await readResults(`${resultsDir}/${name}`);
    expect(results.complete).toBe(false);
    expect(results.stoppedBecause).toContain("The provider rejected the API key");
    expect(JSON.stringify(results)).not.toContain("must not be shown");
    // Two calls were answered before the third was rejected, and what they used is on record.
    expect(results.usage.total!.responses).toBe(2);
    expect(results.runs.map((r) => r.outcome)).toEqual(["failed"]);
  });

  it.each([
    [402, "The account cannot pay for the request"],
    [403, "The key is not allowed to make this request (HTTP 403)"],
    [404, "The provider does not know the model (HTTP 404)"],
  ])("names the cause of a provider error with status %i", async (status, text) => {
    const resultsDir = fresh();
    const stand = oracleFactory({
      failFrom: { call: 1, error: new ModelRequestError("x", status) },
    });
    const { code, stderr } = await run(["--yes", "--case", "PAROL-D01"], {
      resultsDir,
      generatorFactory: stand.factory,
    });
    expect(code).toBe(1);
    expect(stderr).toContain(text);
  });

  it("leaves a checkpoint after every run and removes it once the results are written", async () => {
    const resultsDir = fresh();
    const out = `${resultsDir}/checkpoint.json`;
    const stand = oracleFactory({});
    let seen: string[] = [];
    const { code } = await run(
      ["--yes", "--case", "PAROL-D01", "--case", "PAROL-D03", "--out", out],
      {
        resultsDir,
        generatorFactory: (request) => {
          const inner = stand.factory(request);
          return {
            ...inner,
            generate: (call) => {
              // The first call of the second case: the first run is done and its checkpoint is written.
              if (stand.calls() === 9) void readdir(resultsDir).then((names) => (seen = names));
              return inner.generate(call);
            },
          };
        },
      },
    );
    expect(code).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen).toContain("checkpoint.json.partial");
    const names = await readdir(resultsDir);
    // The recording of the model's answers sits beside the results, and the checkpoint is gone.
    expect(names).toEqual(["checkpoint.json", "checkpoint.responses.jsonl"]);
  });

  it("names the models the provider reports for the attempts of a fallback, and otherwise says it did not", async () => {
    const resultsDir = fresh();
    const stand = oracleFactory({
      usage: (call) => ({
        ...EACH,
        ...(call === 2
          ? {
              attempts: [
                {
                  model: "claude-declined-1",
                  inputTokens: 1,
                  outputTokens: 0,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                },
                {
                  model: "claude-answered-2",
                  inputTokens: 1,
                  outputTokens: 1,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                },
              ],
            }
          : {}),
      }),
    });
    await run(["--yes", "--case", "PAROL-D01"], { resultsDir, generatorFactory: stand.factory });
    const [name] = await readdir(resultsDir);
    const results = await readResults(`${resultsDir}/${name}`);
    expect(results.pins.model.requested).toBe("claude-sonnet-5-5");
    expect(results.pins.model.reported).toEqual(["claude-answered-2", "claude-declined-1"]);
  });

  it("repeats every case k times and scores each repeat, with stability over them", async () => {
    const resultsDir = fresh();
    const stand = oracleFactory({});
    const { code } = await run(["--yes", "--case", "PAROL-D08", "--runs", "3", "--max-cost", "5"], {
      resultsDir,
      generatorFactory: stand.factory,
    });
    expect(code).toBe(0);
    // PAROL-D08 and its twin, three times: six runs of nine calls.
    expect(stand.calls()).toBe(54);
    const [name] = await readdir(resultsDir);
    const results = await readResults(`${resultsDir}/${name}`);
    const section = results.sections[0]!;
    expect(section.completedRepeats).toBe(3);
    expect(section.metrics!.repeats.map((m) => m.repeat)).toEqual([1, 2, 3]);
    // Eight slots: the twin is run to measure the injection effect and has no slots of its own.
    expect(section.metrics!.stability).toMatchObject({ repeats: 3, slots: 8, meanAgreement: 1 });
    expect(results.runs.map((r) => `${r.caseKey}#${r.repeat}`)).toEqual([
      "PAROL-D08#1",
      "PAROL-D08-twin#1",
      "PAROL-D08#2",
      "PAROL-D08-twin#2",
      "PAROL-D08#3",
      "PAROL-D08-twin#3",
    ]);
    // A subset of the split: the gates are not a promotion result and the report says so.
    expect(section.fullSplit).toBe(false);
    expect(section.casesInSplit).toBe(committedRunShape("dev").cases);
    expect(section.casesInSplit).toBe(14);
  });

  it("puts no document text in what it prints or writes", async () => {
    const resultsDir = fresh();
    const loaded = await loadDataset(REPO_ROOT);
    if (!loaded.ok) throw new Error("the dataset must load");
    const playbook = loadPlaybook({
      yaml: readFileSync(`${REPO_ROOT}/apps/parol/playbooks/parol-nda-recipient.yaml`, "utf8"),
      slug: "parol-nda-recipient",
    });
    const [group] = selectCases(loaded.dataset, "dev", []);
    const spans = [];
    for (const runnable of runnableCases(group!)) {
      const prepared = await prepareCase({
        dataset: loaded.dataset,
        runnable,
        repeat: 1,
        playbook,
        workflow: workflowFor("v1"),
        parsed: new Map(),
      });
      spans.push(...prepared.ingest.spans);
    }
    const windows = documentWindows(spans);
    expect(windows.size).toBeGreaterThan(1000);

    const stand = oracleFactory({ usage: () => EACH });
    const live = await run(["--yes", "--max-cost", "50"], {
      resultsDir,
      generatorFactory: stand.factory,
    });
    const selftest = await run(["--selftest"], { resultsDir: fresh() });
    const simulated = await run(["--simulate"], { resultsDir: fresh() });
    expect(simulated.code).toBe(0);
    for (const out of [live, selftest, simulated]) {
      expect(containsDocumentText(out.stdout, windows)).toBe(false);
      expect(containsDocumentText(out.stderr, windows)).toBe(false);
    }
    for (const name of await readdir(resultsDir)) {
      // A recording of the model's answers is not a results file: it holds the answers, which
      // quote the documents, and not the prompts (it keys them by hash). Its lines have a fixed
      // shape, which is checked here instead of scanning for text, and git ignores the file.
      if (name.endsWith(".responses.jsonl")) {
        const [header, ...lines] = (await readFile(`${resultsDir}/${name}`, "utf8"))
          .trim()
          .split("\n");
        expect(Object.keys(JSON.parse(header!)).sort()).toEqual(
          ["format", "kind", "pins", "recordedAt", "results"].sort(),
        );
        const allowed = new Set([
          "key",
          "schema",
          "run",
          "n",
          "outcome",
          "value",
          "message",
          "category",
          "truncated",
          "status",
          "kind",
          "end",
          "complete",
          "reported",
        ]);
        for (const line of lines) {
          for (const field of Object.keys(JSON.parse(line) as object)) {
            expect(allowed.has(field), field).toBe(true);
          }
          // No field is a prompt: a recorded call has the hash of its request and not its text.
          expect(line).not.toContain('"prompt"');
          expect(line).not.toContain('"system"');
        }
        continue;
      }
      expect(containsDocumentText(await readFile(`${resultsDir}/${name}`, "utf8"), windows)).toBe(
        false,
      );
    }
    // And the check can fail: text copied from a document is found.
    expect(containsDocumentText(`x ${[...windows][0]!} y`, windows)).toBe(true);
  });
});
