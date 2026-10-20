import { Hono } from "hono";
import type { AppDeps } from "./deps.js";
import type { AppEnv } from "./env.js";
import { errorHandler, notFoundHandler } from "./errors.js";
import { documentRoutes } from "./routes/documents.js";
import { exportRoutes } from "./routes/export.js";
import { findingRoutes } from "./routes/findings.js";
import { playbookRoutes } from "./routes/playbooks.js";
import { reviewRoutes } from "./routes/reviews.js";
import { systemRoutes } from "./routes/system.js";
import {
  apiNoStore,
  bearerAuth,
  contentTypeCheck,
  hostCheck,
  originCheck,
  requestLog,
  securityHeaders,
} from "./security.js";
import { staticFiles } from "./static.js";

/**
 * The whole HTTP application, built from what it depends on and nothing else: it reads no
 * environment variable, opens no database and starts no work, so a test can build one with an
 * in-memory database, a scripted model, a fixed clock and a counter for ids.
 *
 * The order of the middleware is the order of the checks. The log line is outermost so that a
 * refused request is logged too, and the headers come next so that every answer carries them.
 */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const { config } = deps;
  const app = new Hono<AppEnv>();

  app.use("*", requestLog({ ids: deps.ids, log: deps.log, clock: deps.clock }));
  app.use("*", securityHeaders());
  // Before the checks, so that a refusal is not cached either.
  app.use("/api/*", apiNoStore());
  app.use("*", hostCheck({ accessToken: config.accessToken, allowedHosts: config.allowedHosts }));
  app.use("*", originCheck());
  app.use("*", contentTypeCheck());
  app.use("*", bearerAuth(config.accessToken));

  app.route("/", systemRoutes(deps));
  app.route("/", playbookRoutes(deps));
  app.route("/", documentRoutes(deps));
  app.route("/", reviewRoutes(deps));
  app.route("/", findingRoutes(deps));
  app.route("/", exportRoutes(deps));

  // Last, so that nothing under /api can be taken for a file. A path under /api that no route
  // answers is a not-found of the API, not of the web app.
  app.get("/api/*", (c) => notFoundHandler(c));
  app.get("*", staticFiles(config.webDir));

  app.notFound(notFoundHandler);
  app.onError(errorHandler(deps.log));
  return app;
}
