import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  LlmConfigError,
  ModelRequestError,
  createManagedIdentityTokenSource,
  createObjectGenerator,
  loadLlmConfig,
  type LlmConfig,
} from "../src/index.js";
import { json } from "./anthropic-support.js";
import { chatCompletion, openaiError } from "./openai-support.js";

const CLIENT_ID = "6f1b4b8e-2c3d-4e5f-8a9b-0c1d2e3f4a5b";
const IDENTITY_HEADER = "identity-header-value-that-must-not-leak";
const TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.token-that-must-not-leak";
const IDENTITY_ENDPOINT = "http://localhost:42356/msi/token";
const BASE_URL = "https://contoso-legal.openai.azure.com/openai/v1";

const env = (overrides: Record<string, string | undefined> = {}) => ({
  CLAUSEWISE_PROVIDER: "azure-openai",
  CLAUSEWISE_MODEL: "review-gpt",
  CLAUSEWISE_BASE_URL: BASE_URL,
  IDENTITY_ENDPOINT,
  IDENTITY_HEADER,
  AZURE_CLIENT_ID: CLIENT_ID,
  ...overrides,
});

function configError(values: Record<string, string | undefined>): LlmConfigError {
  try {
    loadLlmConfig(values);
  } catch (error) {
    expect(error).toBeInstanceOf(LlmConfigError);
    return error as LlmConfigError;
  }
  throw new Error("expected loadLlmConfig to throw");
}

/** The current time in seconds plus `seconds`, as the token service writes expires_on. */
const expiresIn = (seconds: number, now = Date.now()) => String(Math.floor(now / 1000) + seconds);

interface Sent {
  url: URL;
  method: string;
  headers: Headers;
  body: string | undefined;
}

/** Answers the local token service and the Azure OpenAI API, and records everything sent. */
function azureFetch(options: { token?: () => Response; model?: (call: number) => Response }) {
  const sent: Sent[] = [];
  let modelCalls = 0;
  const fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    sent.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (url.href.startsWith(IDENTITY_ENDPOINT)) {
      return options.token?.() ?? json({ access_token: TOKEN, expires_on: expiresIn(3600) });
    }
    modelCalls += 1;
    return options.model?.(modelCalls) ?? chatCompletion(JSON.stringify({ verdict: "ok" }));
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

const schema = z.object({ verdict: z.enum(["ok", "bad"]) });
const request = { system: "You review contracts.", prompt: "CONFIDENTIAL contract text", schema };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadLlmConfig for azure-openai", () => {
  it("reads the deployment, the v1 API root and the identity, and keeps no key or header", () => {
    const config = loadLlmConfig(env());
    expect(config).toMatchObject({
      provider: "azure-openai",
      model: "review-gpt",
      apiKey: undefined,
      baseUrl: BASE_URL,
      azure: { identityEndpoint: IDENTITY_ENDPOINT, clientId: CLIENT_ID },
    });
    expect(JSON.stringify(config)).not.toContain(IDENTITY_HEADER);
  });

  it("uses the system-assigned identity when AZURE_CLIENT_ID is unset", () => {
    expect(loadLlmConfig(env({ AZURE_CLIENT_ID: undefined })).azure?.clientId).toBeUndefined();
  });

  it("accepts the root with a trailing slash", () => {
    expect(loadLlmConfig(env({ CLAUSEWISE_BASE_URL: `${BASE_URL}/` })).baseUrl).toBe(BASE_URL);
  });

  it("needs the deployment name", () => {
    expect(configError(env({ CLAUSEWISE_MODEL: undefined })).message).toMatch(/deployment/);
  });

  it("needs the v1 API root", () => {
    expect(configError(env({ CLAUSEWISE_BASE_URL: undefined })).message).toMatch(/openai\/v1/);
  });

  it.each([
    ["http://contoso-legal.openai.azure.com/openai/v1", /https/],
    ["https://contoso-legal.openai.azure.com", /openai\/v1/],
    ["https://contoso-legal.openai.azure.com/openai/deployments/review-gpt", /openai\/v1/],
  ])("refuses %j", (raw, reason) => {
    expect(configError(env({ CLAUSEWISE_BASE_URL: raw })).message).toMatch(reason);
  });

  it("refuses a key, which only works when key access is left on", () => {
    const error = configError(env({ CLAUSEWISE_API_KEY: "a-key-that-must-not-be-echoed" }));
    expect(error.message).toMatch(/managed identity/);
    expect(error.message).not.toContain("a-key-that-must-not-be-echoed");
  });

  it.each(["IDENTITY_ENDPOINT", "IDENTITY_HEADER"])(
    "says it is not running in Azure when %s is missing",
    (name) => {
      const error = configError(env({ [name]: undefined }));
      expect(error.message).toMatch(/not running in Azure Container Apps or App Service/);
      expect(error.message).not.toContain(IDENTITY_HEADER);
    },
  );

  it("refuses a client id that is not a GUID, without repeating it", () => {
    const error = configError(env({ AZURE_CLIENT_ID: "not-a-guid-value" }));
    expect(error.message).toMatch(/AZURE_CLIENT_ID/);
    expect(error.message).not.toContain("not-a-guid-value");
  });

  it("leaves the identity variables alone for the other providers", () => {
    const config = loadLlmConfig({
      ANTHROPIC_API_KEY: "sk-ant-test",
      ...env(),
      CLAUSEWISE_PROVIDER: undefined,
    });
    expect(config.provider).toBe("anthropic");
    expect(config.azure).toBeUndefined();
  });
});

