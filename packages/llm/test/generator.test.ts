import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ModelOutputError,
  ModelRefusalError,
  createObjectGenerator,
  type LlmConfig,
} from "../src/index.js";
import { ModelRequestError } from "../src/generator.js";

const PROMPT_TEXT = "CONFIDENTIAL-PROMPT: the Supplier shall pay 4,250,000 to Acme";
const REPLY_TEXT = "CONFIDENTIAL-REPLY: clause 7.2 is unusual";
const API_KEY = "sk-test-key-that-is-not-real";

const schema = z.object({ verdict: z.enum(["ok", "bad"]) });
const request = { system: "You review contracts.", prompt: PROMPT_TEXT, schema };

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;

function reply(text: string, finish: GenerateResult["finishReason"]["unified"] = "stop") {
  return {
    content: text === "" ? [] : [{ type: "text" as const, text }],
    finishReason: { unified: finish, raw: finish },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  } satisfies GenerateResult;
}

const valid = reply('{"verdict":"ok"}');

type Step = GenerateResult | (() => Promise<GenerateResult>);

// The mock's own array form runs out after its last entry and cannot hold a function that throws,
// so this repeats the final step for as many retries as a test allows.
function sequence(...steps: Step[]): () => Promise<GenerateResult> {
  let next = 0;
  return async () => {
    const step = steps[Math.min(next, steps.length - 1)];
    next += 1;
    if (step === undefined) throw new Error("sequence needs at least one step");
    return typeof step === "function" ? step() : step;
  };
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

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("generate", () => {
  it("returns the parsed object and reports the configured provider and model", async () => {
    const model = new MockLanguageModelV4({ doGenerate: sequence(valid) });
    const generator = createObjectGenerator(makeConfig(), { model });

    await expect(generator.generate(request)).resolves.toEqual({ verdict: "ok" });
    expect(generator.provider).toBe("openai");
    expect(generator.model).toBe("test-model");
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("asks for JSON in the request's schema, with its name, and passes the prompts through", async () => {
    const model = new MockLanguageModelV4({ doGenerate: sequence(valid) });
    const generator = createObjectGenerator(makeConfig(), { model });

    await generator.generate({ ...request, schemaName: "rule_check" });

    const call = model.doGenerateCalls[0];
    expect(call?.responseFormat).toMatchObject({
      type: "json",
      name: "rule_check",
      schema: { type: "object", required: ["verdict"] },
    });
    expect(call?.maxOutputTokens).toBe(12345);
    expect(JSON.stringify(call?.prompt)).toContain("You review contracts.");
    expect(JSON.stringify(call?.prompt)).toContain(PROMPT_TEXT);
  });

  it("offers no tools and never forces one", async () => {
    const model = new MockLanguageModelV4({ doGenerate: sequence(valid) });
    await createObjectGenerator(makeConfig(), { model }).generate(request);
    expect(model.doGenerateCalls[0]?.tools ?? []).toEqual([]);
    expect(model.doGenerateCalls[0]?.toolChoice?.type ?? "auto").toBe("auto");
  });

  it("hands the abort signal to the model call", async () => {
    const model = new MockLanguageModelV4({ doGenerate: sequence(valid) });
    const controller = new AbortController();
    await createObjectGenerator(makeConfig(), { model }).generate({
      ...request,
      signal: controller.signal,
    });
    expect(model.doGenerateCalls[0]?.abortSignal).toBeInstanceOf(AbortSignal);
  });
});

describe("call settings per provider", () => {
  async function firstCall(config: LlmConfig) {
    const model = new MockLanguageModelV4({ doGenerate: sequence(valid) });
    await createObjectGenerator(config, { model }).generate(request);
    return model.doGenerateCalls[0];
  }

  it("leaves sampling alone for openai and asks it not to keep the response", async () => {
    const call = await firstCall(makeConfig());
    expect(call?.temperature).toBeUndefined();
    expect(call?.topP).toBeUndefined();
    expect(call?.providerOptions).toEqual({ openai: { store: false } });
  });

  it("sets temperature 0 for openai-compatible", async () => {
    const call = await firstCall(
      makeConfig({
        provider: "openai-compatible",
        model: "llama3.1",
        baseUrl: "http://localhost:11434/v1",
      }),
    );
    expect(call?.temperature).toBe(0);
    expect(call?.providerOptions).toBeUndefined();
  });
});

describe("output that fails the schema", () => {
  it.each([
    ["text that is not JSON", reply("Sure! Here is my answer.")],
    ["JSON that breaks the schema", reply('{"verdict":"maybe"}')],
    ["JSON of the wrong shape", reply("[1,2,3]")],
    ["an empty reply", reply("")],
  ])("retries after %s and returns the next good answer", async (_label, bad) => {
    const model = new MockLanguageModelV4({ doGenerate: sequence(bad, valid) });
    const generator = createObjectGenerator(makeConfig(), { model });

    await expect(generator.generate(request)).resolves.toEqual({ verdict: "ok" });
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it("sends the same request again on a retry", async () => {
    const model = new MockLanguageModelV4({ doGenerate: sequence(reply("nope"), valid) });
    await createObjectGenerator(makeConfig(), { model }).generate(request);
    const [first, second] = model.doGenerateCalls;
    expect(second?.prompt).toEqual(first?.prompt);
    expect(second?.responseFormat).toEqual(first?.responseFormat);
  });

  it("gives up after maxRetries more attempts with a ModelOutputError", async () => {
    const model = new MockLanguageModelV4({ doGenerate: sequence(reply(REPLY_TEXT)) });
    const generator = createObjectGenerator(makeConfig({ maxRetries: 2 }), { model });

    const error = await failure(generator.generate({ ...request, schemaName: "rule_check" }));

    expect(error).toBeInstanceOf(ModelOutputError);
    expect(model.doGenerateCalls).toHaveLength(3);
    const message = (error as Error).message;
    expect(message).toContain("openai");
    expect(message).toContain("test-model");
    expect(message).toContain("rule_check");
    expect(message).toContain("3 attempts");
  });

  it("leaks neither the prompt nor the reply anywhere in the error", async () => {
    const model = new MockLanguageModelV4({ doGenerate: sequence(reply(REPLY_TEXT)) });
    const generator = createObjectGenerator(makeConfig(), { model });

    const error = (await failure(generator.generate(request))) as Error;

    const everything = [error.message, error.stack, inspect(error, { depth: 10 })].join("\n");
    expect(everything).not.toContain("CONFIDENTIAL");
    expect(everything).not.toContain(API_KEY);
    expect(error.cause).toBeUndefined();
  });

  it("makes exactly one attempt when maxRetries is 0", async () => {
    const model = new MockLanguageModelV4({ doGenerate: sequence(reply("nope")) });
    const generator = createObjectGenerator(makeConfig({ maxRetries: 0 }), { model });

    const error = await failure(generator.generate(request));

    expect(error).toBeInstanceOf(ModelOutputError);
    expect((error as Error).message).toContain("1 attempt.");
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("tells the user to raise the token limit when the reply was cut off", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: sequence(reply('{"verdict":"o', "length")),
    });
    const generator = createObjectGenerator(makeConfig({ maxRetries: 1 }), { model });

    const error = (await failure(generator.generate(request))) as Error;

    expect(error).toBeInstanceOf(ModelOutputError);
    expect(error.message).toContain("CLAUSEWISE_MAX_OUTPUT_TOKENS");
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it("does not suggest a bigger token limit when the reply was not cut off", async () => {
    const model = new MockLanguageModelV4({ doGenerate: sequence(reply("nope")) });
    const error = (await failure(
      createObjectGenerator(makeConfig(), { model }).generate(request),
    )) as Error;
    expect(error.message).not.toContain("CLAUSEWISE_MAX_OUTPUT_TOKENS");
  });
});

describe("refusals", () => {
  it.each([
    ["no text at all", reply("", "content-filter")],
    ["partial text that is not JSON", reply('{"verdict":', "content-filter")],
    ["text that happens to fit the schema", reply('{"verdict":"ok"}', "content-filter")],
  ])(
    "throws ModelRefusalError for a content-filter stop with %s, without retrying",
    async (_label, refused) => {
      const model = new MockLanguageModelV4({ doGenerate: sequence(refused, valid) });
      const generator = createObjectGenerator(makeConfig({ maxRetries: 2 }), { model });

      const error = await failure(generator.generate(request));

      expect(error).toBeInstanceOf(ModelRefusalError);
      expect(error).not.toBeInstanceOf(ModelOutputError);
      expect((error as Error).message).toContain("openai");
      expect((error as Error).message).toContain("test-model");
      expect(model.doGenerateCalls).toHaveLength(1);
    },
  );

  it("does not put the prompt or the reply in the refusal", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: sequence(reply(REPLY_TEXT, "content-filter")),
    });
    const error = (await failure(
      createObjectGenerator(makeConfig(), { model }).generate(request),
    )) as Error;
    expect(inspect(error, { depth: 10 })).not.toContain("CONFIDENTIAL");
  });

  it("still retries when a refusal comes after an earlier bad answer", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: sequence(reply("nope"), reply("", "content-filter"), valid),
    });
    const error = await failure(createObjectGenerator(makeConfig(), { model }).generate(request));
    expect(error).toBeInstanceOf(ModelRefusalError);
    expect(model.doGenerateCalls).toHaveLength(2);
  });
});

