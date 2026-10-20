import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { toJSONSchema, type ZodType } from "zod";
import {
  LlmConfigError,
  ModelOutputError,
  ModelRefusalError,
  type GenerateObjectRequest,
  type LlmConfig,
  type ObjectGenerator,
} from "./types.js";

/**
 * The provider could not be reached or rejected the request. The SDKs' own errors carry the whole
 * request, which is the contract, so this keeps only the status and the provider's message.
 */
export class ModelRequestError extends Error {
  override name = "ModelRequestError";
  readonly statusCode: number | undefined;
  /**
   * True when every other call of the same review would fail the same way, such as a rejected key,
   * a missing model or an exhausted balance, so a caller should stop instead of sending more.
   */
  readonly fatal: boolean;

  constructor(message: string, statusCode: number | undefined, fatal?: boolean) {
    super(message);
    this.statusCode = statusCode;
    this.fatal = fatal ?? (statusCode === 401 || statusCode === 403 || statusCode === 404);
  }
}

/** Token counts for one response. Cached tokens are counted apart from `inputTokens`. */
export interface AnthropicUsage {
  /** Input tokens billed at the full price: the part of the prompt that was not cached. */
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from the cache. */
  cacheReadTokens: number;
  /** Prompt tokens written to the cache by this call. */
  cacheWriteTokens: number;
}

export interface AnthropicOverrides {
  /** A ready client. It then also decides the credentials and the base URL. */
  client?: Anthropic;
  /** Stands in for the network. Ignored when `client` is given. */
  fetch?: typeof globalThis.fetch;
  /**
   * Called once for every response the API returns, whatever came of it, so a failed or cut-off
   * attempt is still counted in the cost. A call that throws before any response has no usage.
   */
  onUsage?: (usage: AnthropicUsage) => void;
}

// The SDK appends /v1/messages itself and would read ANTHROPIC_BASE_URL if given nothing, so the
// default is passed explicitly: a variable left over from another tool must not send the contract
// somewhere the disclosure does not name.
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_HOST = "api.anthropic.com";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MAX_PROVIDER_MESSAGE = 300;
// The SDK refuses a non-streaming request that could run past ten minutes, which it works out as
// 3600 * max_tokens / 128000 seconds. Anything above this has to stream.
const MAX_NON_STREAMING_TOKENS = 21_333;

/** Redacts the key from provider text and caps its length, since the text is shown to the user. */
export function scrubProviderText(text: string, apiKey: string | undefined): string {
  const withoutKey = apiKey ? text.split(apiKey).join("[redacted]") : text;
  return withoutKey.length > MAX_PROVIDER_MESSAGE
    ? `${withoutKey.slice(0, MAX_PROVIDER_MESSAGE)}...`
    : withoutKey;
}

export function describeAnthropicDestination(baseUrl: string | undefined): string {
  let host = DEFAULT_HOST;
  if (baseUrl !== undefined) {
    try {
      host = new URL(baseUrl).host;
    } catch {
      host = "custom endpoint";
    }
  }
  return `Anthropic API (${host})`;
}

// Gateways are usually written down as an API root that ends in /v1, as the OpenAI-style providers
// expect. The SDK adds that segment itself, so keeping it would send requests to /v1/v1/messages.
function apiRoot(baseUrl: string | undefined): string {
  if (baseUrl === undefined) return DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    // The request fails on it later, in the same way for every caller.
    return baseUrl;
  }
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return url.toString();
}

interface Reply {
  content: ReadonlyArray<{ type: string }>;
  stop_reason: string | null;
  stop_details?: { category?: string | null } | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

type Attempt<T> = { ok: true; value: T } | { ok: false; truncated: boolean };

function userContent(request: { prompt: string; sharedPrefix?: string | undefined }) {
  const { prompt, sharedPrefix } = request;
  // The API rejects empty and whitespace-only text blocks, and an error from there is a worse
  // message than one raised before anything is sent.
  if (prompt.trim() === "") throw new TypeError("request.prompt must not be empty.");
  const cacheable =
    sharedPrefix !== undefined && sharedPrefix.trim() !== "" && prompt.startsWith(sharedPrefix);
  if (!cacheable) return [{ type: "text" as const, text: prompt }];
  const rest = prompt.slice(sharedPrefix.length);
  const marker = { type: "ephemeral" as const };
  // Nothing after the prefix means there is no second block to send. The whole prompt is then the
  // shared part, and the one block carries the marker.
  if (rest.trim() === "") return [{ type: "text" as const, text: prompt, cache_control: marker }];
  return [
    { type: "text" as const, text: sharedPrefix, cache_control: marker },
    { type: "text" as const, text: rest },
  ];
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapValues(source: JsonObject, convert: (value: unknown) => JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, convert(value)]));
}

const STRING_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

