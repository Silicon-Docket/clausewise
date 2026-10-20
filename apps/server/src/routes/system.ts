import type { ConfigResponse } from "@clausewise/api";
import { Hono } from "hono";
import type { AppDeps } from "../deps.js";
import type { AppEnv } from "../env.js";

/** The health check and the config the web app reads before it knows whether to ask for a token. */
export function systemRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { model, config } = deps;

  // No database work: a container's health check calls this every few seconds.
  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/api/config", (c) => {
    const response: ConfigResponse = {
      version: deps.version,
      authRequired: config.accessToken !== undefined,
      maxUploadBytes: config.maxUploadBytes,
      model:
        "generator" in model
          ? {
              configured: true,
              provider: model.generator.provider,
              model: model.generator.model,
              disclosure: model.generator.disclosure,
            }
          : { configured: false, problem: model.problem },
    };
    return c.json(response);
  });

  return app;
}
