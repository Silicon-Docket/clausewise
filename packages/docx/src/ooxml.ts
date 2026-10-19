import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

export const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const XML_NS = "http://www.w3.org/XML/1998/namespace";

export class DocxError extends Error {
  override name = "DocxError";
}

export function parseXml(xml: string, what: string): Document {
  const parser = new DOMParser({
    onError(level, message) {
      if (level !== "warning") throw new DocxError(`${what} is not valid XML: ${message}`);
    },
  });
  return parser.parseFromString(xml, "text/xml") as unknown as Document;
}

export function serializeXml(doc: Document): string {
  return new XMLSerializer().serializeToString(doc as never);
}

export function childElements(node: Node): Element[] {
  const out: Element[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1) out.push(c as Element);
  }
  return out;
}

export function isW(node: Node | null | undefined, local: string): node is Element {
  return (
    !!node &&
    node.nodeType === 1 &&
    (node as Element).namespaceURI === W_NS &&
    (node as Element).localName === local
  );
}

export function wChild(el: Element, local: string): Element | undefined {
  return childElements(el).find((c) => isW(c, local));
}

export function getW(el: Element, name: string): string | null {
  return el.getAttributeNS(W_NS, name);
}

export function setW(el: Element, name: string, value: string): void {
  el.setAttributeNS(W_NS, `w:${name}`, value);
}

export function createW(doc: Document, local: string, attrs: Record<string, string> = {}): Element {
  const el = doc.createElementNS(W_NS, `w:${local}`);
  for (const [k, v] of Object.entries(attrs)) setW(el, k, v);
  return el;
}

export function setText(doc: Document, el: Element, text: string): void {
  while (el.firstChild) el.removeChild(el.firstChild);
  el.appendChild(doc.createTextNode(text));
  el.setAttributeNS(XML_NS, "xml:space", "preserve");
}

export function insertAfter(parent: Node, node: Node, ref: Node): void {
  parent.insertBefore(node, ref.nextSibling);
}
