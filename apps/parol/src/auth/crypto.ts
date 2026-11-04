import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The only two primitives the identity and CSRF code use, so every signature in the shell is made
 * and compared the same way.
 *
 * Each use of the secret has its own `domain`, which is hashed in front of the message. A value
 * signed for one purpose (a session cookie) therefore never verifies for another (a CSRF token or
 * the anonymous sign-in cookie), even though they share one secret and look alike.
 */
export function sign(secret: string, domain: string, message: string): string {
  return createHmac("sha256", secret)
    .update(domain)
    .update("\0")
    .update(message)
    .digest("base64url");
}

/**
 * Compares two strings without stopping at the first difference. Strings of different length are
 * unequal, and that is allowed to be visible: the lengths of our own signatures are public. The
 * dummy comparison keeps the work done on a wrong length close to the work done on a wrong value.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** Whole seconds since the epoch, for the issue times inside cookies. */
export function epochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}
