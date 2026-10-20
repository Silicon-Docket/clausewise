import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from "@anthropic-ai/sdk";
import { toJSONSchema, type ZodType } from "zod";
import { BaseUrlError, connectionNotes, normalizeBaseUrl, parseUrl } from "./endpoint.js";
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

export { ModelRequestError, scrubProviderText };

/** Token counts for one response. Cached tokens are counted apart from `inputTokens`. */
export interface AnthropicUsage {
  /** Input tokens billed at the full price: the part of the prompt that was not cached. */
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from the cache. */
  cacheReadTokens: number;
  /** Prompt tokens written to the cache by this call. */
  cacheWriteTokens: number;
  /**
   * Present only when the API reported more than one model attempt for this response, which
   * happens when server-side fallback ran. The four counts above are then the sum over these
   * attempts, which were billed at the rates of different models, so a cost estimate that has to
   * be exact should price each entry on its own.
   */
  attempts?: readonly AnthropicUsageAttempt[];
}

/** The tokens one model attempt used, as the API lists them in `usage.iterations`. */
export interface AnthropicUsageAttempt {
  /** The model that ran this attempt, when the API named it. */
  model: string | undefined;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AnthropicOverrides {
  /**
   * A ready client. It then also decides the credentials and the base URL. Its requests still
   * never follow a redirect, because the adapter derives a copy of it that refuses them.
   */
  client?: Anthropic;
  /** Stands in for the network. Ignored when `client` is given. */
  fetch?: typeof globalThis.fetch;
  /**
   * Called once for every response the API returns, whatever came of it, so a failed or cut-off
   * attempt is still counted in the cost. A call that throws before any response has no usage, and
   * neither does a stream that ends in an error event, since the final message never arrives.
   *
   * With server-side fallback the top-level `usage` of a response describes only the attempt that
   * produced the returned message. The tokens of a declined attempt are billed too, and only
   * `usage.iterations` lists them, so the counts passed here are the sum over every iteration
   * the API reports, with the per-attempt figures in `attempts`. A response that carries no
   * iterations, or numbers that cannot be read, is counted from its top-level usage alone, and a
   * declined attempt that the API does not list is then missing from the total.
   */
  onUsage?: (usage: AnthropicUsage) => void;
}

// The SDK appends /v1/messages itself and would read ANTHROPIC_BASE_URL if given nothing, so the
// default is passed explicitly: a variable left over from another tool must not send the contract
// somewhere the disclosure does not name.
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
// The SDK refuses a non-streaming request that could run past ten minutes, which it works out as
// 3600 * max_tokens / 128000 seconds. Anything above this has to stream.
const MAX_NON_STREAMING_TOKENS = 21_333;
// Variables the SDK turns into headers on every request. They are meant for other tools, and a
// gateway token set for one of them must not travel to the provider the contract goes to.
const AMBIENT_HEADER_VARIABLES = ["ANTHROPIC_CUSTOM_HEADERS"] as const;

// Documented minimum cacheable prompt length per model, in tokens (the prompt caching reference).
// A prefix below it is silently not cached, however it is marked. Unlisted models are left out
// rather than guessed at, which makes the pipeline wait for the first call as it always has.
const CACHE_MINIMUM_TOKENS: ReadonlyArray<readonly [number, readonly string[]]> = [
  [
    512,
    [
      "claude-opus-5",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-fable-5",
      "claude-fable-5-1",
      "claude-mythos-5",
      "claude-mythos-5-1",
    ],
  ],
  [
    1024,
    [
      "claude-sonnet-5",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "claude-sonnet-4-0",
      "claude-sonnet-4",
      "claude-opus-4-1",
      "claude-opus-4-0",
      "claude-opus-4",
    ],
  ],
  [2048, ["claude-opus-4-7", "claude-mythos-preview", "claude-3-5-haiku"]],
  [4096, ["claude-opus-4-6", "claude-opus-4-5", "claude-haiku-4-5"]],
];
// A conservative stand-in for how many characters a token covers.
const CHARS_PER_TOKEN = 4;

/** The shortest shared prefix, in characters, that this model can cache, when it is documented. */
export function minCacheableChars(model: string): number | undefined {
  const id = model
    .trim()
    .toLowerCase()
    .replace(/-(?:\d{8}|latest)$/, "");
  for (const [tokens, ids] of CACHE_MINIMUM_TOKENS) {
    if (ids.includes(id)) return tokens * CHARS_PER_TOKEN;
  }
  return undefined;
}

export function describeAnthropicDestination(baseUrl: string | undefined): string {
  let host = "api.anthropic.com";
  let target = new URL(DEFAULT_BASE_URL);
  if (baseUrl !== undefined) {
    const url = parseUrl(baseUrl);
    if (url === undefined) return "Anthropic API (custom endpoint)";
    host = url.host;
    target = url;
  }
  return `Anthropic API (${[host, ...connectionNotes(target)].join(", ")})`;
}

// The string to hand to the SDK. A URL that cannot be read is passed on as it is, and the request
// then fails in the same way for every caller.
function apiRoot(baseUrl: string | undefined): string {
  if (baseUrl === undefined) return DEFAULT_BASE_URL;
  if (parseUrl(baseUrl) === undefined) return baseUrl;
  try {
    return normalizeBaseUrl(baseUrl, { anthropicRoot: true });
  } catch (error) {
    if (error instanceof BaseUrlError) {
      throw new LlmConfigError(`CLAUSEWISE_BASE_URL is not usable. ${error.message}`);
    }
    throw error;
  }
}

// The SDK reads these when it is built and keeps what it found, so they are hidden only for that
// moment. Nothing awaits in between.
function withoutAmbientHeaders<T>(build: () => T): T {
  const saved = AMBIENT_HEADER_VARIABLES.map((name) => [name, process.env[name]] as const);
  for (const name of AMBIENT_HEADER_VARIABLES) delete process.env[name];
  try {
    return build();
  } finally {
    for (const [name, value] of saved) {
      if (value !== undefined) process.env[name] = value;
    }
  }
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
    iterations?: unknown;
  };
}

