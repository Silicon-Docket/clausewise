import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  LlmConfigError,
  ModelOutputError,
  createAnthropicGenerator,
  createObjectGenerator,
  type LlmConfig,
} from "../src/index.js";
import { ModelRequestError } from "../src/generator.js";
import {
  API_KEY,
  PROMPT_TEXT,
  REPLY_TEXT,
  errorResponse,
  failure,
  headerText,
  json,
  makeConfig,
  messageResponse,
  recordingFetch,
  streamResponse,
  type Recorded,
} from "./anthropic-support.js";

const schema = z.object({ verdict: z.enum(["ok", "bad"]), quote: z.string().nullable() });
const request = { system: "You review contracts.", prompt: PROMPT_TEXT, schema };
const answer = JSON.stringify({ verdict: "ok", quote: null });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function everything(error: Error): string {
  return [error.message, error.stack, inspect(error, { depth: 10, showHidden: true })].join("\n");
}

function expectNoSecrets(error: Error): void {
  const text = everything(error);
  expect(text).not.toContain("CONFIDENTIAL");
  expect(text).not.toContain(API_KEY);
  expect(error.cause).toBeUndefined();
}

type Step = Response | Error | (() => Response | Promise<Response>);

// Plays steps in order and repeats the last one, for responses the recording helper cannot give:
// a request that never reaches the server throws before there is a body to record.
function playback(...steps: Step[]) {
  let calls = 0;
  const fetch = (async () => {
    const step = steps[Math.min(calls, steps.length - 1)];
    calls += 1;
    if (step === undefined) throw new Error("playback needs at least one step");
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step() : step.clone();
  }) as typeof globalThis.fetch;
  return { fetch, calls: () => calls };
}

