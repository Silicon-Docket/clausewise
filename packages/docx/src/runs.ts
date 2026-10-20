import {
  childElements,
  createW,
  hasEdgeSpace,
  insertAfter,
  isPreserved,
  isW,
  setText,
  setW,
  wChild,
} from "./ooxml.js";
import { limitsAfterCutting, scanParagraph } from "./paragraphs.js";

/**
 * Copies run properties onto a new run. A formatting revision inside them is another author's
 * change to the original run, so the copy gets an id of its own instead of repeating the first.
 */
function cloneRunProps(rPr: Element, newId: () => string): Element {
  const clone = rPr.cloneNode(true) as Element;
  for (const child of childElements(clone)) {
    if (isW(child, "rPrChange")) setW(child, "id", newId());
  }
  return clone;
}

/**
 * Run properties for text we insert. The formatting revision on the neighbouring run belongs to
 * that run alone, and carrying it over would make rejecting it change our insertion.
 */
export function insertionRunProps(rPr: Element): Element {
  const clone = rPr.cloneNode(true) as Element;
  for (const child of childElements(clone)) {
    if (isW(child, "rPrChange")) clone.removeChild(child);
  }
  return clone;
}

/**
 * Gives every direct-child run of the paragraph exactly one content child, cloning the run's
 * properties onto each new run. Word treats the result as the same text with the same
 * formatting, and it lets later steps cut and wrap at run granularity.
 */
export function explodeRuns(p: Element, newId: () => string): void {
  for (const run of childElements(p)) {
    if (!isW(run, "r")) continue;
    const rPr = wChild(run, "rPr");
    const kids = childElements(run).filter((k) => k !== rPr);
    let cursor: Element = run;
    for (const kid of kids.slice(1)) {
      const next = run.cloneNode(false) as Element;
      if (rPr) next.appendChild(cloneRunProps(rPr, newId));
      next.appendChild(kid);
      insertAfter(p, next, cursor);
      cursor = next;
    }
  }
}

function isXmlSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/**
 * Whitespace Word drops at the ends of a `w:t` that lacks xml:space="preserve", as lengths. Walked
 * by hand: a pattern anchored at the end backtracks quadratically over a long run of spaces.
 */
function insignificantEdges(text: string): { lead: number; trail: number } {
  let lead = 0;
  while (lead < text.length && isXmlSpace(text.charCodeAt(lead))) lead++;
  if (lead === text.length) return { lead, trail: 0 };
  let trail = 0;
  while (isXmlSpace(text.charCodeAt(text.length - 1 - trail))) trail++;
  return { lead, trail };
}

/**
 * Splits the editable `w:t` elements that straddle any of the offsets. Cuts are made from the
 * right, so an atom that has been cut only ever loses its right end and the positions measured
 * before the first cut stay valid.
 *
 * Word ignores whitespace at the edges of a `w:t` that does not say `xml:space="preserve"`, while
 * the text view counts it. A piece therefore gets the attribute only when it needs it: when the
 * text had it already, or when a cut left real whitespace at one of its edges. Whitespace that
 * Word ignored before stays in pieces of its own, without the attribute, so cutting the text
 * never makes spacing appear in the neighbouring words.
 */
export function splitAtOffsets(
  doc: Document,
  p: Element,
  offsets: Iterable<number>,
  newId: () => string,
): void {
  const requested = [...new Set(offsets)];
  if (requested.length === 0) return;
  const atoms = scanParagraph(p, undefined, limitsAfterCutting(doc)).atoms;
  const kept = atoms.map((a) => isPreserved(a.node));
  const lengths = atoms.map((a) => a.text.length);
  const ignored = atoms.map((a, i) =>
    a.editable && isW(a.node, "t") && !kept[i] ? insignificantEdges(a.text) : undefined,
  );

  const cutSet = new Set(requested);
  atoms.forEach((atom, i) => {
    const edges = ignored[i];
    if (!edges || (edges.lead === 0 && edges.trail === 0)) return;
    if (!requested.some((c) => c > atom.start && c < atom.end)) return;
    if (edges.lead > 0 && edges.lead < lengths[i]!) cutSet.add(atom.start + edges.lead);
    if (edges.trail > 0) cutSet.add(atom.end - edges.trail);
  });
  const cuts = [...cutSet].sort((a, b) => b - a);

  const ends = atoms.map((a) => a.end);
  const texts = atoms.map((a) => a.text);
  const needsPreserve = (i: number, from: number, to: number, piece: string): boolean => {
    if (kept[i]) return true;
    const edges = ignored[i];
    if (edges && (to <= edges.lead || from >= lengths[i]! - edges.trail)) return false;
    return hasEdgeSpace(piece);
  };

  let i = atoms.length - 1;
  for (const cut of cuts) {
    while (i >= 0 && atoms[i]!.start >= cut) i--;
    const atom = atoms[i];
    if (!atom || cut >= ends[i]!) continue;
    if (!atom.editable || !isW(atom.node, "t")) continue;
    const text = texts[i]!;
    const at = cut - atom.start;
    const left = text.slice(0, at);
    const right = text.slice(at);

    const next = atom.run.cloneNode(false) as Element;
    const rPr = wChild(atom.run, "rPr");
    if (rPr) next.appendChild(cloneRunProps(rPr, newId));
    const t = createW(doc, "t");
    setText(doc, t, right, needsPreserve(i, at, text.length, right));
    next.appendChild(t);
    setText(doc, atom.node, left, needsPreserve(i, 0, at, left));
    insertAfter(p, next, atom.run);
    texts[i] = left;
    ends[i] = cut;
  }
}