// A reply that fits the schema; one that does not, and whether it was cut off at the output limit;
// or a stream the API broke with an error event that a fresh request may well not repeat.
type Attempt<T> =
  | { ok: true; value: T }
  | { ok: false; truncated: boolean }
  | { ok: false; transient: ModelRequestError; hintMs: number | undefined };

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
  // output before the mark belongs to the model that declined. A streamed request that declines
  // part-way is the exception: the fallback model continues the partial text, which is then part
  // of the answer. That case is not handled, and fails as invalid output (see LlmConfig.fallback).
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

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

// One entry of usage.iterations, or undefined when it is not made of readable numbers.
function attemptOf(entry: unknown): AnthropicUsageAttempt | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const fields = entry as Record<string, unknown>;
  const inputTokens = count(fields.input_tokens);
  const outputTokens = count(fields.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return {
    model: typeof fields.model === "string" ? fields.model : undefined,
    inputTokens,
    outputTokens,
    cacheReadTokens: count(fields.cache_read_input_tokens) ?? 0,
    cacheWriteTokens: count(fields.cache_creation_input_tokens) ?? 0,
  };
}

function usageOf(usage: Reply["usage"]): AnthropicUsage {
  const top = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
  const listed = Array.isArray(usage.iterations) ? usage.iterations.map(attemptOf) : [];
  const attempts = listed.filter((entry) => entry !== undefined);
  // Only a list that can be read in full is trusted. With one entry missing the sum could come out
  // lower than the top level figure it is meant to improve on.
  if (attempts.length < 2 || attempts.length !== listed.length) return top;
  const sum = (pick: (entry: AnthropicUsageAttempt) => number) =>
    attempts.reduce((total, entry) => total + pick(entry), 0);
  return {
    inputTokens: sum((entry) => entry.inputTokens),
    outputTokens: sum((entry) => entry.outputTokens),
    cacheReadTokens: sum((entry) => entry.cacheReadTokens),
    cacheWriteTokens: sum((entry) => entry.cacheWriteTokens),
    attempts,
  };
}