describe("HTTP errors", () => {
  it.each([
    [400, "Your credit balance is too low.", ""],
    [401, "invalid x-api-key", "ANTHROPIC_API_KEY"],
    [403, "Access denied for this workspace.", "not allowed"],
    [404, "model: claude-nope", "CLAUSEWISE_MODEL"],
    [413, "Request too large.", ""],
    [422, "Unprocessable.", ""],
  ])(
    "maps HTTP %i to a ModelRequestError that keeps the status and does not retry",
    async (status, text, hint) => {
      const { fetch, requests } = recordingFetch(() => errorResponse(status, text));
      const error = await failure(
        createAnthropicGenerator(makeConfig(), { fetch }).generate(request),
      );

      expect(error).toBeInstanceOf(ModelRequestError);
      expect(error.name).toBe("ModelRequestError");
      expect((error as ModelRequestError).statusCode).toBe(status);
      expect(error.message).toContain(`HTTP ${status}`);
      expect(error.message).toContain(text);
      expect(error.message).toContain("anthropic (claude-sonnet-5-5)");
      expect(error.message).toContain(hint);
      expect(requests).toHaveLength(1);
      expectNoSecrets(error);
    },
  );

  it.each([
    [429, "Rate limited.", "CLAUSEWISE_CONCURRENCY"],
    [500, "Internal error.", ""],
    [529, "Overloaded.", ""],
  ])("retries HTTP %i up to maxRetries times and then reports it", async (status, text, hint) => {
    const { fetch, requests } = recordingFetch(() => errorResponse(status, text));
    const generator = createAnthropicGenerator(makeConfig({ maxRetries: 2 }), { fetch });

    const error = await failure(generator.generate(request));

    expect(error).toBeInstanceOf(ModelRequestError);
    expect((error as ModelRequestError).statusCode).toBe(status);
    expect(error.message).toContain(text);
    expect(error.message).toContain(hint);
    expect(requests).toHaveLength(3);
    expectNoSecrets(error);
  });

  it("makes one request when maxRetries is 0", async () => {
    const { fetch, requests } = recordingFetch(() => errorResponse(529, "Overloaded."));
    const generator = createAnthropicGenerator(makeConfig({ maxRetries: 0 }), { fetch });
    await failure(generator.generate(request));
    expect(requests).toHaveLength(1);
  });

  it("recovers when a retry succeeds", async () => {
    const { fetch, requests } = recordingFetch((call) =>
      call === 1 ? errorResponse(529, "Overloaded.") : messageResponse(answer),
    );
    const generator = createAnthropicGenerator(makeConfig({ maxRetries: 1 }), { fetch });
    await expect(generator.generate(request)).resolves.toEqual({ verdict: "ok", quote: null });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.body).toEqual(requests[0]?.body);
  });

  it("does not run output retries on top of an error", async () => {
    const { fetch, requests } = recordingFetch(() => errorResponse(400, "bad request"));
    await failure(
      createAnthropicGenerator(makeConfig({ maxRetries: 0 }), { fetch }).generate(request),
    );
    expect(requests).toHaveLength(1);
  });

  it("redacts the key from the provider's text and shortens a very long message", async () => {
    const { fetch } = recordingFetch(() =>
      errorResponse(401, `bad key ${API_KEY} ${"x".repeat(1000)}`),
    );
    const error = await failure(
      createAnthropicGenerator(makeConfig(), { fetch }).generate(request),
    );
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).toContain("[redacted]");
    expect(error.message.length).toBeLessThan(600);
    expectNoSecrets(error);
  });

  it("redacts a key that straddles the length cap", async () => {
    const padding = "y".repeat(295);
    const { fetch } = recordingFetch(() => errorResponse(400, `${padding}${API_KEY}`));
    const error = await failure(
      createAnthropicGenerator(makeConfig(), { fetch }).generate(request),
    );
    expect(error.message).not.toContain(API_KEY.slice(0, 8));
  });

  it("repeats only the provider's error text, not a body of some other shape", async () => {
    const { fetch } = recordingFetch(() =>
      json({ detail: "ECHOED-REQUEST-TEXT" }, 502, { "retry-after-ms": "1" }),
    );
    const error = await failure(
      createAnthropicGenerator(makeConfig(), { fetch }).generate(request),
    );
    expect((error as ModelRequestError).statusCode).toBe(502);
    expect(error.message).toContain("HTTP 502");
    expect(error.message).not.toContain("ECHOED-REQUEST-TEXT");
  });

  it("does not repeat a page a gateway answered with", async () => {
    const { fetch } = recordingFetch(
      () =>
        new Response("<html>ECHOED-GATEWAY-PAGE</html>", {
          status: 503,
          headers: { "retry-after-ms": "1" },
        }),
    );
    const error = await failure(
      createAnthropicGenerator(makeConfig(), { fetch }).generate(request),
    );
    expect((error as ModelRequestError).statusCode).toBe(503);
    expect(error.message).not.toContain("ECHOED-GATEWAY-PAGE");
  });

  it("names the request id so a report to Anthropic can quote it", async () => {
    const { fetch } = recordingFetch(() =>
      errorResponse(400, "nope", { "request-id": "req_011CSHoEeqs5C35K2UUqR7Fy" }),
    );
    const error = await failure(
      createAnthropicGenerator(makeConfig(), { fetch }).generate(request),
    );
    expect(error.message).toContain("request ID req_011CSHoEeqs5C35K2UUqR7Fy");
  });

  it("leaves out a request id that is not a plain token", async () => {
    const { fetch } = recordingFetch(() =>
      errorResponse(400, "nope", { "request-id": "<script>alert(1)</script>" }),
    );
    const error = await failure(
      createAnthropicGenerator(makeConfig(), { fetch }).generate(request),
    );
    expect(error.message).not.toContain("script");
    expect(error.message).not.toContain("request ID");
  });

  it("keeps the contract and the key out of everything it throws, for every status", async () => {
    for (const status of [400, 401, 403, 404, 429, 500]) {
      const { fetch } = recordingFetch(() => errorResponse(status, "provider text"));
      const generator = createAnthropicGenerator(makeConfig({ maxRetries: 0 }), { fetch });
      expectNoSecrets(await failure(generator.generate(request)));
    }
  });
});

