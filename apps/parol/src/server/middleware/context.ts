import { randomBytes } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { beginRequest, requestState, type AuthDeps } from "../../auth/request.js";
import { UNMATCHED_ROUTE, formatAccessLine } from "./access-log.js";
import { errorResponse, toSafeError, type RenderError } from "./errors.js";
import { applySecurityHeaders } from "./security-headers.js";

export interface ContextOptions {
  log: (line: string) => void;
  renderError?: RenderError | undefined;
}

/** Fresh for every request. A value sent by the client is never reused, so it cannot reach a log. */
export const newRequestId = (): string => `req_${randomBytes(8).toString("hex")}`;

/** Change the response's headers, rebuilding it when its own are read-only (`Response.redirect`). */
function editHeaders(c: Context, edit: (headers: Headers) => void): void {
  try {
    edit(c.res.headers);
  } catch {
    c.res = new Response(c.res.body, c.res);
    edit(c.res.headers);
  }
}

/**
 * The route template for the log: the one the route was declared with, else the last route that
 * matched and handled the request. A request that matched no route has no template, and the path
 * it carried is not used instead.
 */
function routeTemplate(c: Context): string {
  const declared = requestState(c).routeTemplate;
  if (declared !== null) return declared;
  const handled = matchedRoutes(c).filter(
    (route) => route.method !== "ALL" && route.path !== "*" && route.path !== "/*",
  );
  return handled.at(-1)?.path ?? UNMATCHED_ROUTE;
}

/**
 * The outermost middleware. It gives the request an id and a place to remember what the shell
 * learns, lets everything else run, and then, whatever happened, puts on the response the id, the
 * security headers, any cookies the shell issued, and writes the one log line. Doing this after
 * the handlers return is what makes errors and 404s carry the same headers as successes.
 */
export function requestContext(deps: AuthDeps, options: ContextOptions): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    const state = beginRequest(c, deps, newRequestId());
    try {
      await next();
    } catch (thrown) {
      // Hono hands every Error to the error handler itself; this is a thrown value that is not
      // one. It gets the same safe response and is logged by class name only.
      const error = toSafeError(thrown);
      state.errorName = error.logName;
      c.res = errorResponse(c, error, state.requestId, options.renderError);
    }
    const https = deps.config.secureCookies;
    editHeaders(c, (headers) => {
      headers.set("x-request-id", state.requestId);
      applySecurityHeaders(headers, { path: c.req.path, https });
      for (const cookie of state.pendingCookies.values()) headers.append("Set-Cookie", cookie);
    });
    try {
      options.log(
        formatAccessLine({
          requestId: state.requestId,
          method: c.req.method,
          route: routeTemplate(c),
          status: c.res.status,
          latencyMs: performance.now() - started,
          userId: state.principal?.userId ?? null,
          matterId: state.matterId,
          errorName: state.errorName,
        }),
      );
    } catch {
      // A failing log sink must not turn a served request into an error.
    }
  };
}
