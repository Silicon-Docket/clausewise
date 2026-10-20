import { addComment, loadComments, saveComments } from "./comments.js";
import type { CommentsPart } from "./comments.js";
import { matchQuoteStyle, trimEdit } from "./minimize.js";
import {
  DocxError,
  appendRunText,
  createW,
  getW,
  isPreserved,
  isW,
  parseXml,
  resolveLimits,
  sanitizeText,
  setText,
  wChild,
  type DocxLimits,
} from "./ooxml.js";
import {
  DOCUMENT_PART,
  openPackage,
  readDocumentXml,
  writePackage,
  writeXmlPart,
} from "./package.js";
import {
  type Atom,
  type BarrierKind,
  type Blocker,
  type ParagraphScan,
  bodyParagraphs,
  isInTextBox,
  scanParagraph,
} from "./paragraphs.js";
import { explodeRuns, insertionRunProps, splitAtOffsets } from "./runs.js";

/** Replace `[start, end)` of a paragraph's current text. `start === end` inserts. */
export interface Edit {
  paragraphId: string;
  start: number;
  end: number;
  replacement: string;
}

/** A comment on `[start, end)`, or on the whole paragraph when the range is omitted. */
export interface Comment {
  paragraphId: string;
  start?: number;
  end?: number;
  text: string;
}

export interface RedlineOptions {
  author?: string;
  initials?: string;
  date?: Date;
  /** Strike and insert only the words that differ (default true). */
  minimize?: boolean;
  /** Overrides for the default limits on how large and how complex a file may be. */
  limits?: Partial<DocxLimits>;
}

export type Outcome = { applied: true } | { applied: false; reason: string };

export interface RedlineResult {
  buffer: Uint8Array;
  /** One outcome per input edit, in input order. */
  edits: Outcome[];
  /** One outcome per input comment, in input order. */
  comments: Outcome[];
}

const BLOCKER_PHRASE: Record<Blocker, string> = {
  hyperlink: "a hyperlink",
  field: "a field result",
  contentControl: "a content control",
  trackedChange: "an existing tracked change",
  movedText: "text moved by an existing tracked change",
  smartTag: "a smart tag",
  customXml: "custom XML markup",
  textDirection: "a text direction override",
  alternateContent: "an unsupported object (alternate content)",
};

const BARRIER_PHRASE: Record<BarrierKind, string> = {
  hiddenText: "hidden text",
  equation: "an unsupported object (an equation)",
  ruby: "an unsupported object (ruby text)",
  symbol: "an unsupported object (a symbol character)",
  positionalTab: "an unsupported object (a positional tab)",
};

function joinPhrases(phrases: string[]): string {
  const unique = [...new Set(phrases)];
  if (unique.length <= 1) return unique.join("");
  return `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`;
}

function blockedReason(atoms: Atom[]): string {
  const kinds = atoms.flatMap((a) =>
    a.blockedBy === undefined ? [] : [BLOCKER_PHRASE[a.blockedBy]],
  );
  return `the range includes ${joinPhrases(kinds)}, which cannot be edited safely`;
}

interface PlannedEdit {
  index: number;
  start: number;
  end: number;
  removed: string;
  inserted: string;
}

interface PlannedComment {
  index: number;
  start: number;
  end: number;
  text: string;
}

export interface ParagraphPlan {
  index: number;
  p: Element;
  scan: ParagraphScan;
  edits: PlannedEdit[];
  comments: PlannedComment[];
}

/** What was accepted for each input, before anything is written. */
export interface RedlinePlan {
  edits: Outcome[];
  comments: Outcome[];
  paragraphs: ParagraphPlan[];
}

function midSurrogate(text: string, i: number): boolean {
  if (i <= 0 || i >= text.length) return false;
  const before = text.charCodeAt(i - 1);
  const at = text.charCodeAt(i);
  return before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff;
}

function conflicts(a: PlannedEdit, b: PlannedEdit): boolean {
  if (a.start < b.end && b.start < a.end) return true;
  return a.start === a.end && b.start === b.end && a.start === b.start;
}

