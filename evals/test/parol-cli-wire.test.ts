import { readFile, readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AnalysisSchema, LocateSchema } from "../../apps/parol/src/contracts.js";
import { loadPlaybook } from "../../apps/parol/src/playbooks/load.js";
import { workflowFor } from "../../apps/parol/src/prompts/workflows.js";
import { costOf } from "../src/prices.js";
import { loadDataset, selectCases } from "../src/parol/dataset.js";
import { createKeyOracle } from "../src/parol/oracle.js";
import { prepareCase, runnableCases, type ParsedFiles } from "../src/parol/runner.js";
import { REPO_ROOT, makeTempDir, readResults, removeDir, run } from "../src/parol/testing-run.js";

/**
 * The live path of the runner against the real Anthropic adapter, with a server on this machine
 * standing in for the API, as evals/test/anthropic-wire.test.ts does for the Clausewise harness.
 * It shows that the usage callback, the spend guard's fetch and the closed set of provider errors
 * are wired into what the runner builds from the environment. The base URL is a loopback address,
 * so nothing leaves the machine. The answers are the key oracle's, and the server is a scripted
 * stand-in and not a model.
 */

const KEY = "sk-wire-test-key";

let dir = "";
let server: Server;
let address = "";
let mode: "answer" | "unauthorised" = "answer";
/** Output tokens reported by the next responses. */
let outputTokens = 120;
/** The model the next responses name. Undefined: the one that was asked for, as an alias that has not moved. */
let reportedModel: string | undefined;
const seen = {
  requests: 0,
  streamed: 0,
  keyOk: true,
  totals: { input: 0, output: 0, read: 0, write: 0 },
};

const tokensOf = (text: string): number => Math.ceil(text.length / 4);

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

