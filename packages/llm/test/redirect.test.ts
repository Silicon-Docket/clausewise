import Anthropic from "@anthropic-ai/sdk";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ModelRequestError,
  createAnthropicGenerator,
  createObjectGenerator,
  type LlmConfig,
} from "../src/index.js";
import { PROMPT_TEXT, failure } from "./anthropic-support.js";

const KEY = "sk-test-redirect-key-0123456789";
const schema = z.object({ verdict: z.enum(["ok", "bad"]) });
const request = { system: "You review contracts.", prompt: PROMPT_TEXT, schema };

interface Hit {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: string;
}

interface Listener {
  port: number;
  hits: Hit[];
}

const servers: Server[] = [];

// A real socket on loopback, so a redirect is followed (or not) by the real fetch.
type Respond = (status: number, options?: { location?: string; body?: unknown }) => void;

async function listen(answer: (hit: Hit, respond: Respond) => void): Promise<Listener> {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const hit = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      hits.push(hit);
      answer(hit, (status, options = {}) => {
        res.writeHead(status, {
          ...(options.location === undefined ? {} : { location: options.location }),
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        });
        res.end(options.body === undefined ? undefined : JSON.stringify(options.body));
      });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, hits };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

// Server A is the configured endpoint and always redirects. Server B is where the redirect points.
async function pair(status: number) {
  const elsewhere = await listen((_hit, respond) => respond(200));
  const configured = await listen((_hit, respond) =>
    respond(status, { location: `http://127.0.0.1:${elsewhere.port}/steal` }),
  );
  return { configured, elsewhere };
}

function configFor(provider: LlmConfig["provider"], port: number): LlmConfig {
  return {
    provider,
    model: provider === "anthropic" ? "claude-sonnet-5-5" : "some-model",
    apiKey: KEY,
    baseUrl: provider === "anthropic" ? `http://127.0.0.1:${port}` : `http://127.0.0.1:${port}/v1`,
    maxOutputTokens: 1000,
    effort: undefined,
    concurrency: 1,
    maxContextTokens: undefined,
    maxRetries: 2,
  };
}

const providers = ["anthropic", "openai", "openai-compatible"] as const;
const statuses = [301, 302, 307, 308];

function expectNothingLeaked(error: Error, elsewhere: Listener) {
  expect(elsewhere.hits).toEqual([]);
  expect(error).toBeInstanceOf(ModelRequestError);
  const text = [error.message, error.stack].join("\n");
  expect(text).not.toContain(String(elsewhere.port));
  expect(text).not.toContain("steal");
  expect(text).not.toContain(KEY);
  expect(text).not.toContain("CONFIDENTIAL");
}

describe.each(providers)("a redirect from the configured endpoint (%s)", (provider) => {
  it.each(statuses)(
    "is never followed on HTTP %i, so the other origin gets no request, key or body",
    async (status) => {
      const { configured, elsewhere } = await pair(status);

      const error = await failure(
        createObjectGenerator(configFor(provider, configured.port)).generate(request),
      );

      expectNothingLeaked(error, elsewhere);
      expect(configured.hits).toHaveLength(1);
      expect((error as ModelRequestError).statusCode).toBe(status);
      expect((error as ModelRequestError).fatal).toBe(true);
      expect(error.message).toContain(`HTTP ${status}`);
      expect(error.message).toContain("redirect");
      expect(error.message).toContain("CLAUSEWISE_BASE_URL");
    },
  );

  it("is not followed when a fetch is passed in, and that fetch is told not to follow", async () => {
    const { configured, elsewhere } = await pair(307);
    const inits: (RequestInit | undefined)[] = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
      inits.push(init);
      return globalThis.fetch(input, init);
    };

    const error = await failure(
      createObjectGenerator(configFor(provider, configured.port), { fetch }).generate(request),
    );

    expectNothingLeaked(error, elsewhere);
    expect(inits).not.toHaveLength(0);
    expect(inits.every((init) => init?.redirect === "manual")).toBe(true);
  });

  it("does not reveal where it pointed, even when the body names the address", async () => {
    const elsewhere = await listen((_hit, respond) => respond(200));
    const target = `http://127.0.0.1:${elsewhere.port}/steal?token=abc123`;
    const configured = await listen((_hit, respond) => respond(307, { location: target }));
    const error = await failure(
      createObjectGenerator(configFor(provider, configured.port)).generate(request),
    );
    expect(error.message).not.toContain("abc123");
    expectNothingLeaked(error, elsewhere);
  });
});

describe("a redirect with a client the caller built", () => {
  it("is not followed either, and the caller's client is left as it was", async () => {
    const { configured, elsewhere } = await pair(307);
    const client = new Anthropic({
      apiKey: KEY,
      baseURL: `http://127.0.0.1:${configured.port}`,
      maxRetries: 0,
    });

    const error = await failure(
      createAnthropicGenerator(configFor("anthropic", configured.port), { client }).generate(
        request,
      ),
    );

    expectNothingLeaked(error, elsewhere);
    expect(client.fetchOptions).toBeUndefined();
  });
});

describe("the same endpoints without a redirect", () => {
  // The bodies the three providers answer with, so the wrapper is shown to leave a normal exchange
  // alone.
  const answers: Record<(typeof providers)[number], unknown> = {
    anthropic: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [{ type: "text", text: '{"verdict":"ok"}' }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    openai: {
      id: "resp_test",
      object: "response",
      created_at: 1,
      model: "some-model",
      output: [
        {
          type: "message",
          role: "assistant",
          id: "msg_test",
          content: [{ type: "output_text", text: '{"verdict":"ok"}', annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    "openai-compatible": {
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1,
      model: "some-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: '{"verdict":"ok"}' },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  };

  it.each(providers)("still work for %s", async (provider) => {
    const server = await listen((_hit, respond) => respond(200, { body: answers[provider] }));
    await expect(
      createObjectGenerator(configFor(provider, server.port)).generate(request),
    ).resolves.toEqual({ verdict: "ok" });
    expect(server.hits).toHaveLength(1);
  });
});