function checkEdit(scan: ParagraphScan, e: PlannedEdit): string | undefined {
  const { atoms, barriers, text } = scan;
  if (midSurrogate(text, e.start) || midSurrogate(text, e.end)) {
    return "the range splits a surrogate pair";
  }
  if (e.start < e.end) {
    const crossed = barriers.filter((b) => b.position > e.start && b.position < e.end);
    if (crossed.length > 0) {
      return `the range crosses ${joinPhrases(crossed.map((b) => BARRIER_PHRASE[b.kind]))}, which the text view cannot represent`;
    }
    const hit = atoms.filter((a) => a.start < e.end && a.end > e.start);
    if (hit.length === 0) return "there is no editable text in the range";
    const blocked = hit.filter((a) => !a.editable);
    return blocked.length === 0 ? undefined : blockedReason(blocked);
  }
  const straddled = atoms.find((a) => a.start < e.start && e.start < a.end);
  if (straddled) return straddled.editable ? undefined : blockedReason([straddled]);
  const prev = atoms.filter((a) => a.end <= e.start).at(-1);
  const next = atoms.find((a) => a.start >= e.start);
  if (prev?.editable || next?.editable) return undefined;
  const neighbours = [prev, next].flatMap((a) => (a ? [a] : []));
  return neighbours.length > 0
    ? blockedReason(neighbours)
    : "there is no editable text next to the position";
}

/** The child of `p` that holds `node`, or null if `node` is not inside `p`. */
function topLevel(p: Element, node: Node): Node | null {
  let n: Node | null = node;
  while (n && n.parentNode !== p) n = n.parentNode;
  return n;
}

/** Ids this large cannot be incremented safely, and Word keeps them in a signed 32-bit number. */
const MAX_USABLE_ID = 2_000_000_000;

function maxId(doc: Document): number {
  let max = 0;
  for (const el of Array.from(doc.getElementsByTagName("*"))) {
    const n = Number(getW(el, "id"));
    if (Number.isInteger(n) && n < MAX_USABLE_ID) max = Math.max(max, n);
  }
  return max;
}

/**
 * Decides, for each input, whether it can be applied, without touching the document. Each edit is
 * measured against the paragraph as it was read, so the answer does not depend on the order in
 * which the inputs arrive.
 */
