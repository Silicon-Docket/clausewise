import {
  DEFAULT_LIMITS,
  M_NS,
  MC_NS,
  W_NS,
  W_STRICT_NS,
  childElements,
  getW,
  isNs,
  isW,
  limitError,
  limitsOf,
  onOff,
  strictFormatError,
  wChild,
  type DocxLimits,
} from "./ooxml.js";

/** Why text that is part of the paragraph cannot be edited. */
export type Blocker =
  | "hyperlink"
  | "field"
  | "contentControl"
  | "trackedChange"
  | "movedText"
  | "smartTag"
  | "customXml"
  | "textDirection"
  | "alternateContent";

/** Content that takes up room in Word but has no representation in the text view. */
export type BarrierKind = "hiddenText" | "equation" | "ruby" | "symbol" | "positionalTab";

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
  /** What stops the text being edited; undefined exactly when `editable`. */
  blockedBy: Blocker | undefined;
}

/** A point in the text view where something sits that an edit must not reach across. */
export interface Barrier {
  kind: BarrierKind;
  position: number;
}

export interface ParagraphScan {
  atoms: Atom[];
  barriers: Barrier[];
  text: string;
  /** Runs formatted as hidden text that hold something Word would otherwise show. */
  hiddenRuns: number;
  /** How many fields are still open at the end of the paragraph. */
  exitDepth: number;
}

function hasAncestor(node: Node, ns: string, local: string): boolean {
  for (let n = node.parentNode; n; n = n.parentNode) {
    if (isNs(n, ns, local)) return true;
  }
  return false;
}

