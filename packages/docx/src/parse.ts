import type JSZip from "jszip";
import { childElements, getW, isW, parseXml, wChild } from "./ooxml.js";
import { documentRelationships, openPackage, readDocumentXml, readPart } from "./package.js";
import { resolveNumbering } from "./numbering.js";
import { bodyParagraphs, isInTable, paragraphStyle, paragraphText } from "./paragraphs.js";
import { StyleSheet, effectiveOutlineLevel } from "./styles.js";

const STYLES_PART = "word/styles.xml";
const NUMBERING_PART = "word/numbering.xml";
const REL_BASE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";

export interface DocxParagraph {
  /** `p:<index>`, where index counts every body paragraph in document order, tables included. */
  id: string;
  index: number;
  /** The paragraph as it reads with all tracked changes accepted. */
  text: string;
  /** The raw `w:pStyle` id. The name of the style is `styleName`. */
  style: string | undefined;
  /**
   * The effective list membership: the paragraph's own numPr, else the one its style (or a style
   * it is based on) carries. Undefined when the paragraph is in no list, which includes numId 0.
   */
  numbering: { id: string; level: number } | undefined;
  inTable: boolean;
  /**
   * Which table row the paragraph sits in, so that the cells of one row can be told from the next
   * row's: paragraphs with equal values share the innermost row, and the numbers have no other
   * meaning. Undefined outside a table.
   */
  tableRow: number | undefined;
  /**
   * The number Word displays before the paragraph, such as "3.1", "(a)", "iv." or "Article IV".
   * Undefined for a paragraph that is not numbered, a bullet, a level that shows nothing, a number
   * typed into the text, and anything the numbering data does not let us resolve.
   */
  label: string | undefined;
  /** The effective list level, 0 to 8; undefined when the paragraph is not in a list. */
  level: number | undefined;
  isBullet: boolean;
  /**
   * The w:name of the paragraph style, found through styles.xml ("heading 1", "Title", "toc 1"),
   * so a localised style id still resolves. A paragraph without a style has the document's
   * default one. Undefined when styles.xml does not define the style. Word writes its built-in
   * names in lower case and other producers do not ("Heading 1"), so compare without case.
   */
  styleName: string | undefined;
  /** The effective w:outlineLvl, 0 to 8, from the paragraph or its style chain. */
  outlineLevel: number | undefined;
  /** True for table of contents lines, found by style, by content control or by TOC field. */
  isTocEntry: boolean;
}

export interface ParsedDocx {
  paragraphs: DocxParagraph[];
}

export function paragraphId(index: number): string {
  return `p:${index}`;
}

async function relationshipTargets(zip: JSZip): Promise<Map<string, string>> {
  const targets = new Map<string, string>();
  try {
    for (const rel of await documentRelationships(zip)) {
      if (rel.path !== undefined && !targets.has(rel.type)) targets.set(rel.type, rel.path);
    }
  } catch {
    // The default part names below still work for a package whose relationships are damaged.
  }
  return targets;
}

/**
 * Styles and numbering are optional, and a broken one must not stop the contract being read. The
 * relationship names where the part lives; Word and every converter use the default name.
 */
async function optionalXml(
  zip: JSZip,
  targets: ReadonlyMap<string, string>,
  type: string,
  fallback: string,
): Promise<Document | undefined> {
  const named = targets.get(REL_BASE + type);
  for (const path of named === undefined || named === fallback ? [fallback] : [named, fallback]) {
    try {
      const xml = await readPart(zip, path);
      if (xml !== undefined) return parseXml(xml, path);
    } catch {
      // An unreadable part is as good as an absent one.
    }
  }
  return undefined;
}

