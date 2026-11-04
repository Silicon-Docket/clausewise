import type { Context } from "hono";
import { generateCookie, getCookie } from "hono/cookie";
import type { AuthDeps } from "./request.js";

/**
 * Cookies the shell sends. Every one is HttpOnly, SameSite=Strict and scoped to the whole site,
 * and Secure when the deployment is https. SameSite=Strict is the first line against cross-site
 * requests (a browser does not send the cookie on one); the CSRF token is the second.
 */
export function cookieHeader(
  deps: AuthDeps,
  name: string,
  value: string,
  maxAgeSeconds: number,
): string {
  return generateCookie(name, value, {
    path: "/",
    httpOnly: true,
    sameSite: "Strict",
    maxAge: maxAgeSeconds,
    ...(deps.config.secureCookies ? { secure: true } : {}),
  });
}

/** A cookie that tells the browser to forget `name`. Same attributes as the one it replaces. */
export function expiredCookieHeader(deps: AuthDeps, name: string): string {
  return cookieHeader(deps, name, "", 0);
}

/** The raw value the browser sent, or undefined. Never a value taken from anywhere else. */
export function readCookie(c: Context, name: string): string | undefined {
  const value = getCookie(c, name);
  return value === undefined || value === "" ? undefined : value;
}