describe("abort", () => {
  function abortError(signal: AbortSignal): unknown {
    return signal.reason;
  }

  it("rejects with the abort reason and never calls the model when already aborted", async () => {
    const model = new MockLanguageModelV4({ doGenerate: sequence(valid) });
    const controller = new AbortController();
    controller.abort();

    const error = await failure(
      createObjectGenerator(makeConfig(), { model }).generate({
        ...request,
        signal: controller.signal,
      }),
    );

    expect(error).toBe(abortError(controller.signal));
    expect((error as Error).name).toBe("AbortError");
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("surfaces an abort during the call as the abort error, not a ModelOutputError", async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        controller.abort();
        return reply("unusable");
      },
    });

    const error = await failure(
      createObjectGenerator(makeConfig({ maxRetries: 0 }), { model }).generate({
        ...request,
        signal: controller.signal,
      }),
    );

    expect(error).toBe(controller.signal.reason);
    expect(error).not.toBeInstanceOf(ModelOutputError);
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("surfaces an abort that arrives with an empty reply, which the SDK does not parse", async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        controller.abort();
        return reply("", "other");
      },
    });

    const error = await failure(
      createObjectGenerator(makeConfig({ maxRetries: 0 }), { model }).generate({
        ...request,
        signal: controller.signal,
      }),
    );

    expect(error).toBe(controller.signal.reason);
    expect(error).not.toBeInstanceOf(ModelOutputError);
  });

  it("stops retrying once aborted", async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        controller.abort();
        return reply("unusable");
      },
    });

    const error = await failure(
      createObjectGenerator(makeConfig({ maxRetries: 5 }), { model }).generate({
        ...request,
        signal: controller.signal,
      }),
    );

    expect((error as Error).name).toBe("AbortError");
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("surfaces the abort when the transport throws because of it", async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        controller.abort(new Error("review cancelled"));
        throw controller.signal.reason;
      },
    });

    const error = await failure(
      createObjectGenerator(makeConfig(), { model }).generate({
        ...request,
        signal: controller.signal,
      }),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("review cancelled");
    expect(error).not.toBeInstanceOf(ModelRequestError);
  });
});

