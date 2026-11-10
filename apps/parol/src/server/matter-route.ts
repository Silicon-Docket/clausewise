import type { Context, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { TrieRouter } from "hono/router/trie-router";
import { authorizeMatter, authorizeMatterDelete } from "../auth/authorize.js";
import { isUnsafeMethod, verifyCsrf } from "../auth/csrf.js";
import { readPrincipal } from "../auth/identity.js";
import { requestState } from "../auth/request.js";
import {
  GLOBAL_ACTIONS,
  globalRoleAllows,
  type GlobalAction,
  type MatterAction,
} from "../auth/actions.js";
import type { AuthorizedMatter, Principal } from "../auth/types.js";
import { ForbiddenError } from "../services/errors.js";
import { unauthenticatedResponse } from "./middleware/errors.js";

/**
 * How routes are declared. Every route of the application goes through one of two functions, so
 * that what a route needs (nothing, a signed-in person, or membership of a matter in a role) is
 * written down at the place it is defined and enforced by code that is the same for all of them:
 *
 * - `defineMatterRoute` for anything under `/matters/:matterId` or `/api/matters/:matterId`. It
 *   resolves the person, checks the CSRF token on a write, authorizes against the database, and
 *   only then calls the handler, with the `AuthorizedMatter` it made.
 * - `defineRoute` for everything else, with `access` saying whether the route is public or needs a
 *   person, and, for a page that names no matter but only some global roles may open, the
 *   `globalAction` it checks (see `GLOBAL_ACTIONS`).
 *
 * The shell's own middleware (the request context, the host guard and the like) goes through a
 * third, `defineMiddleware`, which only records the function it registers: a handler on a wildcard
 * is not told from middleware by its path, because a responder registered with `app.all('/x/*')`,
 * `app.use` or `app.mount` has the same path.
 *
 * All three record what they registered. `findUnguardedMatterRoutes` compares that record with the
 * routes the application really holds, so a matter route added another way (`app.get`, `app.all`,
 * a mounted sub-application) is found whether or not the author remembered the rule, and
 * `findMatterUrlsWithoutGuard` routes matter URLs through the application to find a generic route
 * (`/:area/:id`, `*`) that would answer them. `describeRoutes` reports anything else as `unmanaged`.
 */

export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type RouteKind = "matter" | "public" | "principal";

export interface MatterRouteSpec {
  /**
   * GET is for the actions that only read (`matter.read`, `run.read`, `finding.read`,
   * `memo.read`): a GET carries no CSRF token. Any other action on GET is a TypeError at
   * registration.
   */
  method: RouteMethod;
  /** Must start with `/matters/:matterId` or `/api/matters/:matterId`. */
  path: string;
  /** What the route does, which decides the roles that may. See `MATTER_ACTIONS`. */
  action: MatterAction;
  handler: (c: Context, am: AuthorizedMatter) => Response | Promise<Response>;
}

export interface PublicRouteSpec {
  method: RouteMethod;
  path: string;
  access: "public";
  handler: (c: Context) => Response | Promise<Response>;
}

export interface PrincipalRouteSpec {
  method: RouteMethod;
  path: string;
  access: "principal";
  /**
   * The global action the route needs, when it is not open to every signed-in person: the guard
   * answers 403 to a person whose global role is not listed for it (see `GLOBAL_ACTIONS`). GET is
   * for the actions that only read (`READ_ONLY_GLOBAL_ACTIONS`): any other global action on GET is
   * a TypeError at registration.
   */
  globalAction?: GlobalAction;
  handler: (c: Context, principal: Principal) => Response | Promise<Response>;
}

export type RouteSpec = PublicRouteSpec | PrincipalRouteSpec;

export interface RouteRecord {
  kind: RouteKind | "middleware";
  method: RouteMethod | "ALL";
  path: string;
  /** The action a matter route checks; null for the others. */
  action: MatterAction | null;
  /** The global action a principal route checks; null for the others. */
  globalAction: GlobalAction | null;
}

/** The record of every guard function made here, by identity of the function Hono holds. */
const records = new WeakMap<object, RouteRecord>();

/** A public write comes from someone with no session, so its body is held to a small size. */
export const PUBLIC_BODY_LIMIT_BYTES = 64 * 1024;
const limitPublicBody = bodyLimit({ maxSize: PUBLIC_BODY_LIMIT_BYTES });

/**
 * The actions that only read. GET and HEAD carry no CSRF token, so a route bound to either may do
 * nothing else. The list is the exception, not the rule: an action not named here (a new one
 * included) is taken to change state and is refused on GET until someone decides otherwise here.
 */
const READ_ONLY_ACTIONS: ReadonlySet<MatterAction> = new Set<MatterAction>([
  "matter.read",
  "run.read",
  "finding.read",
  "memo.read",
]);

/**
 * The global actions that only read, as `READ_ONLY_ACTIONS` is for matter actions: a GET bound to
 * any other global action is refused at registration.
 */
export const READ_ONLY_GLOBAL_ACTIONS: ReadonlySet<GlobalAction> = new Set<GlobalAction>([
  "evaluation.read",
  "pilot.read",
  "audit.read",
  "training.key",
]);

const MATTER_PREFIX = /^(?:\/api)?\/matters\/:matterId(?:\{[^}]*\})?(?:\/|$)/;

