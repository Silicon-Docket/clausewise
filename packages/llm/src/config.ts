import { BaseUrlError, normalizeBaseUrl } from "./endpoint.js";
import { LlmConfigError, type Effort, type LlmConfig, type ProviderName } from "./types.js";

const PROVIDERS: readonly ProviderName[] = [
  "anthropic",
  "openai",
  "openai-compatible",
  "azure-openai",
];
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
  if (provider === "azure-openai") {
    return fail(
      "CLAUSEWISE_MODEL is required when CLAUSEWISE_PROVIDER is azure-openai. " +
        "Set it to the name of the model deployment on your Azure OpenAI resource.",
    );
  }
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
    case "azure-openai":
      // A key would only work if key access were left on, which the Azure deployment turns off.
      if (read(env, "CLAUSEWISE_API_KEY") !== undefined) {
        fail(
          "azure-openai takes no key: it signs in with the managed identity of the Azure service " +
            "it runs in. Unset CLAUSEWISE_API_KEY.",
        );
      }
      return undefined;
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
    if (provider === "azure-openai") {
      fail(
        "CLAUSEWISE_BASE_URL is required when CLAUSEWISE_PROVIDER is azure-openai. Set it to " +
          "your resource's v1 API root, https://<resource>.openai.azure.com/openai/v1.",
      );
    }
    return undefined;
  }
  try {
    const baseUrl = normalizeBaseUrl(raw);
    if (provider === "azure-openai") checkAzureBaseUrl(baseUrl);
    return baseUrl;
  } catch (error) {
    // The reason never repeats the URL, which can carry a password.
    if (error instanceof BaseUrlError)
      return fail(
        `CLAUSEWISE_BASE_URL is not usable. ${error.message} Fix the value, or unset it.`,
      );
    throw error;
  }
}

// Azure OpenAI answers a wrong path with a bare 404, so the shape is checked before anything is
// sent. The v1 API takes no api-version, which is why the root ends in /openai/v1.
function checkAzureBaseUrl(baseUrl: string): void {
  if (!baseUrl.startsWith("https://")) {
    throw new BaseUrlError("For azure-openai it must start with https://.");
  }
  if (!/\/openai\/v1$/i.test(baseUrl)) {
    throw new BaseUrlError(
      "For azure-openai it must be the v1 API root, ending in /openai/v1, as in " +
        "https://<resource>.openai.azure.com/openai/v1.",
    );
  }
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The token service is local to the app and set by the platform, so these variables being absent
// means the process is not running where azure-openai can sign in, which is worth saying before
// any contract is read.
function readAzure(env: Env, provider: ProviderName): LlmConfig["azure"] {
  if (provider !== "azure-openai") return undefined;
  const clientId = read(env, "AZURE_CLIENT_ID");
  const endpoint = read(env, "IDENTITY_ENDPOINT");
  if (endpoint === undefined || read(env, "IDENTITY_HEADER") === undefined) {
    fail(
      "azure-openai signs in with the managed identity of the Azure service it runs in, but " +
        "IDENTITY_ENDPOINT and IDENTITY_HEADER are not both set: this process is not running in " +
        "Azure Container Apps or App Service.",
    );
  }
  let identityEndpoint: string;
  try {
    identityEndpoint = normalizeBaseUrl(endpoint);
  } catch (error) {
    if (error instanceof BaseUrlError) {
      return fail(`IDENTITY_ENDPOINT is not usable. ${error.message}`);
    }
    throw error;
  }
  if (clientId !== undefined && !GUID.test(clientId)) {
    fail(
      "AZURE_CLIENT_ID must be the client id of a user-assigned identity, a GUID. Fix the " +
        "value, or unset it to use the system-assigned identity.",
    );
  }
  return { identityEndpoint, clientId };
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
  const azure = readAzure(env, provider);
  return {
    ...config,
    ...(fallback === undefined ? {} : { fallback }),
    ...(azure === undefined ? {} : { azure }),
  };
}
