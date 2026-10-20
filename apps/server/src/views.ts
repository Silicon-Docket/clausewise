import type {
  Decision,
  Finding,
  FindingEdit,
  ModelInfo,
  ResultRow,
  ReviewDetail,
  ReviewNotShown,
  ReviewStatus,
  ReviewSummary,
  RuleStatus,
  Severity,
} from "@clausewise/api";
import type { ReviewReport, RuleResult } from "@clausewise/review";
import { eq, sql } from "drizzle-orm";
import type { StoredContext, StoredResultContext } from "./context.js";
import type { Db } from "./db/client.js";
import { documents, findings, reviews } from "./db/schema.js";

// ---------------------------------------------------------------------------------------------
// The server's types against the wire format
// ---------------------------------------------------------------------------------------------

// packages/api does not import the other packages on purpose, so these lines are where a change in
// the report that the web app has not caught up with stops the build, not a user.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type WireChecks = [
  Assert<Same<RuleResult["status"], RuleStatus>>,
  Assert<Same<RuleResult["severity"], Severity>>,
  Assert<Same<ReviewReport["counts"], Record<RuleStatus, number>>>,
  Assert<Same<NonNullable<ReviewReport["notShown"]>, ReviewNotShown>>,
  Assert<Same<ReviewReport["model"], ModelInfo>>,
  Assert<Same<ReviewReport["stats"], NonNullable<ReviewDetail["stats"]>>>,
];

// ---------------------------------------------------------------------------------------------
// Review summaries
// ---------------------------------------------------------------------------------------------

/** The columns a summary needs. `open` is read out of the report in the database, not loaded with it. */
export const summaryColumns = {
  id: reviews.id,
  status: reviews.status,
  documentId: reviews.documentId,
  documentName: documents.fileName,
  playbookName: reviews.playbookName,
  client: reviews.client,
  progressDone: reviews.progressDone,
  progressTotal: reviews.progressTotal,
  error: reviews.error,
  open: sql<unknown>`${reviews.report} -> 'open'`,
  createdAt: reviews.createdAt,
  startedAt: reviews.startedAt,
  finishedAt: reviews.finishedAt,
};