/** The part of a text box or of the body in which a field opened in one paragraph can still be open in the next. */
function storyOf(p: Element): Node | null {
  for (let n = p.parentNode; n; n = n.parentNode) {
    if (isW(n, "txbxContent")) return n;
  }
  return null;
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

function barrierOfRunChild(node: Element): BarrierKind | undefined {
  if (node.namespaceURI !== W_NS) return undefined;
  switch (node.localName) {
    case "sym":
      return "symbol";
    case "ptab":
      return "positionalTab";
    case "ruby":
      return "ruby";
    default:
      return undefined;
  }
}

function isHiddenRun(run: Element): boolean {
  const rPr = wChild(run, "rPr");
  if (!rPr) return false;
  return onOff(wChild(rPr, "vanish")) || onOff(wChild(rPr, "specVanish"));
}

function blockerOfContainer(localName: string): Blocker | undefined {
  switch (localName) {
    case "ins":
      return "trackedChange";
    case "moveTo":
      return "movedText";
    case "hyperlink":
      return "hyperlink";
    case "smartTag":
      return "smartTag";
    case "fldSimple":
      return "field";
    case "customXml":
      return "customXml";
    case "bdo":
    case "dir":
      return "textDirection";
    default:
      return undefined;
  }
}

/**
 * Reads a paragraph the way the review sees it. `entryDepth` is how many fields are open when
 * the paragraph starts; left out, it is looked up from the document, which tracks fields across
 * paragraphs.
 */
export function scanParagraph(
  p: Element,
  entryDepth?: number,
  limits: DocxLimits = p.ownerDocument ? limitsOf(p.ownerDocument) : DEFAULT_LIMITS,
): ParagraphScan {
  const atoms: Atom[] = [];
  const barriers: Barrier[] = [];
  let pos = 0;
  let fieldDepth = entryDepth ?? entryFieldDepth(p);
  let runCount = 0;
  let hiddenRuns = 0;

  const visitRun = (run: Element, blocker: Blocker | undefined): void => {
    if (++runCount > limits.maxRunsPerParagraph) {
      throw limitError("A paragraph", "maxRunsPerParagraph", limits);
    }
    const hidden = isHiddenRun(run);
    let hiddenSeen = false;
    for (const c of childElements(run)) {
      if (isW(c, "fldChar")) {
        const type = getW(c, "fldCharType");
        if (type === "begin") fieldDepth++;
        else if (type === "end") fieldDepth = Math.max(0, fieldDepth - 1);
        continue;
      }
      const barrier = barrierOfRunChild(c);
      const text = barrier ? null : contentText(c);
      if (!barrier && !text) continue;
      if (hidden) {
        if (!hiddenSeen) {
          hiddenSeen = true;
          hiddenRuns++;
          barriers.push({ kind: "hiddenText", position: pos });
        }
        continue;
      }
      if (barrier) {
        barriers.push({ kind: barrier, position: pos });
        continue;
      }
      const reason = fieldDepth > 0 ? "field" : blocker;
      atoms.push({
        run,
        node: c,
        text: text ?? "",
        start: pos,
        end: pos + (text ?? "").length,
        editable: reason === undefined,
        blockedBy: reason,
      });
      pos += (text ?? "").length;
    }
  };

  const visit = (container: Element, blocker: Blocker | undefined, level: number): void => {
    if (level > limits.maxNestingDepth) {
      throw limitError("A paragraph", "maxNestingDepth", limits);
    }
    for (const child of childElements(container)) {
      if (child.namespaceURI === M_NS) {
        if (child.localName === "oMath" || child.localName === "oMathPara") {
          barriers.push({ kind: "equation", position: pos });
        }
        continue;
      }
      if (child.namespaceURI === MC_NS) {
        // Word shows the first Choice it understands and ignores the Fallback copy.
        if (child.localName === "AlternateContent") {
          const choice = childElements(child).find((c) => isNs(c, MC_NS, "Choice"));
          if (choice) visit(choice, blocker ?? "alternateContent", level + 1);
        }
        continue;
      }
      if (child.namespaceURI !== W_NS) continue;
      switch (child.localName) {
        case "r":
          visitRun(child, blocker);
          break;
        case "sdt": {
          const content = wChild(child, "sdtContent");
          if (content) visit(content, blocker ?? "contentControl", level + 1);
          break;
        }
        case "ins":
        case "moveTo":
        case "hyperlink":
        case "smartTag":
        case "fldSimple":
        case "customXml":
        case "bdo":
        case "dir":
          visit(child, blocker ?? blockerOfContainer(child.localName), level + 1);
          break;
        // w:del and w:moveFrom hold removed text, which is not part of the current view.
        default:
          break;
      }
    }
  };

  visit(p, undefined, 0);
  return {
    atoms,
    barriers,
    text: atoms.map((a) => a.text).join(""),
    hiddenRuns,
    exitDepth: fieldDepth,
  };
}

const entryDepths = new WeakMap<Document, Map<Element, number>>();

/**
 * Field state is a property of the whole story, not of one paragraph: a table of contents opens
 * in one paragraph and closes in a later one, and everything between is field result.
 */
function computeEntryDepths(doc: Document, list: Element[]): Map<Element, number> {
  const limits = limitsOf(doc);
  const map = new Map<Element, number>();
  const open = new Map<Node | null, number>();
  for (const p of list) {
    const story = storyOf(p);
    const entry = open.get(story) ?? 0;
    map.set(p, entry);
    open.set(story, scanParagraph(p, entry, limits).exitDepth);
  }
  entryDepths.set(doc, map);
  return map;
}

function entryFieldDepth(p: Element): number {
  const doc = p.ownerDocument;
  if (!doc) return 0;
  const map = entryDepths.get(doc) ?? computeEntryDepths(doc, listParagraphs(doc));
  return map.get(p) ?? 0;
}

function listParagraphs(doc: Document): Element[] {
  const body = doc.getElementsByTagNameNS(W_NS, "body")[0];
  if (!body) return [];
  return Array.from(body.getElementsByTagNameNS(W_NS, "p")).filter(
    (p) => !hasAncestor(p, MC_NS, "Fallback"),
  );
}

export function bodyParagraphs(doc: Document): Element[] {
  if (doc.documentElement?.namespaceURI === W_STRICT_NS) throw strictFormatError();
  const list = listParagraphs(doc);
  const limits = limitsOf(doc);
  if (list.length > limits.maxParagraphs) {
    throw limitError("word/document.xml", "maxParagraphs", limits);
  }
  computeEntryDepths(doc, list);
  return list;
}

export function collectAtoms(p: Element): Atom[] {
  return scanParagraph(p).atoms;
}

export function paragraphText(p: Element): string {
  return scanParagraph(p).text;
}

export function isInTable(p: Element): boolean {
  for (let n = p.parentNode; n; n = n.parentNode) {
    if (isW(n, "tc")) return true;
  }
  return false;
}

/** Comments cannot be anchored in a text box: Word has no way to show them there. */
export function isInTextBox(p: Element): boolean {
  return storyOf(p) !== null;
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