/**
 * Whether a registered path can reach a matter: it has a segment `matters` followed by a
 * parameter or a wildcard, or it names a `:matterId` parameter anywhere. Deliberately wider than
 * the two prefixes the rule names, so `/matters/:id/x`, `/api/matters/*` and a mounted
 * `/v2/matters/:matterId` are all caught.
 */
export function isMatterScopedPath(path: string): boolean {
  return /(?:^|\/)matters\/(?::|\*|\{)/.test(path) || /:matterId\b/.test(path);
}

/**
 * Registers a piece of the shell's own middleware for every path and every method. It is the only
 * way the shell registers one, so that `describeRoutes` can tell it from a handler that was
 * registered another way (kind `middleware`, by the identity of the function). The handler runs and
 * hands on; a responder must not be registered here.
 */
export function defineMiddleware(app: Hono, handler: MiddlewareHandler): void {
  records.set(handler, {
    kind: "middleware",
    method: "ALL",
    path: "/*",
    action: null,
    globalAction: null,
  });
  app.use("*", handler);
}

/** The route's own template is logged, never the path the request carried. */
function note(c: Context, path: string): void {
  requestState(c).routeTemplate = path;
}

export function defineMatterRoute(app: Hono, spec: MatterRouteSpec): void {
  if (!MATTER_PREFIX.test(spec.path))
    throw new TypeError(
      "a matter route must start with /matters/:matterId or /api/matters/:matterId",
    );
  const method = spec.method.toUpperCase() as RouteMethod;
  if ((method === "GET" || (method as string) === "HEAD") && !READ_ONLY_ACTIONS.has(spec.action))
    throw new TypeError(
      `${spec.action} changes state, so it cannot be bound to ${method}, which carries no CSRF token; use POST, PUT, PATCH or DELETE`,
    );
  const guard = async (c: Context): Promise<Response> => {
    note(c, spec.path);
    const state = requestState(c);
    // Who, then whether the write is genuine, then whether they may. Nothing before the person is
    // known reads the body, and nothing before the token is checked says whether a matter exists.
    const principal = readPrincipal(c);
    if (principal === null) return unauthenticatedResponse(c);
    if (isUnsafeMethod(c.req.method)) await verifyCsrf(c);
    const { repo, config } = state.deps;
    const matterId = c.req.param("matterId") ?? "";
    const am =
      spec.action === "matter.delete"
        ? authorizeMatterDelete(repo, principal, matterId)
        : authorizeMatter(repo, principal, matterId, spec.action, config);
    // The log names the matter the database confirmed, never the id the request carried.
    state.matterId = am.matterId;
    return spec.handler(c, am);
  };
  records.set(guard, {
    kind: "matter",
    method,
    path: spec.path,
    action: spec.action,
    globalAction: null,
  });
  app.on(method, spec.path, guard);
}

export function defineRoute(app: Hono, spec: RouteSpec): void {
  if (isMatterScopedPath(spec.path))
    throw new TypeError("a route that can reach a matter must be declared with defineMatterRoute");
  // Read from the object as it is, not from its type: a public route that names a global action
  // would be taken for gated and be open to everyone.
  const named = (spec as { globalAction?: unknown }).globalAction;
  if (named !== undefined) {
    if (spec.access !== "principal")
      throw new TypeError("only a route for a signed-in person can name a global action");
    if (typeof named !== "string" || !Object.hasOwn(GLOBAL_ACTIONS, named))
      throw new TypeError("the global action of a route must be one of GLOBAL_ACTIONS");
    const method = (spec.method as string).toUpperCase();
    if (
      (method === "GET" || method === "HEAD") &&
      !READ_ONLY_GLOBAL_ACTIONS.has(named as GlobalAction)
    )
      throw new TypeError(
        `${named} changes state, so it cannot be bound to ${method}, which carries no CSRF token; use POST, PUT, PATCH or DELETE`,
      );
  }
  const globalAction = spec.access === "principal" ? (spec.globalAction ?? null) : null;
  const guard = async (c: Context): Promise<Response> => {
    note(c, spec.path);
    if (spec.access === "public") {
      if (!isUnsafeMethod(c.req.method)) return spec.handler(c);
      let response: Response | undefined;
      await limitPublicBody(c, async () => {
        await verifyCsrf(c);
        response = await spec.handler(c);
      });
      return response as Response;
    }
    const principal = readPrincipal(c);
    if (principal === null) return unauthenticatedResponse(c);
    if (isUnsafeMethod(c.req.method)) await verifyCsrf(c);
    // The person, then whether the write is genuine, then whether their global role may. The
    // role is the one the database gave this request (identity.ts reads it on every request).
    if (globalAction !== null && !globalRoleAllows(principal.globalRole, globalAction))
      throw new ForbiddenError(globalAction);
    return spec.handler(c, principal);
  };
  records.set(guard, {
    kind: spec.access,
    method: spec.method,
    path: spec.path,
    action: null,
    globalAction,
  });
  app.on(spec.method, spec.path, guard);
}

/** Hono wraps a mounted sub-application's handlers when its error handler differs. Look through. */
function recordOf(handler: unknown): RouteRecord | undefined {
  let current: unknown = handler;
  for (let depth = 0; depth < 8 && typeof current === "function"; depth += 1) {
    const found = records.get(current);
    if (found !== undefined) return found;
    current = (current as { __COMPOSED_HANDLER?: unknown }).__COMPOSED_HANDLER;
  }
  return undefined;
}

export interface RouteReport {
  method: string;
  path: string;
  /**
   * How it was declared: `middleware` for the shell's own (`defineMiddleware`), or `unmanaged` for
   * anything registered another way, middleware of another kind included.
   */
  kind: RouteKind | "middleware" | "unmanaged";
  action: MatterAction | null;
  /** The global action a principal route checks; null for every other route. */
  globalAction: GlobalAction | null;
}

/** Every route the application holds, with how it was declared. */
export function describeRoutes(app: Hono): RouteReport[] {
  return app.routes.map((route) => {
    const found = recordOf(route.handler);
    // A guard counts only at the method and path it was made for: the same function registered
    // under another path would be authorizing on a parameter the author never meant.
    const record =
      found !== undefined &&
      found.method === route.method &&
      (route.path === found.path || route.path.endsWith(found.path))
        ? found
        : undefined;
    return {
      method: route.method,
      path: route.path,
      kind: record?.kind ?? "unmanaged",
      action: record?.action ?? null,
      globalAction: record?.globalAction ?? null,
    };
  });
}

/**
 * Every route that can reach a matter and was not registered by `defineMatterRoute`, as
 * `METHOD /path`. Empty means every matter route passes through authorization. Reads the
 * application as it is now, so it holds for routes added after this was written.
 */
export function findUnguardedMatterRoutes(app: Hono): string[] {
  return describeRoutes(app)
    .filter((route) => isMatterScopedPath(route.path) && route.kind !== "matter")
    .map((route) => `${route.method} ${route.path}`);
}

/** Methods a matter URL is probed with. HEAD is answered by the GET handler, so it adds nothing. */
const PROBE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** URLs of the shapes a matter route can have, whether or not any route was declared for them. */
const PROBE_URLS = [
  "/matters/probe",
  "/matters/probe/probe",
  "/matters/probe/probe/probe",
  "/api/matters/probe",
  "/api/matters/probe/probe",
  "/api/matters/probe/probe/probe",
];

/** A path template made into a URL that fits it: every parameter and wildcard becomes `probe`. */
export function concreteUrl(path: string): string {
  return path.replace(/:[A-Za-z_]\w*(?:\{[^}]*\})?\??/g, "probe").replace(/\*/g, "probe");
}

