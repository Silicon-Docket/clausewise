import type { IncludeMode, ReportFormat } from "@clausewise/api";
import type { ReviewReport } from "@clausewise/review";
import { renderMarkdown } from "@clausewise/review";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { documents, findings, reviews } from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import type { AppEnv } from "../env.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { attachmentDisposition, stemOf } from "../filename.js";
import { isFinding } from "../views.js";
import { uuidParam } from "./ids.js";

/** Everything the redline writer needs for one review, read from what the server stored. */
export interface RedlineInput {
  /** The uploaded file, byte for byte. */
  docx: Uint8Array;
  report: ReviewReport;
  /** The rule ids whose comments and edits go into the file. */
  include: ReadonlySet<string>;
  /** The lawyer's own wording by rule id, for findings whose edit is applied and that are included. */
  replacements: ReadonlyMap<string, string>;
  /** The cleaned name of the uploaded file. */
  fileName: string;
}

/**
 * Loads the stored file, the stored report and the lawyer's decisions for a finished review, and
 * works out which findings the file should hold: with `accepted` only the ones the lawyer
 * accepted, with `all` every one not rejected. The download route passes the result to
 * `renderRedline`, so everything it needs is read here in one place.
 */
export async function loadRedlineInput(
  deps: Pick<AppDeps, "db" | "storage">,
  reviewId: string,
  mode: IncludeMode,
): Promise<RedlineInput> {
  const { db, storage } = deps;
  const [review] = await db
    .select({
      status: reviews.status,
      report: reviews.report,
      storageKey: documents.storageKey,
      fileName: documents.fileName,
    })
    .from(reviews)
    .innerJoin(documents, eq(reviews.documentId, documents.id))
    .where(eq(reviews.id, reviewId));
  if (review === undefined) throw notFound("There is no such review.");
  if (review.status !== "done" || review.report === null) {
    throw conflict("This review has not finished, so there is no redline to download yet.");
  }
  const docx = await storage.read(review.storageKey);
  if (docx === undefined) {
    throw notFound("The stored file for this document is missing. Upload the document again.");
  }

  const rows = await db
    .select({
      ruleId: findings.ruleId,
      decision: findings.decision,
      editedReplacement: findings.editedReplacement,
    })
    .from(findings)
    .where(eq(findings.reviewId, reviewId));
  const byRule = new Map(rows.map((row) => [row.ruleId, row]));

  const include = new Set<string>();
  const replacements = new Map<string, string>();
  for (const result of review.report.results) {
    if (!isFinding(result)) continue;
    const row = byRule.get(result.ruleId);
    const decision = row?.decision ?? "pending";
    if (mode === "accepted" ? decision !== "accepted" : decision === "rejected") continue;
    include.add(result.ruleId);
    if (row?.editedReplacement != null && result.edit.kind === "applied") {
      replacements.set(result.ruleId, row.editedReplacement);
    }
  }
  return { docx, report: review.report, include, replacements, fileName: review.fileName };
}

const FORMATS: readonly ReportFormat[] = ["json", "md"];

export function exportRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { db } = deps;

  app.get("/api/reviews/:id/report", async (c) => {
    const id = uuidParam(c, "id", "review");
    const format = FORMATS.find((candidate) => candidate === (c.req.query("format") ?? "json"));
    if (format === undefined) throw badRequest("The format must be json or md.");

    const [review] = await db
      .select({ status: reviews.status, report: reviews.report, fileName: documents.fileName })
      .from(reviews)
      .innerJoin(documents, eq(reviews.documentId, documents.id))
      .where(eq(reviews.id, id));
    if (review === undefined) throw notFound("There is no such review.");
    if (review.status !== "done" || review.report === null) {
      throw conflict("This review has not finished, so it has no report yet.");
    }

    const stem = stemOf(review.fileName);
    if (format === "md") {
      return c.body(renderMarkdown(review.report), 200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": attachmentDisposition(`${stem}.summary.md`),
      });
    }
    return c.body(`${JSON.stringify(review.report, null, 2)}\n`, 200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": attachmentDisposition(`${stem}.report.json`),
    });
  });

  return app;
}
