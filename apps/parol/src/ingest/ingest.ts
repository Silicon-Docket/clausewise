import type { DocxInspection, DocxParagraph } from "@clausewise/docx";
import { segment, type Clause } from "@clausewise/review";
import { sha256Hex } from "../canonical.js";
import {
  DOC_LABELS,
  spanIdOf,
  type IngestDocumentInput,
  type IngestOutput,
  type IngestWarning,
  type SourceSpan,
} from "../contracts.js";
import type { BuildIngest } from "../module-contracts.js";
import { annotateSpans, type AnnotatableSpan } from "./annotate.js";

/** One NDA and at most two amendments. */
const MAX_DOCUMENTS = DOC_LABELS.length;

/**
 * Characters that show nothing. A paragraph made only of them and white space has no reviewable
 * text, which is the same test the upload applies. This is the set the quote anchor deletes.
 */
const NO_VISIBLE_TEXT = /^[\s\u200b-\u200d\u2060\ufeff\u00ad]*$/;

/**
 * The clause id for a span that belongs to no clause, in a document that has none. segment()
 * numbers clauses from c1, so c0 cannot collide with a real one.
 */
const NO_CLAUSE = "c0";

/**
 * Wrong input here is a bug in the caller (the server builds the list from the matter), not a
 * mistake by a user, so these are plain errors. Messages name labels and positions only.
 */
function validate(documents: IngestDocumentInput[]): void {
  if (documents.length === 0) throw new Error("buildIngest: no documents were given");
  if (documents.length > MAX_DOCUMENTS) {
    throw new Error(`buildIngest: at most ${MAX_DOCUMENTS} documents are allowed`);
  }
  const versionIds = new Set<string>();
  documents.forEach((document, position) => {
    const expected = DOC_LABELS[position];
    if (document.label !== expected) {
      throw new Error(
        `buildIngest: documents must be labelled ${DOC_LABELS.join(", ")} in order with no gaps; ` +
          `position ${position} is ${String(document.label)}, expected ${String(expected)}`,
      );
    }
    const kind = position === 0 ? "nda" : "amendment";
    if (document.kind !== kind) {
      throw new Error(
        `buildIngest: ${document.label} must be ${position === 0 ? "the NDA" : "an amendment"}`,
      );
    }
    if (versionIds.has(document.documentVersionId)) {
      throw new Error(`buildIngest: ${document.label} repeats a document version id`);
    }
    versionIds.add(document.documentVersionId);
    let previous = -1;
    for (const paragraph of document.paragraphs) {
      if (!Number.isInteger(paragraph.index) || paragraph.index <= previous) {
        throw new Error(
          `buildIngest: ${document.label} paragraph indexes must be whole numbers in ascending order`,
        );
      }
      previous = paragraph.index;
    }
  });
}

/**
 * Which clause each paragraph (by position) belongs to. segment() leaves some paragraphs in no
 * clause: headings, signature lines, and the cell that holds only a number. They still get a
 * span, because a heading or a title is text a reviewer may need to cite, so they are attached to
 * the clause they sit beside: the next one, which a heading introduces, or else the previous one.
 * Only the clause id and heading are borrowed. The clause number stays null, so a reference to
 * "Section 6.1" can never match a heading that merely precedes clause 6.1.
 */
function clausesByPosition(
  paragraphs: DocxParagraph[],
  clauses: Clause[],
): { clause: Clause | undefined; member: boolean }[] {
  const owner = new Map<string, Clause>();
  for (const clause of clauses) {
    for (const part of clause.paragraphs) if (!owner.has(part.id)) owner.set(part.id, clause);
  }
  const slots = paragraphs.map((paragraph) => ({
    clause: owner.get(paragraph.id),
    member: owner.has(paragraph.id),
  }));
  let previous: Clause | undefined;
  for (const slot of slots) {
    if (slot.member) previous = slot.clause;
    else slot.clause = previous;
  }
  let next: Clause | undefined;
  for (let i = slots.length - 1; i >= 0; i--) {
    const slot = slots[i]!;
    if (slot.member) next = slot.clause;
    else if (next !== undefined) slot.clause = next;
  }
  return slots;
}

