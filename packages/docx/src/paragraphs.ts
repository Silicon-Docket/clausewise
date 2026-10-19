import { W_NS, childElements, getW, isW, wChild } from "./ooxml.js";

/**
 * One character-bearing child of a run (`w:t`, `w:tab`, `w:br`, ...), placed in the
 * paragraph's *current view*: text from tracked insertions is included, text from tracked
 * deletions is not.
 */
export interface Atom {
  run: Element;
  node: Element;
  text: string;
  start: number;
  end: number;
  /** True only for a run that is a direct child of the paragraph and outside any field. */
  editable: boolean;
}

export function bodyParagraphs(doc: Document): Element[] {
  const body = doc.getElementsByTagNameNS(W_NS, "body")[0];
  if (!body) return [];
  return Array.from(body.getElementsByTagNameNS(W_NS, "p"));
}

function contentText(node: Element): string | null {
  if (node.namespaceURI !== W_NS) return null;
  switch (node.localName) {
    case "t":
      return node.textContent ?? "";
    case "tab":
      return "\t";
    case "br":
    case "cr":
      return "\n";
    case "noBreakHyphen":
      return "-";
    default:
      return null;
  }
}

export function collectAtoms(p: Element): Atom[] {
  const atoms: Atom[] = [];
  let pos = 0;
  let fieldDepth = 0;

  const visit = (container: Element): void => {
    for (const child of childElements(container)) {
      if (child.namespaceURI !== W_NS) continue;
      switch (child.localName) {
        case "r":
          for (const c of childElements(child)) {
            if (isW(c, "fldChar")) {
              const type = getW(c, "fldCharType");
              if (type === "begin") fieldDepth++;
              else if (type === "end") fieldDepth = Math.max(0, fieldDepth - 1);
              continue;
            }
            const text = contentText(c);
            if (!text) continue;
            atoms.push({
              run: child,
              node: c,
              text,
              start: pos,
              end: pos + text.length,
              editable: child.parentNode === p && fieldDepth === 0,
            });
            pos += text.length;
          }
          break;
        case "ins":
        case "moveTo":
        case "hyperlink":
        case "smartTag":
        case "fldSimple":
        case "customXml":
          visit(child);
          break;
        case "sdt": {
          const content = wChild(child, "sdtContent");
          if (content) visit(content);
          break;
        }
        // w:del and w:moveFrom hold removed text, which is not part of the current view.
        default:
          break;
      }
    }
  };

  visit(p);
  return atoms;
}

export function paragraphText(p: Element): string {
  return collectAtoms(p)
    .map((a) => a.text)
    .join("");
}

export function isInTable(p: Element): boolean {
  for (let n = p.parentNode; n; n = n.parentNode) {
    if (isW(n, "tc")) return true;
  }
  return false;
}

export function paragraphStyle(p: Element): string | undefined {
  const pPr = wChild(p, "pPr");
  const style = pPr && wChild(pPr, "pStyle");
  return (style && getW(style, "val")) || undefined;
}

export function paragraphNumbering(p: Element): { id: string; level: number } | undefined {
  const pPr = wChild(p, "pPr");
  const numPr = pPr && wChild(pPr, "numPr");
  if (!numPr) return undefined;
  const id = wChild(numPr, "numId");
  const lvl = wChild(numPr, "ilvl");
  const idVal = id && getW(id, "val");
  if (!idVal) return undefined;
  return { id: idVal, level: Number((lvl && getW(lvl, "val")) || 0) };
}
