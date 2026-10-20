import type { ApiError, ErrorCode } from "@clausewise/api";
import type { ErrorHandler, NotFoundHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Logger } from "./log.js";
import type { AppEnv } from "./env.js";

/**
 * A failure whose message was written to be shown to the person using the web app as it is. It
 * never holds document text, a file system path, SQL or a secret, so it can leave the server.
 */
export class HttpError extends Error {
  override name = "HttpError";

  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string): HttpError =>
  new HttpError(400, "bad_request", message);
export const notFound = (message: string): HttpError => new HttpError(404, "not_found", message);
export const conflict = (message: string): HttpError => new HttpError(409, "conflict", message);
export const forbidden = (message: string): HttpError => new HttpError(403, "forbidden", message);

export const tooLarge = (message: string): HttpError =>
  new HttpError(413, "payload_too_large", message);

const body = (code: ErrorCode, message: string, requestId?: string): ApiError => ({
  error: { code, message, ...(requestId === undefined ? {} : { requestId }) },
});

/** The reply for an error that is the server's own fault. Its detail goes to the log, not here. */
export function internalErrorReply(requestId: string): ApiError {
  return body(
    "internal_error",
    `Something went wrong inside Clausewise. The details are in the server log under request id ${requestId}. They are not shown here because they can contain contract text.`,
    requestId,
  );
}

export function errorHandler(log: Logger): ErrorHandler<AppEnv> {
  return (error, c) => {
    if (error instanceof HttpError) {
      // The rest of an oversized upload is not read, so the connection is not reused for it.
      if (error.status === 413) c.header("Connection", "close");
      return c.json(body(error.code, error.message), error.status);
    }
    const requestId = c.get("requestId");
    log.error("unexpected error", error, requestId);
    return c.json(internalErrorReply(requestId), 500);
  };
}

export const notFoundHandler: NotFoundHandler<AppEnv> = (c) =>
  c.json(body("not_found", "There is nothing at this address."), 404);