describe("transport failures", () => {
  function apiError(overrides: Partial<ConstructorParameters<typeof APICallError>[0]> = {}) {
    return new APICallError({
      message: "credit balance is too low",
      url: "https://api.openai.com/v1/responses",
      requestBodyValues: { messages: [{ content: PROMPT_TEXT }] },
      statusCode: 400,
      isRetryable: false,
      ...overrides,
    });
  }

  it("turns an API error into a ModelRequestError with the status and the provider's message", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw apiError();
      },
    });

    const error = (await failure(
      createObjectGenerator(makeConfig(), { model }).generate(request),
    )) as ModelRequestError;

    expect(error).toBeInstanceOf(ModelRequestError);
    expect(error.statusCode).toBe(400);
    expect(error.message).toContain("HTTP 400");
    expect(error.message).toContain("credit balance is too low");
    expect(error.message).toContain("test-model");
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("drops the request body the SDK error carried", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw apiError();
      },
    });

    const error = (await failure(
      createObjectGenerator(makeConfig(), { model }).generate(request),
    )) as Error;

    expect(inspect(error, { depth: 10 })).not.toContain("CONFIDENTIAL");
    expect(error.cause).toBeUndefined();
  });

  it("redacts the API key and shortens a very long provider message", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw apiError({ message: `bad key ${API_KEY} ${"x".repeat(1000)}` });
      },
    });

    const error = (await failure(
      createObjectGenerator(makeConfig(), { model }).generate(request),
    )) as Error;

    expect(error.message).not.toContain(API_KEY);
    expect(error.message).toContain("[redacted]");
    expect(error.message.length).toBeLessThan(500);
  });

  it("does not repeat the message of an error that is not from the provider", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new TypeError(`validation failed for value ${REPLY_TEXT}`);
      },
    });

    const error = (await failure(
      createObjectGenerator(makeConfig(), { model }).generate(request),
    )) as ModelRequestError;

    expect(error).toBeInstanceOf(ModelRequestError);
    expect(error.message).toContain("TypeError");
    expect(error.statusCode).toBeUndefined();
    expect(inspect(error, { depth: 10 })).not.toContain("CONFIDENTIAL");
  });

  it("lets the SDK retry a retryable error up to maxRetries times", async () => {
    vi.useFakeTimers();
    const model = new MockLanguageModelV4({
      doGenerate: sequence(async () => {
        throw apiError({ statusCode: 529, message: "overloaded", isRetryable: true });
      }, valid),
    });
    const generator = createObjectGenerator(makeConfig({ maxRetries: 1 }), { model });

    const outcome = generator.generate(request);
    await vi.advanceTimersByTimeAsync(5000);

    await expect(outcome).resolves.toEqual({ verdict: "ok" });
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it("reports the last error once the SDK has used up its retries", async () => {
    vi.useFakeTimers();
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw apiError({ statusCode: 529, message: "overloaded", isRetryable: true });
      },
    });
    const generator = createObjectGenerator(makeConfig({ maxRetries: 2 }), { model });

    const outcome = failure(generator.generate(request));
    await vi.advanceTimersByTimeAsync(60_000);
    const error = (await outcome) as ModelRequestError;

    expect(error).toBeInstanceOf(ModelRequestError);
    expect(error.statusCode).toBe(529);
    expect(error.message).toContain("overloaded");
    expect(model.doGenerateCalls).toHaveLength(3);
  });
});

