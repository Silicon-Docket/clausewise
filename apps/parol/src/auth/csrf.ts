import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import { CSRF_FIELD } from "../server/pages/forms.js";
import { ValidationError } from "../store/errors.js";
import { cookieHeader, expiredCookieHeader, readCookie } from "./cookies.js";
import { epochSeconds, safeEqual, sign } from "./crypto.js";
import { readPrincipal, sessionCookieValue } from "./identity.js";
import { requestState } from "./request.js";

/**
 * Cross-site request forgery protection.
 *
 * A token is an HMAC of the cookie that identifies the visitor, so it is worthless without that
 * cookie and a page on another site can neither read it nor guess it. Every POST, PUT, PATCH and
 * DELETE must carry one, in the `_csrf` form field or the `x-csrf-token` header. GET and HEAD
 * never change state in Parol, so they carry none.
 *
 * Before sign-in there is no session to bind a token to. The sign-in form would then be open to
 * login CSRF: a hostile page could post a form that signs the visitor in as a person the attacker
 * chose. So a visitor who is shown a form without a session gets a short-lived anonymous cookie, and
 * the token on that form is bound to it. The attacker has no way to put that cookie in the victim's
 * browser or to learn the token that goes with it.
 */

export const ANON_COOKIE = "parol_anon";
/** One hour: long enough to read the page and pick a person, short enough to be disposable. */
export const ANON_MAX_AGE_SECONDS = 60 * 60;
export const CSRF_HEADER = "x-csrf-token";

const ANON_DOMAIN = "parol/anon/v1";
const TOKEN_DOMAIN = "parol/csrf/v1";
const VERSION = "v1";

/** The request carried no token, or one that does not belong to this visitor. Maps to HTTP 403. */
export class CsrfError extends Error {
  override name = "CsrfError";
  constructor() {
    super("the form token is missing or not valid");
  }
}

/** Methods that must carry a token. Anything that is not a plain read does. */
export function isUnsafeMethod(method: string): boolean {
  const upper = method.toUpperCase();
  return upper !== "GET" && upper !== "HEAD" && upper !== "OPTIONS";
}

function mintAnonValue(secret: string, now: Date): string {
  const head = `${VERSION}.${randomBytes(18).toString("base64url")}.${epochSeconds(now)}`;
  return `${head}.${sign(secret, ANON_DOMAIN, head)}`;
}

/** Whether an anonymous cookie value is one we issued and has not run out. */
export function isValidAnonValue(secret: string, value: string, now: Date): boolean {
  if (value.length === 0 || value.length > 256) return false;
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  const [version, nonce, issued, signature] = parts as [string, string, string, string];
  if (version !== VERSION || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !/^\d{1,12}$/.test(issued))
    return false;
  if (!safeEqual(signature, sign(secret, ANON_DOMAIN, `${version}.${nonce}.${issued}`)))
    return false;
  const age = epochSeconds(now) - Number(issued);
  return age <= ANON_MAX_AGE_SECONDS && age >= -60;
}

/** The token for a binding string. Exported for tests that need to forge the wrong one. */
export function tokenForBinding(secret: string, binding: string): string {
  return sign(secret, TOKEN_DOMAIN, binding);
}

function anonValue(c: Context): string | null {
  const state = requestState(c);
  const { config, now } = state.deps;
  const value =
    state.anonValue !== undefined ? state.anonValue : (readCookie(c, ANON_COOKIE) ?? null);
  return value !== null && isValidAnonValue(config.cookieSecret, value, now()) ? value : null;
}

/**
 * What the token is bound to: the session cookie of a signed-in visitor, else the anonymous
 * cookie, else nothing. The prefix keeps a session value and an anonymous value apart.
 */
function currentBinding(c: Context): string | null {
  if (readPrincipal(c) !== null) {
    const session = sessionCookieValue(c);
    if (session !== null) return `s:${session}`;
  }
  const anon = anonValue(c);
  return anon === null ? null : `a:${anon}`;
}

/**
 * The token a page puts in its forms. A visitor who has neither a session nor an anonymous cookie
 * is given the anonymous cookie here, on this response, so the token matches what they post back.
 */
export function csrfToken(c: Context): string {
  const state = requestState(c);
  let binding = currentBinding(c);
  if (binding === null) {
    const value = mintAnonValue(state.deps.config.cookieSecret, state.deps.now());
    state.anonValue = value;
    state.pendingCookies.set(
      ANON_COOKIE,
      cookieHeader(state.deps, ANON_COOKIE, value, ANON_MAX_AGE_SECONDS),
    );
    binding = `a:${value}`;
  }
  return tokenForBinding(state.deps.config.cookieSecret, binding);
}

/** Forget the anonymous cookie, once a session replaces it. */
export function clearAnonymousCookie(c: Context): void {
  const state = requestState(c);
  state.anonValue = null;
  if (readCookie(c, ANON_COOKIE) !== undefined || state.pendingCookies.has(ANON_COOKIE))
    state.pendingCookies.set(ANON_COOKIE, expiredCookieHeader(state.deps, ANON_COOKIE));
}

/** The token from the form field, for requests that carry no header. Reads the body once; Hono caches it. */
async function formToken(c: Context): Promise<string | undefined> {
  const type = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded" && type !== "multipart/form-data")
    return undefined;
  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody();
  } catch {
    // The message of a parser error can quote the body, so it is not passed on.
    throw new ValidationError("bad_body", "the request body could not be read");
  }
  const value = body[CSRF_FIELD];
  return typeof value === "string" ? value : undefined;
}

/**
 * Throws `CsrfError` unless the request carries the token that belongs to this visitor. A header
 * wins over a form field, and a wrong header is not retried against the form.
 */
export async function verifyCsrf(c: Context): Promise<void> {
  const state = requestState(c);
  const binding = currentBinding(c);
  const header = c.req.header(CSRF_HEADER);
  const provided = header !== undefined && header !== "" ? header : await formToken(c);
  // Compared even when there is no binding, so a missing cookie and a wrong token take alike.
  const expected = tokenForBinding(state.deps.config.cookieSecret, binding ?? "none");
  const matches = provided !== undefined && safeEqual(provided, expected);
  if (binding === null || !matches) throw new CsrfError();
}
