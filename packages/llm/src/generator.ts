import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  APICallError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  RetryError,
  generateText,
  type LanguageModel,
} from "ai";
import {
  createAnthropicGenerator,
  describeAnthropicDestination,
  type AnthropicOverrides,
} from "./anthropic.js";
import { connectionNotes, isLocalHostname, parseUrl } from "./endpoint.js";
import {
  ModelRequestError,
  classifyProviderError,
  isFatalKind,
  scrubProviderText,
  type ModelRequestKind,
} from "./request-error.js";
import { REDIRECT_HINT, isRedirectStatus, refuseRedirects } from "./transport.js";
import {
  LlmConfigError,
  ModelOutputError,
  ModelRefusalError,
  type GenerateObjectRequest,
  type LlmConfig,
  type ObjectGenerator,
} from "./types.js";

export { ModelRequestError };

function describeHost(name: string, baseUrl: string | undefined, defaultUrl: string): string {
  const url = baseUrl === undefined ? new URL(defaultUrl) : parseUrl(baseUrl);
  if (url === undefined) return `${name} (custom endpoint)`;
  return `${name} (${[url.host, ...connectionNotes(url)].join(", ")})`;
}

function describeDestination(config: LlmConfig): string {
  switch (config.provider) {
    case "anthropic":
      return describeAnthropicDestination(config.baseUrl);
    case "openai":
      return describeHost("OpenAI API", config.baseUrl, "https://api.openai.com");
    case "openai-compatible": {
      const url = parseUrl(config.baseUrl);
      if (url === undefined) return "OpenAI-compatible server (address not set)";
      // A proxy makes "on this machine" untrue even for localhost, since the proxy decides where
      // the request goes next.
      const notes = connectionNotes(url);
      const through = notes.some((note) => note.startsWith("through a proxy"));
      const where = isLocalHostname(url.hostname)
        ? "on this machine"
        : "a remote server you configured";
      return `OpenAI-compatible server (${[url.host, ...(through ? [] : [where]), ...notes].join(", ")})`;
    }
  }
}

// The SDK reads OPENAI_BASE_URL when it is given no base URL, so the default is passed explicitly:
// otherwise a variable left over from another tool would send the document somewhere other than
// what the disclosure says.
const OPENAI_BASE_URL = "https://api.openai.com/v1";

// Anthropic goes through its own SDK in anthropic.ts, so only these two reach the AI SDK.
type AiSdkConfig = LlmConfig & { provider: "openai" | "openai-compatible" };

function usesAiSdk(config: LlmConfig): config is AiSdkConfig {
  return config.provider !== "anthropic";
}

// Optional fields are spread in only when set. The SDK's option types reject an explicit undefined,
// and an unset key must stay unset so a keyless local server gets no Authorization header at all.
function buildModel(config: AiSdkConfig, fetchOverride: typeof globalThis.fetch | undefined) {
  const shared = {
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    // Every request goes through the wrapper, with or without a stand-in for the network.
    fetch: refuseRedirects(fetchOverride),
  };
  switch (config.provider) {
    case "openai":
      return createOpenAI({ ...shared, baseURL: config.baseUrl ?? OPENAI_BASE_URL })(config.model);
    case "openai-compatible": {
      if (config.baseUrl === undefined) {
        throw new LlmConfigError(
          "CLAUSEWISE_BASE_URL is required when CLAUSEWISE_PROVIDER is openai-compatible.",
        );
      }
      // Without structured outputs the SDK sends only json_object and drops the schema, which
      // leaves a local model guessing the shape.
      return createOpenAICompatible({
        ...shared,
        name: "openai-compatible",
        baseURL: config.baseUrl,
        supportsStructuredOutputs: true,
      })(config.model);
    }
  }
}

interface CallSettings {
  temperature?: number;
  providerOptions?: Record<string, Record<string, string | boolean>>;
}

