import { addComment, loadComments, saveComments } from "./comments.js";
import { trimEdit } from "./minimize.js";
import { createW, getW, isW, parseXml, serializeXml, setText, wChild } from "./ooxml.js";
import { DOCUMENT_PART, openPackage, readDocumentXml, writePackage } from "./package.js";
import { type Atom, bodyParagraphs, collectAtoms } from "./paragraphs.js";
import { explodeRuns, splitAt } from "./runs.js";

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
}

export type Outcome = { applied: true } | { applied: false; reason: string };

export interface RedlineResult {
  buffer: Uint8Array;
  /** One outcome per input edit, in input order. */
  edits: Outcome[];
  /** One outcome per input comment, in input order. */
  comments: Outcome[];
}

const UNEDITABLE =
  "the range includes a hyperlink, a field or an existing tracked change, which cannot be edited safely";

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

interface ParagraphPlan {
  p: Element;
  edits: PlannedEdit[];
  comments: PlannedComment[];
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

function checkEdit(atoms: Atom[], text: string, e: PlannedEdit): string | undefined {
  if (midSurrogate(text, e.start) || midSurrogate(text, e.end)) {
    return "the range splits a surrogate pair";
  }
  if (e.start < e.end) {
    const hit = atoms.filter((a) => a.start < e.end && a.end > e.start);
    return hit.length > 0 && hit.every((a) => a.editable) ? undefined : UNEDITABLE;
  }
  const straddled = atoms.find((a) => a.start < e.start && e.start < a.end);
  if (straddled) return straddled.editable ? undefined : UNEDITABLE;
  const prev = atoms.filter((a) => a.end <= e.start).at(-1);
  const next = atoms.find((a) => a.start >= e.start);
  return prev?.editable || next?.editable ? undefined : UNEDITABLE;
}

function topLevel(p: Element, node: Node): Node {
  let n = node;
  while (n.parentNode && n.parentNode !== p) n = n.parentNode;
  return n;
}

function maxId(doc: Document): number {
  let max = 0;
  for (const el of Array.from(doc.getElementsByTagName("*"))) {
    const n = Number(getW(el, "id"));
    if (Number.isInteger(n)) max = Math.max(max, n);
  }
  return max;
}

export async function applyRedline(
  buf: Uint8Array,
  ops: { edits?: Edit[]; comments?: Comment[] },
  options: RedlineOptions = {},
): Promise<RedlineResult> {
  const edits = ops.edits ?? [];
  const comments = ops.comments ?? [];
  const editOutcomes: Outcome[] = edits.map(() => ({ applied: false, reason: "not processed" }));
  const commentOutcomes: Outcome[] = comments.map(() => ({
    applied: false,
    reason: "not processed",
  }));
  const unchanged = { buffer: buf, edits: editOutcomes, comments: commentOutcomes };
  if (edits.length === 0 && comments.length === 0) return unchanged;

  const zip = await openPackage(buf);
  const doc = parseXml(await readDocumentXml(zip), DOCUMENT_PART);
  const paragraphs = bodyParagraphs(doc);
  const plans = new Map<number, ParagraphPlan>();
  const atomsOf = new Map<number, Atom[]>();

  const lookup = (id: string): { index: number; p: Element } | undefined => {
    const m = /^p:(\d+)$/.exec(id);
    const p = m ? paragraphs[Number(m[1])] : undefined;
    return m && p ? { index: Number(m[1]), p } : undefined;
  };
  const planFor = (index: number, p: Element): ParagraphPlan => {
    let plan = plans.get(index);
    if (!plan) {
      plan = { p, edits: [], comments: [] };
      plans.set(index, plan);
      atomsOf.set(index, collectAtoms(p));
    }
    return plan;
  };
  const textOf = (index: number): string => (atomsOf.get(index) ?? []).map((a) => a.text).join("");

  const reject = (list: Outcome[], i: number, reason: string): void => {
    list[i] = { applied: false, reason };
  };

  edits.forEach((edit, i) => {
    const found = lookup(edit.paragraphId);
    if (!found) return reject(editOutcomes, i, `unknown paragraph ${edit.paragraphId}`);
    const plan = planFor(found.index, found.p);
    const text = textOf(found.index);
    if (
      !Number.isInteger(edit.start) ||
      !Number.isInteger(edit.end) ||
      edit.start < 0 ||
      edit.start > edit.end ||
      edit.end > text.length
    ) {
      return reject(editOutcomes, i, `range ${edit.start}-${edit.end} is outside the paragraph`);
    }
    let planned: PlannedEdit = {
      index: i,
      start: edit.start,
      end: edit.end,
      removed: text.slice(edit.start, edit.end),
      inserted: edit.replacement,
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
    if (planned.removed === planned.inserted)
      return reject(editOutcomes, i, "the edit changes nothing");
    const problem = checkEdit(atomsOf.get(found.index) ?? [], text, planned);
    if (problem) return reject(editOutcomes, i, problem);
    if (plan.edits.some((other) => conflicts(planned, other))) {
      return reject(editOutcomes, i, "the edit overlaps an earlier edit");
    }
    plan.edits.push(planned);
  });

  comments.forEach((comment, i) => {
    const found = lookup(comment.paragraphId);
    if (!found) return reject(commentOutcomes, i, `unknown paragraph ${comment.paragraphId}`);
    const plan = planFor(found.index, found.p);
    const length = textOf(found.index).length;
    const start = comment.start ?? 0;
    const end = comment.end ?? length;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end > length ||
      start > end ||
      (start === end && length > 0)
    ) {
      return reject(commentOutcomes, i, `range ${start}-${end} is outside the paragraph or empty`);
    }
    plan.comments.push({ index: i, start, end, text: comment.text });
  });

  const planned = [...plans.values()].filter((pl) => pl.edits.length + pl.comments.length > 0);
  if (planned.length === 0) return unchanged;
  for (const plan of planned) {
    for (const e of plan.edits) editOutcomes[e.index] = { applied: true };
    for (const c of plan.comments) commentOutcomes[c.index] = { applied: true };
  }

  const author = options.author ?? "Clausewise";
  const initials = options.initials ?? "CW";
  const date = (options.date ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const commentsPart = await loadComments(zip);
  let nextId = Math.max(maxId(doc), maxId(commentsPart.doc)) + 1;
  const annotation = (): Record<string, string> => ({ id: String(nextId++), author, date });

  let addedComments = false;
  for (const plan of planned) {
    const { p } = plan;
    explodeRuns(p);
    const cuts = new Set<number>();
    for (const e of plan.edits) cuts.add(e.start).add(e.end);
    for (const c of plan.comments) cuts.add(c.start).add(c.end);
    for (const cut of cuts) splitAt(doc, p, cut);

    for (const c of plan.comments) {
      const atoms = collectAtoms(p);
      const id = nextId++;
      addComment(commentsPart, { id, author, initials, date, text: c.text });
      addedComments = true;

      const first = atoms.find((a) => a.end > c.start);
      const pPr = wChild(p, "pPr");
      const startRef: Node | null = first
        ? topLevel(p, first.run)
        : pPr
          ? pPr.nextSibling
          : p.firstChild;
      const last = atoms.findLast((a) => a.start < c.end);
      const startMarker = createW(doc, "commentRangeStart", { id: String(id) });
      p.insertBefore(startMarker, startRef);
      const endRef: Node | null = last
        ? topLevel(p, last.run).nextSibling
        : startMarker.nextSibling;
      p.insertBefore(createW(doc, "commentRangeEnd", { id: String(id) }), endRef);
      const refRun = createW(doc, "r");
      refRun.appendChild(createW(doc, "commentReference", { id: String(id) }));
      p.insertBefore(refRun, endRef);
    }

    for (const e of [...plan.edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
      const atoms = collectAtoms(p);
      const covered = atoms.filter((a) => a.end > a.start && a.start >= e.start && a.end <= e.end);
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
            setText(doc, delText, a.text);
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
          ref = prev.run.nextSibling;
        } else {
          source = next!.run;
          ref = next!.run;
        }
      }
      if (!e.inserted) continue;
      const run = createW(doc, "r");
      const rPr = wChild(source, "rPr");
      if (rPr) run.appendChild(rPr.cloneNode(true));
      for (const part of e.inserted.split(/(\n|\t)/)) {
        if (part === "") continue;
        if (part === "\n") run.appendChild(createW(doc, "br"));
        else if (part === "\t") run.appendChild(createW(doc, "tab"));
        else {
          const t = createW(doc, "t");
          setText(doc, t, part);
          run.appendChild(t);
        }
      }
      const ins = createW(doc, "ins", annotation());
      ins.appendChild(run);
      p.insertBefore(ins, ref);
    }
  }

  zip.file(DOCUMENT_PART, serializeXml(doc));
  if (addedComments) await saveComments(zip, commentsPart);
  return { buffer: await writePackage(zip), edits: editOutcomes, comments: commentOutcomes };
}