export function planRedline(
  doc: Document,
  ops: { edits?: Edit[]; comments?: Comment[] },
  options: RedlineOptions = {},
): RedlinePlan {
  const edits = ops.edits ?? [];
  const comments = ops.comments ?? [];
  const editOutcomes: Outcome[] = edits.map(() => ({ applied: false, reason: "not processed" }));
  const commentOutcomes: Outcome[] = comments.map(() => ({
    applied: false,
    reason: "not processed",
  }));
  const paragraphs = bodyParagraphs(doc);
  const plans = new Map<number, ParagraphPlan>();

  const lookup = (id: string): { index: number; p: Element } | undefined => {
    const m = /^p:(\d+)$/.exec(id);
    const p = m ? paragraphs[Number(m[1])] : undefined;
    return m && p ? { index: Number(m[1]), p } : undefined;
  };
  const planFor = (index: number, p: Element): ParagraphPlan => {
    let plan = plans.get(index);
    if (!plan) {
      plan = { index, p, scan: scanParagraph(p), edits: [], comments: [] };
      plans.set(index, plan);
    }
    return plan;
  };
  const reject = (list: Outcome[], i: number, reason: string): void => {
    list[i] = { applied: false, reason };
  };

  edits.forEach((edit, i) => {
    const found = lookup(edit.paragraphId);
    if (!found) return reject(editOutcomes, i, `unknown paragraph ${edit.paragraphId}`);
    const plan = planFor(found.index, found.p);
    const { text } = plan.scan;
    if (
      !Number.isInteger(edit.start) ||
      !Number.isInteger(edit.end) ||
      edit.start < 0 ||
      edit.start > edit.end ||
      edit.end > text.length
    ) {
      return reject(editOutcomes, i, `range ${edit.start}-${edit.end} is outside the paragraph`);
    }
    const replacement = sanitizeText(edit.replacement);
    if (replacement === "" && edit.replacement !== "") {
      // Characters that were all dropped must not turn a replacement into a deletion.
      return reject(editOutcomes, i, "the replacement has no text that Word can hold");
    }
    let planned: PlannedEdit = {
      index: i,
      start: edit.start,
      end: edit.end,
      removed: text.slice(edit.start, edit.end),
      inserted: replacement,
    };
    if (options.minimize !== false) {
      const t = trimEdit(planned.removed, planned.inserted);
      planned = {
        ...planned,
        start: edit.start + t.offset,
        end: edit.start + t.offset + t.removed.length,
        removed: t.removed,
        inserted: t.inserted,
      };
    }
    planned.inserted = matchQuoteStyle(planned.inserted, text, planned.start);
    if (planned.removed === planned.inserted) {
      return reject(editOutcomes, i, "the edit changes nothing");
    }
    const problem = checkEdit(plan.scan, planned);
    if (problem) return reject(editOutcomes, i, problem);
    if (plan.edits.some((other) => conflicts(planned, other))) {
      return reject(editOutcomes, i, "the edit overlaps an earlier edit");
    }
    plan.edits.push(planned);
  });

  comments.forEach((comment, i) => {
    const found = lookup(comment.paragraphId);
    if (!found) return reject(commentOutcomes, i, `unknown paragraph ${comment.paragraphId}`);
    if (isInTextBox(found.p)) {
      return reject(commentOutcomes, i, "comments cannot be placed inside a text box");
    }
    const plan = planFor(found.index, found.p);
    const { text } = plan.scan;
    const start = comment.start ?? 0;
    const end = comment.end ?? text.length;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end > text.length ||
      start > end ||
      (start === end && text.length > 0)
    ) {
      return reject(commentOutcomes, i, `range ${start}-${end} is outside the paragraph or empty`);
    }
    if (midSurrogate(text, start) || midSurrogate(text, end)) {
      return reject(commentOutcomes, i, "the range splits a surrogate pair");
    }
    plan.comments.push({ index: i, start, end, text: comment.text });
  });

  return {
    edits: editOutcomes,
    comments: commentOutcomes,
    paragraphs: [...plans.values()]
      .filter((pl) => pl.edits.length + pl.comments.length > 0)
      .sort((a, b) => a.index - b.index),
  };
}

/**
 * Writes the planned tracked changes and comments into the document and records in the plan's
 * outcomes which of them were placed.
 */
