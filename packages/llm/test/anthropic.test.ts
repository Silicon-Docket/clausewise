import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ModelOutputError,
  ModelRefusalError,
  createAnthropicGenerator,
  createObjectGenerator,
  loadLlmConfig,
  type AnthropicUsage,
  type LlmConfig,
} from "../src/index.js";
import {
  API_KEY,
  PROMPT_TEXT,
  REPLY_TEXT,
  failure,
  makeConfig,
  messageResponse,
  recordingFetch,
  streamResponse,
  type Recorded,
} from "./anthropic-support.js";

const schema = z.object({
  verdict: z.enum(["ok", "bad"]),
  quote: z.string().nullable(),
});
const request = { system: "You review contracts.", prompt: PROMPT_TEXT, schema };
const answer = JSON.stringify({ verdict: "ok", quote: null });

interface Block {
  type: string;
  text: string;
  cache_control?: unknown;
}

function userBlocks(sent: Recorded): Block[] {
  const messages = sent.body.messages as { role: string; content: Block[] }[];
  expect(messages).toHaveLength(1);
  expect(messages[0]?.role).toBe("user");
  return messages[0]?.content ?? [];
}

function markerCount(sent: Recorded): number {
  return JSON.stringify(sent.body).match(/cache_control/g)?.length ?? 0;
}

function first(requests: Recorded[]): Recorded {
  const sent = requests[0];
  if (sent === undefined) throw new Error("no request was sent");
  return sent;
}

