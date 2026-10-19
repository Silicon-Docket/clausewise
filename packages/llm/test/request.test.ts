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

function anthropicMessage(text: string, stopReason = "end_turn") {
  return json({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: text === "" ? [] : [{ type: "text", text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
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
    provider: "anthropic",
    model: "claude-sonnet-5-5",
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

describe.each(["claude-sonnet-5-5", "claude-opus-5-5"])("anthropic request for %s", (model) => {
  async function send(overrides: Partial<LlmConfig> = {}) {
    const { fetch, requests } = recordingFetch(() => anthropicMessage(answer));
    const generator = createObjectGenerator(makeConfig({ model, ...overrides }), { fetch });
    const result = await generator.generate({ ...request, schemaName: "rule_check" });
    const [sent] = requests;
    if (sent === undefined) throw new Error("no request was sent");
    return { sent, requests, result };
  }

  it("posts to the Messages API with the key and returns the parsed answer", async () => {
    const { sent, result } = await send();
    expect(result).toEqual({ verdict: "ok", quote: null });
    expect(sent.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("x-api-key")).toBe(API_KEY);
    expect(sent.headers.get("authorization")).toBeNull();
    expect(sent.body.model).toBe(model);
  });

  it("requests native structured output built from the caller's schema", async () => {
    const { sent } = await send();
    expect(sent.body.output_config).toMatchObject({
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          required: ["verdict", "quote"],
          properties: { verdict: { enum: ["ok", "bad"] } },
        },
      },
    });
  });

  it("does not use a forced JSON tool, which this model answers with HTTP 400", async () => {
    const { sent } = await send();
    expect(sent.body).not.toHaveProperty("tool_choice");
    expect(sent.body).not.toHaveProperty("tools");
  });

  it("leaves out temperature, top_p and top_k", async () => {
    const { sent } = await send();
    expect(sent.body).not.toHaveProperty("temperature");
    expect(sent.body).not.toHaveProperty("top_p");
    expect(sent.body).not.toHaveProperty("top_k");
  });

  it("leaves thinking at the model's adaptive default instead of disabling it", async () => {
    const { sent } = await send();
    expect(sent.body).not.toHaveProperty("thinking");
  });

  it("sets max_tokens to the configured output limit", async () => {
    const { sent } = await send({ maxOutputTokens: 777 });
    expect(sent.body.max_tokens).toBe(777);
  });

  it("sends the prompts as the system and user text", async () => {
    const { sent } = await send();
    expect(sent.body.system).toEqual([{ type: "text", text: "You review contracts." }]);
    expect(JSON.stringify(sent.body.messages)).toContain(PROMPT_TEXT);
  });

  it("omits effort when none is configured", async () => {
    const { sent } = await send();
    expect(sent.body.output_config).not.toHaveProperty("effort");
  });

  it.each(["low", "medium", "high", "xhigh", "max"] as const)(
    "sends output_config.effort %s when configured",
    async (effort) => {
      const { sent } = await send({ effort });
      expect(sent.body.output_config).toMatchObject({ effort });
      expect(sent.body.output_config).toHaveProperty("format");
      expect(sent.body).not.toHaveProperty("thinking");
      expect(sent.body).not.toHaveProperty("temperature");
    },
  );

  it("produces no SDK warnings", async () => {
    await send({ effort: "xhigh" });
    expect(warnings).toEqual([]);
  });

  it("sends the same body again when it retries bad output", async () => {
    const { fetch, requests } = recordingFetch((call) =>
      anthropicMessage(call === 1 ? "not json" : answer),
    );
    const generator = createObjectGenerator(makeConfig({ model }), { fetch });
    await expect(generator.generate(request)).resolves.toEqual({ verdict: "ok", quote: null });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.body).toEqual(requests[0]?.body);
  });
});

describe("anthropic base URL", () => {
  it("sends the request to the configured base URL", async () => {
    const { fetch, requests } = recordingFetch(() => anthropicMessage(answer));
    const generator = createObjectGenerator(
      makeConfig({ baseUrl: "https://gateway.example.com/v1/" }),
      {
        fetch,
      },
    );
    await generator.generate(request);
    expect(requests[0]?.url).toBe("https://gateway.example.com/v1/messages");
  });
});

describe("base URL variables left over from other tools", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("do not redirect the Anthropic request away from the disclosed host", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://elsewhere.example.com/v1");
    const { fetch, requests } = recordingFetch(() => anthropicMessage(answer));
    await createObjectGenerator(makeConfig(), { fetch }).generate(request);
    expect(requests[0]?.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("do not redirect the OpenAI request away from the disclosed host", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://elsewhere.example.com/v1");
    const { fetch, requests } = recordingFetch(() => openaiResponse(answer));
    const config = makeConfig({ provider: "openai", model: "test-model" });
    await createObjectGenerator(config, { fetch }).generate(request);
    expect(requests[0]?.url).toBe("https://api.openai.com/v1/responses");
  });

  it("do not replace the configured key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "key-from-the-environment");
    const { fetch, requests } = recordingFetch(() => anthropicMessage(answer));
    await createObjectGenerator(makeConfig(), { fetch }).generate(request);
    expect(requests[0]?.headers.get("x-api-key")).toBe(API_KEY);
  });
});

describe("anthropic stop reasons", () => {
  it("maps stop_reason refusal to ModelRefusalError without retrying", async () => {
    const { fetch, requests } = recordingFetch(() => anthropicMessage("", "refusal"));
    const generator = createObjectGenerator(makeConfig({ maxRetries: 3 }), { fetch });

    const error = await failure(generator.generate(request));

    expect(error).toBeInstanceOf(ModelRefusalError);
    expect(requests).toHaveLength(1);
  });

  it("maps a refusal that arrives with partial text to ModelRefusalError", async () => {
    const { fetch, requests } = recordingFetch(() => anthropicMessage('{"verdict":', "refusal"));
    const error = await failure(createObjectGenerator(makeConfig(), { fetch }).generate(request));
    expect(error).toBeInstanceOf(ModelRefusalError);
    expect(requests).toHaveLength(1);
  });

  it("treats max_tokens with cut-off JSON as bad output and says how to fix it", async () => {
    const { fetch, requests } = recordingFetch(() =>
      anthropicMessage('{"verdict":"o', "max_tokens"),
    );
    const generator = createObjectGenerator(makeConfig({ maxRetries: 1 }), { fetch });

    const error = await failure(generator.generate(request));

    expect(error).toBeInstanceOf(ModelOutputError);
    expect(error.message).toContain("CLAUSEWISE_MAX_OUTPUT_TOKENS");
    expect(requests).toHaveLength(2);
  });
});

describe("anthropic HTTP errors", () => {
  const apiError = {
    type: "error",
    error: { type: "invalid_request_error", message: "Your credit balance is too low." },
  };

  it("reports the status and the API's message, and does not retry a 400", async () => {
    const { fetch, requests } = recordingFetch(() => json(apiError, 400));
    const error = await failure(createObjectGenerator(makeConfig(), { fetch }).generate(request));

    expect(error).toBeInstanceOf(ModelRequestError);
    expect((error as ModelRequestError).statusCode).toBe(400);
    expect(error.message).toContain("credit balance is too low");
    expect(requests).toHaveLength(1);
  });

  it("keeps the contract and the key out of the error the SDK built around the request", async () => {
    const { fetch } = recordingFetch(() => json(apiError, 401));
    const error = await failure(createObjectGenerator(makeConfig(), { fetch }).generate(request));
    const everything = inspect(error, { depth: 10, showHidden: true });
    expect(everything).not.toContain("CONFIDENTIAL");
    expect(everything).not.toContain(API_KEY);
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
});
