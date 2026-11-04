import type { Context } from "hono";
import { NotFoundError } from "../store/errors.js";
import { ForbiddenError } from "../services/errors.js";
import { cookieHeader, expiredCookieHeader, readCookie } from "./cookies.js";
import { epochSeconds, safeEqual, sign } from "./crypto.js";
import { requestState } from "./request.js";
import type { Principal } from "./types.js";

/**
 * The demo identity (docs/parol/06). The user picks a seeded person from a list. That is not
 * authentication: anyone at the keyboard can be anyone, and the pages say so. What this module does
 * guarantee is that the identity a request acts as is one the server issued, unchanged, recently,
 * to a user who still exists. A user id in a header, a query string or a body is never read.
 *
 * The cookie is `v1.<user id, base64url>.<issued at, seconds>.<signature>`. The signature is an
 * HMAC-SHA256 over the first three parts under the configured secret. Everything else about the
 * user (name, roles) is read from the database on each request, so a change there takes effect at
 * once and nothing about a role lives in the cookie.
 */

export const SESSION_COOKIE = "parol_session";
/** Eight hours. Also enforced from the issue time inside the value, not only by the browser. */
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

const DOMAIN = "parol/session/v1";
const VERSION = "v1";
/** A cookie issued slightly in the future is a clock difference. One far ahead is not ours. */
const CLOCK_SKEW_SECONDS = 60;
const MAX_VALUE_LENGTH = 512;

/** The cookie value for `userId`, issued at `issuedAt`. Exported for tests and for nothing else. */
export function mintSessionValue(secret: string, userId: string, issuedAt: Date): string {
  const head = `${VERSION}.${Buffer.from(userId, "utf8").toString("base64url")}.${epochSeconds(issuedAt)}`;
  return `${head}.${sign(secret, DOMAIN, head)}`;
}

/**
 * What a session cookie value says, when it is well formed, correctly signed and not expired.
 * Any other value, whatever is wrong with it, gives null: the caller cannot tell the cases apart
 * and neither can anyone probing it.
 */
function verifySessionValue(
  secret: string,
  value: string,
  now: Date,
): { userId: string; issuedAt: number } | null {
  if (value.length === 0 || value.length > MAX_VALUE_LENGTH) return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [version, encodedUser, issued, signature] = parts as [string, string, string, string];
  if (version !== VERSION || !/^[A-Za-z0-9_-]{1,256}$/.test(encodedUser)) return null;
  if (!/^\d{1,12}$/.test(issued)) return null;
  const expected = sign(secret, DOMAIN, `${version}.${encodedUser}.${issued}`);
  if (!safeEqual(signature, expected)) return null;
  const age = epochSeconds(now) - Number(issued);
  if (age > SESSION_MAX_AGE_SECONDS || age < -CLOCK_SKEW_SECONDS) return null;
  return {
    userId: Buffer.from(encodedUser, "base64url").toString("utf8"),
    issuedAt: Number(issued),
  };
}

/** The user id inside a session cookie value, or null (see `verifySessionValue`). */
export function parseSessionValue(secret: string, value: string, now: Date): string | null {
  return verifySessionValue(secret, value, now)?.userId ?? null;
}

/** The session cookie value in force for this request: a fresh one, or what the browser sent. */
export function sessionCookieValue(c: Context): string | null {
  const state = requestState(c);
  if (state.sessionValue !== undefined) return state.sessionValue;
  return readCookie(c, SESSION_COOKIE) ?? null;
}

/**
 * Who is asking, or null for an anonymous visitor. Null also when the demo identity is switched
 * off, because there is then no way to be anyone.
 */
export function readPrincipal(c: Context): Principal | null {
  const state = requestState(c);
  if (state.principal !== undefined) return state.principal;
  const { config, repo, now } = state.deps;
  let principal: Principal | null = null;
  if (config.demoIdentity) {
    const value = sessionCookieValue(c);
    const checked = value === null ? null : verifySessionValue(config.cookieSecret, value, now());
    // A value that was signed out of is anonymous, though its signature is still good.
    const userId =
      value !== null &&
      checked !== null &&
      !state.deps.revocations.isRevoked(value, now().getTime())
        ? checked.userId
        : null;
    // A valid signature for a user who has since been deleted is anonymous, not an error.
    const user = userId === null ? undefined : repo.getUser(userId);
    if (user !== undefined)
      principal = { userId: user.id, displayName: user.displayName, globalRole: user.globalRole };
  }
  state.principal = principal;
  return principal;
}

/**
 * Signs `userId` in: sets the session cookie on the response and makes the rest of this request
 * act as that user. The user must exist in the database. Refused when the demo identity is off.
 */
export function issueSession(c: Context, userId: string): Principal {
  const state = requestState(c);
  const { config, repo, now } = state.deps;
  if (!config.demoIdentity) throw new ForbiddenError("session.start");
  const user = repo.getUser(userId);
  if (user === undefined) throw new NotFoundError("user");
  const value = mintSessionValue(config.cookieSecret, user.id, now());
  // The same person signing in again within the second they signed out is issued the same value.
  state.deps.revocations.release(value);
  state.pendingCookies.set(
    SESSION_COOKIE,
    cookieHeader(state.deps, SESSION_COOKIE, value, SESSION_MAX_AGE_SECONDS),
  );
  const principal: Principal = {
    userId: user.id,
    displayName: user.displayName,
    globalRole: user.globalRole,
  };
  state.sessionValue = value;
  state.principal = principal;
  return principal;
}

/**
 * Signs out: the browser is told to forget the cookie, the value is recorded as ended so a copy of
 * it taken before this no longer works, and the rest of this request is anonymous.
 */
export function clearSession(c: Context): void {
  const state = requestState(c);
  const value = sessionCookieValue(c);
  if (value !== null) {
    const checked = verifySessionValue(state.deps.config.cookieSecret, value, state.deps.now());
    // Only a value this server signed is recorded. It is kept until it would have expired anyway.
    if (checked !== null)
      state.deps.revocations.revoke(
        value,
        (checked.issuedAt + SESSION_MAX_AGE_SECONDS + CLOCK_SKEW_SECONDS) * 1000,
        state.deps.now().getTime(),
      );
  }
  state.pendingCookies.set(SESSION_COOKIE, expiredCookieHeader(state.deps, SESSION_COOKIE));
  state.sessionValue = null;
  state.principal = null;
}
