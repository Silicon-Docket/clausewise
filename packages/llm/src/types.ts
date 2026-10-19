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
}

export interface GenerateObjectRequest<T> {
  system: string;
  prompt: string;
  /** Keep the shape plain: strings, enums, arrays, nullable objects. No min/max constraints. */
  schema: ZodType<T>;
  schemaName?: string;
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
}

/** The model declined to answer (a safety stop), so retrying the same request will not help. */
export class ModelRefusalError extends Error {
  override name = "ModelRefusalError";
}

/** The model answered, but never with output that fits the schema, even after retries. */
export class ModelOutputError extends Error {
  override name = "ModelOutputError";
}

/** The environment does not describe a usable model setup. */
export class LlmConfigError extends Error {
  override name = "LlmConfigError";
}