beforeAll(async () => {
  dir = await makeTempDir();
  const loaded = await loadDataset(REPO_ROOT);
  if (!loaded.ok) throw new Error(loaded.problems.join("; "));
  const dataset = loaded.dataset;
  const playbook = loadPlaybook({
    yaml: readFileSync(`${REPO_ROOT}/apps/parol/playbooks/parol-nda-recipient.yaml`, "utf8"),
    slug: "parol-nda-recipient",
  });
  // The labels of the clauses (c1, c2, ...) are the same in every repeat, so an oracle built from
  // the first repeat of the one case the tests run answers all of them.
  const [group] = selectCases(dataset, "dev", ["PAROL-D01"]);
  const runnable = runnableCases(group!)[0]!;
  const parsed: ParsedFiles = new Map();
  const prepared = await prepareCase({
    dataset,
    runnable,
    repeat: 1,
    playbook,
    workflow: workflowFor("v1"),
    parsed,
  });
  const oracle = createKeyOracle({
    caseKey: runnable.caseKey,
    expect: runnable.expect,
    spans: prepared.ingest.spans,
    rules: playbook.rules,
  });

  server = createServer((request, response) => {
    void (async () => {
      const raw = await body(request);
      seen.requests += 1;
      if (request.headers["x-api-key"] !== KEY || request.headers.authorization !== undefined) {
        seen.keyOk = false;
      }
      response.setHeader("content-type", "application/json");
      if (mode === "unauthorised") {
        response.statusCode = 401;
        response.end(
          JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: "invalid x-api-key" },
          }),
        );
        return;
      }
      const parsedBody = JSON.parse(raw) as {
        model: string;
        stream?: boolean;
        system?: string;
        messages: { content: { text: string }[] }[];
      };
      const prompt = (parsedBody.messages[0]?.content ?? []).map((block) => block.text).join("");
      const analyze = prompt.includes("Rule ID: ");
      const answer = await oracle.generate({
        system: parsedBody.system ?? "",
        prompt,
        schemaName: analyze ? "analyze_rule" : "locate_passages",
        schema: (analyze ? AnalysisSchema : LocateSchema) as never,
      });
      const usage = {
        input_tokens: tokensOf(parsedBody.system ?? "") + tokensOf(prompt),
        output_tokens: outputTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      };
      seen.totals.input += usage.input_tokens;
      seen.totals.output += usage.output_tokens;
      const model = reportedModel ?? parsedBody.model;
      if (parsedBody.stream === true) {
        // The Messages API as a stream of server-sent events, which the adapter asks for when the
        // output limit is above what a single reply may take. The model comes first, in
        // message_start, and the events are cut into awkward chunks.
        seen.streamed += 1;
        response.setHeader("content-type", "text/event-stream");
        const event = (type: string, data: unknown): string =>
          `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
        const text = [
          event("message_start", {
            message: {
              id: "msg_test",
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { ...usage, output_tokens: 1 },
            },
          }),
          event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
          event("content_block_delta", {
            index: 0,
            delta: { type: "text_delta", text: JSON.stringify(answer) },
          }),
          event("content_block_stop", { index: 0 }),
          event("message_delta", {
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: usage.output_tokens },
          }),
          event("message_stop", {}),
        ].join("");
        for (let at = 0; at < text.length; at += 37) response.write(text.slice(at, at + 37));
        response.end();
        return;
      }
      response.end(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text: JSON.stringify(answer) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage,
        }),
      );
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await removeDir(dir);
});

const env = () => ({
  ANTHROPIC_API_KEY: KEY,
  CLAUSEWISE_BASE_URL: address,
  CLAUSEWISE_MAX_RETRIES: "0",
});

const reset = (): void => {
  mode = "answer";
  outputTokens = 120;
  reportedModel = undefined;
  seen.requests = 0;
  seen.streamed = 0;
  seen.keyOk = true;
  seen.totals = { input: 0, output: 0, read: 0, write: 0 };
};

describe("the runner with the real Anthropic adapter", () => {
  it("records the usage the adapter reports, prices it, and pins the model and its settings", async () => {
    reset();
    // The alias the run asks for has moved to a snapshot, which only the responses say.
    reportedModel = "claude-sonnet-5-5-20261001";
    const resultsDir = `${dir}/ok`;
    const { code, stdout, stderr } = await run(
      ["--yes", "--case", "PAROL-D01", "--max-cost", "5"],
      { resultsDir, env: env() },
    );
    expect(code, stderr).toBe(0);
    expect(stderr).toContain(`Sending the contract text to: Anthropic API (${address.slice(7)})`);
    expect(seen.requests).toBe(9);
    expect(seen.keyOk).toBe(true);

    const [name] = await readdir(resultsDir);
    const results = await readResults(`${resultsDir}/${name}`);
    expect(results).toMatchObject({
      mode: "live",
      selftest: false,
      simulated: false,
      banner: null,
      complete: true,
    });
    expect(results.usage.available).toBe(true);
    expect(results.usage.calls).toBe(9);
    expect(results.usage.total).toEqual({
      responses: 9,
      inputTokens: seen.totals.input,
      outputTokens: seen.totals.output,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(seen.totals.output).toBe(9 * 120);

    // The price is the table's, and the cost is the usage times it, to the last digit.
    const price = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
    const expected = costOf(
      {
        inputTokens: seen.totals.input,
        outputTokens: seen.totals.output,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      price,
    );
    expect(results.usage.costUsd).toBeCloseTo(expected, 12);
    expect(results.runs).toHaveLength(1);
    expect(results.runs[0]).toMatchObject({
      caseKey: "PAROL-D01",
      repeat: 1,
      outcome: "succeeded",
      modelCalls: 9,
    });
    expect(results.runs[0]!.costUsd).toBeCloseTo(expected, 12);
    expect(results.sections[0]!.cost).toMatchObject({ runs: 1, failedRuns: 0 });
    expect(results.sections[0]!.cost!.totalUsd).toBeCloseTo(expected, 12);
    expect(results.sections[0]!.latency!.completed).toBe(1);

    // What the run is pinned to.
    // The destination is the host of the stub, and the model is the one the responses named. (The
    // pin of the model as reported used to be null on every live run, and the endpoint was not pinned.)
    expect(results.pins.model).toEqual({
      provider: "anthropic",
      requested: "claude-sonnet-5-5",
      endpoint: address.slice("http://".length),
      reported: ["claude-sonnet-5-5-20261001"],
      reportedNote:
        "Read from the model field of the provider's responses, which names the snapshot an alias resolved to. Empty when no response named one.",
    });
    expect(stdout).toContain("reported by the provider: claude-sonnet-5-5-20261001");
    expect(results.pins.generation).toEqual({
      maxOutputTokens: 16000,
      effort: null,
      maxRetries: 0,
      ruleConcurrency: 3,
      temperature: null,
      fallback: null,
    });
    expect(results.pins.prices!.model).toEqual(price);
    expect(results.pins.prices!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(results.sections[0]!.metrics!.repeats[0]!.statusAccuracy).toMatchObject({
      numerator: 8,
      denominator: 8,
    });
    // A live report carries no banner of a scripted run, and prints the cost it measured.
    expect(stdout.startsWith("# Parol evaluation\n")).toBe(true);
    expect(stdout).not.toContain("SELFTEST");
    expect(stdout).toContain("Cost over 1 runs started: total $");
    expect(stdout).toContain("Run latency over 1 completed runs:");
  });

  it("ends the run with exit 1 on a 401 from the wire, names the cause, and records the run that failed", async () => {
    reset();
    mode = "unauthorised";
    const resultsDir = `${dir}/401`;
    const { code, stderr, stdout } = await run(
      ["--yes", "--case", "PAROL-D01", "--max-cost", "5"],
      {
        resultsDir,
        env: env(),
      },
    );
    expect(code).toBe(1);
    expect(stderr).toContain("Error: The provider rejected the API key (HTTP 401).");
    // The first call alone found out, and no rule was sent after it.
    expect(seen.requests).toBe(1);
    expect(stdout).toContain("**INCOMPLETE: the run stopped early.**");
    const [name] = await readdir(resultsDir);
    const results = await readResults(`${resultsDir}/${name}`);
    expect(results.complete).toBe(false);
    expect(results.runs.map((r) => r.outcome)).toEqual(["failed"]);
    expect(results.sections[0]!.metrics).toBeNull();
    expect(results.sections[0]!.gates).toBeNull();
    // Nothing of the provider's own message is kept.
    expect(JSON.stringify(results)).not.toContain("invalid x-api-key");
    expect(stderr).not.toContain("invalid x-api-key");
  });

  it("holds a run to --max-cost request by request and stops with exit 3, keeping the usage", async () => {
    reset();
    // Each answer reports 8,000 output tokens, which is $0.08 at the table's $10 per million. The
    // cost bound of one case is under the limit, so the run starts; a request could cost far more
    // than what is left after a few of them, and the guard stops before it is sent.
    outputTokens = 8000;
    const resultsDir = `${dir}/guard`;
    // The assumed output is small so that the cost bound, which includes every repair call, is
    // under the limit and the run starts; the guard under test is the one that works request by
    // request while the run is going.
    const { code, stderr, stdout } = await run(
      ["--yes", "--case", "PAROL-D01", "--max-cost", "0.3", "--assumed-output-tokens", "100"],
      {
        resultsDir,
        env: env(),
      },
    );
    expect(code).toBe(3);
    expect(stderr).toMatch(
      /Stopped: (A request to the model can cost up to|Recorded spend passed)/,
    );
    expect(stderr).toContain("--max-cost");
    expect(seen.requests).toBeGreaterThan(0);
    expect(seen.requests).toBeLessThan(9);
    expect(stdout).toContain("**INCOMPLETE: the run stopped early.**");
    const [name] = await readdir(resultsDir);
    const results = await readResults(`${resultsDir}/${name}`);
    expect(results.complete).toBe(false);
    expect(results.stoppedBecause).toContain("--max-cost");
    expect(results.usage.total!.responses).toBe(seen.requests);
    expect(results.usage.total!.outputTokens).toBe(seen.requests * 8000);
    // The run was cut short and is on record with what it spent.
    expect(results.runs).toHaveLength(1);
    expect(results.runs[0]).toMatchObject({ outcome: "failed" });
    // The spend recorded is within the limit, plus at most the requests that were already under way.
    expect(results.usage.costUsd!).toBeLessThanOrEqual(0.3 + 0.2);
  });

  it("reads the model of a streamed response from its first event, and leaves the stream to the adapter", async () => {
    reset();
    reportedModel = "claude-sonnet-5-5-20261001";
    const resultsDir = `${dir}/stream`;
    // Above 21,333 output tokens a single reply is refused by the SDK, and the adapter streams.
    const { code, stderr } = await run(["--yes", "--case", "PAROL-D01", "--max-cost", "50"], {
      resultsDir,
      env: { ...env(), CLAUSEWISE_MAX_OUTPUT_TOKENS: "30000" },
    });
    expect(code, stderr).toBe(0);
    expect(seen.requests).toBe(9);
    expect(seen.streamed).toBe(9);
    const [name] = await readdir(resultsDir);
    const results = await readResults(`${resultsDir}/${name}`);
    expect(results.complete).toBe(true);
    expect(results.pins.model.reported).toEqual(["claude-sonnet-5-5-20261001"]);
    // The adapter still read every stream whole: the usage of the nine replies is all there.
    expect(results.usage.total!.responses).toBe(9);
    expect(results.sections[0]!.metrics!.repeats[0]!.statusAccuracy).toMatchObject({
      numerator: 8,
      denominator: 8,
    });
  });

  it("refuses to compare two runs when the alias moved to another snapshot between them", async () => {
    reset();
    const resultsDir = `${dir}/moved`;
    const first = `${dir}/moved-first.json`;
    reportedModel = "claude-sonnet-5-5-20261001";
    const a = await run(["--yes", "--case", "PAROL-D01", "--max-cost", "5", "--out", first], {
      resultsDir,
      env: env(),
    });
    expect(a.code, a.stderr).toBe(0);

    // The same alias, a new snapshot. Nothing in the request or in the configuration differs, so
    // this is the only thing that tells the two runs apart.
    reportedModel = "claude-sonnet-5-5-20261101";
    const second = `${dir}/moved-second.json`;
    const b = await run(
      ["--yes", "--case", "PAROL-D01", "--max-cost", "5", "--compare", first, "--out", second],
      { resultsDir, env: env() },
    );
    expect(b.code).toBe(1);
    expect(b.stderr).toContain("Refusing to compare");
    expect(b.stderr).toContain("model.reported");
    expect((await readResults(second)).pins.model.reported).toEqual(["claude-sonnet-5-5-20261101"]);

    // Named as expected, the difference is printed and the runs are compared.
    reportedModel = "claude-sonnet-5-5-20261101";
    const c = await run(
      [
        "--yes",
        "--case",
        "PAROL-D01",
        "--max-cost",
        "5",
        "--compare",
        first,
        "--allow-differences",
        "model-reported",
        "--out",
        `${dir}/moved-third.json`,
      ],
      { resultsDir, env: env() },
    );
    expect(c.code, c.stderr).toBe(0);
    expect(c.stdout).toContain("model.reported");
  });

  it("leaves no partial file behind once the results are written", async () => {
    reset();
    const resultsDir = `${dir}/partial`;
    await run(["--yes", "--case", "PAROL-D01", "--max-cost", "5"], { resultsDir, env: env() });
    const all = await readdir(resultsDir);
    // The results, and the recording of the answers beside them. No checkpoint.
    expect(all).toHaveLength(2);
    expect(all.filter((name) => name.endsWith(".responses.jsonl"))).toHaveLength(1);
    const names = all.filter((name) => !name.endsWith(".responses.jsonl"));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^parol-\d{8}T\d{6}Z\.json$/);
    const text = await readFile(`${resultsDir}/${names[0]}`, "utf8");
    expect(text.endsWith("\n")).toBe(true);
  });
});