describe.each(["claude-sonnet-5-5", "claude-opus-5-5"])("anthropic request for %s", (model) => {
  async function send(overrides: Partial<LlmConfig> = {}) {
    const { fetch, requests } = recordingFetch(() => messageResponse(answer));
    const generator = createObjectGenerator(makeConfig({ model, ...overrides }), { fetch });
    const result = await generator.generate({ ...request, schemaName: "rule_check" });
    return { sent: first(requests), requests, result };
  }

  it("posts to the Messages API with the key and returns the parsed answer", async () => {
    const { sent, result, requests } = await send();
    expect(result).toEqual({ verdict: "ok", quote: null });
    expect(requests).toHaveLength(1);
    expect(sent.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("x-api-key")).toBe(API_KEY);
    expect(sent.headers.get("authorization")).toBeNull();
    expect(sent.headers.get("anthropic-beta")).toBeNull();
    expect(sent.body.model).toBe(model);
    expect(sent.body).not.toHaveProperty("stream");
  });

  it("requests native structured output built from the caller's schema", async () => {
    const { sent } = await send();
    expect(sent.body.output_config).toMatchObject({
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          required: ["verdict", "quote"],
          additionalProperties: false,
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

  it("sends the system prompt as plain text and the prompt as a user message", async () => {
    const { sent } = await send();
    expect(sent.body.system).toBe("You review contracts.");
    expect(userBlocks(sent)).toEqual([{ type: "text", text: PROMPT_TEXT }]);
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

  it("sends the same body again when it retries bad output", async () => {
    const { fetch, requests } = recordingFetch((call) =>
      messageResponse(call === 1 ? "not json" : answer),
    );
    const generator = createObjectGenerator(makeConfig({ model }), { fetch });
    await expect(generator.generate(request)).resolves.toEqual({ verdict: "ok", quote: null });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.body).toEqual(requests[0]?.body);
  });
});

describe("structured output schema", () => {
  const constrained = z.object({ score: z.number().min(1).max(5), note: z.string() });

  it("keeps constraints the API rejects out of the schema it sends", async () => {
    const { fetch, requests } = recordingFetch(() =>
      messageResponse(JSON.stringify({ score: 3, note: "fine" })),
    );
    await createAnthropicGenerator(makeConfig(), { fetch }).generate({
      ...request,
      schema: constrained,
    });
    const wire = JSON.stringify(first(requests).body.output_config);
    expect(wire).not.toContain('"minimum"');
    expect(wire).not.toContain('"maximum"');
  });

  it("still enforces them on the reply, retrying a reply that breaks one", async () => {
    const { fetch, requests } = recordingFetch((call) =>
      messageResponse(JSON.stringify({ score: call === 1 ? 9 : 4, note: "fine" })),
    );
    const result = await createAnthropicGenerator(makeConfig(), { fetch }).generate({
      ...request,
      schema: constrained,
    });
    expect(result).toEqual({ score: 4, note: "fine" });
    expect(requests).toHaveLength(2);
  });

  it("keeps enums, constants, nesting and nullable fields, which are what bind the model", async () => {
    const rich = z.object({
      status: z.enum(["compliant", "deviation"]),
      kind: z.literal("rule_check"),
      edit: z
        .object({ quote: z.string().describe("copied exactly"), replacement: z.string() })
        .nullable(),
      clauseIds: z.array(z.string()),
      minimum: z.string(),
    });
    const { fetch, requests } = recordingFetch(() => messageResponse("{}"));
    await failure(
      createAnthropicGenerator(makeConfig({ maxRetries: 0 }), { fetch }).generate({
        ...request,
        schema: rich,
      }),
    );
    expect(first(requests).body.output_config).toEqual({
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          required: ["status", "kind", "edit", "clauseIds", "minimum"],
          properties: {
            status: { type: "string", enum: ["compliant", "deviation"] },
            kind: { type: "string", const: "rule_check" },
            edit: {
              anyOf: [
                {
                  type: "object",
                  required: ["quote", "replacement"],
                  properties: {
                    quote: { type: "string", description: "copied exactly" },
                    replacement: { type: "string" },
                  },
                  additionalProperties: false,
                },
                { type: "null" },
              ],
            },
            clauseIds: { type: "array", items: { type: "string" } },
            minimum: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    });
  });

  it("drops the keywords the API cannot enforce while decoding, and only those", async () => {
    const fussy = z.object({
      text: z.string().min(3).max(9).regex(/^x/),
      count: z.number().int().min(1).max(5),
      list: z.array(z.string()).min(2).max(4),
      some: z.array(z.string()).min(1),
      flagged: z.boolean().default(false),
    });
    const { fetch, requests } = recordingFetch(() => messageResponse("{}"));
    await failure(
      createAnthropicGenerator(makeConfig({ maxRetries: 0 }), { fetch }).generate({
        ...request,
        schema: fussy,
      }),
    );
    const wire = JSON.stringify(first(requests).body.output_config);
    for (const keyword of [
      "minLength",
      "maxLength",
      "pattern",
      "minimum",
      "maximum",
      "maxItems",
      "default",
      "$schema",
    ]) {
      expect(wire).not.toContain(`"${keyword}"`);
    }
    expect(wire).toContain('"minItems":1');
    expect(wire).not.toContain('"minItems":2');
    expect(wire).toContain('"type":"integer"');
  });

  it("sends the same schema bytes on every call, so the cache entry survives", async () => {
    const { fetch, requests } = recordingFetch(() => messageResponse(answer));
    const generator = createAnthropicGenerator(makeConfig(), { fetch });
    await generator.generate(request);
    await generator.generate(request);
    expect(JSON.stringify(requests[1]?.body.output_config)).toBe(
      JSON.stringify(requests[0]?.body.output_config),
    );
  });

  it("returns what the schema makes of the reply, defaults included", async () => {
    const withDefault = z.object({ verdict: z.string(), flagged: z.boolean().default(false) });
    const { fetch } = recordingFetch(() => messageResponse('{"verdict":"ok"}'));
    const result = await createAnthropicGenerator(makeConfig(), { fetch }).generate({
      ...request,
      schema: withDefault,
    });
    expect(result).toEqual({ verdict: "ok", flagged: false });
  });
});

describe("prompt caching", () => {
  const prefix = "<contract>\nclause 1\n</contract>\n\n";
  const rule = "Check rule A.";

  async function send(overrides: { prompt?: string; sharedPrefix?: string; system?: string }) {
    const { fetch, requests } = recordingFetch(() => messageResponse(answer));
    const generator = createAnthropicGenerator(makeConfig(), { fetch });
    await generator.generate({ ...request, ...overrides });
    return first(requests);
  }

  it("reports that it caches the shared prefix", () => {
    const { fetch } = recordingFetch(() => messageResponse(answer));
    expect(createAnthropicGenerator(makeConfig(), { fetch }).cachesSharedPrefix).toBe(true);
    expect(createObjectGenerator(makeConfig(), { fetch }).cachesSharedPrefix).toBe(true);
  });

  it("splits the prompt in two and marks only the end of the shared prefix", async () => {
    const sent = await send({ prompt: prefix + rule, sharedPrefix: prefix });
    const blocks = userBlocks(sent);
    expect(blocks).toEqual([
      { type: "text", text: prefix, cache_control: { type: "ephemeral" } },
      { type: "text", text: rule },
    ]);
    expect(blocks.map((block) => block.text).join("")).toBe(prefix + rule);
    expect(markerCount(sent)).toBe(1);
  });

  it("never marks the system prompt", async () => {
    const sent = await send({ prompt: prefix + rule, sharedPrefix: prefix });
    expect(typeof sent.body.system).toBe("string");
    expect(JSON.stringify(sent.body.system)).not.toContain("cache_control");
    expect(markerCount(sent)).toBe(1);
  });

  it.each([
    ["no shared prefix", { prompt: prefix + rule }],
    ["an empty shared prefix", { prompt: prefix + rule, sharedPrefix: "" }],
    ["a whitespace-only shared prefix", { prompt: "  " + rule, sharedPrefix: "  " }],
    ["a shared prefix the prompt does not start with", { prompt: rule, sharedPrefix: prefix }],
  ])("sends one unmarked block for %s", async (_label, overrides) => {
    const sent = await send(overrides);
    expect(userBlocks(sent)).toEqual([{ type: "text", text: overrides.prompt }]);
    expect(markerCount(sent)).toBe(0);
  });

  it("sends one marked block when the prompt is only the shared prefix, never an empty one", async () => {
    const sent = await send({ prompt: prefix, sharedPrefix: prefix });
    expect(userBlocks(sent)).toEqual([
      { type: "text", text: prefix, cache_control: { type: "ephemeral" } },
    ]);
  });

  it("does the same when only whitespace follows the prefix", async () => {
    const sent = await send({ prompt: prefix + " \n", sharedPrefix: prefix });
    expect(userBlocks(sent)).toEqual([
      { type: "text", text: prefix + " \n", cache_control: { type: "ephemeral" } },
    ]);
    expect(markerCount(sent)).toBe(1);
  });

  it("keeps the marked block byte for byte the same across calls that differ in the suffix", async () => {
    const { fetch, requests } = recordingFetch(() => messageResponse(answer));
    const generator = createAnthropicGenerator(makeConfig({ effort: "high" }), { fetch });
    await generator.generate({
      ...request,
      prompt: prefix + "Check rule A.",
      sharedPrefix: prefix,
    });
    await generator.generate({
      ...request,
      prompt: prefix + "Check rule B.",
      sharedPrefix: prefix,
    });
    const [one, two] = requests;
    expect(JSON.stringify(userBlocks(one as Recorded)[0])).toBe(
      JSON.stringify(userBlocks(two as Recorded)[0]),
    );
    expect(userBlocks(one as Recorded)[1]?.text).not.toBe(userBlocks(two as Recorded)[1]?.text);
    for (const key of ["model", "max_tokens", "system", "output_config"]) {
      expect(JSON.stringify(one?.body[key])).toBe(JSON.stringify(two?.body[key]));
    }
  });

  it("omits the system parameter for an empty system prompt", async () => {
    const sent = await send({ system: "  " });
    expect(sent.body).not.toHaveProperty("system");
  });

  it("refuses an empty prompt before sending anything", async () => {
    const { fetch, requests } = recordingFetch(() => messageResponse(answer));
    const generator = createAnthropicGenerator(makeConfig(), { fetch });
    await expect(generator.generate({ ...request, prompt: " \n" })).rejects.toThrow(TypeError);
    expect(requests).toHaveLength(0);
  });
});

describe("usage", () => {
  function recorder() {
    const seen: AnthropicUsage[] = [];
    return { seen, onUsage: (usage: AnthropicUsage) => seen.push(usage) };
  }

  it("reports the token counts of a successful call", async () => {
    const { seen, onUsage } = recorder();
    const { fetch } = recordingFetch(() =>
      messageResponse(answer, {
        usage: {
          input_tokens: 12,
          output_tokens: 34,
          cache_read_input_tokens: 5600,
          cache_creation_input_tokens: 78,
        },
      }),
    );
    await createAnthropicGenerator(makeConfig(), { fetch, onUsage }).generate(request);
    expect(seen).toEqual([
      { inputTokens: 12, outputTokens: 34, cacheReadTokens: 5600, cacheWriteTokens: 78 },
    ]);
  });

  it("counts a missing or null cache figure as zero", async () => {
    const { seen, onUsage } = recorder();
    const { fetch } = recordingFetch(() =>
      messageResponse(answer, {
        usage: { cache_read_input_tokens: null, cache_creation_input_tokens: null },
      }),
    );
    await createAnthropicGenerator(makeConfig(), { fetch, onUsage }).generate(request);
    expect(seen).toEqual([
      { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
  });

  it("reports every response, so cut-off, rejected and refused calls still count", async () => {
    const { seen, onUsage } = recorder();
    const replies = [
      messageResponse('{"verdict":"o', { stopReason: "max_tokens", usage: { output_tokens: 99 } }),
      messageResponse("not json", { usage: { output_tokens: 7 } }),
      messageResponse("", { stopReason: "refusal", usage: { output_tokens: 1 } }),
    ];
    const { fetch } = recordingFetch((call) => replies[call - 1] ?? messageResponse(answer));
    const generator = createAnthropicGenerator(makeConfig({ maxRetries: 5 }), { fetch, onUsage });
    await expect(generator.generate(request)).rejects.toBeInstanceOf(ModelRefusalError);
    expect(seen.map((usage) => usage.outputTokens)).toEqual([99, 7, 1]);
  });

  it("reports nothing for a call that never got a response", async () => {
    const { seen, onUsage } = recorder();
    const { fetch } = recordingFetch(() => new Response("{}", { status: 400 }));
    const generator = createAnthropicGenerator(makeConfig(), { fetch, onUsage });
    await failure(generator.generate(request));
    expect(seen).toEqual([]);
  });

  it("is passed through createObjectGenerator", async () => {
    const onUsage = vi.fn();
    const { fetch } = recordingFetch(() => messageResponse(answer));
    await createObjectGenerator(makeConfig(), { fetch, onUsage }).generate(request);
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it("carries no text from the prompt or the reply", async () => {
    const { seen, onUsage } = recorder();
    const { fetch } = recordingFetch(() => messageResponse(answer));
    await createAnthropicGenerator(makeConfig(), { fetch, onUsage }).generate(request);
    expect(Object.keys(seen[0] ?? {}).sort()).toEqual([
      "cacheReadTokens",
      "cacheWriteTokens",
      "inputTokens",
      "outputTokens",
    ]);
  });
});

describe("replies that do not fit the schema", () => {
  it.each([
    ["text that is not JSON", messageResponse("Sure! Here is my answer.")],
    ["JSON that breaks the schema", messageResponse('{"verdict":"maybe","quote":null}')],
    ["JSON of the wrong shape", messageResponse("[1,2,3]")],
    ["an empty reply", messageResponse("")],
    [
      "a reply with only a thinking block",
      messageResponse("", { content: [{ type: "thinking", thinking: "", signature: "sig" }] }),
    ],
  ])("retries after %s and returns the next good answer", async (_label, bad) => {
    const { fetch, requests } = recordingFetch((call) =>
      call === 1 ? bad : messageResponse(answer),
    );
    const generator = createAnthropicGenerator(makeConfig(), { fetch });
    await expect(generator.generate(request)).resolves.toEqual({ verdict: "ok", quote: null });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.body).toEqual(requests[0]?.body);
  });

  it("gives up after maxRetries more attempts with a ModelOutputError", async () => {
    const { fetch, requests } = recordingFetch(() => messageResponse(REPLY_TEXT));
    const generator = createAnthropicGenerator(makeConfig({ maxRetries: 2 }), { fetch });

    const error = await failure(generator.generate({ ...request, schemaName: "rule_check" }));

    expect(error).toBeInstanceOf(ModelOutputError);
    expect(requests).toHaveLength(3);
    expect(error.message).toContain("anthropic");
    expect(error.message).toContain("claude-sonnet-5-5");
    expect(error.message).toContain("rule_check");
    expect(error.message).toContain("3 attempts");
  });

  it("leaks neither the prompt, the reply nor the key anywhere in the error", async () => {
    const { fetch } = recordingFetch(() => messageResponse(REPLY_TEXT));
    const error = await failure(
      createAnthropicGenerator(makeConfig(), { fetch }).generate(request),
    );
    const everything = [
      error.message,
      error.stack,
      inspect(error, { depth: 10, showHidden: true }),
    ];
    for (const text of everything) {
      expect(text).not.toContain("CONFIDENTIAL");
      expect(text).not.toContain(API_KEY);
    }
    expect(error.cause).toBeUndefined();
  });

  it("makes exactly one attempt when maxRetries is 0", async () => {
    const { fetch, requests } = recordingFetch(() => messageResponse("nope"));
    const error = await failure(
      createAnthropicGenerator(makeConfig({ maxRetries: 0 }), { fetch }).generate(request),
    );
    expect(error).toBeInstanceOf(ModelOutputError);
    expect(error.message).toContain("1 attempt.");
    expect(requests).toHaveLength(1);
  });

  it("joins a reply that arrives in several text blocks without adding anything between", async () => {
    const { fetch } = recordingFetch(() =>
      messageResponse("", {
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "text", text: '{"verdict":"o' },
          { type: "text", text: 'k","quote":null}' },
        ],
      }),
    );
    const result = await createAnthropicGenerator(makeConfig(), { fetch }).generate(request);
    expect(result).toEqual({ verdict: "ok", quote: null });
  });

  it("does not suggest a bigger token limit when the reply was not cut off", async () => {
    const { fetch } = recordingFetch(() => messageResponse("nope"));
    const error = await failure(
      createAnthropicGenerator(makeConfig(), { fetch }).generate(request),
    );
    expect(error.message).not.toContain("CLAUSEWISE_MAX_OUTPUT_TOKENS");
  });

  it("fails clearly when a gateway answers 200 with something that is not a message", async () => {
    const { fetch } = recordingFetch(
      () => new Response("<html>REPLY-FROM-GATEWAY</html>", { status: 200 }),
    );
    const error = await failure(
      createAnthropicGenerator(makeConfig(), { fetch }).generate(request),
    );
    expect(error.name).toBe("ModelRequestError");
    expect(error.message).toContain("not a Messages API response");
    expect(error.message).not.toContain("REPLY-FROM-GATEWAY");
  });
});

describe("stop reasons", () => {
  const refused = {
    stopReason: "refusal",
    stopDetails: { type: "refusal", category: "cyber", explanation: "EXPLANATION-TEXT" },
  };

  it("maps a refusal to ModelRefusalError with its category, without retrying", async () => {
    const onUsage = vi.fn();
    const { fetch, requests } = recordingFetch(() => messageResponse("", refused));
    const generator = createAnthropicGenerator(makeConfig({ maxRetries: 3 }), { fetch, onUsage });

    const error = await failure(generator.generate(request));

    expect(error).toBeInstanceOf(ModelRefusalError);
    expect(error).not.toBeInstanceOf(ModelOutputError);
    expect((error as ModelRefusalError).category).toBe("cyber");
    expect(error.message).toContain("anthropic");
    expect(error.message).toContain("claude-sonnet-5-5");
    expect(error.message).toContain("cyber");
    expect(error.message).not.toContain("EXPLANATION-TEXT");
    expect(requests).toHaveLength(1);
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it("leaves the category unset when the refusal names none", async () => {
    const { fetch } = recordingFetch(() =>
      messageResponse("", {
        stopReason: "refusal",
        stopDetails: { type: "refusal", category: null, explanation: null },
      }),
    );
    const error = await failure(
      createAnthropicGenerator(makeConfig(), { fetch }).generate(request),
    );
    expect(error).toBeInstanceOf(ModelRefusalError);
    expect((error as ModelRefusalError).category).toBeUndefined();
    expect(error.message).not.toContain("category");
  });

  it("leaves the category unset when the response has no stop details at all", async () => {
    const { fetch } = recordingFetch(() => messageResponse("", { stopReason: "refusal" }));
    const error = await failure(
      createAnthropicGenerator(makeConfig(), { fetch }).generate(request),
    );
    expect(error).toBeInstanceOf(ModelRefusalError);
    expect((error as ModelRefusalError).category).toBeUndefined();
  });

  it("does not repeat a category that is not a plain label", async () => {
    const { fetch } = recordingFetch(() =>
      messageResponse("", {
        stopReason: "refusal",
        stopDetails: { type: "refusal", category: `bad ${REPLY_TEXT}`, explanation: null },
      }),
    );
    const error = await failure(
      createAnthropicGenerator(makeConfig(), { fetch }).generate(request),
    );
    expect((error as ModelRefusalError).category).toBeUndefined();
    expect(inspect(error, { depth: 10 })).not.toContain("CONFIDENTIAL");
  });

  it.each([
    ["no text at all", ""],
    ["partial text that is not JSON", '{"verdict":'],
    ["text that happens to fit the schema", answer],
  ])("treats a refusal with %s as a refusal", async (_label, text) => {
    const { fetch, requests } = recordingFetch(() => messageResponse(text, refused));
    const error = await failure(
      createAnthropicGenerator(makeConfig({ maxRetries: 2 }), { fetch }).generate(request),
    );
    expect(error).toBeInstanceOf(ModelRefusalError);
    expect(requests).toHaveLength(1);
  });

  it("keeps the prompt and the reply out of the refusal", async () => {
    const { fetch } = recordingFetch(() => messageResponse(REPLY_TEXT, refused));
    const error = await failure(
      createAnthropicGenerator(makeConfig(), { fetch }).generate(request),
    );
    expect(inspect(error, { depth: 10, showHidden: true })).not.toContain("CONFIDENTIAL");
  });

  it("still retries when a refusal comes after an earlier bad answer", async () => {
    const { fetch, requests } = recordingFetch((call) =>
      call === 1 ? messageResponse("nope") : messageResponse("", refused),
    );
    const error = await failure(
      createAnthropicGenerator(makeConfig(), { fetch }).generate(request),
    );
    expect(error).toBeInstanceOf(ModelRefusalError);
    expect(requests).toHaveLength(2);
  });

  it("counts max_tokens as a failed attempt and retries, then succeeds", async () => {
    const { fetch, requests } = recordingFetch((call) =>
      call === 1
        ? messageResponse('{"verdict":"o', { stopReason: "max_tokens" })
        : messageResponse(answer),
    );
    const generator = createAnthropicGenerator(makeConfig(), { fetch });
    await expect(generator.generate(request)).resolves.toEqual({ verdict: "ok", quote: null });
    expect(requests).toHaveLength(2);
  });

  it("tells the user to raise the token limit when every attempt was cut off", async () => {
    const { fetch, requests } = recordingFetch(() =>
      messageResponse('{"verdict":"o', { stopReason: "max_tokens" }),
    );
    const generator = createAnthropicGenerator(makeConfig({ maxRetries: 1 }), { fetch });

    const error = await failure(generator.generate(request));

    expect(error).toBeInstanceOf(ModelOutputError);
    expect(error.message).toContain("CLAUSEWISE_MAX_OUTPUT_TOKENS");
    expect(requests).toHaveLength(2);
  });

  it("only blames the token limit when the last attempt was the one cut off", async () => {
    const { fetch } = recordingFetch((call) =>
      call === 1
        ? messageResponse('{"verdict":"o', { stopReason: "max_tokens" })
        : messageResponse("not json"),
    );
    const error = await failure(
      createAnthropicGenerator(makeConfig({ maxRetries: 1 }), { fetch }).generate(request),
    );
    expect(error.message).not.toContain("CLAUSEWISE_MAX_OUTPUT_TOKENS");
  });

  it("uses a reply that is complete and valid even if the stop reason says max_tokens", async () => {
    const { fetch, requests } = recordingFetch(() =>
      messageResponse(answer, { stopReason: "max_tokens" }),
    );
    const generator = createAnthropicGenerator(makeConfig(), { fetch });
    await expect(generator.generate(request)).resolves.toEqual({ verdict: "ok", quote: null });
    expect(requests).toHaveLength(1);
  });
});

describe("a limit above what one request may wait for", () => {
  // The SDK refuses a non-streaming request above this, so the adapter streams from here up.
  const LAST_NON_STREAMING = 21_333;

  it("sends a plain request at the largest limit the SDK allows without streaming", async () => {
    const { fetch, requests } = recordingFetch(() => messageResponse(answer));
    const generator = createAnthropicGenerator(
      makeConfig({ maxOutputTokens: LAST_NON_STREAMING }),
      {
        fetch,
      },
    );
    await generator.generate(request);
    expect(first(requests).body.max_tokens).toBe(LAST_NON_STREAMING);
    expect(first(requests).body).not.toHaveProperty("stream");
  });

  it.each([LAST_NON_STREAMING + 1, 32_000, 64_000, 128_000])(
    "streams the request when max_tokens is %i and parses the final message",
    async (maxOutputTokens) => {
      const { fetch, requests } = recordingFetch(() => streamResponse(answer));
      const generator = createAnthropicGenerator(makeConfig({ maxOutputTokens }), { fetch });

      await expect(generator.generate(request)).resolves.toEqual({ verdict: "ok", quote: null });

      const sent = first(requests);
      expect(sent.body.stream).toBe(true);
      expect(sent.body.max_tokens).toBe(maxOutputTokens);
      expect(sent.url).toBe("https://api.anthropic.com/v1/messages");
      expect(sent.body).not.toHaveProperty("tools");
      expect(sent.body).not.toHaveProperty("tool_choice");
      expect(sent.body).not.toHaveProperty("thinking");
      expect(sent.body).not.toHaveProperty("temperature");
      expect(sent.body.output_config).toHaveProperty("format.type", "json_schema");
    },
  );

  it("marks the shared prefix the same way when streaming", async () => {
    const { fetch, requests } = recordingFetch(() => streamResponse(answer));
    const generator = createAnthropicGenerator(makeConfig({ maxOutputTokens: 64_000 }), { fetch });
    await generator.generate({ ...request, prompt: "PREFIX rule", sharedPrefix: "PREFIX " });
    expect(userBlocks(first(requests))).toEqual([
      { type: "text", text: "PREFIX ", cache_control: { type: "ephemeral" } },
      { type: "text", text: "rule" },
    ]);
  });

  it("sends effort when streaming too", async () => {
    const { fetch, requests } = recordingFetch(() => streamResponse(answer));
    const generator = createAnthropicGenerator(
      makeConfig({ maxOutputTokens: 64_000, effort: "max" }),
      { fetch },
    );
    await generator.generate(request);
    expect(first(requests).body.output_config).toMatchObject({ effort: "max" });
  });

  it("reports usage from the streamed message, cache figures included", async () => {
    const seen: AnthropicUsage[] = [];
    const { fetch } = recordingFetch(() =>
      streamResponse(answer, {
        usage: {
          input_tokens: 21,
          output_tokens: 43,
          cache_read_input_tokens: 6500,
          cache_creation_input_tokens: 87,
        },
      }),
    );
    const generator = createAnthropicGenerator(makeConfig({ maxOutputTokens: 64_000 }), {
      fetch,
      onUsage: (usage) => seen.push(usage),
    });
    await generator.generate(request);
    expect(seen).toEqual([
      { inputTokens: 21, outputTokens: 43, cacheReadTokens: 6500, cacheWriteTokens: 87 },
    ]);
  });

  it("joins text blocks of a streamed reply without a separator", async () => {
    const { fetch } = recordingFetch(() =>
      streamResponse("", {
        content: [
          { type: "text", text: '{"verdict":"o' },
          { type: "text", text: 'k","quote":null}' },
        ],
      }),
    );
    const generator = createAnthropicGenerator(makeConfig({ maxOutputTokens: 64_000 }), { fetch });
    await expect(generator.generate(request)).resolves.toEqual({ verdict: "ok", quote: null });
  });

  it("maps a streamed refusal to ModelRefusalError with its category", async () => {
    const { fetch, requests } = recordingFetch(() =>
      streamResponse('{"verdict":', {
        stopReason: "refusal",
        stopDetails: { type: "refusal", category: "bio", explanation: null },
      }),
    );
    const generator = createAnthropicGenerator(
      makeConfig({ maxOutputTokens: 64_000, maxRetries: 3 }),
      { fetch },
    );
    const error = await failure(generator.generate(request));
    expect(error).toBeInstanceOf(ModelRefusalError);
    expect((error as ModelRefusalError).category).toBe("bio");
    expect(requests).toHaveLength(1);
  });

  it("treats a streamed reply cut off at max_tokens like a non-streamed one", async () => {
    const { fetch, requests } = recordingFetch((call) =>
      call === 1
        ? streamResponse('{"verdict":"o', { stopReason: "max_tokens" })
        : streamResponse(answer),
    );
    const generator = createAnthropicGenerator(makeConfig({ maxOutputTokens: 64_000 }), { fetch });
    await expect(generator.generate(request)).resolves.toEqual({ verdict: "ok", quote: null });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.body).toEqual(requests[0]?.body);
  });

  it("retries streamed output that breaks the schema, then gives up with ModelOutputError", async () => {
    const { fetch, requests } = recordingFetch(() => streamResponse(REPLY_TEXT));
    const generator = createAnthropicGenerator(
      makeConfig({ maxOutputTokens: 64_000, maxRetries: 1 }),
      { fetch },
    );
    const error = await failure(generator.generate(request));
    expect(error).toBeInstanceOf(ModelOutputError);
    expect(requests).toHaveLength(2);
    expect(inspect(error, { depth: 10, showHidden: true })).not.toContain("CONFIDENTIAL");
  });
});

describe("server-side fallback", () => {
  const BETA = "server-side-fallback-2026-07-01";

  it("is off unless configured: no beta endpoint, header or fallbacks field", async () => {
    const { fetch, requests } = recordingFetch(() => messageResponse(answer));
    await createAnthropicGenerator(makeConfig(), { fetch }).generate(request);
    const sent = first(requests);
    expect(sent.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent.headers.get("anthropic-beta")).toBeNull();
    expect(sent.body).not.toHaveProperty("fallbacks");
    expect(sent.body).not.toHaveProperty("betas");
  });

  it("asks for the default fallback through the beta Messages API, with the same body otherwise", async () => {
    const plain = recordingFetch(() => messageResponse(answer));
    const withFallback = recordingFetch(() => messageResponse(answer));
    const config = makeConfig({ effort: "high" });
    const prompt = { ...request, prompt: "PREFIX rule", sharedPrefix: "PREFIX " };
    await createAnthropicGenerator(config, { fetch: plain.fetch }).generate(prompt);
    await createAnthropicGenerator(
      { ...config, fallback: "default" },
      {
        fetch: withFallback.fetch,
      },
    ).generate(prompt);

    const sent = first(withFallback.requests);
    expect(sent.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(sent.headers.get("anthropic-beta")).toBe(BETA);
    expect(sent.headers.get("x-api-key")).toBe(API_KEY);
    expect(sent.body.fallbacks).toBe("default");
    expect(sent.body).not.toHaveProperty("betas");
    const { fallbacks: _fallbacks, ...rest } = sent.body;
    expect(rest).toEqual(first(plain.requests).body);
    expect(markerCount(sent)).toBe(1);
  });

  it.each([
    ["tools", "tools"],
    ["tool_choice", "tool_choice"],
    ["thinking", "thinking"],
    ["temperature", "temperature"],
  ])("still sends no %s", async (_label, key) => {
    const { fetch, requests } = recordingFetch(() => messageResponse(answer));
    await createAnthropicGenerator(makeConfig({ fallback: "default" }), { fetch }).generate(
      request,
    );
    expect(first(requests).body).not.toHaveProperty(key);
  });

  it("works through createObjectGenerator", async () => {
    const { fetch, requests } = recordingFetch(() => messageResponse(answer));
    await createObjectGenerator(makeConfig({ fallback: "default" }), { fetch }).generate(request);
    expect(first(requests).body.fallbacks).toBe("default");
  });

  it("is switched on by CLAUSEWISE_FALLBACK=default and by nothing else", async () => {
    const on = recordingFetch(() => messageResponse(answer));
    const off = recordingFetch(() => messageResponse(answer));
    const env = { ANTHROPIC_API_KEY: API_KEY };
    await createObjectGenerator(loadLlmConfig({ ...env, CLAUSEWISE_FALLBACK: "default" }), {
      fetch: on.fetch,
    }).generate(request);
    await createObjectGenerator(loadLlmConfig(env), { fetch: off.fetch }).generate(request);
    expect(first(on.requests).body.fallbacks).toBe("default");
    expect(first(off.requests).body).not.toHaveProperty("fallbacks");
  });

  it("streams through the beta API for a large limit", async () => {
    const { fetch, requests } = recordingFetch(() => streamResponse(answer));
    const generator = createAnthropicGenerator(
      makeConfig({ fallback: "default", maxOutputTokens: 64_000 }),
      { fetch },
    );
    await expect(generator.generate(request)).resolves.toEqual({ verdict: "ok", quote: null });
    const sent = first(requests);
    expect(sent.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(sent.headers.get("anthropic-beta")).toBe(BETA);
    expect(sent.body.stream).toBe(true);
    expect(sent.body.fallbacks).toBe("default");
  });

  it("uses only what follows the last fallback block, since the text before it was declined", async () => {
    const hop = {
      type: "fallback",
      from: { model: "claude-sonnet-5-5" },
      to: { model: "claude-opus-5-5" },
      trigger: { type: "refusal", category: "cyber" },
    };
    const { fetch } = recordingFetch(() =>
      messageResponse("", {
        content: [{ type: "text", text: '{"verdict":"ba' }, hop, { type: "text", text: answer }],
      }),
    );
    const generator = createAnthropicGenerator(makeConfig({ fallback: "default" }), { fetch });
    await expect(generator.generate(request)).resolves.toEqual({ verdict: "ok", quote: null });
  });

  it("still reports a refusal when the whole chain declined", async () => {
    const { fetch, requests } = recordingFetch(() =>
      messageResponse("", {
        stopReason: "refusal",
        stopDetails: { type: "refusal", category: "bio", explanation: null },
      }),
    );
    const generator = createAnthropicGenerator(makeConfig({ fallback: "default" }), { fetch });
    const error = await failure(generator.generate(request));
    expect(error).toBeInstanceOf(ModelRefusalError);
    expect((error as ModelRefusalError).category).toBe("bio");
    expect(requests).toHaveLength(1);
  });
});