describe("connection failures", () => {
  it("maps a dropped connection to a ModelRequestError without a status", async () => {
    const { fetch } = playback(new TypeError("fetch failed"));
    const generator = createAnthropicGenerator(makeConfig({ maxRetries: 0 }), { fetch });

    const error = await failure(generator.generate(request));

    expect(error).toBeInstanceOf(ModelRequestError);
    expect((error as ModelRequestError).statusCode).toBeUndefined();
    expect(error.message).toContain("no connection");
    expect(error.message).toContain("anthropic (claude-sonnet-5-5)");
  });

  it("says when the request timed out", async () => {
    const { fetch } = playback(new Error("Request timed out."));
    const generator = createAnthropicGenerator(makeConfig({ maxRetries: 0 }), { fetch });
    const error = await failure(generator.generate(request));
    expect(error).toBeInstanceOf(ModelRequestError);
    expect(error.message).toContain("timed out");
  });

  it("does not repeat what the underlying error said, which can name hosts or carry the key", async () => {
    const { fetch } = playback(
      new TypeError(`connect failed to internal-host with ${API_KEY} while sending ${PROMPT_TEXT}`),
    );
    const error = await failure(
      createAnthropicGenerator(makeConfig({ maxRetries: 0 }), { fetch }).generate(request),
    );
    expect(error.message).not.toContain("internal-host");
    expectNoSecrets(error);
  });

  it("retries a dropped connection and recovers", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = playback(new TypeError("fetch failed"), messageResponse(answer));
    const generator = createAnthropicGenerator(makeConfig({ maxRetries: 1 }), { fetch });

    const outcome = generator.generate(request);
    await vi.advanceTimersByTimeAsync(5000);

    await expect(outcome).resolves.toEqual({ verdict: "ok", quote: null });
    expect(calls()).toBe(2);
  });

  it("reports the failure once the retries are used up", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = playback(new TypeError("fetch failed"));
    const generator = createAnthropicGenerator(makeConfig({ maxRetries: 2 }), { fetch });

    const outcome = failure(generator.generate(request));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await outcome).toBeInstanceOf(ModelRequestError);
    expect(calls()).toBe(3);
  });

  it("maps a dropped connection on a streamed request too", async () => {
    const { fetch } = playback(new TypeError("fetch failed"));
    const generator = createAnthropicGenerator(
      makeConfig({ maxRetries: 0, maxOutputTokens: 64_000 }),
      { fetch },
    );
    const error = await failure(generator.generate(request));
    expect(error).toBeInstanceOf(ModelRequestError);
    expect(error.message).toContain("no connection");
  });
});

describe("failures that are not the provider's", () => {
  function clientThatThrows(thrown: unknown): Anthropic {
    return {
      messages: {
        create: async () => {
          throw thrown;
        },
      },
    } as unknown as Anthropic;
  }

  it("names the kind of an unexpected error and nothing it said", async () => {
    const client = clientThatThrows(new RangeError(`bad value ${REPLY_TEXT} ${API_KEY}`));
    const error = await failure(
      createAnthropicGenerator(makeConfig(), { client }).generate(request),
    );
    expect(error).toBeInstanceOf(ModelRequestError);
    expect(error.message).toContain("RangeError");
    expect((error as ModelRequestError).statusCode).toBeUndefined();
    expectNoSecrets(error);
  });

  it("copes with something that is not an Error at all", async () => {
    const client = clientThatThrows("a string with CONFIDENTIAL text");
    const error = await failure(
      createAnthropicGenerator(makeConfig(), { client }).generate(request),
    );
    expect(error).toBeInstanceOf(ModelRequestError);
    expect(error.message).toContain("unknown error");
    expectNoSecrets(error);
  });

  it("maps errors the SDK raises itself, such as a bad base URL, to a request error", async () => {
    const generator = createAnthropicGenerator(
      makeConfig({ baseUrl: "not a url", maxRetries: 0 }),
      {
        fetch: playback(messageResponse(answer)).fetch,
      },
    );
    const error = await failure(generator.generate(request));
    expect(error).toBeInstanceOf(ModelRequestError);
    expectNoSecrets(error);
  });
});

