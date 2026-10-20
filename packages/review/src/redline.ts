import { applyRedline, parseDocx, type Comment, type Edit } from "@clausewise/docx";
import type { Severity } from "@clausewise/playbook";
import { normalizeForAnchor, trimEdges } from "./anchor.js";
import { ReviewError } from "./errors.js";
import type { CommentAnchor, ReviewReport, RuleResult } from "./types.js";

// Everything that puts a review into a Word file lives here, so that the file a review returns and
// the file rebuilt later from its report are made by the same code.

export const DEFAULT_AUTHOR = "Clausewise";
export const UNSAFE_EDIT = "the document could not be edited safely";
/** The most a lawyer's own replacement for one tracked change may hold, in characters. */
export const MAX_REPLACEMENT_CHARS = 20_000;
const MAX_SHOWN_CHARS = 80;
const NO_PARAGRAPH = "The document has no paragraph to comment on.";

// ---------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------

// The category and the error name come from outside, so only short plain labels are repeated.
const SAFE_LABEL = /^[\w .:-]{1,64}$/;

export function safeLabel(value: string | undefined): string | undefined {
  const label = value?.trim();
  return label !== undefined && SAFE_LABEL.test(label) ? label : undefined;
}

export const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const BLANK_TITLE = /^[\p{Z}\p{Cc}\p{Cf}]*$/u;

/** The rule's title on one line, or its id when the title has nothing a reader could see. */
export function titleOf(rule: { id: string; title: string }): string {
  const title = oneLine(rule.title);
  return BLANK_TITLE.test(title) ? rule.id : title;
}

const shown = (text: string): string =>
  text.length > MAX_SHOWN_CHARS ? `${text.slice(0, MAX_SHOWN_CHARS)}...` : text;

const errorLabel = (error: unknown): string => {
  const label = error instanceof Error ? safeLabel(error.name) : undefined;
  return label === undefined ? "" : ` (${label})`;
};

/** What the words of a finding's comment are made from. */
export interface CommentSource {
  ruleId: string;
  title: string;
  severity: Severity;
  status: "deviation" | "missing";
  comment: string;
  explanation: string;
  suggestedClause: string | null;
}

/**
 * The text of a finding's comment. `wording` is the replacement the lawyer would otherwise have
 * seen as a tracked change, and is given only when that change is not written.
 */