// Keeps only the keywords the API decodes against, since it rejects a schema over one it cannot
// enforce. A constraint left out here is still checked on the reply by the zod schema. The SDK's
// zodOutputFormat helper is not used: it moves enum and const into the description text, which
// leaves the model free to answer outside them.
function wireSchema(node: unknown): JsonObject {
  if (!isObject(node)) return {};
  const out: JsonObject = {};
  for (const key of ["type", "enum", "const", "description", "title", "required", "$ref"]) {
    if (key in node) out[key] = node[key];
  }
  if (isObject(node.properties)) out.properties = mapValues(node.properties, wireSchema);
  if (isObject(node.$defs)) out.$defs = mapValues(node.$defs, wireSchema);
  if (isObject(node.items)) out.items = wireSchema(node.items);
  if (node.minItems === 0 || node.minItems === 1) out.minItems = node.minItems;
  if (typeof node.format === "string" && STRING_FORMATS.has(node.format)) out.format = node.format;
  const variants = Array.isArray(node.anyOf) ? node.anyOf : node.oneOf;
  if (Array.isArray(variants)) out.anyOf = variants.map(wireSchema);
  if (Array.isArray(node.allOf)) out.allOf = node.allOf.map(wireSchema);
  const types = Array.isArray(node.type) ? node.type : [node.type];
  if (types.includes("object") || "properties" in out) out.additionalProperties = false;
  return out;
}

function outputFormat(schema: ZodType<unknown>): Anthropic.JSONOutputFormat {
  return { type: "json_schema", schema: wireSchema(toJSONSchema(schema)) };
}

function replyText(content: Reply["content"]): string {
  // A server-side fallback marks where one model's output ends and the next begins, and the
  // output before the mark belongs to the model that declined.
  const start = content.findLastIndex((block) => block.type === "fallback") + 1;
  return content
    .slice(start)
    .map((block) =>
      block.type === "text" && "text" in block && typeof block.text === "string" ? block.text : "",
    )
    .join("");
}

// A gateway can answer 200 with something that is not a Messages API response, and the SDK then
// hands that back as it is.
function isReply(value: unknown): value is Reply {
  if (typeof value !== "object" || value === null) return false;
  const { content, usage } = value as { content?: unknown; usage?: unknown };
  if (!Array.isArray(content) || typeof usage !== "object" || usage === null) return false;
  const counts = usage as { input_tokens?: unknown; output_tokens?: unknown };
  return typeof counts.input_tokens === "number" && typeof counts.output_tokens === "number";
}

function providerMessage(error: APIError): string {
  const body: unknown = error.error;
  if (typeof body !== "object" || body === null || !("error" in body)) return "";
  const inner = body.error;
  if (typeof inner !== "object" || inner === null || !("message" in inner)) return "";
  return typeof inner.message === "string" ? inner.message : "";
}

