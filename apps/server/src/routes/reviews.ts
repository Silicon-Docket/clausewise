import type { ReviewListResponse } from "@clausewise/api";
import { LIMITS } from "@clausewise/api";
import { and, count, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { readJson, storableText } from "../body.js";
import { documents, reviews } from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import type { AppEnv } from "../env.js";
import { HttpError, conflict, notFound } from "../errors.js";
import { getReviewDetail, getReviewSummary, listReviewSummaries } from "../views.js";
import { isUuid, uuidParam } from "./ids.js";
import { limitParam } from "./limit.js";

const CreateReview = z.strictObject({
  documentId: z.string().min(1).max(64),
  playbookId: z.string().min(1).max(200),
  client: storableText("The client text contains a NUL character.")
    .max(LIMITS.maxClientChars, `at most ${LIMITS.maxClientChars} characters`)
    .optional(),
});

export function reviewRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { db, model, config, clock, ids, runner, playbooks } = deps;

  app.post("/api/reviews", async (c) => {
    const body = await readJson(c, CreateReview);
    // Before anything is created: a review that could never run is not worth a row.
    if (!("generator" in model)) {
      throw new HttpError(
        503,
        "model_not_configured",
        `The model is not set up, so no review can run. ${model.problem}`,
      );
    }

    const documentId = body.documentId.toLowerCase();
    const [document] = isUuid(documentId)
      ? await db.select({ id: documents.id }).from(documents).where(eq(documents.id, documentId))
      : [];
    if (document === undefined) throw notFound("There is no such document.");
    const resolved = await playbooks.resolve(body.playbookId);
    if (resolved === undefined) throw notFound("There is no such playbook.");

    const [existing] = await db
      .select({ total: count() })
      .from(reviews)
      .where(eq(reviews.documentId, document.id));
    if ((existing?.total ?? 0) >= config.maxReviewsPerDocument) {
      throw new HttpError(
        429,
        "too_many_requests",
        `This document already has ${config.maxReviewsPerDocument} reviews, which is the most one document keeps. Delete some of them first.`,
      );
    }
    const place = runner.reserve();
    if (place === undefined) {
      throw new HttpError(
        429,
        "too_many_requests",
        "Too many reviews are waiting to run. Wait for some of them to finish, or cancel one, and try again.",
      );
    }

    const id = ids.uuid();
    const client = body.client?.trim();
    try {
      await db.insert(reviews).values({
        id,
        documentId: document.id,
        playbookId: resolved.id,
        playbookName: resolved.name,
        playbookYaml: resolved.yaml,
        client: client === undefined || client === "" ? null : client,
        status: "queued",
        progressDone: 0,
        progressTotal: resolved.playbook.rules.length,
        createdAt: clock.now(),
      });
    } catch (error) {
      place.release();
      throw error;
    }

    // Read before the runner can pick it up, so that the answer says "queued" as it should.
    const summary = await getReviewSummary(db, id);
    runner.enqueue(id, place);
    if (summary === undefined) throw notFound("There is no such review.");
    return c.json(summary, 202);
  });

  app.get("/api/reviews", async (c) => {
    const response: ReviewListResponse = { reviews: await listReviewSummaries(db, limitParam(c)) };
    return c.json(response);
  });

  app.get("/api/reviews/:id", async (c) => {
    const detail = await getReviewDetail(db, uuidParam(c, "id", "review"));
    if (detail === undefined) throw notFound("There is no such review.");
    return c.json(detail);
  });

  app.post("/api/reviews/:id/cancel", async (c) => {
    const id = uuidParam(c, "id", "review");
    const [stopped] = await db
      .update(reviews)
      .set({ status: "cancelled", finishedAt: clock.now() })
      .where(and(eq(reviews.id, id), inArray(reviews.status, ["queued", "running"])))
      .returning({ id: reviews.id });
    if (stopped === undefined) {
      const current = await getReviewSummary(db, id);
      if (current === undefined) throw notFound("There is no such review.");
      throw conflict("Only a review that is waiting or running can be cancelled.");
    }
    // The row says cancelled before the model calls are stopped, so a review that finishes in
    // between cannot turn into a result.
    runner.abort(id);
    const summary = await getReviewSummary(db, id);
    if (summary === undefined) throw notFound("There is no such review.");
    return c.json(summary);
  });

  app.delete("/api/reviews/:id", async (c) => {
    const id = uuidParam(c, "id", "review");
    const [row] = await db
      .select({ status: reviews.status })
      .from(reviews)
      .where(eq(reviews.id, id));
    if (row === undefined) throw notFound("There is no such review.");
    if (row.status === "running") {
      throw conflict("This review is running. Cancel it first, then delete it.");
    }
    await db.delete(reviews).where(eq(reviews.id, id));
    // A review that was waiting leaves the queue; one that started in between is stopped.
    runner.abort(id);
    return c.body(null, 204);
  });

  return app;
}
