import {
  childElements,
  createW,
  insertAfter,
  isPreserved,
  isW,
  setText,
  setW,
  wChild,
} from "./ooxml.js";
import { scanParagraph } from "./paragraphs.js";

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

/**
 * Splits the editable `w:t` elements that straddle any of the offsets. Cuts are made from the
 * right, so an atom that has been cut only ever loses its right end and the positions measured
 * before the first cut stay valid.
 *
 * Word ignores whitespace at the edges of a `w:t` that does not say `xml:space="preserve"`. A
 * piece gets the attribute only when the cut itself leaves it with whitespace at an edge, or the
 * text had it already, so spacing Word never showed does not appear in the neighbouring text.
 */
export function splitAtOffsets(
  doc: Document,
  p: Element,
  offsets: Iterable<number>,
  newId: () => string,
): void {
  const cuts = [...new Set(offsets)].sort((a, b) => b - a);
  if (cuts.length === 0) return;
  const atoms = scanParagraph(p).atoms;
  const ends = atoms.map((a) => a.end);
  const texts = atoms.map((a) => a.text);
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
    const kept = isPreserved(atom.node);

    const next = atom.run.cloneNode(false) as Element;
    const rPr = wChild(atom.run, "rPr");
    if (rPr) next.appendChild(cloneRunProps(rPr, newId));
    const t = createW(doc, "t");
    setText(doc, t, right, kept || /^[ \t\r\n]/.test(right));
    next.appendChild(t);
    setText(doc, atom.node, left, kept || /[ \t\r\n]$/.test(left));
    insertAfter(p, next, atom.run);
    texts[i] = left;
    ends[i] = cut;
  }
}