export function createAnthropicGenerator(
  config: LlmConfig,
  overrides: AnthropicOverrides = {},
): ObjectGenerator {
  if (config.provider !== "anthropic") {
    throw new LlmConfigError("createAnthropicGenerator needs CLAUSEWISE_PROVIDER to be anthropic.");
  }
  if (config.fallback !== undefined && config.baseUrl !== undefined) {
    throw new LlmConfigError(
      "CLAUSEWISE_FALLBACK works only against the Anthropic API itself, not through " +
        "CLAUSEWISE_BASE_URL. Unset one of the two.",
    );
  }

  const apiKey = config.apiKey;
  let client = overrides.client;
  // ANTHROPIC_CUSTOM_HEADERS is merged in after the client's own auth headers, so it could swap
  // the key or add a second credential. Sent with each request, these are applied after it, which
  // makes the configured key the one that arrives. A client the caller supplies keeps its own.
  let credentialHeaders: { "x-api-key": string; authorization: null } | undefined;
  if (client === undefined) {
    if (apiKey === undefined || apiKey === "") {
      throw new LlmConfigError(
        "ANTHROPIC_API_KEY is required when CLAUSEWISE_PROVIDER is anthropic. " +
          "Set it to your Anthropic API key.",
      );
    }
    client = new Anthropic({
      apiKey,
      // Left undefined, the SDK takes ANTHROPIC_AUTH_TOKEN from the environment and sends it
      // next to the key, which the API rejects. With a key set it never consults ANTHROPIC_PROFILE.
      authToken: null,
      baseURL: apiRoot(config.baseUrl),
      maxRetries: config.maxRetries,
      // At debug level the SDK logs request details, and a trace span can carry message content
      // when the environment asks for it. Neither is wanted with confidential contracts.
      logLevel: "off",
      openTelemetry: false,
      ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
    });
    credentialHeaders = { "x-api-key": apiKey, authorization: null };
  }
  const api = client;

  const who = `anthropic (${config.model})`;

  function refusal(category: string | null | undefined): ModelRefusalError {
    const named = typeof category === "string" && /^[a-z0-9_]{1,40}$/.test(category);
    return new ModelRefusalError(
      `${who} declined to answer: the provider stopped the response with a refusal` +
        `${named ? ` (category: ${category})` : ""}. Retrying the same request will not help.`,
      named ? category : undefined,
    );
  }

  function failure(error: APIError, hint: string): ModelRequestError {
    const detail = scrubProviderText(providerMessage(error), apiKey);
    const status = error.status === undefined ? "" : ` with HTTP ${error.status}`;
    const id = /^[\w-]{1,80}$/.test(error.requestID ?? "")
      ? ` (request ID ${error.requestID})`
      : "";
    const sentence = detail === "" ? "." : `: ${detail}${/[.!?]$/.test(detail) ? "" : "."}`;
    return new ModelRequestError(
      `The request to ${who} failed${status}${id}${sentence}${hint === "" ? "" : ` ${hint}`}`,
      error.status,
    );
  }

  // Only the provider's own error text is repeated. Other errors can quote what failed to parse,
  // which may be model output, and a connection error's cause can name internal hosts.
  function requestError(error: unknown): ModelRequestError {
    if (error instanceof NotFoundError) {
      return failure(error, "Check that CLAUSEWISE_MODEL names a model this key can use.");
    }
    if (error instanceof AuthenticationError) {
      return failure(error, "Check that ANTHROPIC_API_KEY is a valid, active key.");
    }
    if (error instanceof PermissionDeniedError) {
      return failure(error, "This key is not allowed to make this request.");
    }
    if (error instanceof RateLimitError) {
      return failure(error, "Lower CLAUSEWISE_CONCURRENCY, or try again later.");
    }
    // A connection error is an APIError in this SDK, so it has to be tested before the base class.
    if (error instanceof APIConnectionError) {
      const what =
        error instanceof APIConnectionTimeoutError ? "the request timed out" : "no connection";
      return new ModelRequestError(
        `The request to ${who} failed (${what}). Check that the API host is reachable from this machine.`,
        undefined,
      );
    }
    if (error instanceof APIError) return failure(error, "");
    const kind = error instanceof Error ? error.name : "unknown error";
    return new ModelRequestError(`The request to ${who} failed (${kind}).`, undefined);
  }

  function send(
    params: Anthropic.MessageCreateParamsNonStreaming,
    signal: AbortSignal | undefined,
  ) {
    const options = {
      ...(signal === undefined ? {} : { signal }),
      ...(credentialHeaders === undefined ? {} : { headers: credentialHeaders }),
    };
    const streaming = params.max_tokens > MAX_NON_STREAMING_TOKENS;
    if (config.fallback !== undefined) {
      const body: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
        ...params,
        betas: [FALLBACK_BETA],
        fallbacks: config.fallback,
      };
      return streaming
        ? api.beta.messages.stream(body, options).finalMessage()
        : api.beta.messages.create(body, options);
    }
    return streaming
      ? api.messages.stream(params, options).finalMessage()
      : api.messages.create(params, options);
  }

  async function attempt<T>(
    request: GenerateObjectRequest<T>,
    params: Anthropic.MessageCreateParamsNonStreaming,
  ): Promise<Attempt<T>> {
    let reply: unknown;
    try {
      reply = await send(params, request.signal);
    } catch (error) {
      if (request.signal?.aborted) throw request.signal.reason;
      throw requestError(error);
    }
    if (!isReply(reply)) {
      throw new ModelRequestError(
        `The request to ${who} failed (the reply was not a Messages API response).`,
        undefined,
      );
    }
    overrides.onUsage?.({
      inputTokens: reply.usage.input_tokens,
      outputTokens: reply.usage.output_tokens,
      cacheReadTokens: reply.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: reply.usage.cache_creation_input_tokens ?? 0,
    });
    if (reply.stop_reason === "refusal") throw refusal(reply.stop_details?.category);

    // Structured output cannot be complete JSON that fits the schema and also be cut off, so a
    // reply that parses is used whatever its stop reason says.
    const failed = { ok: false, truncated: reply.stop_reason === "max_tokens" } as const;
    let json: unknown;
    try {
      json = JSON.parse(replyText(reply.content));
    } catch {
      return failed;
    }
    const parsed = request.schema.safeParse(json);
    return parsed.success ? { ok: true, value: parsed.data } : failed;
  }

  return {
    provider: config.provider,
    model: config.model,
    disclosure: describeAnthropicDestination(config.baseUrl),
    cachesSharedPrefix: true,
    async generate<T>(request: GenerateObjectRequest<T>): Promise<T> {
      // Built once so a retry sends the same bytes, which keeps its cache entry valid. Thinking and
      // effort are never varied between calls for the same reason. Sampling settings, thinking
      // and tool use are left out altogether: claude-sonnet-5-5 and claude-opus-5-5 answer HTTP
      // 400 to forced tool use, to thinking disabled and to non-default sampling, and they think
      // adaptively when left alone.
      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model: config.model,
        max_tokens: config.maxOutputTokens,
        ...(request.system.trim() === "" ? {} : { system: request.system }),
        messages: [{ role: "user", content: userContent(request) }],
        output_config: {
          format: outputFormat(request.schema),
          ...(config.effort === undefined ? {} : { effort: config.effort }),
        },
      };
      const attempts = config.maxRetries + 1;
      let truncated = false;
      for (let made = 0; made < attempts; made += 1) {
        request.signal?.throwIfAborted();
        const outcome = await attempt(request, params);
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
