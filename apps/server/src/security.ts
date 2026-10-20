import { createHash, timingSafeEqual } from "node:crypto";
import type { HonoRequest, MiddlewareHandler } from "hono";
import type { Clock, IdSource } from "./deps.js";
import type { AppEnv } from "./env.js";
import { HttpError } from "./errors.js";
import type { Logger } from "./log.js";

// ---------------------------------------------------------------------------------------------
// Request id and the one log line
// ---------------------------------------------------------------------------------------------

/**
 * Gives the request an id of the server's own making (a client's header could hold anything, and
 * it would end up in the log), and writes the request's log line when it has been answered. The
 * line holds the route pattern and the outcome, and nothing about the request itself.
 */
export function requestLog(args: {
  ids: IdSource;
  log: Logger;
  clock: Clock;
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = args.ids.requestId();
    c.set("requestId", requestId);
    c.header("X-Request-Id", requestId);
    const started = performance.now();
    try {
      await next();
    } finally {
      // After next(), also when a handler threw: the error handler has made the response by then.
      args.log.request({
        requestId,
        method: c.req.method,
        route: routePattern(c.req),
        status: c.res.status,
        durationMs: Math.round(performance.now() - started),
      });
    }
  };
}

// The route that answered, which is the last one that ran: after the request has been handled the
// index still points at it. A middleware answers nothing by itself, so a request that only
// middleware saw is logged as unmatched rather than with its address, which a client chose.
function routePattern(request: HonoRequest): string {
  const route = request.matchedRoutes[request.routeIndex];
  return route === undefined || route.method === "ALL" ? "(unmatched)" : route.path;
}

// ---------------------------------------------------------------------------------------------
// Headers on every response
// ---------------------------------------------------------------------------------------------

/** The policy of the web app: its own files only, no inline script or style, no framing. */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/**
 * Set on every response, errors and static files included. The headers are put on before the
 * handler runs, and Hono carries them over to whatever response replaces the context's, which is
 * how an error reply gets them too. No CORS header is ever set: a page on another origin can send
 * a request but cannot read the answer.
 */
export function securityHeaders(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    await next();
  };
}

/** API answers must not be kept by a browser or a proxy: they hold the client's material. */
export function apiNoStore(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  };
}

// ---------------------------------------------------------------------------------------------
// Who may ask
// ---------------------------------------------------------------------------------------------

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The host the request was addressed to: the Host header, else the host of the request URL. */
export function requestHost(request: Request): string {
  return (request.headers.get("host") ?? new URL(request.url).host).toLowerCase();
}

function splitPort(host: string): { name: string; port: string | undefined } | undefined {
  const match = /^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(host);
  const name = match?.[1];
  return name === undefined ? undefined : { name, port: match?.[2] };
}

export function isAllowedHost(host: string, extra: readonly string[]): boolean {
  const parts = splitPort(host);
  if (parts === undefined) return false;
  return LOCAL_HOSTS.has(parts.name) || extra.includes(host) || extra.includes(parts.name);
}

/**
 * Without an access token, a page on any website could make the visitor's browser talk to this
 * server through a name it controls that points at 127.0.0.1 (DNS rebinding) and read the
 * answers. Such a request carries the attacker's name in its Host header, so only this machine's
 * names and the ones the owner listed are answered. With a token the token is the defence.
 */
export function hostCheck(args: {
  accessToken: string | undefined;
  allowedHosts: readonly string[];
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (
      args.accessToken === undefined &&
      !isAllowedHost(requestHost(c.req.raw), args.allowedHosts)
    ) {
      throw new HttpError(
        421,
        "wrong_host",
        "This server does not answer requests addressed to this name. Open Clausewise at http://localhost (with its port), or add the name you use to CLAUSEWISE_ALLOWED_HOSTS.",
      );
    }
    await next();
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * A request that changes something must come from a page this server served. A browser says where
 * a page came from in the Origin header, and a page on another site cannot change it.
 */
export function originCheck(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && !SAFE_METHODS.has(c.req.method)) {
      let originHost: string | undefined;
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        originHost = undefined;
      }
      if (originHost === undefined || originHost !== requestHost(c.req.raw)) {
        throw new HttpError(
          403,
          "forbidden",
          "This request came from a page on another site, so it was refused.",
        );
      }
    }
    await next();
  };
}

const BODY_TYPES = new Set(["application/json", "multipart/form-data"]);

/** The media type of a Content-Type header, in lower case and without its parameters. */
export function mediaType(header: string | undefined): string | undefined {
  const type = header?.split(";")[0]?.trim().toLowerCase();
  return type === undefined || type === "" ? undefined : type;
}

/**
 * Rejects a body of a type a form on another site could send without asking the browser's
 * permission (text/plain, a urlencoded form). A request with no body has no type and passes; a
 * route that needs a body checks for it itself.
 */
export function contentTypeCheck(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method)) {
      const type = mediaType(c.req.header("content-type"));
      if (type !== undefined && !BODY_TYPES.has(type)) {
        throw new HttpError(
          415,
          "unsupported_media_type",
          "The request body must be JSON (application/json) or a file upload (multipart/form-data).",
        );
      }
    }
    await next();
  };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Compares in constant time. Hashing first makes both sides the same length, as the call needs. */
export function tokensMatch(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

/** Paths that need no token: the health check, the config the web app reads to learn it needs one, and the web app. */
function isPublic(method: string, path: string): boolean {
  if (path === "/healthz") return true;
  if (path === "/api/config") return method === "GET" || method === "HEAD";
  return !(path === "/api" || path.startsWith("/api/"));
}

/**
 * The token goes in an Authorization header, never a cookie, so a request made by another site
 * cannot carry it. A refusal says nothing about the token: not whether one is needed, not how it
 * differed.
 */
export function bearerAuth(accessToken: string | undefined): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (accessToken === undefined || isPublic(c.req.method, c.req.path)) {
      await next();
      return;
    }
    const given = /^Bearer (.+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
    if (given === undefined || !tokensMatch(given, accessToken)) {
      c.header("WWW-Authenticate", "Bearer");
      throw new HttpError(401, "unauthorized", "Sign in with the access token to use Clausewise.");
    }
    await next();
  };
}
