import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ModelOutputError,
  ModelRefusalError,
  createObjectGenerator,
  type LlmConfig,
} from "../src/index.js";
import { ModelRequestError } from "../src/generator.js";

const PROMPT_TEXT = "CONFIDENTIAL-PROMPT: the Supplier shall pay 4,250,000 to Acme";
const API_KEY = "sk-test-key-that-is-not-real";

const schema = z.object({
  verdict: z.enum(["ok", "bad"]),
  quote: z.string().nullable(),
});
const request = { system: "You review contracts.", prompt: PROMPT_TEXT, schema };
const answer = JSON.stringify({ verdict: "ok", quote: null });

interface Recorded {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: Record<string, unknown>;
}

// Stands in for the network, so these tests see exactly what the real SDK would put on the wire.
function recordingFetch(respond: (call: number) => Response) {
  const requests: Recorded[] = [];
  const fetch = (async (url: unknown, init?: RequestInit) => {
    requests.push({
      url: String(url),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return respond(requests.length);
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function chatCompletion(text: string, finishReason = "stop") {
  return json({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "llama3.1",
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: finishReason },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

function openaiResponse(text: string) {
  return json({
    id: "resp_test",
    object: "response",
    created_at: 1,
    model: "test-model",
    output: [
      {
        type: "message",
        role: "assistant",
        id: "msg_test",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

function makeConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "openai",
    model: "test-model",
    apiKey: API_KEY,
    baseUrl: undefined,
    maxOutputTokens: 12345,
    effort: undefined,
    concurrency: 4,
    maxContextTokens: undefined,
    maxRetries: 2,
    ...overrides,
  };
}

// The SDK reports settings a model ignores as warnings. A clean run proves the request was built
// from settings the model accepts rather than settings the SDK quietly dropped.
let warnings: unknown[] = [];
const globals = globalThis as { AI_SDK_LOG_WARNINGS?: unknown };
let savedLogger: unknown;

beforeEach(() => {
  warnings = [];
  savedLogger = globals.AI_SDK_LOG_WARNINGS;
  globals.AI_SDK_LOG_WARNINGS = (entry: unknown) => warnings.push(entry);
});

afterEach(() => {
  if (savedLogger === undefined) delete globals.AI_SDK_LOG_WARNINGS;
  else globals.AI_SDK_LOG_WARNINGS = savedLogger;
});

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the promise to reject");
}

describe("base URL variables left over from other tools", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("do not redirect the OpenAI request away from the disclosed host", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://elsewhere.example.com/v1");
    const { fetch, requests } = recordingFetch(() => openaiResponse(answer));
    await createObjectGenerator(makeConfig(), { fetch }).generate(request);
    expect(requests[0]?.url).toBe("https://api.openai.com/v1/responses");
  });
});

describe("openai-compatible request", () => {
  const compatible = makeConfig({
    provider: "openai-compatible",
    model: "llama3.1",
    apiKey: undefined,
    baseUrl: "http://localhost:11434/v1",
  });

  async function send(config: LlmConfig = compatible) {
    const { fetch, requests } = recordingFetch(() => chatCompletion(answer));
    const result = await createObjectGenerator(config, { fetch }).generate(request);
    const [sent] = requests;
    if (sent === undefined) throw new Error("no request was sent");
    return { sent, result };
  }

  it("posts chat completions to the configured base URL", async () => {
    const { sent, result } = await send();
    expect(result).toEqual({ verdict: "ok", quote: null });
    expect(sent.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(sent.body.model).toBe("llama3.1");
  });

  it("cleans the schema name for servers that only accept letters, digits, _ and -", async () => {
    const { fetch, requests } = recordingFetch(() => chatCompletion(answer));
    await createObjectGenerator(compatible, { fetch }).generate({
      ...request,
      schemaName: "rule check: 7.2/a",
    });
    expect(requests[0]?.body.response_format).toMatchObject({
      json_schema: { name: "rule_check__7_2_a" },
    });
  });

  it("copes with a trailing slash on the base URL", async () => {
    const { sent } = await send({ ...compatible, baseUrl: "http://localhost:11434/v1/" });
    expect(sent.url).toBe("http://localhost:11434/v1/chat/completions");
  });

  it("sends temperature 0", async () => {
    const { sent } = await send();
    expect(sent.body.temperature).toBe(0);
    expect(sent.body).not.toHaveProperty("top_p");
  });

  it("sends no Authorization header when there is no key", async () => {
    const { sent } = await send();
    expect(sent.headers.has("authorization")).toBe(false);
    expect(sent.headers.has("x-api-key")).toBe(false);
  });

  it("sends the key as a bearer token when there is one", async () => {
    const { sent } = await send({ ...compatible, apiKey: API_KEY });
    expect(sent.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
  });

  it("gives the server the schema instead of a bare json_object", async () => {
    const { sent } = await send();
    expect(sent.body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { schema: { type: "object", required: ["verdict", "quote"] } },
    });
  });

  it("caps the reply at the configured output limit and offers no tools", async () => {
    const { sent } = await send({ ...compatible, maxOutputTokens: 4096 });
    expect(sent.body.max_tokens).toBe(4096);
    expect(sent.body).not.toHaveProperty("tools");
    expect(sent.body).not.toHaveProperty("tool_choice");
  });

  it("produces no SDK warnings", async () => {
    await send();
    expect(warnings).toEqual([]);
  });

  it("maps finish_reason content_filter to ModelRefusalError without retrying", async () => {
    const { fetch, requests } = recordingFetch(() => chatCompletion("", "content_filter"));
    const error = await failure(createObjectGenerator(compatible, { fetch }).generate(request));
    expect(error).toBeInstanceOf(ModelRefusalError);
    expect(requests).toHaveLength(1);
  });

  it("retries bad output and then gives up with ModelOutputError", async () => {
    const { fetch, requests } = recordingFetch(() => chatCompletion("Sure thing!"));
    const error = await failure(
      createObjectGenerator({ ...compatible, maxRetries: 1 }, { fetch }).generate(request),
    );
    expect(error).toBeInstanceOf(ModelOutputError);
    expect(error.message).toContain("openai-compatible");
    expect(error.message).toContain("llama3.1");
    expect(requests).toHaveLength(2);
  });
});

describe("openai request", () => {
  const openai = makeConfig({ provider: "openai", model: "test-model", apiKey: API_KEY });

  async function send(config: LlmConfig = openai) {
    const { fetch, requests } = recordingFetch(() => openaiResponse(answer));
    const result = await createObjectGenerator(config, { fetch }).generate(request);
    const [sent] = requests;
    if (sent === undefined) throw new Error("no request was sent");
    return { sent, result };
  }

  it("posts to the OpenAI Responses API with the key and the exact model name", async () => {
    const { sent, result } = await send();
    expect(result).toEqual({ verdict: "ok", quote: null });
    expect(sent.url).toBe("https://api.openai.com/v1/responses");
    expect(sent.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(sent.body.model).toBe("test-model");
  });

  it("requests structured output and leaves sampling alone", async () => {
    const { sent } = await send();
    expect(sent.body.text).toMatchObject({ format: { type: "json_schema" } });
    expect(sent.body.max_output_tokens).toBe(12345);
    expect(sent.body).not.toHaveProperty("temperature");
    expect(sent.body).not.toHaveProperty("top_p");
    expect(sent.body).not.toHaveProperty("reasoning");
  });

  it("asks OpenAI not to store the response", async () => {
    const { sent } = await send();
    expect(sent.body.store).toBe(false);
  });

  it("uses the base URL override", async () => {
    const { sent } = await send({ ...openai, baseUrl: "https://gateway.example.com/v1" });
    expect(sent.url).toBe("https://gateway.example.com/v1/responses");
  });

  it("produces no SDK warnings", async () => {
    await send();
    expect(warnings).toEqual([]);
  });

  it("reports the status and the API's message, and does not retry a 401", async () => {
    const { fetch, requests } = recordingFetch(() =>
      json(
        { error: { message: "Incorrect API key provided.", type: "invalid_request_error" } },
        401,
      ),
    );
    const error = await failure(createObjectGenerator(openai, { fetch }).generate(request));

    expect(error).toBeInstanceOf(ModelRequestError);
    expect((error as ModelRequestError).statusCode).toBe(401);
    expect(error.message).toContain("Incorrect API key provided");
    expect(requests).toHaveLength(1);
  });

  it("keeps the contract and the key out of the error the SDK built around the request", async () => {
    const { fetch } = recordingFetch(() =>
      json({ error: { message: `bad key ${API_KEY}`, type: "invalid_request_error" } }, 401),
    );
    const error = await failure(createObjectGenerator(openai, { fetch }).generate(request));
    const everything = inspect(error, { depth: 10, showHidden: true });
    expect(everything).not.toContain("CONFIDENTIAL");
    expect(everything).not.toContain(API_KEY);
  });
});