describe("createManagedIdentityTokenSource", () => {
  it("asks the token service for an Azure OpenAI token as the named identity", async () => {
    const { fetch, sent } = azureFetch({});
    const source = createManagedIdentityTokenSource(
      { identityEndpoint: IDENTITY_ENDPOINT, clientId: CLIENT_ID },
      { fetch, readHeader: () => IDENTITY_HEADER },
    );
    await expect(source.token()).resolves.toBe(TOKEN);
    const [call] = sent;
    expect(call?.method).toBe("GET");
    expect(call?.url.searchParams.get("resource")).toBe("https://cognitiveservices.azure.com");
    expect(call?.url.searchParams.get("api-version")).toBe("2019-08-01");
    expect(call?.url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(call?.headers.get("x-identity-header")).toBe(IDENTITY_HEADER);
  });

  it("reads the header at every request, because the platform rotates it", async () => {
    let now = 1_000_000_000_000;
    let header = "first-header";
    const { fetch, sent } = azureFetch({
      token: () => json({ access_token: TOKEN, expires_on: expiresIn(600, now) }),
    });
    const source = createManagedIdentityTokenSource(
      { identityEndpoint: IDENTITY_ENDPOINT, clientId: undefined },
      { fetch, readHeader: () => header, now: () => now },
    );
    await source.token();
    header = "second-header";
    now += 6 * 60 * 1000;
    await source.token();
    expect(sent.map((call) => call.headers.get("x-identity-header"))).toEqual([
      "first-header",
      "second-header",
    ]);
    expect(sent[0]?.url.searchParams.has("client_id")).toBe(false);
  });

  it("reuses a token until five minutes before it expires", async () => {
    let now = 1_000_000_000_000;
    const { fetch, sent } = azureFetch({
      token: () => json({ access_token: TOKEN, expires_on: expiresIn(3600, now) }),
    });
    const source = createManagedIdentityTokenSource(
      { identityEndpoint: IDENTITY_ENDPOINT, clientId: CLIENT_ID },
      { fetch, readHeader: () => IDENTITY_HEADER, now: () => now },
    );
    await source.token();
    now += 54 * 60 * 1000;
    await source.token();
    expect(sent).toHaveLength(1);
    now += 2 * 60 * 1000;
    await source.token();
    expect(sent).toHaveLength(2);
  });

  it("shares one request between callers that ask at the same time", async () => {
    const { fetch, sent } = azureFetch({});
    const source = createManagedIdentityTokenSource(
      { identityEndpoint: IDENTITY_ENDPOINT, clientId: CLIENT_ID },
      { fetch, readHeader: () => IDENTITY_HEADER },
    );
    const tokens = await Promise.all([source.token(), source.token(), source.token()]);
    expect(tokens).toEqual([TOKEN, TOKEN, TOKEN]);
    expect(sent).toHaveLength(1);
  });

  it("does not let one caller's abort fail another caller waiting on the same request", async () => {
    let release: (() => void) | undefined;
    const fetch = (async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return json({ access_token: TOKEN, expires_on: expiresIn(3600) });
    }) as typeof globalThis.fetch;
    const source = createManagedIdentityTokenSource(
      { identityEndpoint: IDENTITY_ENDPOINT, clientId: CLIENT_ID },
      { fetch, readHeader: () => IDENTITY_HEADER },
    );
    const controller = new AbortController();
    const aborted = source.token(controller.signal);
    const other = source.token();
    controller.abort(new Error("stopped"));
    release?.();
    await expect(aborted).rejects.toThrow("stopped");
    await expect(other).resolves.toBe(TOKEN);
  });

  it("asks again after a failed request instead of keeping the failure", async () => {
    let calls = 0;
    const { fetch } = azureFetch({
      token: () => {
        calls += 1;
        return calls === 1
          ? json({ error: "busy" }, 503)
          : json({ access_token: TOKEN, expires_on: expiresIn(3600) });
      },
    });
    const source = createManagedIdentityTokenSource(
      { identityEndpoint: IDENTITY_ENDPOINT, clientId: CLIENT_ID },
      { fetch, readHeader: () => IDENTITY_HEADER },
    );
    await expect(source.token()).rejects.toBeInstanceOf(ModelRequestError);
    await expect(source.token()).resolves.toBe(TOKEN);
  });

  it.each([
    [400, true],
    [404, true],
    [500, false],
    [503, false],
  ])(
    "reports HTTP %i from the token service as an auth failure, fatal %s",
    async (status, fatal) => {
      const { fetch } = azureFetch({ token: () => json({ error: IDENTITY_HEADER }, status) });
      const source = createManagedIdentityTokenSource(
        { identityEndpoint: IDENTITY_ENDPOINT, clientId: CLIENT_ID },
        { fetch, readHeader: () => IDENTITY_HEADER },
      );
      const error = (await source.token().catch((caught: unknown) => caught)) as ModelRequestError;
      expect(error).toBeInstanceOf(ModelRequestError);
      expect(error.kind).toBe("auth");
      expect(error.fatal).toBe(fatal);
      expect(error.statusCode).toBe(status);
      expect(error.message).toMatch(/AZURE_CLIENT_ID/);
      expect(error.message).not.toContain(IDENTITY_HEADER);
    },
  );

  it.each([
    ["no token", { expires_on: expiresIn(3600) }],
    ["an empty token", { access_token: "", expires_on: expiresIn(3600) }],
    ["no expiry", { access_token: TOKEN }],
    ["an expiry that is not a number", { access_token: TOKEN, expires_on: "soon" }],
  ])("refuses an answer with %s, without repeating it", async (_label, body) => {
    const { fetch } = azureFetch({ token: () => json(body) });
    const source = createManagedIdentityTokenSource(
      { identityEndpoint: IDENTITY_ENDPOINT, clientId: CLIENT_ID },
      { fetch, readHeader: () => IDENTITY_HEADER },
    );
    const error = (await source.token().catch((caught: unknown) => caught)) as Error;
    expect(error).toBeInstanceOf(ModelRequestError);
    expect(error.message).not.toContain(TOKEN);
  });

  it("says the process is not in Azure when the header is missing, and sends nothing", async () => {
    const { fetch, sent } = azureFetch({});
    const source = createManagedIdentityTokenSource(
      { identityEndpoint: IDENTITY_ENDPOINT, clientId: CLIENT_ID },
      { fetch, readHeader: () => undefined },
    );
    await expect(source.token()).rejects.toThrow(/IDENTITY_HEADER is not set/);
    expect(sent).toHaveLength(0);
  });

  it("does not repeat the cause of a connection failure", async () => {
    const fetch = (async () => {
      throw new TypeError(`connect ECONNREFUSED 10.0.0.7:42356 ${IDENTITY_HEADER}`);
    }) as typeof globalThis.fetch;
    const source = createManagedIdentityTokenSource(
      { identityEndpoint: IDENTITY_ENDPOINT, clientId: CLIENT_ID },
      { fetch, readHeader: () => IDENTITY_HEADER },
    );
    const error = (await source.token().catch((caught: unknown) => caught)) as ModelRequestError;
    expect(error.fatal).toBe(false);
    expect(error.message).not.toMatch(/10\.0\.0\.7|ECONNREFUSED/);
    expect(error.message).not.toContain(IDENTITY_HEADER);
  });
});

