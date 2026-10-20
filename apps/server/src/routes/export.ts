import type { IncludeMode, ReportFormat } from "@clausewise/api";
import type { ReviewReport } from "@clausewise/review";
import { ReviewError, renderMarkdown, renderRedline } from "@clausewise/review";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { documents, findings, reviews } from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import type { AppEnv } from "../env.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { DOCX_TYPE, attachmentDisposition, derivedFileName } from "../filename.js";
import { isFinding } from "../views.js";
import { uuidParam } from "./ids.js";

/** Who the tracked changes and comments in a downloaded redline are by. */
export const REDLINE_AUTHOR = "Clausewise";
/** The response header that carries what the lawyer should know about the file. */
export const WARNINGS_HEADER = "X-Clausewise-Warnings";
/** The most the value of that header may hold, once percent-encoded. */
export const MAX_WARNINGS_HEADER_CHARS = 4000;

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

const leftOut = (count: number): string =>
  `${count} more ${count === 1 ? "warning was" : "warnings were"} left out because there was no room for ${count === 1 ? "it" : "them"} here.`;

// What encodeURIComponent makes of one string in a JSON list: the quotation marks, the escapes
// and every character outside ASCII. The list then adds %5B and %5D around the elements and a %2C
// between two of them, which is 6 characters and 3 for each element but the first.
const encodedLength = (text: string): number => encodeURIComponent(JSON.stringify(text)).length;

/**
 * The value of the X-Clausewise-Warnings header: the warnings as a JSON array of strings,
 * percent-encoded so that the header is plain ASCII whatever the warnings say. A header has a
 * limit, so when the list does not fit in `MAX_WARNINGS_HEADER_CHARS` characters whole warnings
 * are dropped from the end and one is added that says how many were left out. Nothing is cut in
 * the middle of a warning. Undefined when there is nothing to say.
 */
export function warningsHeaderValue(warnings: readonly string[]): string | undefined {
  if (warnings.length === 0) return undefined;
  const encode = (list: readonly string[]): string => encodeURIComponent(JSON.stringify(list));
  const whole = encode(warnings);
  if (whole.length <= MAX_WARNINGS_HEADER_CHARS) return whole;

  const sizes = warnings.map(encodedLength);
  let kept = warnings.length - 1;
  let length = 6 + 3 * kept + sizes.slice(0, kept).reduce((sum, size) => sum + size, 0);
  // Drop from the end until the kept warnings and the notice about the rest fit.
  for (; kept > 0; kept -= 1) {
    if (length + encodedLength(leftOut(warnings.length - kept)) <= MAX_WARNINGS_HEADER_CHARS) break;
    length -= 3 + (sizes[kept - 1] ?? 0);
  }
  return encode([...warnings.slice(0, kept), leftOut(warnings.length - kept)]);
}

const MODES: readonly IncludeMode[] = ["accepted", "all"];
const FORMATS: readonly ReportFormat[] = ["json", "md"];

export function exportRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { db, clock } = deps;

  app.get("/api/reviews/:id/docx", async (c) => {
    const id = uuidParam(c, "id", "review");
    const mode = MODES.find((candidate) => candidate === (c.req.query("include") ?? "accepted"));
    if (mode === undefined) throw badRequest("include must be accepted or all.");

    const input = await loadRedlineInput(deps, id, mode);
    let built: Awaited<ReturnType<typeof renderRedline>>;
    try {
      built = await renderRedline({
        docx: input.docx,
        report: input.report,
        include: input.include,
        replacements: input.replacements,
        author: REDLINE_AUTHOR,
        date: clock.now(),
      });
    } catch (error) {
      // The stored file is not the one the report is about, or a wording is too long to write. The
      // message names the rule and never repeats the contract. Any other failure is the
      // server's own and is answered as one, with the detail in the log.
      if (error instanceof ReviewError) throw conflict(error.message);
      throw error;
    }

    const warnings = warningsHeaderValue(built.warnings);
    if (warnings !== undefined) c.header(WARNINGS_HEADER, warnings);
    // The writer's type allows a shared buffer, which a response body does not; the copy is the
    // size of one contract.
    const file = new Uint8Array(built.redlined);
    // Content-Type, nosniff and no-store: the first is set here, the other two by the middleware.
    return c.body(file, 200, {
      "Content-Type": DOCX_TYPE,
      "Content-Disposition": attachmentDisposition(
        derivedFileName(input.fileName, ".redlined.docx"),
      ),
      "Content-Length": String(file.byteLength),
    });
  });

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

    if (format === "md") {
      return c.body(renderMarkdown(review.report), 200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": attachmentDisposition(
          derivedFileName(review.fileName, ".summary.md"),
        ),
      });
    }
    return c.body(`${JSON.stringify(review.report, null, 2)}\n`, 200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": attachmentDisposition(
        derivedFileName(review.fileName, ".report.json"),
      ),
    });
  });

  return app;
}
