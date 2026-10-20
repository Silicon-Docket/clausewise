import { envProxyFor } from "./proxy.js";

/** Why a base URL was refused. The text never repeats the URL, which can carry credentials. */
export class BaseUrlError extends Error {
  override name = "BaseUrlError";
}

/**
 * Hosts that mean this machine, so a connection that never leaves it needs no encryption. The
 * hostname of an IPv6 literal keeps its brackets in a parsed URL.
 */
const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
  "host.docker.internal",
]);

export function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname.toLowerCase());
}

export function parseUrl(raw: string | undefined): URL | undefined {
  if (raw === undefined) return undefined;
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

// The Messages API paths the Anthropic SDK appends itself. A base URL that already ends in one of
// them would be sent to the path twice.
const ANTHROPIC_API_PATH = /(?:\/v1)?\/messages$|\/v1$/i;

/**
 * Checks a base URL and writes it in one canonical form: an http or https URL with no username,
 * password, query or fragment, and no trailing slash. A URL with a query would have the request
 * path appended inside it, and credentials in a URL end up in logs and error messages.
 *
 * With `anthropicRoot` the API path is removed too, because the Anthropic SDK adds `/v1/messages`
 * itself while gateways are usually written down as an API root ending in `/v1`, as the other
 * providers are configured. The result is exactly the string to hand to that SDK.
 */
export function normalizeBaseUrl(raw: string, options: { anthropicRoot?: boolean } = {}): string {
  const url = parseUrl(raw.trim());
  if (url === undefined) {
    throw new BaseUrlError("It is not a valid URL. Set it to a full http or https URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BaseUrlError("It must start with http:// or https://.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new BaseUrlError(
      "It must not contain a username or password. Pass the key in the API key variable.",
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new BaseUrlError("It must not contain a query string or fragment.");
  }
  let path = url.pathname.replace(/\/+$/, "");
  if (options.anthropicRoot === true) path = path.replace(ANTHROPIC_API_PATH, "");
  return `${url.origin}${path}`;
}

/**
 * What a reader of the disclosure line needs to know about the connection beyond the host: whether
 * the contract crosses a network in clear text, and whether a proxy configured in the environment
 * sits in the path. A proxy is named by its host only, never with credentials or a path.
 */
export function connectionNotes(target: URL | undefined): string[] {
  if (target === undefined) return [];
  const notes: string[] = [];
  if (target.protocol === "http:" && !isLocalHostname(target.hostname)) {
    notes.push("not encrypted: plain http");
  }
  const proxy = envProxyFor(target);
  if (proxy !== undefined) {
    notes.push(proxy === "" ? "through a proxy" : `through a proxy (${proxy})`);
  }
  return notes;
}
