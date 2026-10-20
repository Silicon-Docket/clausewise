import type { BulkDecisionResponse } from "@clausewise/api";
import { LIMITS } from "@clausewise/api";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { readJson, storableText } from "../body.js";
import { findings, reviews } from "../db/schema.js";
import type { Db } from "../db/client.js";
import type { AppDeps } from "../deps.js";
import type { AppEnv } from "../env.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { isFinding, toFinding } from "../views.js";
import { uuidParam } from "./ids.js";

const Decision = z.enum(["pending", "accepted", "rejected"]);
const Severity = z.enum(["high", "medium", "low"]);

const PatchFinding = z.strictObject({
  decision: Decision.optional(),
  editedReplacement: storableText("The wording contains a NUL character.")
    .max(LIMITS.maxReplacementChars, `at most ${LIMITS.maxReplacementChars} characters`)
    .nullable()
    .optional(),
});

const MAX_RULE_IDS = 500;
const BulkDecision = z.strictObject({
  decision: Decision,
  ruleIds: z.array(z.string().min(1).max(200)).max(MAX_RULE_IDS).optional(),
  severities: z.array(Severity).max(3).optional(),
});

/** A finished review with its report, which is what a decision is about. */
async function finishedReport(db: Db, id: string) {
  const [row] = await db
    .select({ status: reviews.status, report: reviews.report, context: reviews.context })
    .from(reviews)
    .where(eq(reviews.id, id));
  if (row === undefined) throw notFound("There is no such review.");
  if (row.status !== "done" || row.report === null) {
    throw conflict("This review has not finished, so it has no findings to decide on yet.");
  }
  return { report: row.report, context: row.context };
}

export function findingRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { db, clock } = deps;

  app.patch("/api/reviews/:id/findings/:ruleId", async (c) => {
    const id = uuidParam(c, "id", "review");
    const ruleId = c.req.param("ruleId");
    const body = await readJson(c, PatchFinding);
    if (body.decision === undefined && body.editedReplacement === undefined) {
      throw badRequest("Send a decision, wording of your own, or both.");
    }

    const { report, context } = await finishedReport(db, id);
    const result = report.results.find((item) => item.ruleId === ruleId && isFinding(item));
    if (result === undefined) throw notFound("There is no such finding in this review.");
    if (
      body.editedReplacement !== undefined &&
      body.editedReplacement !== null &&
      result.edit.kind !== "applied"
    ) {
      throw badRequest(
        "Wording of your own can replace only a suggested change to the contract. This finding is a comment only.",
      );
    }

    const now = clock.now();
    const changes = {
      ...(body.decision === undefined ? {} : { decision: body.decision }),
      ...(body.editedReplacement === undefined
        ? {}
        : { editedReplacement: body.editedReplacement }),
      updatedAt: now,
    };
    // An upsert: the row is made when the review finishes, and this keeps a missing one from
    // turning a decision into an error.
    const [row] = await db
      .insert(findings)
      .values({
        reviewId: id,
        ruleId,
        decision: body.decision ?? "pending",
        editedReplacement: body.editedReplacement ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({ target: [findings.reviewId, findings.ruleId], set: changes })
      .returning({
        ruleId: findings.ruleId,
        decision: findings.decision,
        editedReplacement: findings.editedReplacement,
      });
    return c.json(toFinding(result, context?.results[ruleId], row));
  });

  app.patch("/api/reviews/:id/findings", async (c) => {
    const id = uuidParam(c, "id", "review");
    const body = await readJson(c, BulkDecision);
    const { report } = await finishedReport(db, id);
    const wanted = report.results
      .filter(isFinding)
      .filter(
        (result) =>
          (body.ruleIds === undefined || body.ruleIds.includes(result.ruleId)) &&
          (body.severities === undefined || body.severities.includes(result.severity)),
      )
      .map((result) => result.ruleId);
    if (wanted.length === 0) {
      const empty: BulkDecisionResponse = { updated: 0 };
      return c.json(empty);
    }
    const changed = await db
      .update(findings)
      .set({ decision: body.decision, updatedAt: clock.now() })
      .where(and(eq(findings.reviewId, id), inArray(findings.ruleId, wanted)))
      .returning({ ruleId: findings.ruleId });
    const response: BulkDecisionResponse = { updated: changed.length };
    return c.json(response);
  });

  return app;
}