export function commentText(source: CommentSource, wording: string): string {
  const body = source.comment === "" ? source.explanation : source.comment;
  let text = `[${source.severity.toUpperCase()}] ${titleOf({ id: source.ruleId, title: source.title })}\n${body}`;
  if (source.status === "missing" && source.suggestedClause !== null) {
    text += `\n\nSuggested clause:\n${source.suggestedClause}`;
  }
  if (wording !== "") {
    text += `\n\nSuggested wording (could not be applied automatically): ${wording}`;
  }
  return text;
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

/** One finding on its way into the file: its comment, and the tracked change it asks for. */
export interface Piece {
  source: CommentSource;
  /** The wording of the change, repeated in the comment when the change is not written. */
  wording: string;
  /** The tracked change asked for, if there is one to try. */
  edit: Edit | undefined;
  /** Why there is no tracked change, once it was refused or never matched the document. */
  blocked: string | undefined;
  /** Where the comment goes while there is no reason against the tracked change. */
  placed: CommentAnchor | undefined;
  /** Where the comment goes when there is: on the clause, not on a change that is not there. */
  moved: CommentAnchor | undefined;
  /** Why the file lacks this comment, when the engine refused it. */
  commentRefused: string | undefined;
}

type LivePiece = Piece & { edit: Edit };

const isLive = (piece: Piece): piece is LivePiece =>
  piece.edit !== undefined && piece.blocked === undefined;

/** Where the finding's comment is written, or would be if the file could be written. */
export function anchorOf(piece: Piece): CommentAnchor | undefined {
  return piece.blocked === undefined ? piece.placed : piece.moved;
}

function toComment(piece: Piece): Comment {
  const anchor = anchorOf(piece);
  if (anchor === undefined) throw new ReviewError(NO_PARAGRAPH);
  const wording = piece.blocked === undefined ? "" : piece.wording;
  return { ...anchor, text: commentText(piece.source, wording) };
}

export interface Written {
  buffer: Uint8Array;
  /** Set when the file could not be written as asked. */
  warning: string | undefined;
  /** Tracked changes in `buffer`. */
  edits: number;
  /** Comments in `buffer`. */
  comments: number;
}

/**
 * Writes every edit and comment in one call. Only the redline engine knows which edits it
 * refuses, and a refused edit changes its comment: the comment moves to the clause and gains the
 * wording the lawyer would otherwise have to retype. So when an edit is refused the call is
 * repeated from the original bytes without it, until none is. Each repeat drops at least one edit,
 * so it ends, and in practice a refusal costs one more call. The pieces say what became of them:
 * a refused edit sets `blocked`, a refused comment sets `commentRefused`.
 *
 * The review is paid for by now, so a writer that throws must not lose it. The edits are given up
 * first and the comments written alone; if even that throws, the original bytes go back unchanged.
 * Either way every finding is still in the report, and a warning says what the file lacks.
 */
export async function writeRedline(args: {
  docx: Uint8Array;
  pieces: Piece[];
  author: string;
  date: Date | undefined;
}): Promise<Written> {
  const { docx, pieces } = args;
  const redlineOptions = {
    author: args.author,
    ...(args.date === undefined ? {} : { date: args.date }),
  };

  const pass = async (): Promise<Omit<Written, "warning"> & { refused: boolean }> => {
    const live = pieces.filter(isLive);
    const edits: Edit[] = live.map((piece) => piece.edit);
    const comments = pieces.map(toComment);
    const result = await applyRedline(docx, { edits, comments }, redlineOptions);

    let refused = false;
    live.forEach((piece, i) => {
      const outcome = result.edits[i];
      if (outcome !== undefined && !outcome.applied) {
        piece.blocked = outcome.reason;
        refused = true;
      }
    });
    pieces.forEach((piece, i) => {
      const outcome = result.comments[i];
      piece.commentRefused = outcome !== undefined && !outcome.applied ? outcome.reason : undefined;
    });
    const written = (outcomes: typeof result.edits): number =>
      outcomes.filter((outcome) => outcome.applied).length;
    const edited = written(result.edits);
    const commented = written(result.comments);
    return {
      buffer: edited + commented > 0 ? result.buffer : docx,
      edits: edited,
      comments: commented,
      refused,
    };
  };

  const settled = async (): Promise<Omit<Written, "warning">> => {
    for (;;) {
      const { refused, ...done } = await pass();
      if (!refused) return done;
    }
  };

  const giveUpEdits = (): void => {
    for (const piece of pieces) {
      if (isLive(piece)) piece.blocked = UNSAFE_EDIT;
    }
  };

  try {
    return { ...(await settled()), warning: undefined };
  } catch (failure) {
    giveUpEdits();
    try {
      return {
        ...(await settled()),
        warning: `The Word file could not be edited with tracked changes${errorLabel(failure)}, so the suggested edits are written as comments and no text of the contract was changed.`,
      };
    } catch (second) {
      return {
        buffer: docx,
        edits: 0,
        comments: 0,
        warning: `The Word file could not be edited safely${errorLabel(second)}, so the redlined file is a copy of the original with no tracked changes and no comments. Every finding is in the report.`,
      };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Rebuilding a redline from a report
// ---------------------------------------------------------------------------------------------

export interface RenderRedlineInput {
  /** The file that was reviewed. */
  docx: Uint8Array;
  report: ReviewReport;
  /** Rule ids to include, or "all" for every deviation and missing result. */
  include: ReadonlySet<string> | "all";
  /**
   * Replacement text by rule id, for results whose edit is `applied`. It overrides the model's.
   * The empty string deletes the span. Whitespace at either end is dropped, as it is for the
   * model's wording, because the span never starts or ends with a space and a space kept would be
   * written twice. A replacement that says the same as the span leaves only the comment. An entry
   * for a rule that is not included, or is not in the report, is ignored; one for an included
   * finding that has no tracked change is ignored with a warning. Text longer than
   * MAX_REPLACEMENT_CHARS, for any rule, is a ReviewError.
   */
  replacements?: ReadonlyMap<string, string>;
  /** Default "Clausewise". */
  author?: string;
  /** Default: now. */
  date?: Date;
}

export interface RenderRedlineResult {
  /**
   * The redlined file. When nothing is written it is a copy of `docx`, not `docx` itself, so the
   * caller can change one without the other.
   */
  redlined: Uint8Array;
  /** Tracked changes written. */
  edits: number;
  /** Comments written. */
  comments: number;
  /** Things the lawyer should know, such as an edit the engine refused and turned into a comment. */
  warnings: string[];
}

type Flagged = RuleResult & { status: "deviation" | "missing" };

const isFlagged = (result: RuleResult): result is Flagged =>
  result.status === "deviation" || result.status === "missing";

/**
 * The redlined file for some of a report's findings, built again from the report and the file it
 * was made for. It uses the writer a review uses, so with every finding included and nothing
 * replaced it holds exactly what the review returned.
 *
 * Throws ReviewError when `docx` is not the file the report is about: a span that the report
 * recorded no longer holds the same words, or a paragraph it names is gone. Nothing is written at
 * a place that does not match.
 */
export async function renderRedline(input: RenderRedlineInput): Promise<RenderRedlineResult> {
  const { docx, report, include } = input;
  const replacements = input.replacements ?? new Map<string, string>();
  for (const [ruleId, text] of replacements) {
    if (text.length > MAX_REPLACEMENT_CHARS) {
      throw new ReviewError(
        `The replacement text for "${shown(oneLine(ruleId))}" has ${text.length} characters, and the most that can be written is ${MAX_REPLACEMENT_CHARS}. Shorten it.`,
      );
    }
  }

  const chosen = report.results
    .filter(isFlagged)
    .filter((result) => include === "all" || include.has(result.ruleId));
  if (chosen.length === 0)
    return { redlined: new Uint8Array(docx), edits: 0, comments: 0, warnings: [] };

  const parsed = await parseDocx(docx);
  const texts = new Map(parsed.paragraphs.map((paragraph) => [paragraph.id, paragraph.text]));
  const first = parsed.paragraphs[0]?.id;

  const titleIn = (result: Flagged): string =>
    shown(titleOf({ id: result.ruleId, title: result.title }));
  const mismatch = (result: Flagged, what: string): ReviewError =>
    new ReviewError(
      `The document does not match the report: ${what} (rule "${titleIn(result)}"). Check that this is the file that was reviewed and that it has not been changed since.`,
    );

  // A comment's range is the whole paragraph unless it says otherwise, as the engine reads it.
  const checkAnchor = (result: Flagged, anchor: CommentAnchor): void => {
    const text = texts.get(anchor.paragraphId);
    if (text === undefined)
      throw mismatch(result, "a paragraph the report names is not in the document");
    const start = anchor.start ?? 0;
    const end = anchor.end ?? text.length;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      start > end ||
      end > text.length
    ) {
      throw mismatch(result, "the place recorded for a comment is outside its paragraph");
    }
  };

  let unanchored = 0;
  const unused: string[] = [];
  const pieces: Piece[] = chosen.map((result): Piece => {
    const source: CommentSource = {
      ruleId: result.ruleId,
      title: result.title,
      severity: result.severity,
      status: result.status,
      comment: result.comment,
      explanation: result.explanation,
      suggestedClause: result.suggestedClause,
    };

    let anchor: CommentAnchor;
    if (result.commentAnchor === undefined) {
      // A report from before comments were anchored. The finding is kept, on the first paragraph.
      if (first === undefined) throw new ReviewError(NO_PARAGRAPH);
      unanchored += 1;
      anchor = { paragraphId: first };
    } else {
      const { paragraphId, start, end } = result.commentAnchor;
      anchor = {
        paragraphId,
        ...(start === undefined ? {} : { start }),
        ...(end === undefined ? {} : { end }),
      };
    }
    checkAnchor(result, anchor);

    const { edit } = result;
    const base = { source, commentRefused: undefined };
    if (edit.kind === "applied") {
      const text = texts.get(edit.paragraphId);
      if (
        text === undefined ||
        !Number.isInteger(edit.start) ||
        !Number.isInteger(edit.end) ||
        edit.start < 0 ||
        edit.start > edit.end ||
        edit.end > text.length ||
        text.slice(edit.start, edit.end) !== edit.original
      ) {
        throw mismatch(result, "the words the report says were changed are not where it says");
      }
      const given = replacements.get(result.ruleId);
      const replacement =
        given === undefined
          ? edit.replacement
          : trimEdges(given, !/^\s/.test(edit.original), !/\s$/.test(edit.original));
      // The lawyer put the original words back: the comment stays and nothing is changed.
      const unchanged =
        given !== undefined &&
        normalizeForAnchor(replacement) === normalizeForAnchor(edit.original);
      return {
        ...base,
        wording: replacement.trim(),
        edit: unchanged
          ? undefined
          : { paragraphId: edit.paragraphId, start: edit.start, end: edit.end, replacement },
        blocked: undefined,
        placed: anchor,
        // An edit the engine refuses leaves its comment on the paragraph that holds it. The report
        // keeps no clause boundaries, and the paragraph is inside the clause.
        moved: { paragraphId: edit.paragraphId },
      };
    }

    if (replacements.has(result.ruleId)) unused.push(titleIn(result));
    if (edit.kind === "comment-only") {
      return {
        ...base,
        wording: edit.proposed.replacement.trim(),
        edit: undefined,
        blocked: edit.reason,
        placed: anchor,
        moved: anchor,
      };
    }
    return {
      ...base,
      wording: "",
      edit: undefined,
      blocked: undefined,
      placed: anchor,
      moved: anchor,
    };
  });

  const asked = new Set<Piece>(pieces.filter(isLive));
  const written = await writeRedline({
    docx,
    pieces,
    author: input.author ?? DEFAULT_AUTHOR,
    date: input.date,
  });

  const warnings: string[] = [];
  if (unanchored > 0) {
    warnings.push(
      `${unanchored} ${unanchored === 1 ? "finding has" : "findings have"} no recorded place for ${unanchored === 1 ? "its comment" : "their comments"}, because the report was made by an older version, so ${unanchored === 1 ? "the comment is" : "the comments are"} on the first paragraph.`,
    );
  }
  for (const title of unused) {
    warnings.push(
      `The replacement text for "${title}" was not used, because that finding has no tracked change to put it in.`,
    );
  }
  for (const piece of pieces) {
    const title = shown(titleOf({ id: piece.source.ruleId, title: piece.source.title }));
    if (asked.has(piece) && piece.blocked !== undefined && piece.blocked !== UNSAFE_EDIT) {
      warnings.push(
        `The tracked change for "${title}" could not be written (${piece.blocked}), so its comment is on the paragraph and carries the suggested wording.`,
      );
    }
    if (written.warning === undefined && piece.commentRefused !== undefined) {
      warnings.push(`The comment for "${title}" could not be written (${piece.commentRefused}).`);
    }
  }
  if (written.warning !== undefined) warnings.push(written.warning);

  return {
    redlined: written.buffer === docx ? new Uint8Array(docx) : written.buffer,
    edits: written.edits,
    comments: written.comments,
    warnings,
  };
}
