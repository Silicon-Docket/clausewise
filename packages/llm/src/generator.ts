import { createAnthropic } from "@ai-sdk/anthropic";
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
  LlmConfigError,
  ModelOutputError,
  ModelRefusalError,
  type GenerateObjectRequest,
  type LlmConfig,
  type ObjectGenerator,
} from "./types.js";

/**
 * The provider could not be reached or rejected the request. The AI SDK's own errors carry the
 * whole request body, which is the contract, so this keeps only the status and the provider's
 * message.
 */
export class ModelRequestError extends Error {
  override name = "ModelRequestError";
  readonly statusCode: number | undefined;

  constructor(message: string, statusCode: number | undefined) {
    super(message);
    this.statusCode = statusCode;
  }
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "host.docker.internal"]);
const MAX_PROVIDER_MESSAGE = 300;

function parseUrl(raw: string | undefined): URL | undefined {
  if (raw === undefined) return undefined;
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function hostOrDefault(baseUrl: string | undefined, defaultHost: string): string {
  if (baseUrl === undefined) return defaultHost;
  return parseUrl(baseUrl)?.host ?? "custom endpoint";
}

function describeDestination(config: LlmConfig): string {
  switch (config.provider) {
    case "anthropic":
      return `Anthropic API (${hostOrDefault(config.baseUrl, "api.anthropic.com")})`;
    case "openai":
      return `OpenAI API (${hostOrDefault(config.baseUrl, "api.openai.com")})`;
    case "openai-compatible": {
      const url = parseUrl(config.baseUrl);
      if (url === undefined) return "OpenAI-compatible server (address not set)";
      const where = LOCAL_HOSTNAMES.has(url.hostname)
        ? "on this machine"
        : "a remote server you configured";
      return `OpenAI-compatible server (${url.host}, ${where})`;
    }
  }
}

// The SDK reads ANTHROPIC_BASE_URL and OPENAI_BASE_URL when it is given no base URL, so the default
// is passed explicitly: otherwise a variable left over from another tool would send the document
// somewhere other than what the disclosure says.
const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const OPENAI_BASE_URL = "https://api.openai.com/v1";

// Optional fields are spread in only when set. The SDK's option types reject an explicit undefined,
// and an unset key must stay unset so a keyless local server gets no Authorization header at all.
function buildModel(config: LlmConfig, fetchOverride: typeof globalThis.fetch | undefined) {
  const shared = {
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    ...(fetchOverride === undefined ? {} : { fetch: fetchOverride }),
  };
  switch (config.provider) {
    case "anthropic":
      return createAnthropic({ ...shared, baseURL: config.baseUrl ?? ANTHROPIC_BASE_URL })(
        config.model,
      );
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

function callSettings(config: LlmConfig): CallSettings {
  switch (config.provider) {
    case "anthropic":
      // claude-sonnet-5-5 and claude-opus-5-5 answer HTTP 400 to a non-default temperature, top_p or
      // top_k, to thinking disabled and to forced tool use, and think adaptively by default. So
      // sampling and thinking stay unset, and structuredOutputMode stays on the SDK's auto, which
      // uses native structured outputs for these models instead of a forced JSON tool.
      return config.effort === undefined
        ? {}
        : { providerOptions: { anthropic: { effort: config.effort } } };
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

type Attempt<T> = { ok: true; value: T } | { ok: false; truncated: boolean };

export function createObjectGenerator(
  config: LlmConfig,
  overrides?: { model?: LanguageModel; fetch?: typeof globalThis.fetch },
): ObjectGenerator {
  // A bare string would be resolved by the AI SDK's default provider, the Vercel AI Gateway, and
  // the document would leave for a service nobody configured.
  if (typeof overrides?.model === "string") {
    throw new TypeError("overrides.model must be a model object, not a model id string.");
  }
  const model = overrides?.model ?? buildModel(config, overrides?.fetch);
  const settings = callSettings(config);
  const who = `${config.provider} (${config.model})`;

  const refusal = () =>
    new ModelRefusalError(
      `${who} declined to answer: the provider stopped the response with a refusal or content ` +
        "filter. Retrying the same request will not help.",
    );

  function scrub(text: string): string {
    const withoutKey = config.apiKey ? text.split(config.apiKey).join("[redacted]") : text;
    return withoutKey.length > MAX_PROVIDER_MESSAGE
      ? `${withoutKey.slice(0, MAX_PROVIDER_MESSAGE)}...`
      : withoutKey;
  }

  // Only an APICallError's message is repeated. It is the provider's own error text, whereas other
  // SDK errors can quote the value that failed to validate, which may be model output.
  function requestError(error: unknown): ModelRequestError {
    const cause = RetryError.isInstance(error) ? error.lastError : error;
    if (APICallError.isInstance(cause)) {
      const status = cause.statusCode === undefined ? "" : ` with HTTP ${cause.statusCode}`;
      return new ModelRequestError(
        `The request to ${who} failed${status}: ${scrub(cause.message)}`,
        cause.statusCode,
      );
    }
    const kind = cause instanceof Error ? cause.name : "unknown error";
    return new ModelRequestError(`The request to ${who} failed (${kind}).`, undefined);
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
      let truncated = false;
      for (let made = 0; made < attempts; made += 1) {
        request.signal?.throwIfAborted();
        const outcome = await attempt(request);
        if (outcome.ok) return outcome.value;
        // A mock or a server that ignores the signal can still hand back unusable output after
        // the abort, and that must not be reported as the model's fault.
        request.signal?.throwIfAborted();
        truncated = outcome.truncated;
      }
      const label = request.schemaName === undefined ? "" : ` for "${request.schemaName}"`;
      const hint = truncated
        ? " The last reply was cut off at the output token limit, so raise CLAUSEWISE_MAX_OUTPUT_TOKENS."
        : "";
      throw new ModelOutputError(
        `${who} did not return output that fits the schema${label} after ${attempts} ` +
          `${attempts === 1 ? "attempt" : "attempts"}.${hint}`,
      );
    },
  };
}
