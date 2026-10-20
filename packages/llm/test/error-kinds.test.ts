import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ModelRequestError,
  createObjectGenerator,
  type LlmConfig,
  type ModelRequestKind,
} from "../src/index.js";
import {
  API_KEY,
  PROMPT_TEXT,
  failure,
  json,
  makeConfig,
  recordingFetch,
} from "./anthropic-support.js";
import { openaiError } from "./openai-support.js";

const schema = z.object({ verdict: z.enum(["ok", "bad"]) });
const request = { system: "You review contracts.", prompt: PROMPT_TEXT, schema };

describe("ModelRequestError defaults", () => {
  it.each<[number | undefined, ModelRequestKind, boolean]>([
    [401, "auth", true],
    [402, "billing", true],
    [403, "permission", true],
    [404, "not_found", true],
    [429, "rate_limit", false],
    [500, "server", false],
    [502, "server", false],
    [503, "server", false],
    [529, "overloaded", false],
    [400, "other", false],
    [413, "other", false],
    [307, "other", false],
    [undefined, "other", false],
  ])("derives the kind and fatality of status %s", (status, kind, fatal) => {
    const error = new ModelRequestError("message", status);
    expect(error.kind).toBe(kind);
    expect(error.fatal).toBe(fatal);
    expect(error.statusCode).toBe(status);
  });

  it("lets the caller state the fatality and the kind", () => {
    const stated = new ModelRequestError("m", 400, true, "billing");
    expect(stated.fatal).toBe(true);
    expect(stated.kind).toBe("billing");
    expect(new ModelRequestError("m", 401, false).fatal).toBe(false);
    expect(new ModelRequestError("m", undefined, false, "network").kind).toBe("network");
  });

  it("derives the fatality from a stated kind", () => {
    expect(new ModelRequestError("m", 400, undefined, "billing").fatal).toBe(true);
    expect(new ModelRequestError("m", 500, undefined, "overloaded").fatal).toBe(false);
  });
});

interface Case {
  name: string;
  status: number;
  kind: ModelRequestKind;
  fatal: boolean;
}

