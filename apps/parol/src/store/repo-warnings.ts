import { WARNING_CODES, type SpanAnnotation, type WarningCode } from "../contracts.js";
import { parseWith, type Ctx } from "./context.js";
import { NotFoundError, ValidationError } from "./errors.js";
import { AnnotationSchema } from "./schemas.js";

/** A warning about one document version, as the upload service stored it. */
export interface StoredIngestWarning {
  seq: number;
  matterId: string;
  documentVersionId: string;
  /** The span the warning is about, or null for a whole-document warning. */
  spanId: string | null;
  code: WarningCode;
  /** Ids, counts and pattern names. Never document text. */
  detail: string;
  createdAt: string;
}

export interface NewIngestWarning {
  code: WarningCode;
  spanId?: string | null;
  detail: string;
}

interface RawWarning {
  seq: number;
  matter_id: string;
  document_version_id: string;
  span_id: string | null;
  code: WarningCode;
  detail: string;
  created_at: string;
}

const toWarning = (r: RawWarning): StoredIngestWarning => ({
  seq: r.seq,
  matterId: r.matter_id,
  documentVersionId: r.document_version_id,
  spanId: r.span_id,
  code: r.code,
  detail: r.detail,
  createdAt: r.created_at,
});

// The migration limits a detail to this many characters. Checked here as well so that a caller gets
// a clear error, and so that the error does not depend on SQLite's wording (which quotes the value).
const MAX_DETAIL = 300;
const CODES: ReadonlySet<string> = new Set(WARNING_CODES);

/**
 * Upload warnings (migration 003) and the refresh of a matter's annotations.
 *
 * Annotations depend on every document of a run: a term the NDA defines and an amendment uses is
 * linked across them. `insertSpans` leaves a version that already has spans alone, so when the set
 * of operative versions changes, the annotations of the versions that stayed would otherwise keep
 * the links of the old set. `replaceAnnotations` is how the upload service keeps them equal to what
 * `buildIngest` would produce for the current set.
 */
export function createWarningsApi(ctx: Ctx) {
  const { get, all, run, tx } = ctx;

  const versionInMatter = (matterId: string, versionId: string): boolean =>
    get<{ n: number }>(
      "SELECT 1 AS n FROM document_versions WHERE id = ? AND matter_id = ?",
      versionId,
      matterId,
    ) !== undefined;

  /**
   * Replaces every warning of one document version. The upload service knows all of a version's
   * warnings at once (ingest's, and the near-duplicate notice), so a replace keeps the set exact
   * without a way to add a stray one later.
   */
  function replaceIngestWarnings(
    matterId: string,
    documentVersionId: string,
    warnings: readonly NewIngestWarning[],
  ): StoredIngestWarning[] {
    for (const warning of warnings) {
      if (!CODES.has(warning.code))
        throw new ValidationError("bad_warning_code", "warning code is not recognised");
      if (typeof warning.detail !== "string" || warning.detail.length > MAX_DETAIL)
        throw new ValidationError("bad_warning_detail", "warning detail is too long");
    }
    return tx(() => {
      if (!versionInMatter(matterId, documentVersionId))
        throw new NotFoundError("document version");
      run(
        "DELETE FROM ingest_warnings WHERE matter_id = ? AND document_version_id = ?",
        matterId,
        documentVersionId,
      );
      const now = ctx.now();
      for (const warning of warnings) {
        const spanId = warning.spanId ?? null;
        if (spanId !== null) {
          const inVersion = get<{ n: number }>(
            "SELECT 1 AS n FROM source_spans WHERE id = ? AND matter_id = ? AND document_version_id = ?",
            spanId,
            matterId,
            documentVersionId,
          );
          if (inVersion === undefined) throw new NotFoundError("span");
        }
        run(
          `INSERT INTO ingest_warnings (matter_id, document_version_id, span_id, code, detail, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          matterId,
          documentVersionId,
          spanId,
          warning.code,
          warning.detail,
          now,
        );
      }
      return listIngestWarnings(matterId, [documentVersionId]);
    });
  }

  /** Warnings of the named versions, or of the whole matter when none are named. Oldest first. */
  const listIngestWarnings = (
    matterId: string,
    documentVersionIds?: readonly string[],
  ): StoredIngestWarning[] =>
    all<RawWarning>(
      `SELECT * FROM ingest_warnings
       WHERE matter_id = ?1
         AND (?2 IS NULL OR document_version_id IN (SELECT value FROM json_each(?2)))
       ORDER BY seq`,
      matterId,
      documentVersionIds === undefined ? null : JSON.stringify(documentVersionIds),
    ).map(toWarning);

  /**
   * Replaces the annotations of the spans of the named versions with `annotations`, in the order
   * given. Every annotation must name a span of one of those versions. Spans are never touched.
   */
  function replaceAnnotations(
    matterId: string,
    documentVersionIds: readonly string[],
    annotations: readonly SpanAnnotation[],
  ): number {
    const parsed = annotations.map((a) => parseWith(AnnotationSchema, a, "annotation"));
    return tx(() => {
      const ids = JSON.stringify(documentVersionIds);
      const spanIds = new Set(
        all<{ id: string }>(
          `SELECT id FROM source_spans
           WHERE matter_id = ? AND document_version_id IN (SELECT value FROM json_each(?))`,
          matterId,
          ids,
        ).map((r) => r.id),
      );
      for (const note of parsed) if (!spanIds.has(note.spanId)) throw new NotFoundError("span");
      run(
        `DELETE FROM span_annotations WHERE span_id IN (
           SELECT id FROM source_spans
           WHERE matter_id = ? AND document_version_id IN (SELECT value FROM json_each(?)))`,
        matterId,
        ids,
      );
      for (const note of parsed) {
        const { kind, spanId, ...value } = note;
        run(
          "INSERT INTO span_annotations (span_id, kind, value) VALUES (?, ?, ?)",
          spanId,
          kind,
          JSON.stringify(value),
        );
      }
      return parsed.length;
    });
  }

  return { replaceIngestWarnings, listIngestWarnings, replaceAnnotations };
}

export type WarningsApi = ReturnType<typeof createWarningsApi>;
