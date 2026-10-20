import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { RuleCheckSchema } from "@clausewise/review";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { costOf } from "../src/prices.js";
import type { EvalResult } from "../src/result.js";
import { allFixtures, makeTempDir, removeDir, routedModel, run } from "./support.js";

/**
 * The harness against the real Anthropic adapter, with a server on this machine standing in for
 * the API. This is the one test that shows the usage callback is wired into the adapter the
 * harness builds from the environment, and that a 401 from the wire ends the run. Nothing leaves
 * the machine: the base URL is a loopback address.
 */

const KEY = "sk-wire-test-key";

interface Seen {
  requests: number;
  cacheMarked: number;
  keyOk: boolean;
  totals: { input: number; output: number; read: number; write: number };
}

let dir = "";
let server: Server;
let address = "";
let mode: "answer" | "unauthorised" = "answer";
const seen: Seen = {
  requests: 0,
  cacheMarked: 0,
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
  const model = routedModel(await allFixtures());
  const cached = new Set<string>();

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

      const parsed = JSON.parse(raw) as {
        model: string;
        system?: string;
        messages: { content: { text: string; cache_control?: unknown }[] }[];
      };
      const blocks = parsed.messages[0]?.content ?? [];
      const prompt = blocks.map((block) => block.text).join("");
      const check = await model.generate({
        system: parsed.system ?? "",
        prompt,
        schema: RuleCheckSchema,
      });

      // The cache marker is on the first block, and the API caches everything up to it, the system
      // prompt included. Seeing that prefix for the first time writes the cache entry and every
      // later sight of it reads the entry.
      const marked = blocks.find((block) => block.cache_control !== undefined);
      if (marked !== undefined) seen.cacheMarked += 1;
      const system = parsed.system ?? "";
      const rest = blocks
        .filter((block) => block !== marked)
        .map((block) => block.text)
        .join("");
      const key = marked === undefined ? undefined : system + marked.text;
      const cacheTokens = key === undefined ? 0 : tokensOf(key);
      const hit = key !== undefined && cached.has(key);
      if (key !== undefined) cached.add(key);

      const usage = {
        input_tokens: key === undefined ? tokensOf(system) + tokensOf(prompt) : tokensOf(rest),
        output_tokens: 120,
        cache_read_input_tokens: hit ? cacheTokens : 0,
        cache_creation_input_tokens: key !== undefined && !hit ? cacheTokens : 0,
      };
      seen.totals.input += usage.input_tokens;
      seen.totals.output += usage.output_tokens;
      seen.totals.read += usage.cache_read_input_tokens;
      seen.totals.write += usage.cache_creation_input_tokens;

      response.end(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: parsed.model,
          content: [{ type: "text", text: JSON.stringify(check) }],
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

describe("the harness with the real Anthropic adapter", () => {
  it("records the usage the adapter reports, cache reads and writes included", async () => {
    mode = "answer";
    const out = `${dir}/wire.json`;
    const { code, stdout, stderr } = await run(
      ["--yes", "--fixture", "nda-balanced.docx", "--out", out],
      { dir, env: env() },
    );
    expect(stderr).toContain(`Sending the contract text to: Anthropic API (${address.slice(7)})`);
    expect(code).toBe(0);

    expect(seen.requests).toBe(10);
    expect(seen.cacheMarked).toBe(10);
    expect(seen.keyOk).toBe(true);

    const result = JSON.parse(await readFile(out, "utf8")) as EvalResult;
    expect(result.score.accuracy).toBe(1);
    expect(result.usage.available).toBe(true);
    expect(result.usage.total).toEqual({
      responses: 10,
      inputTokens: seen.totals.input,
      outputTokens: seen.totals.output,
      cacheReadTokens: seen.totals.read,
      cacheWriteTokens: seen.totals.write,
    });
    // The first request wrote the contract to the cache and the other nine read it.
    expect(seen.totals.write).toBeGreaterThan(0);
    expect(seen.totals.read).toBe(9 * seen.totals.write);
    expect(seen.totals.output).toBe(1200);

    const price = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
    expect(result.cost.actualUsd).toBeCloseTo(
      costOf(
        {
          inputTokens: seen.totals.input,
          outputTokens: seen.totals.output,
          cacheReadTokens: seen.totals.read,
          cacheWriteTokens: seen.totals.write,
        },
        price,
      ),
      12,
    );
    expect(result.usage.cache?.readShare).toBeGreaterThan(0.8);
    expect(stdout).toContain("Cache effectiveness:");
  });

  it("ends the run with exit 1 on a 401 from the wire and says so", async () => {
    mode = "unauthorised";
    const before = seen.requests;
    const { code, stderr, stdout } = await run(["--yes", "--fixture", "nda-balanced.docx"], {
      dir,
      env: env(),
    });
    mode = "answer";
    expect(code).toBe(1);
    expect(stderr).toContain("The model provider answered HTTP 401, so no rule can be checked.");
    expect(stderr).toContain("Spent so far: 0 input");
    expect(stdout).toBe("");
    // The first call alone found out, and the other nine were never sent.
    expect(seen.requests - before).toBe(1);
  });
});