describe("createObjectGenerator for azure-openai", () => {
  function generator(fetch: typeof globalThis.fetch): ReturnType<typeof createObjectGenerator> {
    vi.stubEnv("IDENTITY_HEADER", IDENTITY_HEADER);
    return createObjectGenerator(loadLlmConfig(env()), { fetch });
  }

  it("sends the deployment to Chat Completions with the identity's token and nothing else", async () => {
    // The SDK would read this when given no key; it must not reach Azure.
    vi.stubEnv("OPENAI_API_KEY", "sk-proj-ambient-key-that-must-not-be-sent");
    const { fetch, sent } = azureFetch({});
    await expect(generator(fetch).generate(request)).resolves.toEqual({ verdict: "ok" });

    const modelCalls = sent.filter((call) => !call.url.href.startsWith(IDENTITY_ENDPOINT));
    expect(modelCalls).toHaveLength(1);
    const [call] = modelCalls;
    expect(call?.url.href).toBe(`${BASE_URL}/chat/completions`);
    expect(call?.url.searchParams.has("api-version")).toBe(false);
    expect(call?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(call?.headers.has("api-key")).toBe(false);
    const pairs: string[] = [];
    call?.headers.forEach((value, name) => pairs.push(`${name}: ${value}`));
    const wire = pairs.join("\n");
    expect(wire).not.toContain("ambient-key");
    expect(wire).not.toContain("managed-identity");
    expect(JSON.parse(call?.body ?? "{}")).toMatchObject({ model: "review-gpt" });
  });

  it("says where the contract goes and how it signs in", () => {
    const { fetch } = azureFetch({});
    expect(generator(fetch).disclosure).toBe(
      "Azure OpenAI (contoso-legal.openai.azure.com, signed in with a managed identity)",
    );
  });

  it("reports an identity that cannot sign in before any contract text is sent", async () => {
    const { fetch, sent } = azureFetch({ token: () => json({ error: "no identity" }, 400) });
    const error = (await generator(fetch)
      .generate(request)
      .catch((caught: unknown) => caught)) as ModelRequestError;
    expect(error).toBeInstanceOf(ModelRequestError);
    expect(error.kind).toBe("auth");
    expect(error.fatal).toBe(true);
    expect(sent.every((call) => call.url.href.startsWith(IDENTITY_ENDPOINT))).toBe(true);
  });

  it("points a refused token at the role the identity needs", async () => {
    const { fetch } = azureFetch({
      model: () => openaiError(401, { message: "Access denied due to invalid token." }),
    });
    const error = (await generator(fetch)
      .generate(request)
      .catch((caught: unknown) => caught)) as ModelRequestError;
    expect(error.kind).toBe("auth");
    expect(error.message).toMatch(/Cognitive Services OpenAI User/);
    expect(error.message).not.toContain(TOKEN);
  });

  it("points a missing deployment at CLAUSEWISE_MODEL", async () => {
    const { fetch } = azureFetch({
      model: () =>
        openaiError(404, { message: "The API deployment for this resource does not exist." }),
    });
    const error = (await generator(fetch)
      .generate(request)
      .catch((caught: unknown) => caught)) as ModelRequestError;
    expect(error.kind).toBe("not_found");
    expect(error.message).toMatch(/CLAUSEWISE_MODEL is the name of a deployment/);
  });

  it("fetches one token for many calls", async () => {
    const { fetch, sent } = azureFetch({});
    const azure = generator(fetch);
    await Promise.all([azure.generate(request), azure.generate(request), azure.generate(request)]);
    expect(sent.filter((call) => call.url.href.startsWith(IDENTITY_ENDPOINT))).toHaveLength(1);
  });

  it("refuses to build without the identity settings that loadLlmConfig adds", () => {
    const config: LlmConfig = {
      provider: "azure-openai",
      model: "review-gpt",
      apiKey: undefined,
      baseUrl: BASE_URL,
      maxOutputTokens: 16000,
      effort: undefined,
      concurrency: 4,
      maxContextTokens: undefined,
      maxRetries: 2,
    };
    expect(() => createObjectGenerator(config)).toThrow(LlmConfigError);
  });
});
