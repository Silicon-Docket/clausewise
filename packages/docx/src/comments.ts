import type JSZip from "jszip";
import {
  DocxError,
  W_NS,
  appendRunText,
  childElements,
  createW,
  isW,
  parseXml,
  sanitizeText,
} from "./ooxml.js";
import {
  documentRelationships,
  entryName,
  isUsableSidePart,
  packageLimits,
  readPart,
  writeXmlPart,
} from "./package.js";

const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
export const COMMENTS_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";
const COMMENTS_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml";
const RELS_PATH = "word/_rels/document.xml.rels";
const CONTENT_TYPES_PATH = "[Content_Types].xml";
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** The parts that must change to register a comments part, read before anything is written. */
interface Registration {
  /** Absent when a relationship to the part is already in place. */
  rels: Document | undefined;
  contentTypes: Document;
}

export interface CommentsPart {
  doc: Document;
  root: Element;
  path: string;
  /** The part was read from the package, so it is already registered. */
  existed: boolean;
  /** A relationship to the part is already in the document's relationships. */
  relationshipExists: boolean;
  registration?: Registration;
}

export function createCommentsPart(
  path = "word/comments.xml",
  relationshipExists = false,
): CommentsPart {
  const doc = parseXml(`${XML_DECL}<w:comments xmlns:w="${W_NS}"/>`, "new comments part");
  return { doc, root: doc.documentElement, path, existed: false, relationshipExists };
}

/**
 * The comments part the document's relationships point to, if one can be trusted. A relationship
 * is only a claim: followed blindly, one aimed at document.xml or styles.xml makes the comments
 * code overwrite or pollute that part.
 */
export async function findCommentsPart(
  zip: JSZip,
): Promise<{ path: string; doc: Document | undefined } | undefined> {
  const rels = await documentRelationships(zip);
  let missing: string | undefined;
  for (const rel of rels) {
    if (rel.type !== COMMENTS_REL || !isUsableSidePart(rel.path)) continue;
    const real = entryName(zip, rel.path);
    if (real === undefined) {
      missing ??= rel.path;
      continue;
    }
    const xml = await readPart(zip, real);
    if (xml === undefined) continue;
    const doc = parseXml(xml, real, packageLimits(zip));
    if (isW(doc.documentElement, "comments")) return { path: real, doc };
  }
  return missing === undefined ? undefined : { path: missing, doc: undefined };
}

function unusedCommentsName(zip: JSZip, taken: Set<string>): string {
  for (let n = 0; ; n++) {
    const name = `word/comments${n === 0 ? "" : n}.xml`;
    if (entryName(zip, name) === undefined && !taken.has(name.toLowerCase())) return name;
  }
}

/**
 * Reads what registering a new comments part will change. Doing it up front means a package whose
 * relationships or content types cannot be read is found before the document is touched, not
 * after the comment markers are already in it.
 */
async function readRegistration(zip: JSZip, relationshipExists: boolean): Promise<Registration> {
  const limits = packageLimits(zip);
  let rels: Document | undefined;
  if (!relationshipExists) {
    const relsXml = await readPart(zip, RELS_PATH);
    rels = parseXml(relsXml ?? `${XML_DECL}<Relationships xmlns="${REL_NS}"/>`, RELS_PATH, limits);
  }
  const ctXml = await readPart(zip, CONTENT_TYPES_PATH);
  if (!ctXml) throw new DocxError(`Not a .docx file: ${CONTENT_TYPES_PATH} is missing`);
  return { rels, contentTypes: parseXml(ctXml, CONTENT_TYPES_PATH, limits) };
}

export async function loadComments(zip: JSZip): Promise<CommentsPart> {
  const found = await findCommentsPart(zip);
  if (found?.doc) {
    return {
      doc: found.doc,
      root: found.doc.documentElement,
      path: found.path,
      existed: true,
      relationshipExists: true,
    };
  }
  const part = found
    ? createCommentsPart(found.path, true)
    : createCommentsPart(
        unusedCommentsName(
          zip,
          new Set(
            (await documentRelationships(zip)).flatMap((r) =>
              r.path === undefined ? [] : [r.path.toLowerCase()],
            ),
          ),
        ),
      );
  part.registration = await readRegistration(zip, part.relationshipExists);
  return part;
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
  sanitizeText(c.text)
    .split("\n")
    .forEach((line, i) => {
      const p = createW(doc, "p");
      if (i === 0) {
        const ref = createW(doc, "r");
        ref.appendChild(createW(doc, "annotationRef"));
        p.appendChild(ref);
      }
      const r = createW(doc, "r");
      appendRunText(doc, r, line, false);
      p.appendChild(r);
      comment.appendChild(p);
    });
  part.root.appendChild(comment);
}

export async function saveComments(zip: JSZip, part: CommentsPart): Promise<void> {
  writeXmlPart(zip, part.path, part.doc);
  if (part.existed) return;

  const { rels, contentTypes: ct } =
    part.registration ?? (await readRegistration(zip, part.relationshipExists));
  if (rels) {
    const used = new Set<string>();
    let maxId = 0;
    for (const rel of childElements(rels.documentElement)) {
      const id = rel.getAttribute("Id") ?? "";
      used.add(id);
      const m = /^rId(\d+)$/.exec(id);
      if (m) maxId = Math.max(maxId, Number(m[1]));
    }
    let next = maxId + 1;
    while (used.has(`rId${next}`)) next++;
    const rel = rels.createElementNS(REL_NS, "Relationship");
    rel.setAttribute("Id", `rId${next}`);
    rel.setAttribute("Type", COMMENTS_REL);
    rel.setAttribute("Target", part.path.replace(/^word\//, ""));
    rels.documentElement.appendChild(rel);
    writeXmlPart(zip, RELS_PATH, rels);
  }

  const partName = `/${part.path}`.toLowerCase();
  const existing = childElements(ct.documentElement).find(
    (e) => e.localName === "Override" && e.getAttribute("PartName")?.toLowerCase() === partName,
  );
  if (existing) existing.setAttribute("ContentType", COMMENTS_CT);
  else {
    const override = ct.createElementNS(CT_NS, "Override");
    override.setAttribute("PartName", `/${part.path}`);
    override.setAttribute("ContentType", COMMENTS_CT);
    ct.documentElement.appendChild(override);
  }
  writeXmlPart(zip, CONTENT_TYPES_PATH, ct);
}
