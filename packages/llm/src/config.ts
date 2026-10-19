import { LlmConfigError, type Effort, type LlmConfig, type ProviderName } from "./types.js";

const PROVIDERS: readonly ProviderName[] = ["anthropic", "openai", "openai-compatible"];
const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";
const DEFAULT_MAX_OUTPUT_TOKENS = 16000;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_RETRIES = 2;

type Env = Record<string, string | undefined>;

// Messages name the variable and the fix but never echo a value: a mistyped variable can hold a
// key, and a base URL can carry credentials.
function fail(message: string): never {
  throw new LlmConfigError(message);
}

// Whitespace is trimmed because a key pasted from a file or a Docker secret often ends in a
// newline, which would make the provider reject a key that looks right.
function read(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function readInteger(env: Env, name: string, fallback: number, minimum: 0 | 1): number;
function readInteger(
  env: Env,
  name: string,
  fallback: undefined,
  minimum: 0 | 1,
): number | undefined;
function readInteger(
  env: Env,
  name: string,
  fallback: number | undefined,
  minimum: 0 | 1,
): number | undefined {
  const raw = read(env, name);
  if (raw === undefined) return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < minimum) {
    const kind = minimum === 0 ? "a whole number, 0 or more" : "a positive whole number";
    fail(`${name} must be ${kind}. Fix the value, or unset it to use the default.`);
  }
  return value;
}

function readProvider(env: Env): ProviderName {
  const raw = read(env, "CLAUSEWISE_PROVIDER");
  if (raw === undefined) return "anthropic";
  const provider = PROVIDERS.find((candidate) => candidate === raw);
  if (provider === undefined) {
    fail(
      `CLAUSEWISE_PROVIDER must be one of: ${PROVIDERS.join(", ")}. ` +
        "Fix the value, or unset it to use anthropic.",
    );
  }
  return provider;
}

function readModel(env: Env, provider: ProviderName): string {
  const model = read(env, "CLAUSEWISE_MODEL");
  if (model !== undefined) return model;
  if (provider === "anthropic") return DEFAULT_ANTHROPIC_MODEL;
  return fail(
    `CLAUSEWISE_MODEL is required when CLAUSEWISE_PROVIDER is ${provider}. ` +
      "Set it to the exact model name your account or server offers.",
  );
}

function readApiKey(env: Env, provider: ProviderName): string | undefined {
  switch (provider) {
    case "anthropic":
      return (
        read(env, "ANTHROPIC_API_KEY") ??
        fail(
          "ANTHROPIC_API_KEY is required when CLAUSEWISE_PROVIDER is anthropic. " +
            "Set it to your Anthropic API key.",
        )
      );
    case "openai":
      return (
        read(env, "OPENAI_API_KEY") ??
        fail(
          "OPENAI_API_KEY is required when CLAUSEWISE_PROVIDER is openai. " +
            "Set it to your OpenAI API key.",
        )
      );
    case "openai-compatible":
      return read(env, "CLAUSEWISE_API_KEY");
  }
}

function readBaseUrl(env: Env, provider: ProviderName): string | undefined {
  const raw = read(env, "CLAUSEWISE_BASE_URL");
  if (raw === undefined) {
    if (provider === "openai-compatible") {
      fail(
        "CLAUSEWISE_BASE_URL is required when CLAUSEWISE_PROVIDER is openai-compatible. " +
          "Set it to your server's API root, for example http://localhost:11434/v1 for Ollama.",
      );
    }
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail(
      "CLAUSEWISE_BASE_URL is not a valid URL. Set it to a full http or https URL, or unset it.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail("CLAUSEWISE_BASE_URL must start with http:// or https://. Fix the value, or unset it.");
  }
  return raw;
}

function readEffort(env: Env, provider: ProviderName): Effort | undefined {
  const raw = read(env, "CLAUSEWISE_EFFORT");
  if (raw === undefined) return undefined;
  if (provider !== "anthropic") {
    fail(
      "CLAUSEWISE_EFFORT only applies when CLAUSEWISE_PROVIDER is anthropic. " +
        "Unset it for other providers.",
    );
  }
  const effort = EFFORTS.find((candidate) => candidate === raw);
  if (effort === undefined) {
    fail(
      `CLAUSEWISE_EFFORT must be one of: ${EFFORTS.join(", ")}. ` +
        "Fix the value, or unset it to use the model default.",
    );
  }
  return effort;
}

// Off unless the variable is exactly "default". Server-side fallback sends the same prompt to a
// second model whenever the first declines it, so it is never switched on by a vague value.
function readFallback(
  env: Env,
  provider: ProviderName,
  baseUrl: string | undefined,
): "default" | undefined {
  const raw = read(env, "CLAUSEWISE_FALLBACK");
  if (raw === undefined) return undefined;
  if (provider !== "anthropic") {
    fail(
      "CLAUSEWISE_FALLBACK only applies when CLAUSEWISE_PROVIDER is anthropic. " +
        "Unset it for other providers.",
    );
  }
  if (raw !== "default") {
    fail(
      "CLAUSEWISE_FALLBACK must be exactly default. " +
        "Fix the value, or unset it to keep fallback off.",
    );
  }
  if (baseUrl !== undefined) {
    fail(
      "CLAUSEWISE_FALLBACK works only against the Anthropic API itself, not through " +
        "CLAUSEWISE_BASE_URL. Unset one of the two.",
    );
  }
  return raw;
}

export function loadLlmConfig(env: Record<string, string | undefined>): LlmConfig {
  const provider = readProvider(env);
  const config: LlmConfig = {
    provider,
    model: readModel(env, provider),
    apiKey: readApiKey(env, provider),
    baseUrl: readBaseUrl(env, provider),
    maxOutputTokens: readInteger(env, "CLAUSEWISE_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS, 1),
    effort: readEffort(env, provider),
    concurrency: readInteger(env, "CLAUSEWISE_CONCURRENCY", DEFAULT_CONCURRENCY, 1),
    maxContextTokens: readInteger(env, "CLAUSEWISE_MAX_CONTEXT_TOKENS", undefined, 1),
    maxRetries: readInteger(env, "CLAUSEWISE_MAX_RETRIES", DEFAULT_MAX_RETRIES, 0),
  };
  const fallback = readFallback(env, provider, config.baseUrl);
  return fallback === undefined ? config : { ...config, fallback };
}
