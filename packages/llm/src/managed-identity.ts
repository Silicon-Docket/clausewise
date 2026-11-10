import { ModelRequestError } from "./request-error.js";

/** The Entra ID resource that Azure OpenAI accepts tokens for. */
export const AZURE_OPENAI_RESOURCE = "https://cognitiveservices.azure.com";

/** Where the token service of an Azure Container Apps or App Service app is, and which identity. */
export interface ManagedIdentityConfig {
  /** The local token service, from the platform's IDENTITY_ENDPOINT variable. */
  identityEndpoint: string;
  /**
   * The client id of the user-assigned identity to sign in as. Unset asks for the app's
   * system-assigned identity, which the token service refuses when the app has none.
   */
  clientId: string | undefined;
}

export interface TokenSource {
  /** A bearer token that is valid for at least the next few minutes. */
  token(signal?: AbortSignal): Promise<string>;
}

// A token is replaced this long before it expires, so a request that takes a while to reach the
// model does not arrive with a token that has just run out.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const TOKEN_API_VERSION = "2019-08-01";

function identityFailure(message: string, status?: number, fatal = true): ModelRequestError {
  return new ModelRequestError(message, status, fatal, "auth");
}

function parseExpiry(raw: unknown): number | undefined {
  const text = typeof raw === "number" ? String(raw) : raw;
  if (typeof text !== "string" || !/^\d+$/.test(text)) return undefined;
  const seconds = Number(text);
  return Number.isSafeInteger(seconds) ? seconds * 1000 : undefined;
}

/**
 * Gets tokens from the managed identity of the Azure service this process runs in, through the
 * local REST endpoint that Container Apps and App Service provide. No key or secret is involved:
 * the platform proves who the app is.
 *
 * The SSRF header is read at every request because the platform rotates it. Neither the header
 * nor a token is ever put in an error message.
 */
export function createManagedIdentityTokenSource(
  config: ManagedIdentityConfig,
  options: {
    resource?: string;
    readHeader?: () => string | undefined;
    fetch?: typeof globalThis.fetch;
    now?: () => number;
  } = {},
): TokenSource {
  const resource = options.resource ?? AZURE_OPENAI_RESOURCE;
  const readHeader = options.readHeader ?? (() => process.env.IDENTITY_HEADER);
  const now = options.now ?? Date.now;
  let cached: { token: string; expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;

  async function request(): Promise<string> {
    const header = readHeader()?.trim();
    if (header === undefined || header === "") {
      throw identityFailure(
        "Could not get a token from this service's managed identity: IDENTITY_HEADER is not " +
          "set, so this process is not running in Azure Container Apps or App Service.",
      );
    }
    const url = new URL(config.identityEndpoint);
    url.searchParams.set("resource", resource);
    url.searchParams.set("api-version", TOKEN_API_VERSION);
    if (config.clientId !== undefined) url.searchParams.set("client_id", config.clientId);

    let response: Response;
    try {
      response = await (options.fetch ?? globalThis.fetch)(url, {
        method: "GET",
        headers: { "x-identity-header": header, metadata: "true" },
        redirect: "manual",
      });
    } catch (error) {
      // The cause can name internal addresses, so only its kind is kept.
      const kind = error instanceof Error ? error.name : "unknown error";
      throw identityFailure(
        `Could not reach this service's managed identity token endpoint (${kind}).`,
        undefined,
        false,
      );
    }
    if (!response.ok) {
      // A client id that names no identity attached to this app is the usual 400, and it fails the
      // same way every time; a server error might not.
      const fatal = response.status < 500;
      throw identityFailure(
        `This service's managed identity did not issue a token (HTTP ${response.status}). ` +
          "Check that AZURE_CLIENT_ID is the client id of a user-assigned identity attached to " +
          "this app.",
        response.status,
        fatal,
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw identityFailure("The managed identity token endpoint answered with no JSON.");
    }
    const token = (body as { access_token?: unknown }).access_token;
    const expiresAt = parseExpiry((body as { expires_on?: unknown }).expires_on);
    if (typeof token !== "string" || token === "" || expiresAt === undefined) {
      throw identityFailure("The managed identity token endpoint answered without a usable token.");
    }
    cached = { token, expiresAt };
    return token;
  }

  return {
    async token(signal) {
      signal?.throwIfAborted();
      if (cached !== undefined && cached.expiresAt - now() > REFRESH_MARGIN_MS) return cached.token;
      // Rule checks run in parallel and share one request for a new token. It is not tied to any
      // one caller's signal, so one aborted check cannot fail the others waiting on it; the local
      // token service answers quickly, and each caller checks its own signal once it has a token.
      pending ??= request().finally(() => {
        pending = undefined;
      });
      const token = await pending;
      signal?.throwIfAborted();
      return token;
    },
  };
}

/**
 * Wraps `fetch` so every request carries a current bearer token in place of whatever credential
 * the SDK set. The SDK is given a fixed placeholder key only so that it never reads one from the
 * environment, and this wrapper makes sure the placeholder never reaches the wire.
 */
export function withBearerToken(
  source: TokenSource,
  base?: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete("api-key");
    headers.set("authorization", `Bearer ${await source.token(init?.signal ?? undefined)}`);
    return (base ?? globalThis.fetch)(input, { ...init, headers });
  };
}