export async function parseDocx(buf: Uint8Array): Promise<ParsedDocx> {
  const zip = await openPackage(buf);
  const doc = parseXml(await readDocumentXml(zip), "word/document.xml");
  const targets = await relationshipTargets(zip);
  const styles = new StyleSheet(await optionalXml(zip, targets, "styles", STYLES_PART));
  const elements = bodyParagraphs(doc);
  const numbering = await optionalXml(zip, targets, "numbering", NUMBERING_PART);
  const lists = resolveNumbering(elements, styles, numbering);
  const inTocField = tocFieldParagraphs(elements);
  const rows = tableRows(elements);

  return {
    paragraphs: elements.map((p, index) => {
      const style = paragraphStyle(p);
      const styleId = styles.effectiveStyleId(style);
      const list = lists[index]!;
      return {
        id: paragraphId(index),
        index,
        text: paragraphText(p),
        style,
        numbering: list.numbering,
        inTable: isInTable(p),
        tableRow: rows[index],
        label: list.label,
        level: list.numbering?.level,
        isBullet: list.isBullet,
        styleName: styles.get(styleId)?.name,
        outlineLevel: effectiveOutlineLevel(wChild(p, "pPr"), styles.chain(styleId)),
        isTocEntry: styles.isTocStyle(styleId) || inTocContentControl(p) || inTocField.has(index),
      };
    }),
  };
}

/** A number per paragraph for the table row it sits in, handed out in order of first sight. */
function tableRows(paragraphs: readonly Element[]): (number | undefined)[] {
  const ids = new Map<Node, number>();
  return paragraphs.map((p) => {
    for (let n = p.parentNode; n; n = n.parentNode) {
      if (!isW(n, "tr")) continue;
      let id = ids.get(n);
      if (id === undefined) {
        id = ids.size;
        ids.set(n, id);
      }
      return id;
    }
    return undefined;
  });
}

function inTocContentControl(p: Element): boolean {
  for (let n = p.parentNode; n; n = n.parentNode) {
    if (!isW(n, "sdt")) continue;
    const properties = wChild(n, "sdtPr");
    const part = properties && wChild(properties, "docPartObj");
    const gallery = part && wChild(part, "docPartGallery");
    if (gallery && getW(gallery, "val")?.trim().toLowerCase() === "table of contents") return true;
  }
  return false;
}

interface OpenField {
  /** Index of the paragraph that holds the field's begin mark. */
  from: number;
  instruction: string;
  /** Decided when the field's result starts, since only then is the instruction complete. */
  toc: boolean | undefined;
}

const TOC_INSTRUCTION = /^\s*TOC\b/i;

/** isW narrows to never on its false branch when the node is already an Element. */
const named = (el: Element, local: string): boolean => isW(el, local);

/**
 * Indexes of the paragraphs that lie inside a TOC field. Its entries are separate paragraphs
 * between the begin and end marks, so this runs over the whole body. A TOC field that never
 * ends is not trusted: it would otherwise cover the rest of the contract.
 */
function tocFieldParagraphs(paragraphs: readonly Element[]): Set<number> {
  const covered = new Set<number>();
  const open: OpenField[] = [];
  const decide = (field: OpenField): boolean =>
    (field.toc ??= TOC_INSTRUCTION.test(field.instruction));

  paragraphs.forEach((p, index) => {
    visitLiveContent(p, (el) => {
      if (named(el, "fldChar")) {
        const type = getW(el, "fldCharType");
        if (type === "begin") {
          open.push({ from: index, instruction: "", toc: undefined });
        } else if (type === "separate") {
          const field = open[open.length - 1];
          if (field) decide(field);
        } else if (type === "end") {
          const field = open.pop();
          if (field && decide(field)) {
            for (let i = field.from; i <= index; i++) covered.add(i);
          }
        }
      } else if (named(el, "instrText")) {
        const field = open[open.length - 1];
        if (field && field.toc === undefined) field.instruction += el.textContent ?? "";
      } else if (named(el, "fldSimple") && TOC_INSTRUCTION.test(getW(el, "instr") ?? "")) {
        covered.add(index);
      }
    });
  });
  return covered;
}

/**
 * Visits what a paragraph holds in document order, leaving out removed text and the paragraphs
 * of a text box, which are visited as paragraphs in their own right. It does not recurse, so
 * absurdly nested markup cannot exhaust the stack.
 */
function visitLiveContent(root: Element, visit: (el: Element) => void): void {
  const pending: Element[] = [];
  const pushChildren = (parent: Element): void => {
    const children = childElements(parent);
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]!);
  };
  pushChildren(root);
  for (let el = pending.pop(); el; el = pending.pop()) {
    if (named(el, "p") || named(el, "del") || named(el, "moveFrom")) continue;
    visit(el);
    pushChildren(el);
  }
}