/**
 * Whether a route is middleware that every request under some prefix passes through: the shell's
 * own (`defineMiddleware`), or one registered for every method on a wildcard with a fixed prefix
 * another way. It runs and hands on, so the route that answers is the next one that matches. The
 * second kind is taken for middleware by its path alone, which cannot tell it from a responder:
 * `findMatterUrlsWithoutGuard` is for matter URLs, and the evaluation's exposure suite stops for
 * any such route that the application's own source registers, and sends every method to it. A
 * wildcard that names a matter path is not exempt: the path check reports it.
 */
function isPrefixMiddleware(route: RouteReport): boolean {
  if (route.kind === "middleware") return true;
  return (
    route.method === "ALL" &&
    route.kind === "unmanaged" &&
    /^(?:\/[A-Za-z0-9._~-]+)*\/?\*$/.test(route.path) &&
    !isMatterScopedPath(route.path)
  );
}

/**
 * Probes the application with URLs that name a matter (`/matters/<id>`, `/api/matters/<id>/...`,
 * and a concrete URL for every guarded route) and reports each one that something other than a
 * matter guard would answer, as `METHOD /url answered by METHOD /pattern`. Empty means every such
 * URL goes to a guard, or to nothing (the 404 page).
 *
 * `findUnguardedMatterRoutes` reads the paths routes were registered with, so it cannot see a route
 * whose path does not name a matter: `/:area/:id`, `/api/*` or `*` answer `/matters/<id>` all the
 * same. This asks the router instead, in registration order, as a real request is routed: the first
 * handler that matches and is not prefix middleware decides, so a guard registered before a generic
 * route covers its own URLs and one registered after it does not.
 *
 * The routes are put into a router of its own. Hono's router refuses new routes once it has
 * matched a request, so asking the application's own would stop the application being extended.
 */
export function findMatterUrlsWithoutGuard(app: Hono): string[] {
  const routes = describeRoutes(app);
  const router = new TrieRouter<number>();
  routes.forEach((route, index) => {
    try {
      router.add(route.method, route.path, index);
    } catch {
      // A path the router cannot hold cannot be reached by a request either.
    }
  });
  const urls = new Set(PROBE_URLS);
  for (const route of routes) if (route.kind === "matter") urls.add(concreteUrl(route.path));
  const found = new Set<string>();
  for (const method of PROBE_METHODS) {
    for (const url of urls) {
      const [matches] = router.match(method, url);
      for (const [index] of matches) {
        const route = routes[index];
        if (route === undefined || isPrefixMiddleware(route)) continue;
        if (route.kind !== "matter")
          found.add(`${method} ${url} answered by ${route.method} ${route.path}`);
        break;
      }
    }
  }
  return [...found];
}
