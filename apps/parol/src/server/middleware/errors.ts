import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { CsrfError } from "../../auth/csrf.js";
import { UploadError } from "../../module-contracts.js";
import { ForbiddenError, RunNotReadyError } from "../../services/errors.js";
import {
  ActiveRunError,
  AuditDetailError,
  ConflictError,
  EXPORT_BLOCKER_REASONS,
  ExportBlockedError,
  NotFoundError,
  StaleRunError,
  ValidationError,
} from "../../store/errors.js";
import { isApiPath } from "../http.js";
import { urls } from "../urls.js";

/**
 * Turns whatever was thrown into a response that is safe to send to the person who caused it.
 *
 * The rule is that the response names a kind of problem and never repeats what the caller sent. So
 * a class gets a fixed message, and the only things taken from an error object are values a
 * module chose and that are checked here to be what they claim to be: a short code, an id read
 * from the database, a closed reason. A module's own message text is not passed on, except for the
 * two classes whose contract is that the message is written for the user (an upload that cannot be
 * accepted, a run that cannot start). The log gets the error's class name for unexpected failures
 * and nothing else.
 */

export interface SafeError {
  status: ContentfulStatusCode;
  kind: string;
  /** The heading for an HTML page. */
  title: string;
  message: string;
  /** Extra JSON fields, each already checked. */
  extra: Record<string, unknown>;
  /** The class name for the access log, set only for failures nobody expected. */
  logName: string | null;
}

const TITLES: Record<number, string> = {
  400: "That request was not valid",
  401: "Sign in first",
  403: "You may not do that",
  404: "Page not found",
  409: "That conflicts with the current state",
  413: "That upload is too large",
  422: "That file could not be accepted",
  500: "Something went wrong",
};
export const titleFor = (status: number): string => TITLES[status] ?? TITLES[500]!;

const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const REASONS: ReadonlySet<string> = new Set(EXPORT_BLOCKER_REASONS);
const WHY: ReadonlySet<string> = new Set(["superseded", "inputs_changed"]);

const safeCode = (code: unknown, fallback: string): string =>
  typeof code === "string" && CODE.test(code) ? code : fallback;
const safeId = (id: unknown): string | null => (typeof id === "string" && ID.test(id) ? id : null);

