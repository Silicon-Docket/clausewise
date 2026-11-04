import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { clearAnonymousCookie } from "../auth/csrf.js";
import { clearSession, issueSession } from "../auth/identity.js";
import { SessionRevocations } from "../auth/revocation.js";
import { requestState, type AuthDeps } from "../auth/request.js";
import { ValidationError } from "../store/errors.js";
import { assetHandler, loadAssets, DEFAULT_ASSETS_DIR } from "./assets.js";
import type { AppDeps } from "./deps.js";
import { bodyMediaType, formString, readForm } from "./http.js";
import { defineRoute } from "./matter-route.js";
import { requestContext } from "./middleware/context.js";
import { hostGuard } from "./middleware/host-guard.js";
import { NOT_FOUND, errorResponse, toSafeError, type RenderError } from "./middleware/errors.js";
import { SIGN_IN_INTENT, SIGN_OUT_INTENT, FIELDS } from "./pages/forms.js";
import { urls } from "./urls.js";

export interface AppOptions {
  /**
   * Renders an error page. It receives a status and a fixed title, never text from the request,
   * and for a server fault (5xx) the request id, which the page should show so it can be quoted.
   * Without it the shell sends a minimal page of its own.
   */
  renderError?: RenderError;
  /**
   * Receives one access line per request (docs/parol/06): ids, route template, status, latency.
   * Default: standard output. Nothing a caller typed is ever passed to it.
   */
  log?: (line: string) => void;
  /** Where the static files are. Default: apps/parol/public. */
  assetsDir?: string;
}

/** Room, beyond the upload limit, for multipart boundaries and the other fields of the form. */
export const UPLOAD_MARGIN_BYTES = 64 * 1024;
/** The shortest cookie secret `createApp` accepts. `parseEnv` asks for more. */
export const MIN_COOKIE_SECRET_LENGTH = 16;

export const SESSION_END_PATH = `${urls.session()}/end`;

const defaultLog = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** A sign-in or sign-out as a form posts it, or as a script sends it. */
async function readSessionFields(
  c: Parameters<typeof readForm>[0],
): Promise<{ intent: string | undefined; userId: string | undefined }> {
  if (bodyMediaType(c) === "application/json") {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ValidationError("bad_body", "the request body could not be read");
    }
    const record =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const text = (value: unknown): string | undefined =>
      typeof value === "string" ? value : undefined;
    return { intent: text(record[FIELDS.intent]), userId: text(record[FIELDS.userId]) };
  }
  const form = await readForm(c);
  return { intent: formString(form, FIELDS.intent), userId: formString(form, FIELDS.userId) };
}

/**
 * The Hono application with everything every route shares: request ids, security headers, the
 * body limit, safe errors, the access log, the demo identity routes, the health check and the
 * static files. Page and API routes are added to it afterwards, through `defineRoute` and
 * `defineMatterRoute`.
 */
export function createApp(deps: AppDeps, options: AppOptions = {}): Hono {
  const { config } = deps;
  if (config.cookieSecret.length < MIN_COOKIE_SECRET_LENGTH)
    throw new TypeError("the cookie secret is too short");
  if (!Number.isFinite(config.maxUploadBytes) || config.maxUploadBytes < 0)
    throw new TypeError("the upload limit is not a size");

  const log = options.log ?? defaultLog;
  const assets = loadAssets(options.assetsDir ?? DEFAULT_ASSETS_DIR);
  const authDeps: AuthDeps = {
    repo: deps.repo,
    config,
    now: deps.now,
    revocations: new SessionRevocations(),
  };
  const app = new Hono();

  // Order matters: the context wraps everything, so a body that is too large still gets the
  // headers, the request id and a log line.
  app.use("*", requestContext(authDeps, { log, renderError: options.renderError }));
  app.use("*", hostGuard(config));
  app.use("*", bodyLimit({ maxSize: config.maxUploadBytes + UPLOAD_MARGIN_BYTES }));

  app.onError((err, c) => {
    const state = requestState(c);
    const safe = toSafeError(err);
    state.errorName = safe.logName;
    return errorResponse(c, safe, state.requestId, options.renderError);
  });
  app.notFound((c) => errorResponse(c, NOT_FOUND, requestState(c).requestId, options.renderError));

  // A health check for a process manager. It reads nothing and says nothing about the data.
  defineRoute(app, {
    method: "GET",
    path: "/healthz",
    access: "public",
    handler: (c) => c.json({ status: "ok" }),
  });

  defineRoute(app, {
    method: "GET",
    path: "/assets/:name",
    access: "public",
    handler: assetHandler(assets),
  });

  // The sign-in and sign-out forms post here (pages/forms.ts). Signing out works whether or not
  // the demo identity is on; signing in works only when it is.
  defineRoute(app, {
    method: "POST",
    path: urls.session(),
    access: "public",
    handler: async (c) => {
      const wantsJson = bodyMediaType(c) === "application/json";
      const { intent = SIGN_IN_INTENT, userId } = await readSessionFields(c);
      if (intent === SIGN_OUT_INTENT) {
        clearSession(c);
        return wantsJson ? c.json({ ok: true }) : c.redirect(urls.home(), 303);
      }
      if (intent !== SIGN_IN_INTENT)
        throw new ValidationError("bad_intent", "the request did not say what to do");
      // With the identity off the route behaves as if it were not there.
      if (!config.demoIdentity) return c.notFound();
      const user = userId === undefined || userId === "" ? undefined : deps.repo.getUser(userId);
      if (user === undefined)
        throw new ValidationError("unknown_identity", "choose one of the listed identities");
      const principal = issueSession(c, user.id);
      clearAnonymousCookie(c);
      return wantsJson
        ? c.json({
            user: {
              userId: principal.userId,
              displayName: principal.displayName,
              globalRole: principal.globalRole,
            },
          })
        : c.redirect(urls.matters(), 303);
    },
  });

  defineRoute(app, {
    method: "POST",
    path: SESSION_END_PATH,
    access: "public",
    handler: (c) => {
      clearSession(c);
      return bodyMediaType(c) === "application/json"
        ? c.json({ ok: true })
        : c.redirect(urls.home(), 303);
    },
  });

  return app;
}
