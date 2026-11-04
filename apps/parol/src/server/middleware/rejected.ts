import { RequestError } from "@hono/node-server";
import { newRequestId } from "./context.js";
import { UNMATCHED_ROUTE, formatAccessLine } from "./access-log.js";
import { builtinErrorPage, errorNameOf, titleFor } from "./errors.js";
import { applySecurityHeaders } from "./security-headers.js";

/**
 * What the server sends for a request that never reached the application: the HTTP adapter builds
 * the address of a request from its request line and Host header, and refuses what does not make
 * one (a space in the Host, a backslash in the path, a target that is not a path). Without this the
 * adapter answers a bare 400 with no body, so the one kind of request that is already malformed
 * would also be the one kind that skips the security headers, the request id and the access log.
 *
 * The page is the built-in one with a fixed title: it names the kind of problem and nothing about
 * what was sent. The log line has the same fixed shape as any other, with no method (the request
 * could not be read), no route and no person, and the class name of the refusal.
 */
export function rejectedRequestHandler(options: {
  log: (line: string) => void;
  https: boolean;
}): (error: unknown) => Response {
  return (error) => {
    const status = error instanceof RequestError ? 400 : 500;
    const requestId = newRequestId();
    const headers = new Headers({ "content-type": "text/html; charset=UTF-8" });
    headers.set("x-request-id", requestId);
    applySecurityHeaders(headers, { path: "/", https: options.https });
    try {
      options.log(
        formatAccessLine({
          requestId,
          method: "-",
          route: UNMATCHED_ROUTE,
          status,
          latencyMs: 0,
          userId: null,
          matterId: null,
          errorName: errorNameOf(error),
        }),
      );
    } catch {
      // A failing log sink must not change the answer.
    }
    const html = builtinErrorPage(status, titleFor(status), status >= 500 ? requestId : undefined);
    return new Response(html, { status, headers });
  };
}
