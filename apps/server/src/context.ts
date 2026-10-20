import type { FindingClause } from "@clausewise/api";
import { parseDocx } from "@clausewise/docx";
import { segment, type Clause, type ReviewReport } from "@clausewise/review";

/**
 * What the screen needs to show one result, kept with the review so that the screen does not
 * change if the segmenter changes later: the clauses the result cites, and for an applied edit
 * the whole paragraph that holds it.
 */
export interface StoredResultContext {
  clauses: FindingClause[];
  /** Only for a result whose edit was applied. `start` and `end` of the edit index into it. */
  paragraphText?: string;
}

export interface StoredContext {
  /** By rule id. */
  results: Record<string, StoredResultContext>;
}

const clauseView = (clause: Clause): FindingClause => ({
  id: clause.id,
  number: clause.number ?? null,
  heading: clause.heading ?? null,
  text: clause.text,
});

/**
 * Reads the stored file again with the same two steps the review used and keeps, for every result,
 * the clauses it cites. The clause ids in the report were issued by `segment` for this very file,
 * so a report and a file that belong together always agree here.
 */
export async function buildContext(docx: Uint8Array, report: ReviewReport): Promise<StoredContext> {
  const parsed = await parseDocx(docx);
  const clauses = segment(parsed.paragraphs);
  const byId = new Map(clauses.map((clause) => [clause.id, clause]));
  const paragraphs = new Map(parsed.paragraphs.map((paragraph) => [paragraph.id, paragraph.text]));

  const results: Record<string, StoredResultContext> = Object.create(null) as Record<
    string,
    StoredResultContext
  >;
  for (const result of report.results) {
    const cited = result.clauseIds.flatMap((id) => {
      const clause = byId.get(id);
      return clause === undefined ? [] : [clauseView(clause)];
    });
    const entry: StoredResultContext = { clauses: cited };
    if (result.edit.kind === "applied") {
      const text = paragraphs.get(result.edit.paragraphId);
      if (text !== undefined) entry.paragraphText = text;
    }
    results[result.ruleId] = entry;
  }
  return { results };
}