describe("Anthropic errors", () => {
  function body(type: string, message: string, details?: Record<string, unknown>) {
    return {
      type: "error",
      error: { type, message, ...(details === undefined ? {} : { details }) },
    };
  }

  const cases: ReadonlyArray<Case & { body: unknown }> = [
    {
      name: "a rejected key",
      status: 401,
      body: body("authentication_error", "invalid x-api-key"),
      kind: "auth",
      fatal: true,
    },
    {
      name: "a key that may not do this",
      status: 403,
      body: body("permission_error", "Not allowed."),
      kind: "permission",
      fatal: true,
    },
    {
      name: "a missing model",
      status: 404,
      body: body("not_found_error", "model: claude-nope"),
      kind: "not_found",
      fatal: true,
    },
    {
      name: "a billing problem",
      status: 402,
      body: body("billing_error", "Billing problem with this account."),
      kind: "billing",
      fatal: true,
    },
    {
      name: "a spend limit the account owner set, which comes as HTTP 400",
      status: 400,
      body: body(
        "invalid_request_error",
        "You have reached your specified API usage limits. You will regain access on 2026-11-01.",
      ),
      kind: "billing",
      fatal: true,
    },
    {
      name: "an empty credit balance, which comes as HTTP 400",
      status: 400,
      body: body(
        "invalid_request_error",
        "Your credit balance is too low to access the Anthropic API.",
      ),
      kind: "billing",
      fatal: true,
    },
    {
      name: "a spend cap, which comes as HTTP 429 with no retry hint",
      status: 429,
      body: body("rate_limit_error", "Spend cap reached.", {
        error_code: "enforced_spend_limit_reached",
      }),
      kind: "billing",
      fatal: true,
    },
    {
      name: "an ordinary rate limit",
      status: 429,
      body: body("rate_limit_error", "Rate limited."),
      kind: "rate_limit",
      fatal: false,
    },
    {
      name: "an overloaded API",
      status: 529,
      body: body("overloaded_error", "Overloaded."),
      kind: "overloaded",
      fatal: false,
    },
    {
      name: "a server error",
      status: 500,
      body: body("api_error", "Internal error."),
      kind: "server",
      fatal: false,
    },
    {
      name: "a bad gateway",
      status: 502,
      body: body("api_error", "Bad gateway."),
      kind: "server",
      fatal: false,
    },
    {
      name: "a request that is wrong in some other way",
      status: 400,
      body: body("invalid_request_error", "max_tokens: too large"),
      kind: "other",
      fatal: false,
    },
    {
      name: "a request that is too large",
      status: 413,
      body: body("request_too_large", "Request too large."),
      kind: "other",
      fatal: false,
    },
  ];

  it.each(cases)("classifies $name", async ({ status, body: payload, kind, fatal }) => {
    const { fetch } = recordingFetch(() => json(payload, status, { "retry-after-ms": "1" }));
    const generator = createObjectGenerator(makeConfig({ maxRetries: 0 }), { fetch });

    const error = (await failure(generator.generate(request))) as ModelRequestError;

    expect(error).toBeInstanceOf(ModelRequestError);
    expect(error.statusCode).toBe(status);
    expect(error.kind).toBe(kind);
    expect(error.fatal).toBe(fatal);
  });

  it("tells the user to look at the account when it is a billing problem", async () => {
    const { fetch } = recordingFetch(() =>
      json(body("billing_error", "Billing problem with this account."), 402),
    );
    const error = await failure(
      createObjectGenerator(makeConfig({ maxRetries: 0 }), { fetch }).generate(request),
    );
    expect(error.message).toContain("Billing problem with this account.");
    expect(error.message).toMatch(/credit balance|spend limit/);
  });

  it("classifies a dropped connection as a network failure that a retry may cure", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed", { cause: new Error("ECONNRESET internal-host.corp") });
    }) as typeof globalThis.fetch;
    const error = (await failure(
      createObjectGenerator(makeConfig({ maxRetries: 0 }), { fetch }).generate(request),
    )) as ModelRequestError;
    expect(error.kind).toBe("network");
    expect(error.fatal).toBe(false);
    expect(error.statusCode).toBeUndefined();
    expect(error.message).not.toContain("internal-host");
  });

  it("makes one request for a fatal error even when retries are allowed", async () => {
    const { fetch, requests } = recordingFetch(() =>
      json(body("billing_error", "Billing problem."), 402),
    );
    await failure(
      createObjectGenerator(makeConfig({ maxRetries: 2 }), { fetch }).generate(request),
    );
    expect(requests).toHaveLength(1);
  });
});

