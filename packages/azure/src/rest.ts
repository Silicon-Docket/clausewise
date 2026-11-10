import type { TokenSource } from "@clausewise/llm";

/** The Entra ID resource Azure Storage accepts tokens for. */
export const STORAGE_RESOURCE = "https://storage.azure.com";

/**
 * The storage REST API version every request names. Bearer tokens need 2017-11-09 or later; a
 * fixed version keeps the service's behaviour from changing under the app.
 */
export const STORAGE_API_VERSION = "2023-11-03";

/**
 * A storage request that failed. The message names the operation, the HTTP status and Azure's
 * error code, which is a fixed identifier; it never repeats a token, a response body or a blob.
 */
export class StorageError extends Error {
  override name = "StorageError";

  constructor(
    message: string,
    readonly status: number | undefined,
    readonly code: string | undefined,
  ) {
    super(message);
  }
}

export interface StorageClientOptions {
  /** The account's endpoint for this service, as the foundation template outputs it. */
  endpoint: string;
  /** Tokens for STORAGE_RESOURCE, from the app's managed identity. */
  tokens: TokenSource;
  fetch?: typeof globalThis.fetch;
}

/**
 * Checks an endpoint and writes it with one trailing slash. Only https: a bearer token must never
 * cross a network in clear text. No credentials, query or fragment.
 */
export function normalizeEndpoint(raw: string, variable: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`${variable} is not a valid URL.`);
  }
  if (url.protocol !== "https:") throw new Error(`${variable} must start with https://.`);
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error(`${variable} must not contain credentials, a query or a fragment.`);
  }
  return `${url.origin}${url.pathname.replace(/\/*$/, "/")}`;
}

/** Sends one authenticated storage request. Redirects are answered, never followed. */
export async function storageRequest(
  options: StorageClientOptions,
  operation: string,
  url: URL,
  init: { method: string; headers?: Record<string, string>; body?: Uint8Array | string },
): Promise<Response> {
  const token = await options.tokens.token();
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(url, {
      method: init.method,
      headers: {
        ...init.headers,
        authorization: `Bearer ${token}`,
        "x-ms-version": STORAGE_API_VERSION,
        "x-ms-date": new Date().toUTCString(),
      },
      // A contract can be 50 MiB, so it is not copied: the type of a view on a shared buffer is
      // what fetch's type refuses, and the service never hands one over.
      ...(init.body === undefined ? {} : { body: init.body as BodyInit }),
      redirect: "manual",
    });
  } catch (error) {
    // The cause can name internal addresses, so only its kind is kept.
    const kind = error instanceof Error ? error.name : "unknown error";
    throw new StorageError(
      `${operation} failed: Azure Storage could not be reached (${kind}).`,
      undefined,
      undefined,
    );
  }
  return response;
}

/** The error for an answer the caller did not expect. The body is drained and never read. */
export async function unexpected(operation: string, response: Response): Promise<StorageError> {
  await response.body?.cancel().catch(() => undefined);
  const raw = response.headers.get("x-ms-error-code") ?? undefined;
  // Azure's codes are identifiers such as BlobNotFound. Anything else is not repeated.
  const code = raw !== undefined && /^[A-Za-z]{1,64}$/.test(raw) ? raw : undefined;
  return new StorageError(
    `${operation} failed with HTTP ${response.status}${code === undefined ? "" : ` (${code})`}.`,
    response.status,
    code,
  );
}
