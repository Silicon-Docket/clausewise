import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

export async function buildDocx(
  body: string,
  extra: Record<string, string> = {},
  opts: { withCommentsRel?: boolean } = {},
): Promise<Uint8Array> {
  const zip = new JSZip();
  const comments = opts.withCommentsRel
    ? '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>'
    : "";
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${comments}</Types>`,
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  const commentsRel = opts.withCommentsRel
    ? '<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>'
    : "";
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${commentsRel}</Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}</w:body></w:document>`,
  );
  for (const [path, content] of Object.entries(extra)) zip.file(path, content);
  return zip.generateAsync({ type: "uint8array" });
}

/** A run of plain text. */
export const run = (text: string, rPr = ""): string =>
  `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;

export const para = (inner: string, pPr = ""): string =>
  `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${inner}</w:p>`;

async function documentDoc(buf: Uint8Array): Promise<Document> {
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file("word/document.xml")!.async("string");
  return new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
}

export async function readPartText(buf: Uint8Array, path: string): Promise<string | undefined> {
  const zip = await JSZip.loadAsync(buf);
  return zip.file(path)?.async("string");
}

function inside(node: Node, local: string): boolean {
  for (let n = node.parentNode; n; n = n.parentNode) {
    if ((n as Element).namespaceURI === W && (n as Element).localName === local) return true;
  }
  return false;
}

/**
 * Paragraph texts as Word would show them after Accept All (`accepted`) or Reject All
 * (`rejected`), read straight from the XML so it does not depend on the library under test.
 */
export async function views(buf: Uint8Array, mode: "accepted" | "rejected"): Promise<string[]> {
  const doc = await documentDoc(buf);
  const out: string[] = [];
  for (const p of Array.from(doc.getElementsByTagNameNS(W, "p"))) {
    let text = "";
    for (const t of Array.from(p.getElementsByTagNameNS(W, mode === "accepted" ? "t" : "*"))) {
      const local = (t as Element).localName;
      if (mode === "accepted" && local === "t") text += t.textContent;
      if (mode === "rejected") {
        if (local === "t" && !inside(t, "ins")) text += t.textContent;
        if (local === "delText") text += t.textContent;
      }
    }
    out.push(text);
  }
  return out;
}

export async function elements(buf: Uint8Array, local: string): Promise<Element[]> {
  const doc = await documentDoc(buf);
  return Array.from(doc.getElementsByTagNameNS(W, local));
}

/** Ids of every tracked change and comment. A comment's range markers share one id by design. */
export async function annotationIds(buf: Uint8Array): Promise<string[]> {
  const doc = await documentDoc(buf);
  const ids: string[] = [];
  for (const local of ["ins", "del", "commentRangeStart"]) {
    for (const el of Array.from(doc.getElementsByTagNameNS(W, local))) {
      ids.push(el.getAttributeNS(W, "id") ?? "");
    }
  }
  return ids;
}