describe("createObjectGenerator", () => {
  it("refuses a model id string, which the SDK would route to a gateway nobody configured", () => {
    expect(() => createObjectGenerator(makeConfig(), { model: "openai/some-model" })).toThrow(
      TypeError,
    );
  });

  it("serves anthropic through its own adapter and the other providers through the AI SDK", () => {
    const model = new MockLanguageModelV4({ doGenerate: sequence(valid) });
    expect(createObjectGenerator(makeConfig({ provider: "anthropic" })).cachesSharedPrefix).toBe(
      true,
    );
    expect(createObjectGenerator(makeConfig(), { model }).cachesSharedPrefix).toBeUndefined();
  });

  it("refuses a model stand-in for anthropic rather than ignore it and call the real API", () => {
    const model = new MockLanguageModelV4({ doGenerate: sequence(valid) });
    expect(() => createObjectGenerator(makeConfig({ provider: "anthropic" }), { model })).toThrow(
      TypeError,
    );
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("sends the whole prompt on the AI SDK path, which does not use sharedPrefix", async () => {
    const model = new MockLanguageModelV4({ doGenerate: sequence(valid) });
    await createObjectGenerator(makeConfig(), { model }).generate({
      ...request,
      prompt: "PREFIX rest",
      sharedPrefix: "PREFIX ",
    });
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain("PREFIX rest");
  });
});
