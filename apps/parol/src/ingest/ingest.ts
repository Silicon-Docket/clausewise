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
import { hasNoVisibleText, withoutInvisible } from "./invisible.js";

/** One NDA and at most two amendments. */
const MAX_DOCUMENTS = DOC_LABELS.length;

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

// Tracked changes are read, in their accepted form, which is the only reason they are listed apart
// from the content above. A deleted figure and the figure typed over it read as the agreed text, so
// a lawyer who looks at the file in Word (where both show) has to be told the two views differ.
const READ_AS_ACCEPTED: [keyof DocxInspection, string][] = [
  ["trackedInsertions", "tracked_insertions"],
  ["trackedDeletions", "tracked_deletions"],
];

/** Counts only: what the Word file holds that the review never shows the model, or shows differently. */
function unreviewedDetail(
  inspection: DocxInspection | null,
  clauseLikeContents: number,
): string | undefined {
  const counts = (list: [keyof DocxInspection, string][]): string[] =>
    inspection === null
      ? []
      : list
          .filter(([key]) => inspection[key] > 0)
          .map(([key, name]) => `${name}=${inspection[key]}`);
  const unread = counts(UNREVIEWED);
  if (clauseLikeContents > 0) unread.push(`toc_entries=${clauseLikeContents}`);
  const accepted = counts(READ_AS_ACCEPTED);
  const parts: string[] = [];
  if (unread.length > 0) parts.push(`not reviewed: ${unread.join(", ")}`);
  if (accepted.length > 0) parts.push(`read as accepted: ${accepted.join(", ")}`);
  return parts.length === 0 ? undefined : parts.join("; ");
}

// A line of a table of contents is a short heading, usually with a page number or leader dots
// after it. Paragraphs the engine marks as contents entries (by style, content control or field)
// are left out of the spans, so a counterparty could set an operative clause in a contents style
// and have it hidden from the review while it stays on the page in Word. An entry that is long,
// that runs to many words, or that reads as a sentence is counted in the unreviewed content
// warning (a count only, never the words). An ordinary contents line is not, so a normal
// agreement's contents page raises nothing. What this misses: a short clause with no sentence
// punctuation and a page number, which is indistinguishable from a heading.
const MAX_CONTENTS_LINE_CHARS = 100;
const MAX_CONTENTS_LINE_WORDS = 14;
const MIN_SENTENCE_WORDS = 4;
const ENDS_LIKE_A_SENTENCE = /[\p{L})\]"'\u201d\u2019][.;!?]$/u;

function readsLikeClause(text: string): boolean {
  const visible = withoutInvisible(text).trim();
  if (visible === "") return false;
  // The length test comes first, so the patterns below only ever run on a short string.
  if (visible.length > MAX_CONTENTS_LINE_CHARS) return true;
  const words = visible.split(/\s+/).length;
  return (
    words > MAX_CONTENTS_LINE_WORDS ||
    (words >= MIN_SENTENCE_WORDS && ENDS_LIKE_A_SENTENCE.test(visible))
  );
}

/**
 * segment() reads a paragraph that begins "Section 6.1 of the Agreement is deleted" as clause
 * 6.1, because a typed "Section N" opens a clause. In an amendment that is a sentence about the
 * NDA's clause, not the amendment's own, and the number would collide with the NDA's. The
 * paragraph keeps its clause id and heading; only the number is dropped. A number followed by
 * a title or a full stop ("Section 1. Capitalized terms") is the document's own numbering and
 * stays. What this misses: a reference sentence that continues with a word not listed here.
 */
const REFERENCE_SENTENCE =
  /^(?:sections?|secs?\.?|clauses?|articles?|paragraphs?|paras?\.?|\u00a7\u00a7?|\u00b6\u00b6?)\s*\d[\d.]*[A-Z]?(?:\([a-z0-9]{1,4}\))*(?:\s*,)?\s+(?:of|to|in|under|is|are|shall|will|hereby|as|and|or|from|be|has|have|was|were|remains?|continues?|applies|apply|survives?|stands?)\b/i;

function isReferenceSentence(clause: Clause, memo: Map<string, boolean>): boolean {
  if (clause.number === undefined) return false;
  let known = memo.get(clause.id);
  if (known === undefined) {
    known = REFERENCE_SENTENCE.test(clause.paragraphs[0]?.text.trimStart() ?? "");
    memo.set(clause.id, known);
  }
  return known;
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
  const clauseLikeTocEntries = new Map<string, number>();
  const total = new Map<string, number>();
  let modelNumber = 0;

  for (const document of documents) {
    const clauses = segment(document.paragraphs);
    const slots = clausesByPosition(document.paragraphs, clauses);
    const own: SourceSpan[] = [];
    const referenceSentences = new Map<string, boolean>();
    let toc = 0;
    let clauseLikeToc = 0;

    document.paragraphs.forEach((paragraph, position) => {
      if (paragraph.isTocEntry === true) {
        toc++;
        if (readsLikeClause(paragraph.text)) clauseLikeToc++;
        return;
      }
      // Stored as is. Offsets of verified quotes refer to this exact string.
      if (hasNoVisibleText(paragraph.text)) return;
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
        clauseNumber:
          slot.member &&
          slot.clause !== undefined &&
          !isReferenceSentence(slot.clause, referenceSentences)
            ? (slot.clause.number ?? null)
            : null,
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
    clauseLikeTocEntries.set(document.documentVersionId, clauseLikeToc);
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
    const unreviewed = unreviewedDetail(document.inspection, clauseLikeTocEntries.get(id) ?? 0);
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