interface ProviderError {
  type: string | undefined;
  code: string | undefined;
  message: string;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function providerError(error: APIError): ProviderError {
  const body: unknown = error.error;
  const inner: unknown =
    typeof body === "object" && body !== null && "error" in body ? body.error : undefined;
  if (typeof inner !== "object" || inner === null) {
    return { type: textOf(error.type), code: undefined, message: "" };
  }
  const fields = inner as Record<string, unknown>;
  const details = fields.details;
  const detailCode =
    typeof details === "object" && details !== null
      ? textOf((details as Record<string, unknown>).error_code)
      : undefined;
  return {
    type: textOf(fields.type) ?? textOf(error.type),
    code: detailCode ?? textOf(fields.code),
    message: textOf(fields.message) ?? "",
  };
}

const HINTS: Record<ModelRequestKind, string> = {
  auth: "Check that ANTHROPIC_API_KEY is a valid, active key.",
  permission: "This key is not allowed to make this request.",
  not_found: "Check that CLAUSEWISE_MODEL names a model this key can use.",
  billing:
    "Check the credit balance and the spend limits of the Anthropic account behind this key.",
  rate_limit: "Lower CLAUSEWISE_CONCURRENCY, or try again later.",
  overloaded: "",
  server: "",
  network: "",
  other: "",
};

// The stream error events that mean the service, not the request, was at fault. The SDK retries
// only the HTTP answer that opens a stream, so a failure after that is the adapter's to retry.
const RETRYABLE_STREAM_ERRORS: ReadonlySet<string> = new Set(["overloaded_error", "api_error"]);

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;

// What the server said about when to come back, in the headers the SDK reads for the same purpose.
function retryHintMs(error: APIError): number | undefined {
  const ms = Number(error.headers?.get("retry-after-ms") ?? Number.NaN);
  if (Number.isFinite(ms) && ms >= 0) return Math.min(ms, MAX_DELAY_MS);
  const seconds = Number(error.headers?.get("retry-after") ?? Number.NaN);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_DELAY_MS);
  return undefined;
}