describe("abort", () => {
  it("rejects with the abort reason and sends nothing when already aborted", async () => {
    const { fetch, requests } = recordingFetch(() => messageResponse(answer));
    const controller = new AbortController();
    controller.abort();

    const error = await failure(
      createAnthropicGenerator(makeConfig(), { fetch }).generate({
        ...request,
        signal: controller.signal,
      }),
    );

    expect(error).toBe(controller.signal.reason);
    expect(error.name).toBe("AbortError");
    expect(requests).toHaveLength(0);
  });

  it("hands the signal to the request, so aborting cancels it", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const sent = new Promise<void>((resolve) => (started = resolve));
    const fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
        started();
      })) as typeof globalThis.fetch;

    const outcome = failure(
      createAnthropicGenerator(makeConfig(), { fetch }).generate({
        ...request,
        signal: controller.signal,
      }),
    );
    await sent;
    controller.abort(new Error("review cancelled"));

    const error = await outcome;
    expect(error.message).toBe("review cancelled");
    expect(error).toBe(controller.signal.reason);
    expect(error).not.toBeInstanceOf(ModelRequestError);
  });

  it("hands the signal to a streamed request too", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const sent = new Promise<void>((resolve) => (started = resolve));
    const fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
        started();
      })) as typeof globalThis.fetch;

    const outcome = failure(
      createAnthropicGenerator(makeConfig({ maxOutputTokens: 64_000 }), { fetch }).generate({
        ...request,
        signal: controller.signal,
      }),
    );
    await sent;
    controller.abort(new Error("review cancelled"));

    const error = await outcome;
    expect(error).toBe(controller.signal.reason);
    expect(error).not.toBeInstanceOf(ModelRequestError);
  });

  it("surfaces an abort that arrives with unusable output, not a ModelOutputError", async () => {
    const controller = new AbortController();
    const { fetch, requests } = recordingFetch(() => {
      controller.abort();
      return messageResponse("unusable");
    });

    const error = await failure(
      createAnthropicGenerator(makeConfig({ maxRetries: 5 }), { fetch }).generate({
        ...request,
        signal: controller.signal,
      }),
    );

    expect(error).toBe(controller.signal.reason);
    expect(error).not.toBeInstanceOf(ModelOutputError);
    expect(requests).toHaveLength(1);
  });

  it("surfaces an abort that arrives with an empty reply", async () => {
    const controller = new AbortController();
    const { fetch } = recordingFetch(() => {
      controller.abort();
      return messageResponse("");
    });
    const error = await failure(
      createAnthropicGenerator(makeConfig({ maxRetries: 0 }), { fetch }).generate({
        ...request,
        signal: controller.signal,
      }),
    );
    expect(error).toBe(controller.signal.reason);
    expect(error).not.toBeInstanceOf(ModelOutputError);
  });

  it("surfaces the abort when the transport fails because of it", async () => {
    const controller = new AbortController();
    const { fetch } = recordingFetch(() => {
      controller.abort(new Error("review cancelled"));
      throw controller.signal.reason;
    });
    const error = await failure(
      createAnthropicGenerator(makeConfig(), { fetch }).generate({
        ...request,
        signal: controller.signal,
      }),
    );
    expect(error.message).toBe("review cancelled");
    expect(error).not.toBeInstanceOf(ModelRequestError);
  });

  it("prefers the abort over an HTTP error that arrives with it", async () => {
    const controller = new AbortController();
    const { fetch } = recordingFetch(() => {
      controller.abort();
      return errorResponse(401, "invalid x-api-key");
    });
    const error = await failure(
      createAnthropicGenerator(makeConfig(), { fetch }).generate({
        ...request,
        signal: controller.signal,
      }),
    );
    expect(error).toBe(controller.signal.reason);
  });

  it("does not start another attempt once aborted", async () => {
    const controller = new AbortController();
    const { fetch, requests } = recordingFetch((call) => {
      if (call === 1) controller.abort();
      return messageResponse("unusable");
    });
    await failure(
      createAnthropicGenerator(makeConfig({ maxRetries: 5 }), { fetch }).generate({
        ...request,
        signal: controller.signal,
      }),
    );
    expect(requests).toHaveLength(1);
  });
});

