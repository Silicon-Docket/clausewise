import { childElements, createW, insertAfter, isW, setText, wChild } from "./ooxml.js";
import { collectAtoms } from "./paragraphs.js";

/**
 * Gives every direct-child run of the paragraph exactly one content child, cloning the run's
 * properties onto each new run. Word treats the result as the same text with the same
 * formatting, and it lets later steps cut and wrap at run granularity.
 */
export function explodeRuns(p: Element): void {
  for (const run of childElements(p)) {
    if (!isW(run, "r")) continue;
    const rPr = wChild(run, "rPr");
    const kids = childElements(run).filter((k) => k !== rPr);
    let cursor: Element = run;
    for (const kid of kids.slice(1)) {
      const next = run.cloneNode(false) as Element;
      if (rPr) next.appendChild(rPr.cloneNode(true));
      next.appendChild(kid);
      insertAfter(p, next, cursor);
      cursor = next;
    }
  }
}

/** Splits the editable `w:t` that straddles `offset`, if there is one. */
export function splitAt(doc: Document, p: Element, offset: number): void {
  const atom = collectAtoms(p).find((a) => a.start < offset && offset < a.end);
  if (!atom || !atom.editable || !isW(atom.node, "t")) return;
  const cut = offset - atom.start;
  const next = atom.run.cloneNode(false) as Element;
  const rPr = wChild(atom.run, "rPr");
  if (rPr) next.appendChild(rPr.cloneNode(true));
  const t = createW(doc, "t");
  setText(doc, t, atom.text.slice(cut));
  next.appendChild(t);
  setText(doc, atom.node, atom.text.slice(0, cut));
  insertAfter(p, next, atom.run);
}
