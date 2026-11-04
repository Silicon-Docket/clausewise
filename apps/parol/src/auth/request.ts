import type { Context } from "hono";
import type { AppDeps } from "../server/deps.js";
import type { SessionRevocations } from "./revocation.js";
import type { Principal } from "./types.js";

/**
 * What the identity, CSRF and authorization code need from the application. `revocations` is the
 * shell's own record of sessions signed out of; `createApp` makes it, so it is not part of `AppDeps`.
 */
export type AuthDeps = Pick<AppDeps, "repo" | "config" | "now"> & {
  revocations: SessionRevocations;
};

/**
 * What the shell remembers about one request. It lives in a WeakMap keyed by the request's
 * context and not in `c.set`, so it needs no change to the Hono environment type that every route
 * module is written against, and nothing but this package can read or write it.
 *
 * Nothing in here is taken from the request without being checked first: `principal` is read from
 * a verified cookie and the database, and `matterId` is set only after authorization, so the access
 * log can name them without repeating anything the caller typed.
 */
export interface RequestState {
  readonly deps: AuthDeps;
  readonly requestId: string;
  /** Undefined until read. Null means anonymous. Memoised so one request does one lookup. */
  principal?: Principal | null;
  /** The session cookie value in force: undefined means "read it from the request". */
  sessionValue?: string | null;
  /** The anonymous sign-in cookie value in force, with the same convention. */
  anonValue?: string | null;
  /** Cookies to send, by name, so a second write replaces the first. Added to the response last. */
  readonly pendingCookies: Map<string, string>;
  /** Set only from an `AuthorizedMatter`, never from the route parameter. */
  matterId: string | null;
  /** The template the route was registered with, such as `/matters/:matterId/runs`. */
  routeTemplate: string | null;
  /** The class name of the error that ended the request, when one did. */
  errorName: string | null;
}

const states = new WeakMap<Context, RequestState>();

export function beginRequest(c: Context, deps: AuthDeps, requestId: string): RequestState {
  const state: RequestState = {
    deps,
    requestId,
    pendingCookies: new Map(),
    matterId: null,
    routeTemplate: null,
    errorName: null,
  };
  states.set(c, state);
  return state;
}

/** Throws a plain error naming the setup mistake when `createApp` did not handle the request. */
export function requestState(c: Context): RequestState {
  const state = states.get(c);
  if (state === undefined) throw new Error("the Parol shell middleware is not installed");
  return state;
}