describe("credentials and addresses taken from the environment", () => {
  const profileDirs: string[] = [];

  afterEach(() => {
    for (const dir of profileDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function sent(config: LlmConfig = makeConfig()): Promise<Recorded> {
    const { fetch, requests } = recordingFetch(() => messageResponse(answer));
    await createObjectGenerator(config, { fetch }).generate(request);
    const only = requests[0];
    if (only === undefined) throw new Error("no request was sent");
    return only;
  }

  function expectConfiguredKeyOnly(request: Recorded): void {
    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request.headers.get("x-api-key")).toBe(API_KEY);
    expect(request.headers.get("authorization")).toBeNull();
  }

  it("ignores ANTHROPIC_BASE_URL and sends to the host the disclosure names", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://elsewhere.example.com");
    expectConfiguredKeyOnly(await sent());
  });

  it("uses the configured base URL over ANTHROPIC_BASE_URL", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://elsewhere.example.com");
    const request = await sent(makeConfig({ baseUrl: "https://gateway.example.com" }));
    expect(request.url).toBe("https://gateway.example.com/v1/messages");
  });

  it("ignores ANTHROPIC_AUTH_TOKEN instead of sending it next to the key", async () => {
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "token-from-another-tool");
    const request = await sent();
    expectConfiguredKeyOnly(request);
    expect(headerText(request.headers)).not.toContain("token-from-another-tool");
  });

  it("ignores ANTHROPIC_API_KEY in favour of the configured key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "key-from-the-environment");
    expectConfiguredKeyOnly(await sent());
  });

  it("ignores ANTHROPIC_PROFILE and a profile that would redirect and re-authenticate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clausewise-llm-profile-"));
    profileDirs.push(dir);
    mkdirSync(join(dir, "configs"));
    writeFileSync(
      join(dir, "configs", "work.json"),
      JSON.stringify({
        version: "1.0",
        base_url: "https://profile.example.com",
        authentication: { type: "user_oauth", client_id: "" },
      }),
    );
    vi.stubEnv("ANTHROPIC_CONFIG_DIR", dir);
    vi.stubEnv("ANTHROPIC_PROFILE", "work");
    const request = await sent();
    expectConfiguredKeyOnly(request);
    expect(headerText(request.headers)).not.toContain("oauth");
  });

  it("does not let ANTHROPIC_CUSTOM_HEADERS swap the key or add a second credential", async () => {
    vi.stubEnv(
      "ANTHROPIC_CUSTOM_HEADERS",
      "Authorization: Bearer from-custom-headers\nX-Api-Key: other-key",
    );
    const request = await sent();
    expectConfiguredKeyOnly(request);
    expect(headerText(request.headers)).not.toContain("from-custom-headers");
    expect(headerText(request.headers)).not.toContain("other-key");
  });

  it("holds for a streamed request too", async () => {
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "token-from-another-tool");
    vi.stubEnv(
      "ANTHROPIC_CUSTOM_HEADERS",
      "Authorization: Bearer from-custom-headers\nX-Api-Key: other-key",
    );
    const { fetch, requests } = recordingFetch(() => streamResponse(answer));
    await createAnthropicGenerator(makeConfig({ maxOutputTokens: 64_000 }), { fetch }).generate(
      request,
    );
    const sentRequest = requests[0] as Recorded;
    expect(sentRequest.body.stream).toBe(true);
    expectConfiguredKeyOnly(sentRequest);
    expect(headerText(sentRequest.headers)).not.toContain("from-custom-headers");
  });

  it("keeps the SDK from logging request bodies when ANTHROPIC_LOG asks for debug output", async () => {
    vi.stubEnv("ANTHROPIC_LOG", "debug");
    const spies = (["debug", "info", "warn", "error", "log"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    await sent();
    for (const spy of spies) {
      expect(inspect(spy.mock.calls, { depth: 10 })).not.toContain("CONFIDENTIAL");
    }
  });

  describe("without those protections, the same environment would take over", () => {
    // These show the tests above are not passing by accident: a client built the obvious way
    // does what they rule out.
    it("sends a stray token and a stray base URL", async () => {
      vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "token-from-another-tool");
      vi.stubEnv("ANTHROPIC_BASE_URL", "https://elsewhere.example.com");
      const { fetch, requests } = recordingFetch(() => messageResponse(answer));
      const bare = new Anthropic({ apiKey: API_KEY, fetch });
      await bare.messages.create({
        model: "claude-sonnet-5-5",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(requests[0]?.url).toBe("https://elsewhere.example.com/v1/messages");
      expect(requests[0]?.headers.get("authorization")).toBe("Bearer token-from-another-tool");
    });

    it("logs the request body at debug level", async () => {
      vi.stubEnv("ANTHROPIC_LOG", "debug");
      const spy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      const { fetch } = recordingFetch(() => messageResponse(answer));
      const bare = new Anthropic({ apiKey: API_KEY, fetch });
      await bare.messages.create({
        model: "claude-sonnet-5-5",
        max_tokens: 10,
        messages: [{ role: "user", content: PROMPT_TEXT }],
      });
      expect(inspect(spy.mock.calls, { depth: 10 })).toContain("CONFIDENTIAL");
    });
  });
});

describe("base URL", () => {
  async function urlFor(baseUrl: string | undefined): Promise<string> {
    const { fetch, requests } = recordingFetch(() => messageResponse(answer));
    await createAnthropicGenerator(makeConfig({ baseUrl }), { fetch }).generate(request);
    return requests[0]?.url ?? "";
  }

  it("defaults to the Anthropic API", async () => {
    expect(await urlFor(undefined)).toBe("https://api.anthropic.com/v1/messages");
  });

  it("takes the API root, as ANTHROPIC_BASE_URL does", async () => {
    expect(await urlFor("https://gateway.example.com")).toBe(
      "https://gateway.example.com/v1/messages",
    );
    expect(await urlFor("https://gateway.example.com/")).toBe(
      "https://gateway.example.com/v1/messages",
    );
  });

  it("still accepts a root that ends in /v1, as the other providers are configured", async () => {
    expect(await urlFor("https://gateway.example.com/v1")).toBe(
      "https://gateway.example.com/v1/messages",
    );
    expect(await urlFor("https://gateway.example.com/v1/")).toBe(
      "https://gateway.example.com/v1/messages",
    );
  });

  it("keeps a path prefix a gateway lives under", async () => {
    expect(await urlFor("https://gateway.example.com/anthropic")).toBe(
      "https://gateway.example.com/anthropic/v1/messages",
    );
    expect(await urlFor("https://gateway.example.com/team/v1/")).toBe(
      "https://gateway.example.com/team/v1/messages",
    );
  });

  it("keeps the port", async () => {
    expect(await urlFor("http://localhost:4000")).toBe("http://localhost:4000/v1/messages");
  });
});

describe("construction", () => {
  it("needs a key and says which variable to set, without reading the environment", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", API_KEY);
    for (const apiKey of [undefined, ""]) {
      expect(() => createAnthropicGenerator(makeConfig({ apiKey }))).toThrow(LlmConfigError);
      expect(() => createAnthropicGenerator(makeConfig({ apiKey }))).toThrow(/ANTHROPIC_API_KEY/);
    }
  });

  it("refuses a config for another provider", () => {
    const config = makeConfig({ provider: "openai", model: "m" });
    expect(() => createAnthropicGenerator(config)).toThrow(LlmConfigError);
  });

  it("refuses fallback together with a custom base URL, and says so", () => {
    const config = makeConfig({ fallback: "default", baseUrl: "https://gateway.example.com" });
    expect(() => createAnthropicGenerator(config)).toThrow(LlmConfigError);
    expect(() => createAnthropicGenerator(config)).toThrow(/CLAUSEWISE_FALLBACK/);
    expect(() => createObjectGenerator(config)).toThrow(LlmConfigError);
  });

  it("reports the configured provider and model", () => {
    const generator = createAnthropicGenerator(makeConfig({ model: "claude-opus-5-5" }));
    expect(generator.provider).toBe("anthropic");
    expect(generator.model).toBe("claude-opus-5-5");
  });

  it("names the default host in the disclosure and the overridden host when there is one", () => {
    expect(createAnthropicGenerator(makeConfig()).disclosure).toBe(
      "Anthropic API (api.anthropic.com)",
    );
    expect(
      createAnthropicGenerator(makeConfig({ baseUrl: "https://gateway.example.com:8443/v1" }))
        .disclosure,
    ).toBe("Anthropic API (gateway.example.com:8443)");
    expect(createAnthropicGenerator(makeConfig({ baseUrl: "not a url" })).disclosure).toBe(
      "Anthropic API (custom endpoint)",
    );
  });

  it("uses a client it is given instead of building one, and leaves its credentials alone", async () => {
    const { fetch, requests } = recordingFetch(() => messageResponse(answer));
    const client = new Anthropic({
      apiKey: "the-clients-own-key",
      baseURL: "https://own.example.com",
      fetch,
    });
    const generator = createAnthropicGenerator(makeConfig(), { client });

    await expect(generator.generate(request)).resolves.toEqual({ verdict: "ok", quote: null });

    expect(requests[0]?.url).toBe("https://own.example.com/v1/messages");
    expect(requests[0]?.headers.get("x-api-key")).toBe("the-clients-own-key");
  });

  it("needs no key in the config when it is given a client", async () => {
    const { fetch } = recordingFetch(() => messageResponse(answer));
    const client = new Anthropic({ apiKey: "the-clients-own-key", fetch });
    const generator = createAnthropicGenerator(makeConfig({ apiKey: undefined }), { client });
    await expect(generator.generate(request)).resolves.toEqual({ verdict: "ok", quote: null });
  });

  it("works through createObjectGenerator with a client", async () => {
    const { fetch, requests } = recordingFetch(() => messageResponse(answer));
    const client = new Anthropic({ apiKey: "the-clients-own-key", fetch });
    await createObjectGenerator(makeConfig(), { client }).generate(request);
    expect(requests).toHaveLength(1);
  });

  it("streams through a client it is given too", async () => {
    const { fetch, requests } = recordingFetch(() => streamResponse(answer));
    const client = new Anthropic({ apiKey: "the-clients-own-key", fetch });
    const generator = createAnthropicGenerator(makeConfig({ maxOutputTokens: 64_000 }), { client });
    await expect(generator.generate(request)).resolves.toEqual({ verdict: "ok", quote: null });
    expect(requests[0]?.body.stream).toBe(true);
  });
});
