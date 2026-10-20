import type { PlaybookListResponse } from "@clausewise/api";
import { Hono } from "hono";
import { z } from "zod";
import { PLAYBOOK_BODY_LIMIT, readJson, storableText } from "../body.js";
import type { AppDeps } from "../deps.js";
import type { AppEnv } from "../env.js";
import { notFound } from "../errors.js";

const YamlBody = z.strictObject({ yaml: storableText("The playbook contains a NUL character.") });

export function playbookRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { playbooks } = deps;

  app.get("/api/playbooks", async (c) => {
    const response: PlaybookListResponse = { playbooks: await playbooks.list() };
    return c.json(response);
  });

  // Registered before the routes with an id in the address, so that it is never read as one.
  app.post("/api/playbooks/validate", async (c) => {
    const { yaml } = await readJson(c, YamlBody, PLAYBOOK_BODY_LIMIT);
    return c.json(playbooks.validate(yaml));
  });

  app.get("/api/playbooks/:id", async (c) => {
    const detail = await playbooks.get(c.req.param("id"));
    if (detail === undefined) throw notFound("There is no such playbook.");
    return c.json(detail);
  });

  app.post("/api/playbooks", async (c) => {
    const { yaml } = await readJson(c, YamlBody, PLAYBOOK_BODY_LIMIT);
    return c.json(await playbooks.create(yaml), 201);
  });

  app.put("/api/playbooks/:id", async (c) => {
    const { yaml } = await readJson(c, YamlBody, PLAYBOOK_BODY_LIMIT);
    return c.json(await playbooks.update(c.req.param("id"), yaml));
  });

  app.delete("/api/playbooks/:id", async (c) => {
    await playbooks.remove(c.req.param("id"));
    return c.body(null, 204);
  });

  return app;
}