/** Text written for the user, with control characters and length taken out. */
function userText(value: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * The class name of an error, if it looks like one. Some classes (Hono's `HTTPException`) leave
 * `name` at "Error", so the constructor's name is the better label when `name` says nothing.
 */
export function errorNameOf(err: unknown): string {
  if (!(err instanceof Error)) return "NonError";
  if (!NAME.test(err.name)) return "Error";
  if (err.name !== "Error") return err.name;
  const constructorName = (err.constructor as { name?: unknown } | undefined)?.name;
  return typeof constructorName === "string" && NAME.test(constructorName)
    ? constructorName
    : "Error";
}

const safe = (
  status: ContentfulStatusCode,
  kind: string,
  message: string,
  extra: Record<string, unknown> = {},
  logName: string | null = null,
): SafeError => ({ status, kind, title: titleFor(status), message, extra, logName });

/** The same answer for an unknown route, a matter the caller may not know of, and a missing row. */
export const NOT_FOUND: SafeError = safe(404, "not_found", "Not found.");

const internal = (err: unknown): SafeError =>
  safe(500, "internal", "Something went wrong on the server.", {}, errorNameOf(err));

export function toSafeError(err: unknown): SafeError {
  if (err instanceof CsrfError)
    return safe(403, "csrf", "The form is no longer valid. Reload the page and try again.");
  if (err instanceof NotFoundError) return NOT_FOUND;
  if (err instanceof ForbiddenError) return safe(403, "forbidden", "You may not do that.");
  // A detail object that broke the audit rules is a defect in our code, not in the request.
  if (err instanceof AuditDetailError) return internal(err);
  if (err instanceof ValidationError)
    return safe(400, "invalid_request", "The request was not valid.", {
      code: safeCode(err.code, "invalid"),
    });
  if (err instanceof ExportBlockedError)
    return safe(
      409,
      "export_blocked",
      "The memo cannot be exported until every finding has a current decision.",
      {
        code: "export_blocked",
        // Finding ids and reason codes only: never a rule title, a quote or a reviewer's reason.
        blockers: err.blockers.slice(0, 100).map((b) => ({
          findingId: safeId(b.findingId),
          reason: REASONS.has(b.reason) ? b.reason : "unknown",
        })),
      },
    );
  if (err instanceof ActiveRunError) {
    const runId = safeId(err.activeRunId);
    return safe(409, "active_run", "The matter already has a run in progress.", {
      code: "active_run",
      ...(runId === null ? {} : { activeRunId: runId }),
    });
  }
  if (err instanceof StaleRunError)
    return safe(409, "stale_run", "The run no longer matches the matter's documents.", {
      code: "stale_run",
      ...(WHY.has(err.why) ? { why: err.why } : {}),
    });
  if (err instanceof ConflictError)
    return safe(409, "conflict", "The request conflicts with the current state.", {
      code: safeCode(err.code, "conflict"),
    });
  if (err instanceof RunNotReadyError)
    return safe(409, "not_ready", "The matter is not ready for a review.", {
      code: "not_ready",
      reasons: err.reasons.slice(0, 20).map((reason) => userText(reason, 200)),
    });
  if (err instanceof UploadError)
    return safe(
      422,
      "upload_rejected",
      userText(err.message, 300) || "The file could not be accepted.",
    );
  // Validation libraries put received values in their messages; only the fact is reported.
  if (err instanceof ZodError)
    return safe(400, "invalid_request", "The request was not valid.", { code: "invalid" });
  if (err instanceof HTTPException) {
    if (err.status === 413) return safe(413, "too_large", "The request body is too large.");
    if (err.status === 401) return safe(401, "unauthenticated", "Sign in first.");
    if (err.status === 403) return safe(403, "forbidden", "You may not do that.");
    if (err.status === 404) return safe(404, "not_found", "Not found.");
    if (err.status === 422)
      return safe(422, "unprocessable", "The request could not be processed.");
    if (err.status >= 400 && err.status < 500)
      return safe(400, "invalid_request", "The request was not valid.", { code: "invalid" });
  }
  return internal(err);
}

/**
 * Renders an error page. `requestId` is given for a server fault (5xx) only, so the person who
 * sees "Something went wrong" has something to quote. It is made by the server for the request,
 * never taken from it. Pages for every other status get none, which keeps a 404 for a matter the
 * caller may not know of byte for byte the same as a 404 for a matter that does not exist.
 */
export type RenderError = (status: number, title: string, requestId?: string) => string;

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (ch) =>
    ch === "&"
      ? "&amp;"
      : ch === "<"
        ? "&lt;"
        : ch === ">"
          ? "&gt;"
          : ch === '"'
            ? "&quot;"
            : "&#39;",
  );

/**
 * The page used when the application gives none. A fixed title and a link home; nothing from the
 * request, and nothing inline, to satisfy the content security policy.
 */
export function builtinErrorPage(status: number, title: string, requestId?: string): string {
  const heading = escapeHtml(title);
  const reference =
    requestId === undefined ? "" : `<p>Reference: <code>${escapeHtml(requestId)}</code></p>`;
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    `<title>${heading} | Parol</title>`,
    '<link rel="stylesheet" href="/assets/parol.css">',
    "</head><body><main>",
    `<p>Error ${status}</p><h1>${heading}</h1>${reference}`,
    `<p><a href="${urls.home()}">Back to the start</a></p>`,
    "</main></body></html>",
  ].join("");
}

/** The response for a failure: JSON under /api, an HTML page otherwise. */
export function errorResponse(
  c: Context,
  error: SafeError,
  requestId: string,
  render: RenderError = builtinErrorPage,
): Response {
  if (isApiPath(c.req.path)) {
    // Only a server fault carries the request id: the 4xx bodies stay byte-identical for the same
    // kind of failure, which is what keeps a missing matter and a forbidden one indistinguishable.
    const body = {
      error: {
        kind: error.kind,
        message: error.message,
        ...error.extra,
        ...(error.status >= 500 ? { requestId } : {}),
      },
    };
    return c.json(body, error.status);
  }
  // Only a server fault carries the id, for the same reason as in the JSON body above.
  const reference = error.status >= 500 ? requestId : undefined;
  let html: string;
  try {
    html = render(error.status, error.title, reference);
  } catch {
    html = builtinErrorPage(error.status, error.title, reference);
  }
  return c.html(html, error.status);
}

/** What a visitor with no session gets: 401 JSON for the API, a redirect to sign-in for pages. */
export function unauthenticatedResponse(c: Context): Response {
  if (isApiPath(c.req.path))
    return c.json({ error: { kind: "unauthenticated", message: "Sign in first." } }, 401);
  return c.redirect(urls.home(), 303);
}