describe.each([
  [
    "openai",
    (): LlmConfig =>
      makeConfig({ provider: "openai", model: "test-model", apiKey: API_KEY, maxRetries: 0 }),
  ],
  [
    "openai-compatible",
    (): LlmConfig =>
      makeConfig({
        provider: "openai-compatible",
        model: "llama3.1",
        apiKey: API_KEY,
        baseUrl: "https://llm.example.com/v1",
        maxRetries: 0,
      }),
  ],
] as const)("OpenAI-style errors from %s", (_name, configFor) => {
  const cases: ReadonlyArray<Case & { response: () => Response }> = [
    {
      name: "a rejected key",
      status: 401,
      response: () =>
        openaiError(401, {
          message: "Incorrect API key provided.",
          type: "invalid_request_error",
          code: "invalid_api_key",
        }),
      kind: "auth",
      fatal: true,
    },
    {
      name: "a key that may not do this",
      status: 403,
      response: () => openaiError(403, { message: "Country not supported.", code: "forbidden" }),
      kind: "permission",
      fatal: true,
    },
    {
      name: "a missing model",
      status: 404,
      response: () =>
        openaiError(404, { message: "The model does not exist.", code: "model_not_found" }),
      kind: "not_found",
      fatal: true,
    },
    {
      name: "a payment required answer from a gateway",
      status: 402,
      response: () => openaiError(402, { message: "Insufficient credits." }),
      kind: "billing",
      fatal: true,
    },
    {
      name: "an exhausted quota, which comes as HTTP 429",
      status: 429,
      response: () =>
        openaiError(429, {
          message: "You exceeded your current quota, please check your plan and billing details.",
          type: "insufficient_quota",
          code: "insufficient_quota",
        }),
      kind: "billing",
      fatal: true,
    },
    {
      name: "a hard billing limit, which comes as HTTP 400",
      status: 400,
      response: () =>
        openaiError(400, {
          message: "Billing hard limit has been reached.",
          type: "invalid_request_error",
          code: "billing_hard_limit_reached",
        }),
      kind: "billing",
      fatal: true,
    },
    {
      name: "an ordinary rate limit",
      status: 429,
      response: () =>
        openaiError(429, {
          message: "Rate limit reached for requests.",
          type: "requests",
          code: "rate_limit_exceeded",
        }),
      kind: "rate_limit",
      fatal: false,
    },
    {
      name: "an overloaded server",
      status: 529,
      response: () => openaiError(529, { message: "Overloaded." }),
      kind: "overloaded",
      fatal: false,
    },
    {
      name: "a 503 that says the engine is overloaded",
      status: 503,
      response: () =>
        openaiError(503, {
          message: "The engine is currently overloaded, please try again later.",
        }),
      kind: "overloaded",
      fatal: false,
    },
    {
      name: "a server error",
      status: 500,
      response: () => openaiError(500, { message: "The server had an error." }),
      kind: "server",
      fatal: false,
    },
    {
      name: "a request that is wrong in some other way",
      status: 400,
      response: () =>
        openaiError(400, { message: "Unsupported parameter.", type: "invalid_request_error" }),
      kind: "other",
      fatal: false,
    },
    {
      name: "an error page that is not JSON",
      status: 502,
      response: () => new Response("<html>Bad gateway</html>", { status: 502 }),
      kind: "server",
      fatal: false,
    },
  ];

  it.each(cases)("classifies $name", async ({ status, response, kind, fatal }) => {
    const { fetch } = recordingFetch(() => response());
    const error = (await failure(
      createObjectGenerator(configFor(), { fetch }).generate(request),
    )) as ModelRequestError;

    expect(error).toBeInstanceOf(ModelRequestError);
    expect(error.statusCode).toBe(status);
    expect(error.kind).toBe(kind);
    expect(error.fatal).toBe(fatal);
  });

  it("repeats the provider's sentence for an exhausted quota and points at the account", async () => {
    const { fetch } = recordingFetch(() =>
      openaiError(429, {
        message: "You exceeded your current quota.",
        type: "insufficient_quota",
        code: "insufficient_quota",
      }),
    );
    const error = await failure(createObjectGenerator(configFor(), { fetch }).generate(request));
    expect(error.message).toContain("You exceeded your current quota.");
    expect(error.message).toMatch(/credit balance|spend limit/);
  });

  it("classifies a dropped connection as a network failure without the cause text", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed", {
        cause: new Error("connect ECONNREFUSED 10.1.2.3:5432 CAUSE-CANARY"),
      });
    }) as typeof globalThis.fetch;

    const error = (await failure(
      createObjectGenerator(configFor(), { fetch }).generate(request),
    )) as ModelRequestError;

    expect(error.kind).toBe("network");
    expect(error.fatal).toBe(false);
    expect(error.statusCode).toBeUndefined();
    expect(error.message).not.toContain("CAUSE-CANARY");
    expect(error.message).not.toContain("10.1.2.3");
    expect(error.message).toContain("no connection");
  });
});