const UNREVIEWED: [keyof DocxInspection, string][] = [
  ["footnotes", "footnotes"],
  ["endnotes", "endnotes"],
  ["headerFooterParts", "header_footer_parts"],
  ["comments", "comments"],
  ["hiddenRuns", "hidden_runs"],
  ["images", "images"],
];

/** Counts only: what the Word file holds that the review never shows the model. */
function unreviewedDetail(inspection: DocxInspection | null): string | undefined {
  if (inspection === null) return undefined;
  const parts = UNREVIEWED.filter(([key]) => inspection[key] > 0).map(
    ([key, name]) => `${name}=${inspection[key]}`,
  );
  return parts.length === 0 ? undefined : `not reviewed: ${parts.join(", ")}`;
}

/**
 * Turns the parsed documents of a run into the spans the model reads and cites, the annotations
 * derived from them with patterns, and the warnings a person should see first. Pure and
 * deterministic: the same input gives byte-identical output, with nothing read from the clock, the
 * environment or the order of an object's keys.
 */
export const buildIngest: BuildIngest = ({ documents }) => {
  validate(documents);

  const spans: SourceSpan[] = [];
  const annotatable: AnnotatableSpan[] = [];
  const spansOf = new Map<string, SourceSpan[]>();
  const tocEntries = new Map<string, number>();
  const total = new Map<string, number>();
  let modelNumber = 0;

  for (const document of documents) {
    const clauses = segment(document.paragraphs);
    const slots = clausesByPosition(document.paragraphs, clauses);
    const own: SourceSpan[] = [];
    let toc = 0;

    document.paragraphs.forEach((paragraph, position) => {
      if (paragraph.isTocEntry === true) {
        toc++;
        return;
      }
      // Stored as is. Offsets of verified quotes refer to this exact string.
      if (NO_VISIBLE_TEXT.test(paragraph.text)) return;
      const slot = slots[position]!;
      modelNumber++;
      const span: SourceSpan = {
        id: spanIdOf(document.documentVersionId, paragraph.index),
        label: `${document.label}-p${paragraph.index}`,
        modelLabel: `c${modelNumber}`,
        documentVersionId: document.documentVersionId,
        docLabel: document.label,
        paragraphIndex: paragraph.index,
        clauseId: slot.clause?.id ?? NO_CLAUSE,
        clauseNumber: slot.member ? (slot.clause?.number ?? null) : null,
        heading: slot.clause?.heading ?? null,
        text: paragraph.text,
        textSha256: sha256Hex(paragraph.text),
      };
      own.push(span);
      spans.push(span);
      annotatable.push({ id: span.id, text: span.text, documentKind: document.kind });
    });

    spansOf.set(document.documentVersionId, own);
    tocEntries.set(document.documentVersionId, toc);
    total.set(document.documentVersionId, document.paragraphs.length);
  }

  const { annotations, instructionPatterns } = annotateSpans(annotatable);

  const warnings: IngestWarning[] = [];
  for (const document of documents) {
    const id = document.documentVersionId;
    const own = spansOf.get(id) ?? [];
    if (own.length === 0) {
      warnings.push({
        code: "no_reviewable_text",
        documentVersionId: id,
        detail: `${document.label} has no paragraph with reviewable text (paragraphs: ${total.get(id) ?? 0}, table of contents entries: ${tocEntries.get(id) ?? 0})`,
      });
    }
    const unreviewed = unreviewedDetail(document.inspection);
    if (unreviewed !== undefined) {
      warnings.push({ code: "unreviewed_content", documentVersionId: id, detail: unreviewed });
    }
    // Only the pattern names and the span id: the warning is shown and stored, and the words that
    // matched are document text.
    for (const span of own) {
      const patterns = instructionPatterns.get(span.id);
      if (patterns === undefined) continue;
      warnings.push({
        code: "instruction_like_text",
        documentVersionId: id,
        spanId: span.id,
        detail: `matched ${patterns.join(", ")} in ${span.id}`,
      });
    }
  }

  const output: IngestOutput = { spans, annotations, warnings };
  return output;
};