export function executeRedline(
  doc: Document,
  plan: RedlinePlan,
  commentsPart: CommentsPart,
  options: RedlineOptions = {},
): { addedComments: boolean } {
  const author = options.author ?? "Clausewise";
  const initials = options.initials ?? "CW";
  const when = options.date ?? new Date();
  if (Number.isNaN(when.getTime()))
    throw new DocxError("The date for the tracked changes is not valid");
  const date = when.toISOString().replace(/\.\d{3}Z$/, "Z");

  const ids = { next: Math.max(maxId(doc), maxId(commentsPart.doc)) + 1 };
  const takeId = (): number => ids.next++;
  const annotation = (): Record<string, string> => ({ id: String(takeId()), author, date });
  const freshId = (): string => String(takeId());

  let addedComments = false;
  for (const pl of plan.paragraphs) {
    const { p } = pl;
    explodeRuns(p, freshId);
    const cuts = new Set<number>();
    for (const e of pl.edits) cuts.add(e.start).add(e.end);
    for (const c of pl.comments) cuts.add(c.start).add(c.end);
    splitAtOffsets(doc, p, cuts, freshId);

    // One reading of the paragraph, taken after the cuts and before anything is wrapped, serves
    // every edit. Re-reading between edits would see the markup earlier edits just wrote.
    const { atoms, text } = scanParagraph(p);
    if (text !== pl.scan.text) {
      throw new DocxError(
        "A paragraph changed while it was being prepared, so nothing was written",
      );
    }

    for (const c of pl.comments) {
      const id = takeId();
      addComment(commentsPart, { id, author, initials, date, text: c.text });
      addedComments = true;

      const first = atoms.find((a) => a.end > c.start);
      const last = atoms.findLast((a) => a.start < c.end);
      const pPr = wChild(p, "pPr");
      const startRef: Node | null = first
        ? topLevel(p, first.run)
        : pPr
          ? pPr.nextSibling
          : p.firstChild;
      const startMarker = createW(doc, "commentRangeStart", { id: String(id) });
      p.insertBefore(startMarker, startRef);
      const lastTop = last ? topLevel(p, last.run) : null;
      const endRef: Node | null = lastTop ? lastTop.nextSibling : startMarker.nextSibling;
      p.insertBefore(createW(doc, "commentRangeEnd", { id: String(id) }), endRef);
      const refRun = createW(doc, "r");
      refRun.appendChild(createW(doc, "commentReference", { id: String(id) }));
      p.insertBefore(refRun, endRef);
      plan.comments[c.index] = { applied: true };
    }

    for (const e of [...pl.edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
      const covered = atoms.filter((a) => a.start >= e.start && a.end <= e.end);
      let source: Element;
      let ref: Node | null;
      if (covered.length > 0) {
        source = covered[0]!.run;
        let lastDel: Element = source;
        for (const a of covered) {
          const del = createW(doc, "del", annotation());
          a.run.parentNode!.insertBefore(del, a.run);
          del.appendChild(a.run);
          if (isW(a.node, "t")) {
            const delText = createW(doc, "delText");
            setText(doc, delText, a.text, isPreserved(a.node));
            a.run.replaceChild(delText, a.node);
          }
          lastDel = del;
        }
        ref = lastDel.nextSibling;
      } else {
        const prev = atoms.filter((a) => a.end <= e.start).at(-1);
        const next = atoms.find((a) => a.start >= e.start);
        if (prev?.editable) {
          source = prev.run;
          ref = topLevel(p, prev.run)?.nextSibling ?? null;
        } else if (next?.editable) {
          source = next.run;
          ref = topLevel(p, next.run);
        } else {
          plan.edits[e.index] = {
            applied: false,
            reason: "there is no editable text next to the position",
          };
          continue;
        }
      }
      plan.edits[e.index] = { applied: true };
      if (!e.inserted) continue;
      const run = createW(doc, "r");
      const rPr = wChild(source, "rPr");
      if (rPr) run.appendChild(insertionRunProps(rPr));
      appendRunText(doc, run, e.inserted, true);
      const ins = createW(doc, "ins", annotation());
      ins.appendChild(run);
      p.insertBefore(ins, ref);
    }
  }
  return { addedComments };
}

export async function applyRedline(
  buf: Uint8Array,
  ops: { edits?: Edit[]; comments?: Comment[] },
  options: RedlineOptions = {},
): Promise<RedlineResult> {
  const edits = ops.edits ?? [];
  const comments = ops.comments ?? [];
  if (edits.length === 0 && comments.length === 0) {
    return {
      buffer: buf,
      edits: [],
      comments: [],
    };
  }

  const limits = resolveLimits(options.limits);
  const zip = await openPackage(buf, limits);
  const doc = parseXml(await readDocumentXml(zip), DOCUMENT_PART, limits);
  const plan = planRedline(doc, ops, options);
  if (plan.paragraphs.length === 0) {
    return { buffer: buf, edits: plan.edits, comments: plan.comments };
  }

  const commentsPart = await loadComments(zip);
  const { addedComments } = executeRedline(doc, plan, commentsPart, options);

  writeXmlPart(zip, DOCUMENT_PART, doc);
  if (addedComments) await saveComments(zip, commentsPart);
  return { buffer: await writePackage(zip), edits: plan.edits, comments: plan.comments };
}
