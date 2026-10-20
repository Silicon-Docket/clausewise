import type { ZodType } from "zod";

export type ProviderName = "anthropic" | "openai" | "openai-compatible";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LlmConfig {
  provider: ProviderName;
  model: string;
  /** Not needed for most local OpenAI-compatible servers such as Ollama. */
  apiKey: string | undefined;
  /** Required for `openai-compatible`; optional override for the others. */
  baseUrl: string | undefined;
  /** Upper bound on tokens in one response, thinking included. Default 16000. */
  maxOutputTokens: number;
  /** Anthropic only. Left unset, the model's own default applies. */
  effort: Effort | undefined;
  /** How many rule checks may be in flight at once. Default 4. */
  concurrency: number;
  /**
   * Largest prompt, in estimated tokens, to send in one call. Contracts longer than this are
   * reviewed in overlapping windows. Unset means the whole contract goes in every call.
   */
  maxContextTokens: number | undefined;
  /** Retries for transport errors and for output that fails the schema. Default 2. */
  maxRetries: number;
  /**
   * Anthropic only, and only against the Anthropic API itself. "default" asks the API to rerun a
   * request on its default fallback model when the requested model declines it. Unset means off.
   */
  fallback?: "default" | undefined;
}

export interface GenerateObjectRequest<T> {
  system: string;
  prompt: string;
  /** Keep the shape plain: strings, enums, arrays, nullable objects. No min/max constraints. */
  schema: ZodType<T>;
  schemaName?: string;
  /**
   * The leading part of `prompt` that is identical across a batch of calls over the same document.
   * An adapter whose provider caches by prefix marks the end of it. `prompt` still holds the whole
   * text, so an adapter that ignores this field loses nothing.
   */
  sharedPrefix?: string;
  signal?: AbortSignal;
}

export interface ObjectGenerator {
  generate<T>(request: GenerateObjectRequest<T>): Promise<T>;
  readonly provider: string;
  readonly model: string;
  /**
   * One plain sentence saying where document text is sent, for example
   * "Anthropic API (api.anthropic.com)". Shown to the user before a review starts.
   */
  readonly disclosure: string;
  /**
   * True when `sharedPrefix` is cached. A cache entry only becomes readable once the first
   * response starts, so callers should finish one call before launching the rest in parallel.
   */
  readonly cachesSharedPrefix?: boolean;
  /**
   * The shortest shared prefix, in characters, that the provider can cache. Below it the prefix is
   * never cached, so waiting for one call to finish before the rest start gains nothing.
   */
  readonly minCacheableChars?: number;
}

/** The model declined to answer (a safety stop), so retrying the same request will not help. */
export class ModelRefusalError extends Error {
  override name = "ModelRefusalError";
  /** The provider's reason for declining, such as "cyber", when it gave one. */
  readonly category: string | undefined;

  constructor(message: string, category?: string) {
    super(message);
    this.category = category;
  }
}

/** The model answered, but never with output that fits the schema, even after retries. */
export class ModelOutputError extends Error {
  override name = "ModelOutputError";
  /** True when the last reply stopped at the output token limit, so a retry cannot help. */
  readonly truncated: boolean;

  constructor(message: string, truncated = false) {
    super(message);
    this.truncated = truncated;
  }
}

/** The environment does not describe a usable model setup. */
export class LlmConfigError extends Error {
  override name = "LlmConfigError";
}
