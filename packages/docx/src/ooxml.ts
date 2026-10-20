import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

export const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const W_STRICT_NS = "http://purl.oclc.org/ooxml/wordprocessingml/main";
export const XML_NS = "http://www.w3.org/XML/1998/namespace";
export const MC_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006";
export const M_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math";

export class DocxError extends Error {
  override name = "DocxError";
}

const MIB = 1024 * 1024;

/**
 * What the engine refuses to process. The defaults sit far above any real contract (a 500 page
 * agreement is a few MB of XML) and far below what exhausts a laptop, because a counterparty's
 * file is untrusted input.
 */
export interface DocxLimits {
  /** Size of the .docx file itself. */
  maxInputBytes: number;
  /** Declared uncompressed size of every part together, and of the parts actually read. */
  maxUncompressedBytes: number;
  /** Uncompressed size of word/document.xml. */
  maxDocumentXmlBytes: number;
  /** Uncompressed size of any other part the engine reads. */
  maxPartBytes: number;
  /** Number of entries in the zip. */
  maxZipEntries: number;
  /** Number of w:p elements in a part. */
  maxParagraphs: number;
  /** Number of runs inside one paragraph. */
  maxRunsPerParagraph: number;
  /** Element nesting depth. */
  maxNestingDepth: number;
}

export const DEFAULT_LIMITS: Readonly<DocxLimits> = Object.freeze({
  maxInputBytes: 256 * MIB,
  maxUncompressedBytes: 1024 * MIB,
  maxDocumentXmlBytes: 50 * MIB,
  maxPartBytes: 20 * MIB,
  maxZipEntries: 20_000,
  maxParagraphs: 100_000,
  maxRunsPerParagraph: 20_000,
  maxNestingDepth: 256,
});

export function resolveLimits(overrides?: Partial<DocxLimits>): DocxLimits {
  return { ...DEFAULT_LIMITS, ...overrides };
}

/** The error for a limit, naming the limit so the caller can see which one to raise. */
export function limitError(what: string, name: keyof DocxLimits, limits: DocxLimits): DocxError {
  const value = limits[name];
  const shown = name.endsWith("Bytes")
    ? `${Math.round((value / MIB) * 100) / 100} MiB`
    : `${value}`;
  return new DocxError(`${what} is over the limit of ${shown} (${name}), so it was not processed`);
}

/** Strict Open XML names the same markup differently, so reading it as normal Word XML finds no text at all. */
export function strictFormatError(): DocxError {
  return new DocxError(
    "This file uses the Strict Open XML format, which is not supported. Open it in Word and " +
      'save it again as a normal "Word Document (.docx)".',
  );
}

const documentLimits = new WeakMap<Document, DocxLimits>();

/** The limits a document was parsed under, so later steps on it enforce the same ones. */
export function limitsOf(doc: Document): DocxLimits {
  return documentLimits.get(doc) ?? resolveLimits();
}

/**
 * Walks the tags of an XML string before any DOM exists, so a file built to be deep, wide or
 * run-heavy is refused with bounded memory instead of after the DOM has been built.
 */
function guardXml(xml: string, what: string, limits: DocxLimits): void {
  const n = xml.length;
  let depth = 0;
  let paragraphs = 0;
  let runs = 0;
  let i = 0;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0 || lt + 1 >= n) return;
    const c = xml.charCodeAt(lt + 1);
    if (c === 33) {
      let end: number;
      let skip: number;
      if (xml.startsWith("<!--", lt)) {
        end = xml.indexOf("-->", lt + 4);
        skip = 3;
      } else if (xml.startsWith("<![CDATA[", lt)) {
        end = xml.indexOf("]]>", lt + 9);
        skip = 3;
      } else {
        end = xml.indexOf(">", lt);
        skip = 1;
      }
      if (end < 0) return;
      i = end + skip;
      continue;
    }
    if (c === 63) {
      const end = xml.indexOf("?>", lt + 2);
      if (end < 0) return;
      i = end + 2;
      continue;
    }
    const closing = c === 47;
    let j = lt + (closing ? 2 : 1);
    const nameStart = j;
    while (j < n) {
      const ch = xml.charCodeAt(j);
      if (ch <= 32 || ch === 47 || ch === 62) break;
      j++;
    }
    const name = xml.slice(nameStart, j);
    let quote = 0;
    for (; j < n; j++) {
      const ch = xml.charCodeAt(j);
      if (quote !== 0) {
        if (ch === quote) quote = 0;
      } else if (ch === 34 || ch === 39) quote = ch;
      else if (ch === 62) break;
    }
    if (j >= n) return;
    if (closing) {
      depth--;
    } else {
      const local = name.slice(name.lastIndexOf(":") + 1);
      if (local === "p") {
        if (++paragraphs > limits.maxParagraphs) throw limitError(what, "maxParagraphs", limits);
        runs = 0;
      } else if (local === "r") {
        if (++runs > limits.maxRunsPerParagraph) {
          throw limitError(what, "maxRunsPerParagraph", limits);
        }
      }
      if (xml.charCodeAt(j - 1) !== 47 && ++depth > limits.maxNestingDepth) {
        throw limitError(what, "maxNestingDepth", limits);
      }
    }
    i = j + 1;
  }
}

/**
 * Only the XML 1.0 rule for line ends is applied. The parser's default also turns U+0085, U+2028
 * and U+2029 into line feeds, which rewrites untouched paragraphs when the part is written back.
 */
