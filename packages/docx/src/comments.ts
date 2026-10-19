import type JSZip from "jszip";
import {
  DocxError,
  W_NS,
  childElements,
  createW,
  parseXml,
  serializeXml,
  setText,
} from "./ooxml.js";
import { readPart } from "./package.js";

const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const COMMENTS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";
const COMMENTS_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml";
const RELS_PATH = "word/_rels/document.xml.rels";
const CONTENT_TYPES_PATH = "[Content_Types].xml";
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

export interface CommentsPart {
  doc: Document;
  root: Element;
  path: string;
  existed: boolean;
}

export async function loadComments(zip: JSZip): Promise<CommentsPart> {
  const relsXml = await readPart(zip, RELS_PATH);
  if (relsXml) {
    const rels = parseXml(relsXml, RELS_PATH);
    for (const rel of childElements(rels.documentElement)) {
      if (rel.getAttribute("Type") !== COMMENTS_REL) continue;
      const target = rel.getAttribute("Target") ?? "comments.xml";
      const path = target.startsWith("/") ? target.slice(1) : `word/${target}`;
      const xml = await readPart(zip, path);
      if (xml) {
        const doc = parseXml(xml, path);
        return { doc, root: doc.documentElement, path, existed: true };
      }
    }
  }
  const doc = parseXml(`${XML_DECL}<w:comments xmlns:w="${W_NS}"/>`, "new comments part");
  return { doc, root: doc.documentElement, path: "word/comments.xml", existed: false };
}

export function addComment(
  part: CommentsPart,
  c: { id: number; author: string; initials: string; date: string; text: string },
): void {
  const { doc } = part;
  const comment = createW(doc, "comment", {
    id: String(c.id),
    author: c.author,
    date: c.date,
    initials: c.initials,
  });
  c.text.split(/\r?\n/).forEach((line, i) => {
    const p = createW(doc, "p");
    if (i === 0) {
      const ref = createW(doc, "r");
      ref.appendChild(createW(doc, "annotationRef"));
      p.appendChild(ref);
    }
    const r = createW(doc, "r");
    const t = createW(doc, "t");
    setText(doc, t, line);
    r.appendChild(t);
    p.appendChild(r);
    comment.appendChild(p);
  });
  part.root.appendChild(comment);
}

export async function saveComments(zip: JSZip, part: CommentsPart): Promise<void> {
  zip.file(part.path, serializeXml(part.doc));
  if (part.existed) return;

  const relsXml = await readPart(zip, RELS_PATH);
  const rels = parseXml(relsXml ?? `${XML_DECL}<Relationships xmlns="${REL_NS}"/>`, RELS_PATH);
  let maxId = 0;
  for (const rel of childElements(rels.documentElement)) {
    const m = /^rId(\d+)$/.exec(rel.getAttribute("Id") ?? "");
    if (m) maxId = Math.max(maxId, Number(m[1]));
  }
  const rel = rels.createElementNS(REL_NS, "Relationship");
  rel.setAttribute("Id", `rId${maxId + 1}`);
  rel.setAttribute("Type", COMMENTS_REL);
  rel.setAttribute("Target", part.path.replace(/^word\//, ""));
  rels.documentElement.appendChild(rel);
  zip.file(RELS_PATH, serializeXml(rels));

  const ctXml = await readPart(zip, CONTENT_TYPES_PATH);
  if (!ctXml) throw new DocxError(`Not a .docx file: ${CONTENT_TYPES_PATH} is missing`);
  const ct = parseXml(ctXml, CONTENT_TYPES_PATH);
  const override = ct.createElementNS(CT_NS, "Override");
  override.setAttribute("PartName", `/${part.path}`);
  override.setAttribute("ContentType", COMMENTS_CT);
  ct.documentElement.appendChild(override);
  zip.file(CONTENT_TYPES_PATH, serializeXml(ct));
}