function retryDelay(hintMs: number | undefined, made: number): number {
  if (hintMs !== undefined) return hintMs;
  return Math.min(BASE_DELAY_MS * 2 ** made, MAX_DELAY_MS) * (0.75 + Math.random() * 0.25);
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  signal?.throwIfAborted();
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
  let client: Anthropic;
  // ANTHROPIC_CUSTOM_HEADERS is merged in after the client's own auth headers, so it could swap
  // the key or add a second credential. Sent with each request, these are applied after it, which
  // makes the configured key the one that arrives. A client the caller supplies keeps its own.
  let credentialHeaders: { "x-api-key": string; authorization: null } | undefined;
  if (overrides.client === undefined) {
    if (apiKey === undefined || apiKey === "") {
      throw new LlmConfigError(
        "ANTHROPIC_API_KEY is required when CLAUSEWISE_PROVIDER is anthropic. " +
          "Set it to your Anthropic API key.",
      );
    }
    const baseURL = apiRoot(config.baseUrl);
    client = withoutAmbientHeaders(
      () =>
        new Anthropic({
          apiKey,
          // Left undefined, the SDK takes ANTHROPIC_AUTH_TOKEN from the environment and sends it
          // next to the key, which the API rejects. With a key set it never consults
          // ANTHROPIC_PROFILE.
          authToken: null,
          baseURL,
          maxRetries: config.maxRetries,
          // At debug level the SDK logs request details, and a trace span can carry message
          // content when the environment asks for it. Neither is wanted with confidential
          // contracts.
          logLevel: "off",
          openTelemetry: false,
          fetch: refuseRedirects(overrides.fetch),
        }),
    );
    credentialHeaders = { "x-api-key": apiKey, authorization: null };
  } else {
    // A stand-in for a client that has no options to derive from is used as it is. The copy is
    // built like any other client, so it must not pick up headers from the environment that the
    // caller's own client did not have.
    const given = overrides.client;
    client =
      typeof given.withOptions === "function"
        ? withoutAmbientHeaders(() =>
            given.withOptions({ fetchOptions: { ...given.fetchOptions, redirect: "manual" } }),
          )
        : given;
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

  function failure(error: APIError): ModelRequestError {
    const provider = providerError(error);
    const kind = classifyProviderError({
      status: error.status,
      type: provider.type,
      code: provider.code,
      message: provider.message,
    });
    const redirected = isRedirectStatus(error.status);
    // A redirect page is the one answer whose text could name the address it points at.
    const detail = redirected ? "" : scrubProviderText(provider.message, apiKey);
    const status = error.status === undefined ? "" : ` with HTTP ${error.status}`;
    const id = /^[\w-]{1,80}$/.test(error.requestID ?? "")
      ? ` (request ID ${error.requestID})`
      : "";
    const sentence = detail === "" ? "." : `: ${detail}${/[.!?]$/.test(detail) ? "" : "."}`;
    const hint = redirected ? REDIRECT_HINT : HINTS[kind];
    return new ModelRequestError(
      `The request to ${who} failed${status}${id}${sentence}${hint === "" ? "" : ` ${hint}`}`,
      error.status,
      isFatalKind(kind) || redirected,
      kind,
    );
  }

  // Only the provider's own error text is repeated. Other errors can quote what failed to parse,
  // which may be model output, and a connection error's cause can name internal hosts.
  function requestError(error: unknown): ModelRequestError {
    // A connection error is an APIError in this SDK, so it has to be tested before the base class.
    if (error instanceof APIConnectionError) {
      const what =
        error instanceof APIConnectionTimeoutError ? "the request timed out" : "no connection";
      return new ModelRequestError(
        `The request to ${who} failed (${what}). Check that the API host is reachable from this machine.`,
        undefined,
        false,
        "network",
      );
    }
    if (error instanceof APIError) return failure(error);
    const kind = error instanceof Error ? error.name : "unknown error";
    return new ModelRequestError(
      `The request to ${who} failed (${kind}).`,
      undefined,
      false,
      "other",
    );
  }

  // An error event inside a stream that opened normally has no status. The SDK does not retry it,
  // so one that says the service was overloaded or failed is handed back to the attempt loop.
  function isTransientStreamError(error: unknown): error is APIError {
    return (
      error instanceof APIError &&
      !(error instanceof APIConnectionError) &&
      error.status === undefined &&
      RETRYABLE_STREAM_ERRORS.has(providerError(error).type ?? "")
    );
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
      if (isTransientStreamError(error)) {
        return { ok: false, transient: requestError(error), hintMs: retryHintMs(error) };
      }
      throw requestError(error);
    }
    if (!isReply(reply)) {
      throw new ModelRequestError(
        `The request to ${who} failed (the reply was not a Messages API response).`,
        undefined,
        false,
        "other",
      );
    }
    overrides.onUsage?.(usageOf(reply.usage));
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

  const cacheFloor = minCacheableChars(config.model);
  return {
    provider: config.provider,
    model: config.model,
    disclosure: describeAnthropicDestination(config.baseUrl),
    cachesSharedPrefix: true,
    ...(cacheFloor === undefined ? {} : { minCacheableChars: cacheFloor }),
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
      let transient: ModelRequestError | undefined;
      for (let made = 0; made < attempts; made += 1) {
        request.signal?.throwIfAborted();
        const outcome = await attempt(request, params);
        if (outcome.ok) return outcome.value;
        // A mock or a server that ignores the signal can still hand back unusable output after
        // the abort, and that must not be reported as the model's fault.
        request.signal?.throwIfAborted();
        if ("transient" in outcome) {
          transient = outcome.transient;
          if (made + 1 < attempts) await pause(retryDelay(outcome.hintMs, made), request.signal);
          continue;
        }
        transient = undefined;
        // Sending the same request again would be cut off at the same place, and each attempt
        // is billed for every token up to the limit, thinking included.
        if (outcome.truncated) {
          throw new ModelOutputError(
            `${who} did not return output that fits the schema${labelOf(request)}: the reply was ` +
              "cut off at the output token limit, which also covers thinking, so retrying cannot " +
              "help. Raise CLAUSEWISE_MAX_OUTPUT_TOKENS.",
            true,
          );
        }
      }
      if (transient !== undefined) throw transient;
      throw new ModelOutputError(
        `${who} did not return output that fits the schema${labelOf(request)} after ${attempts} ` +
          `${attempts === 1 ? "attempt" : "attempts"}.`,
      );
    },
  };
}

function labelOf(request: { schemaName?: string | undefined }): string {
  return request.schemaName === undefined ? "" : ` for "${request.schemaName}"`;
}