function normalizeLineEnds(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

export function parseXml(xml: string, what: string, limits?: Partial<DocxLimits>): Document {
  const resolved = resolveLimits(limits);
  guardXml(xml, what, resolved);
  const parser = new DOMParser({
    locator: false,
    normalizeLineEndings: normalizeLineEnds,
    onError(level) {
      // The parser's own message can quote the document, so it is never passed on.
      if (level !== "warning") throw new DocxError(`${what} is not valid XML`);
    },
  });
  let doc: Document;
  try {
    doc = parser.parseFromString(xml, "text/xml") as unknown as Document;
  } catch {
    throw new DocxError(`${what} is not valid XML`);
  }
  documentLimits.set(doc, resolved);
  return doc;
}

const DECLARED_ENCODING = /^(<\?xml[^?]*?\bencoding\s*=\s*)(["'])[^"']*\2/;

/**
 * Parts are always written as UTF-8, so a declaration inherited from a UTF-16 part is corrected.
 * A raw carriage return can only come from a character reference, which a bare one would turn
 * into a line feed on the next read.
 */
export function serializeXml(doc: Document): string {
  return new XMLSerializer()
    .serializeToString(doc as never)
    .replace(DECLARED_ENCODING, '$1"UTF-8"')
    .replace(/\r/g, "&#13;");
}

/** Every code point XML 1.0 can carry, which excludes most controls, U+FFFE, U+FFFF and lone surrogates. */
const NOT_XML_CHAR = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;
const HAS_NOT_XML_CHAR = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/g;

/**
 * Makes text safe to put in a text node or attribute: line ends become LF, characters XML cannot
 * carry are dropped (a vertical tab or form feed becomes a space so words do not fuse) and a lone
 * surrogate becomes U+FFFD.
 */
export function xmlSafe(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(NOT_XML_CHAR, (ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0xd800 && cp <= 0xdfff) return "\uFFFD";
    return cp === 0x0b || cp === 0x0c ? " " : "";
  });
}

/** For text that arrives from a model: also drops the bidi controls that can reorder what a reader sees. */
export function sanitizeText(text: string): string {
  return xmlSafe(text).replace(BIDI_CONTROL, "");
}

export function hasInvalidXmlChars(text: string): boolean {
  return HAS_NOT_XML_CHAR.test(text);
}

/** The last line of defence: a part that would be unreadable is never written. */
export function assertXmlChars(xml: string, part: string): void {
  if (hasInvalidXmlChars(xml)) {
    throw new DocxError(
      `${part} would contain characters XML does not allow, so it was not written`,
    );
  }
}

export function childElements(node: Node): Element[] {
  const out: Element[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1) out.push(c as Element);
  }
  return out;
}

export function isNs(node: Node | null | undefined, ns: string, local: string): node is Element {
  return (
    !!node &&
    node.nodeType === 1 &&
    (node as Element).namespaceURI === ns &&
    (node as Element).localName === local
  );
}

export function isW(node: Node | null | undefined, local: string): node is Element {
  return isNs(node, W_NS, local);
}

export function wChild(el: Element, local: string): Element | undefined {
  return childElements(el).find((c) => isW(c, local));
}

export function getW(el: Element, name: string): string | null {
  return el.getAttributeNS(W_NS, name);
}

/** A boolean property such as w:vanish: present means on unless it says otherwise. */
export function onOff(el: Element | undefined): boolean {
  if (!el) return false;
  const val = getW(el, "val");
  return !(val === "0" || val === "false" || val === "off");
}

export function setW(el: Element, name: string, value: string): void {
  const clean = sanitizeText(value).replace(/[\t\n]/g, " ");
  el.setAttributeNS(W_NS, `w:${name}`, clean);
}

export function createW(doc: Document, local: string, attrs: Record<string, string> = {}): Element {
  const el = doc.createElementNS(W_NS, `w:${local}`);
  for (const [k, v] of Object.entries(attrs)) setW(el, k, v);
  return el;
}

export function isPreserved(el: Element): boolean {
  return el.getAttributeNS(XML_NS, "space") === "preserve";
}

/** Word ignores whitespace at the edges of a w:t unless xml:space says to keep it. */
export function hasEdgeSpace(text: string): boolean {
  return /^[ \t\n\r]|[ \t\n\r]$/.test(text);
}

/**
 * Replaces the content of a w:t or w:delText. `preserve` says whether xml:space="preserve" is
 * written: "auto" adds it only when the text has whitespace at an edge, and a piece cut out of a
 * longer text passes the answer for its own edges.
 */
export function setText(
  doc: Document,
  el: Element,
  text: string,
  preserve: boolean | "auto" = "auto",
): void {
  const clean = xmlSafe(text);
  while (el.firstChild) el.removeChild(el.firstChild);
  el.appendChild(doc.createTextNode(clean));
  if (preserve === true || (preserve === "auto" && hasEdgeSpace(clean))) {
    el.setAttributeNS(XML_NS, "xml:space", "preserve");
  } else if (el.hasAttributeNS(XML_NS, "space")) {
    el.removeAttributeNS(XML_NS, "space");
  }
}

/** Fills a run with the text, writing tabs (and line breaks when asked) as their own elements. */
export function appendRunText(
  doc: Document,
  run: Element,
  text: string,
  lineBreaks: boolean,
): void {
  for (const part of text.split(lineBreaks ? /(\n|\t)/ : /(\t)/)) {
    if (part === "") continue;
    if (part === "\n") run.appendChild(createW(doc, "br"));
    else if (part === "\t") run.appendChild(createW(doc, "tab"));
    else {
      const t = createW(doc, "t");
      setText(doc, t, part);
      run.appendChild(t);
    }
  }
}

export function insertAfter(parent: Node, node: Node, ref: Node): void {
  parent.insertBefore(node, ref.nextSibling);
}