function callSettings(config: AiSdkConfig): CallSettings {
  switch (config.provider) {
    case "openai":
      // The Responses API keeps what it generates for 30 days unless told not to.
      return { providerOptions: { openai: { store: false } } };
    case "openai-compatible":
      // Local models drift between runs, and a rule check should give the same answer twice.
      return { temperature: 0 };
  }
}

// OpenAI-style APIs reject a schema name with anything but letters, digits, underscores and dashes,
// and a caller's label is written for people, so it is cleaned before it goes on the wire.
function wireName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

interface ProviderBody {
  type: string | undefined;
  code: string | undefined;
  message: string | undefined;
}

function field(source: unknown, name: string): unknown {
  return typeof source === "object" && source !== null
    ? (source as Record<string, unknown>)[name]
    : undefined;
}

function textOrNumber(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return typeof value === "number" ? String(value) : undefined;
}

// OpenAI and the servers that copy it answer with {"error": {"message", "type", "code"}}. Only
// these three fields are read, and only the message is ever repeated.
function providerBody(responseBody: string | undefined): ProviderBody {
  const none = { type: undefined, code: undefined, message: undefined };
  if (responseBody === undefined) return none;
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return none;
  }
  const inner = field(parsed, "error");
  const message = field(inner, "message");
  return {
    type: textOrNumber(field(inner, "type")),
    code: textOrNumber(field(inner, "code")),
    message: typeof message === "string" && message !== "" ? message : undefined,
  };
}

function hints(config: AiSdkConfig): Record<ModelRequestKind, string> {
  const keyName = config.provider === "openai" ? "OPENAI_API_KEY" : "CLAUSEWISE_API_KEY";
  return {
    auth: `Check that ${keyName} is a valid, active key for this server.`,
    permission: "This key is not allowed to make this request.",
    not_found:
      "Check that CLAUSEWISE_MODEL names a model this account or server offers, and that " +
      "CLAUSEWISE_BASE_URL is the API root.",
    billing: "Check the credit balance and the spend limits of the account behind this key.",
    rate_limit: "Lower CLAUSEWISE_CONCURRENCY, or try again later.",
    overloaded: "",
    server: "",
    network: "",
    other: "",
  };
}

type Attempt<T> = { ok: true; value: T } | { ok: false; truncated: boolean };

/**
 * `fetch` replaces the network for every provider. `model` stands in for the AI SDK model of the
 * openai providers, while `client` and `onUsage` belong to the anthropic adapter and are ignored
 * by the others.
 */