export interface SummaryRow {
  id: string;
  status: ReviewStatus;
  documentId: string;
  documentName: string;
  playbookName: string;
  client: string | null;
  progressDone: number;
  progressTotal: number;
  error: string | null;
  open: unknown;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

// Some drivers hand back JSON that a query built, as text.
function openCounts(raw: unknown): Record<Severity, number> | null {
  const value = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (typeof value !== "object" || value === null) return null;
  const { high, medium, low } = value as Record<string, unknown>;
  return isCount(high) && isCount(medium) && isCount(low) ? { high, medium, low } : null;
}

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

export function toReviewSummary(row: SummaryRow): ReviewSummary {
  return {
    id: row.id,
    status: row.status,
    documentId: row.documentId,
    documentName: row.documentName,
    playbookName: row.playbookName,
    client: row.client,
    progress: { done: row.progressDone, total: row.progressTotal },
    error: row.error,
    open: row.status === "done" ? openCounts(row.open) : null,
    createdAt: row.createdAt.toISOString(),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
  };
}

export async function listReviewSummaries(db: Db): Promise<ReviewSummary[]> {
  const rows = await db
    .select(summaryColumns)
    .from(reviews)
    .innerJoin(documents, eq(reviews.documentId, documents.id))
    .orderBy(sql`${reviews.createdAt} desc`, sql`${reviews.id} desc`);
  return rows.map(toReviewSummary);
}

export async function getReviewSummary(db: Db, id: string): Promise<ReviewSummary | undefined> {
  const [row] = await db
    .select(summaryColumns)
    .from(reviews)
    .innerJoin(documents, eq(reviews.documentId, documents.id))
    .where(eq(reviews.id, id));
  return row === undefined ? undefined : toReviewSummary(row);
}

// ---------------------------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------------------------

export interface DecisionRow {
  ruleId: string;
  decision: Decision;
  editedReplacement: string | null;
}

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export const isFinding = (result: RuleResult): boolean =>
  result.status === "deviation" || result.status === "missing";

function editView(result: RuleResult, context: StoredResultContext | undefined): FindingEdit {
  const edit = result.edit;
  switch (edit.kind) {
    case "none":
      return { kind: "none" };
    case "comment-only":
      return {
        kind: "comment-only",
        proposed: { quote: edit.proposed.quote, replacement: edit.proposed.replacement },
        reason: edit.reason,
      };
    case "applied":
      return {
        kind: "applied",
        original: edit.original,
        replacement: edit.replacement,
        // A context stored without the paragraph (not written by this version) still gives a
        // span that agrees with its text, so the screen never shows an edit that does not fit.
        paragraphText: context?.paragraphText ?? edit.original,
        start: context?.paragraphText === undefined ? 0 : edit.start,
        end: context?.paragraphText === undefined ? edit.original.length : edit.end,
      };
  }
}

export function toFinding(
  result: RuleResult,
  context: StoredResultContext | undefined,
  decision: DecisionRow | undefined,
): Finding {
  if (result.status !== "deviation" && result.status !== "missing") {
    throw new Error("Only a deviation or a missing clause is a finding.");
  }
  return {
    ruleId: result.ruleId,
    title: result.title,
    severity: result.severity,
    required: result.required,
    status: result.status,
    explanation: result.explanation,
    comment: result.comment,
    suggestedClause: result.suggestedClause,
    clauses: context?.clauses ?? [],
    edit: editView(result, context),
    decision: decision?.decision ?? "pending",
    editedReplacement: decision?.editedReplacement ?? null,
  };
}

function toResultRow(result: RuleResult): ResultRow {
  if (result.status === "deviation" || result.status === "missing") {
    throw new Error("A deviation or a missing clause is a finding, not a result row.");
  }
  return {
    ruleId: result.ruleId,
    title: result.title,
    severity: result.severity,
    status: result.status,
    clauseNumbers: result.clauseNumbers,
    explanation: result.explanation,
    error: result.error ?? null,
  };
}

/** The findings, worst first and in playbook order within a severity, and the rules that are not findings. */
export function splitResults(
  report: ReviewReport,
  context: StoredContext | null,
  decisions: readonly DecisionRow[],
): { findings: Finding[]; results: ResultRow[] } {
  const byRule = new Map(decisions.map((row) => [row.ruleId, row]));
  const flagged = report.results
    .filter(isFinding)
    .map((result) => toFinding(result, context?.results[result.ruleId], byRule.get(result.ruleId)));
  // Array.prototype.sort is stable, so playbook order is kept within a severity.
  flagged.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return {
    findings: flagged,
    results: report.results.filter((result) => !isFinding(result)).map(toResultRow),
  };
}

export async function getReviewDetail(db: Db, id: string): Promise<ReviewDetail | undefined> {
  const summary = await getReviewSummary(db, id);
  if (summary === undefined) return undefined;
  if (summary.status !== "done") {
    return {
      ...summary,
      model: null,
      warnings: [],
      notShown: null,
      stats: null,
      counts: null,
      findings: [],
      results: [],
    };
  }
  const [stored] = await db
    .select({ report: reviews.report, context: reviews.context })
    .from(reviews)
    .where(eq(reviews.id, id));
  const report = stored?.report;
  if (report === null || report === undefined) {
    // A review marked done always has its report; this would be a damaged database.
    return {
      ...summary,
      model: null,
      warnings: [],
      notShown: null,
      stats: null,
      counts: null,
      findings: [],
      results: [],
    };
  }
  const decisions = await db
    .select({
      ruleId: findings.ruleId,
      decision: findings.decision,
      editedReplacement: findings.editedReplacement,
    })
    .from(findings)
    .where(eq(findings.reviewId, id));
  const split = splitResults(report, stored?.context ?? null, decisions);
  return {
    ...summary,
    model: report.model,
    warnings: report.warnings ?? [],
    notShown: report.notShown ?? null,
    stats: report.stats,
    counts: report.counts,
    findings: split.findings,
    results: split.results,
  };
}
