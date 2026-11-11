import { STATUS_CODES, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { RequestError } from "@hono/node-server";
import { newRequestId } from "./context.js";
import { UNMATCHED_ROUTE, formatAccessLine, markAnsweredBelow } from "./access-log.js";
import { builtinErrorPage, errorNameOf, titleFor } from "./errors.js";
import { applySecurityHeaders } from "./security-headers.js";

/**
 * What the server sends for a request that never reached the application. Three things refuse a
 * request below the application, and each used to answer with a bare status line, which made the
 * one kind of request that is already malformed the one kind that skipped the security headers,
 * the request id and the access log:
 *
 *  - the HTTP adapter, which builds the address of a request from its request line and Host header
 *    and refuses what does not make one (`rejectedRequestHandler`);
 *  - Node's own parser, which refuses a request line, a header or a length it cannot read, and
 *    reports it as a `clientError` on the socket (`wireErrorHandler`);
 *  - Node's own Host check, and the framing the parser reports only after it has handed the request
 *    on (`guardRequests`).
 *
 * The page is the built-in one with a fixed title and the fixed sentence for the status
 * (`guidance.ts`, chosen by the status alone, since nothing of the request was read), so that a
 * request refused below the application still says what happened and what to do. It names the
 * kind of problem and nothing about what was sent. The log line has the same fixed shape as any
 * other, with no method (the request could not be read), no route and no person, and a fixed name
 * for the refusal.
 */

export interface WireOptions {
  log: (line: string) => void;
  https: boolean;
}

interface Refusal {
  headers: Headers;
  html: string;
}

/** Makes the answer and writes its one access line, so the two cannot disagree about the status. */
function refuse(status: number, errorName: string, options: WireOptions): Refusal {
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
        errorName,
      }),
    );
  } catch {
    // A failing log sink must not change the answer.
  }
  return {
    headers,
    html: builtinErrorPage(status, titleFor(status), status >= 500 ? requestId : undefined),
  };
}

/** The adapter's refusal of a request it cannot build an address for. */
export function rejectedRequestHandler(options: WireOptions): (error: unknown) => Response {
  return (error) => {
    const status = error instanceof RequestError ? 400 : 500;
    const { headers, html } = refuse(status, errorNameOf(error), options);
    return new Response(html, { status, headers });
  };
}

// ---------------------------------------------------------------------------------------------
// Node's own parser
// ---------------------------------------------------------------------------------------------

/** The codes Node's parser and server use. Fixed words of Node's, never taken from a request. */
const WIRE_CODE = /^(?:HPE|ERR)_[A-Z0-9_]{1,56}$/;

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && WIRE_CODE.test(code) ? code : null;
}

/** The status Node's own default would have sent for the same error. */
function statusOfWireError(error: unknown): 400 | 408 | 431 {
  const code = codeOf(error);
  if (code === "HPE_HEADER_OVERFLOW") return 431;
  if (code === "ERR_HTTP_REQUEST_TIMEOUT") return 408;
  return 400;
}

/**
 * Sockets whose request `guardRequests` has already answered. The parser reports its own error for
 * the same request right after, and a second answer and a second log line would contradict the
 * first.
 */
const answered = new WeakSet<Duplex>();

/**
 * The `clientError` handler of the HTTP server. Without one Node writes a bare `400 Bad Request`
 * (`431` for a header that is too large) and closes the connection. This writes the same status,
 * with the headers every other response has, and logs it.
 *
 * It answers only when an answer is possible: a socket that is gone, or one whose response is
 * already on its way out, is closed and nothing is logged, because no request was refused.
 */
export function wireErrorHandler(options: WireOptions): (error: Error, socket: Duplex) => void {
  return (error, socket) => {
    if (answered.has(socket)) return;
    // `_httpMessage` is the response of the request being served, if the parser had handed one on
    // before it failed (a body that turns out to be malformed). Half a response must not be
    // followed by a second one.
    const inFlight = (socket as { _httpMessage?: { headersSent?: boolean } })._httpMessage;
    if (!socket.writable || socket.destroyed || inFlight?.headersSent === true) {
      socket.destroy();
      return;
    }
    if (inFlight !== undefined) markAnsweredBelow(inFlight);
    const status = statusOfWireError(error);
    const { headers, html } = refuse(status, codeOf(error) ?? errorNameOf(error), options);
    headers.set("content-length", String(Buffer.byteLength(html)));
    headers.set("date", new Date().toUTCString());
    headers.set("connection", "close");
    const head = [`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}`];
    headers.forEach((value, name) => head.push(`${name}: ${value}`));
    // Closed once the answer is out, so a client that never hangs up does not hold the socket.
    socket.end(`${head.join("\r\n")}\r\n\r\n${html}`, () => socket.destroy());
  };
}

// ---------------------------------------------------------------------------------------------
// Requests the parser lets through that no answer can be built for
// ---------------------------------------------------------------------------------------------

/**
 * Why the framing of a request cannot be trusted, as a fixed name, or null. A Transfer-Encoding
 * that does not end in `chunked` is refused by Node's parser, but only after it has handed the
 * request on, so the application would start to answer a request that the client is told is
 * malformed and would log a status the client never saw. A request that lacks Host is refused by
 * Node itself, with a bare answer, unless the server is told to leave it to us.
 */
function framingProblem(req: IncomingMessage): string | null {
  if (req.httpVersion === "1.1" && req.headers.host === undefined) return "MissingHostHeader";
  const coding = req.headers["transfer-encoding"];
  if (coding !== undefined && coding.split(",").pop()?.trim().toLowerCase() !== "chunked")
    return "UnrecognisedTransferEncoding";
  return null;
}

/**
 * Wraps the request listener. A request whose framing cannot be trusted is answered with a 400 here
 * and never reaches the application; every other request goes through untouched. The server must be
 * created with `requireHostHeader: false`, or Node answers a missing Host before this runs.
 */
export function guardRequests(
  options: WireOptions,
  next: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): (req: IncomingMessage, res: ServerResponse) => void | Promise<void> {
  return (req, res) => {
    const problem = framingProblem(req);
    if (problem === null) return next(req, res);
    answered.add(req.socket);
    const { headers, html } = refuse(400, problem, options);
    headers.set("connection", "close");
    const fields: Record<string, string> = {};
    headers.forEach((value, name) => (fields[name] = value));
    res.writeHead(400, fields);
    res.end(html);
    return undefined;
  };
}