export function createObjectGenerator(
  config: LlmConfig,
  overrides?: { model?: LanguageModel } & AnthropicOverrides,
): ObjectGenerator {
  // A bare string would be resolved by the AI SDK's default provider, the Vercel AI Gateway, and
  // the document would leave for a service nobody configured.
  if (typeof overrides?.model === "string") {
    throw new TypeError("overrides.model must be a model object, not a model id string.");
  }
  if (!usesAiSdk(config)) {
    // A model stand-in meant for a test would be ignored here, and the test would then call the
    // real API.
    if (overrides?.model !== undefined) {
      throw new TypeError(
        "overrides.model only applies to the openai and openai-compatible providers. " +
          "Use overrides.client or overrides.fetch for anthropic.",
      );
    }
    return createAnthropicGenerator(config, overrides);
  }
  const model = overrides?.model ?? buildModel(config, overrides?.fetch);
  const settings = callSettings(config);
  const who = `${config.provider} (${config.model})`;
  const hintFor = hints(config);

  const refusal = () =>
    new ModelRefusalError(
      `${who} declined to answer: the provider stopped the response with a refusal or content ` +
        "filter. Retrying the same request will not help.",
    );

  // Only an APICallError's message is repeated. It is the provider's own error text, whereas other
  // SDK errors can quote the value that failed to validate, which may be model output. A call that
  // got no answer says so in fixed words: its message holds the network error's cause, which can
  // name internal hosts or echo the request.
  function requestError(error: unknown): ModelRequestError {
    const cause = RetryError.isInstance(error) ? error.lastError : error;
    if (APICallError.isInstance(cause)) {
      if (cause.statusCode === undefined) {
        return new ModelRequestError(
          `The request to ${who} failed (no connection). Check that the API host is reachable ` +
            "from this machine.",
          undefined,
          false,
          "network",
        );
      }
      const body = providerBody(cause.responseBody);
      const kind = classifyProviderError({
        status: cause.statusCode,
        type: body.type,
        code: body.code,
        message: body.message ?? cause.message,
      });
      const redirected = isRedirectStatus(cause.statusCode);
      const detail = redirected
        ? ""
        : scrubProviderText(body.message ?? cause.message, config.apiKey);
      const hint = redirected ? REDIRECT_HINT : hintFor[kind];
      return new ModelRequestError(
        `The request to ${who} failed with HTTP ${cause.statusCode}` +
          `${detail === "" ? "." : `: ${detail}`}${hint === "" ? "" : ` ${hint}`}`,
        cause.statusCode,
        isFatalKind(kind) || redirected,
        kind,
      );
    }
    const kind = cause instanceof Error ? cause.name : "unknown error";
    return new ModelRequestError(
      `The request to ${who} failed (${kind}).`,
      undefined,
      false,
      "other",
    );
  }

  async function attempt<T>(request: GenerateObjectRequest<T>): Promise<Attempt<T>> {
    const name = request.schemaName === undefined ? "" : wireName(request.schemaName);
    let result;
    try {
      result = await generateText({
        model,
        instructions: request.system,
        prompt: request.prompt,
        output: Output.object({
          schema: request.schema,
          ...(name === "" ? {} : { name }),
        }),
        maxOutputTokens: config.maxOutputTokens,
        maxRetries: config.maxRetries,
        // With any telemetry integration registered, or any subscriber on the ai:telemetry
        // diagnostics channel, the SDK would hand over the whole prompt. A tracing agent preloaded
        // into the process is not something the contract should be shown to.
        telemetry: { isEnabled: false },
        ...(request.signal === undefined ? {} : { abortSignal: request.signal }),
        ...settings,
      });
    } catch (error) {
      if (request.signal?.aborted) throw request.signal.reason;
      if (!NoObjectGeneratedError.isInstance(error)) throw requestError(error);
      if (error.finishReason === "content-filter") throw refusal();
      return { ok: false, truncated: error.finishReason === "length" };
    }
    if (result.finishReason === "content-filter") throw refusal();
    try {
      return { ok: true, value: result.output };
    } catch (error) {
      if (!NoOutputGeneratedError.isInstance(error)) throw error;
      return { ok: false, truncated: result.finishReason === "length" };
    }
  }

  return {
    provider: config.provider,
    model: config.model,
    disclosure: describeDestination(config),
    async generate<T>(request: GenerateObjectRequest<T>): Promise<T> {
      const attempts = config.maxRetries + 1;
      const label = request.schemaName === undefined ? "" : ` for "${request.schemaName}"`;
      for (let made = 0; made < attempts; made += 1) {
        request.signal?.throwIfAborted();
        const outcome = await attempt(request);
        if (outcome.ok) return outcome.value;
        // A mock or a server that ignores the signal can still hand back unusable output after
        // the abort, and that must not be reported as the model's fault.
        request.signal?.throwIfAborted();
        // Sending the same request again would be cut off at the same place, and each attempt is
        // billed for every token up to the limit.
        if (outcome.truncated) {
          throw new ModelOutputError(
            `${who} did not return output that fits the schema${label}: the reply was cut off at ` +
              "the output token limit, which also covers any reasoning, so retrying cannot help. " +
              "Raise CLAUSEWISE_MAX_OUTPUT_TOKENS.",
            true,
          );
        }
      }
      throw new ModelOutputError(
        `${who} did not return output that fits the schema${label} after ${attempts} ` +
          `${attempts === 1 ? "attempt" : "attempts"}.`,
      );
    },
  };
}
