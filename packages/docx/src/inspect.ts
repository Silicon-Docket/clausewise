import type JSZip from "jszip";
import {
  MC_NS,
  W_NS,
  isNs,
  isW,
  parseXml,
  resolveLimits,
  type DocxLimits,
} from "./ooxml.js";
import {
  DOCUMENT_PART,
  documentRelationships,
  entryName,
  isUsableSidePart,
  openPackage,
  packageLimits,
  readDocumentXml,
  readPart,
  type Relationship,
} from "./package.js";
import { bodyParagraphs, scanParagraph } from "./paragraphs.js";

/** What a Word file holds that the review does not show to the model. */
export interface DocxInspection {
  /** Tracked insertions (w:ins and moved-in text) anywhere in the story parts. */
  trackedInsertions: number;
  /** Tracked deletions (w:del and moved-out text) anywhere in the story parts. */
  trackedDeletions: number;
  /** Entries in the comments part. */
  comments: number;
  /** Footnotes, without the separator entries every document carries. */
  footnotes: number;
  /** Endnotes, without the separator entries every document carries. */
  endnotes: number;
  /** Header and footer parts that contain any text. */
  headerFooterParts: number;
  /** Runs formatted as hidden text, which Word does not display. */
  hiddenRuns: number;
  /** Pictures and drawings, not counting text boxes. */
  images: number;
}

/** Entries of a notes part that only hold the line between the text and the notes. */
const NOTE_FILLERS = new Set(["separator", "continuationSeparator", "continuationNotice"]);

const REL_BASE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";

type SideKind = "comments" | "footnotes" | "endnotes" | "header" | "footer";

const ROOT: Record<SideKind, string> = {
  comments: "comments",
  footnotes: "footnotes",
  endnotes: "endnotes",
  header: "hdr",
  footer: "ftr",
};

/** Where each kind of part lives when the relationships do not say. */
const CONVENTIONAL_NAME: Record<SideKind, RegExp> = {
  comments: /^word\/comments\.xml$/i,
  footnotes: /^word\/footnotes\.xml$/i,
  endnotes: /^word\/endnotes\.xml$/i,
  header: /^word\/header\d*\.xml$/i,
  footer: /^word\/footer\d*\.xml$/i,
};

function insideFallback(el: Element): boolean {
  for (let n = el.parentNode; n; n = n.parentNode) {
    if (isNs(n, MC_NS, "Fallback")) return true;
  }
  return false;
}

/** Elements of one kind, leaving out the second copy Word keeps of a text box for old readers. */
function all(doc: Document, local: string): Element[] {
  return Array.from(doc.getElementsByTagNameNS(W_NS, local)).filter((el) => !insideFallback(el));
}

function containsTextBox(el: Element): boolean {
  return el.getElementsByTagNameNS(W_NS, "txbxContent").length > 0;
}

function countImages(doc: Document): number {
  let n = 0;
  for (const local of ["drawing", "pict"]) {
    for (const el of all(doc, local)) if (!containsTextBox(el)) n++;
  }
  return n;
}

function countRevisions(doc: Document): { insertions: number; deletions: number } {
  return {
    insertions: all(doc, "ins").length + all(doc, "moveTo").length,
    deletions: all(doc, "del").length + all(doc, "moveFrom").length,
  };
}

function hasText(doc: Document): boolean {
  return all(doc, "t").some((t) => (t.textContent ?? "").trim() !== "");
}

/**
 * Reads one optional part. A part that is damaged or too large only costs the count for that
 * part: the report is a courtesy, and it must not stop a contract that can be reviewed.
 */
async function readSidePart(zip: JSZip, path: string, kind: SideKind): Promise<Document | undefined> {
  try {
    const real = entryName(zip, path);
    if (real === undefined) return undefined;
    const xml = await readPart(zip, real);
    if (xml === undefined) return undefined;
    const doc = parseXml(xml, real, packageLimits(zip));
    return isW(doc.documentElement, ROOT[kind]) ? doc : undefined;
  } catch {
    return undefined;
  }
}

async function relationshipsOrNone(zip: JSZip): Promise<Relationship[]> {
  try {
    return await documentRelationships(zip);
  } catch {
    return [];
  }
}

/** The parts of one kind that the document points to, plus the ones sitting where Word puts them. */
function sidePaths(zip: JSZip, rels: Relationship[], kind: SideKind): string[] {
  const found = new Map<string, string>();
  for (const rel of rels) {
    if (rel.type !== `${REL_BASE}${kind}` || !isUsableSidePart(rel.path)) continue;
    found.set(rel.path.toLowerCase(), rel.path);
  }
  for (const name of Object.keys(zip.files)) {
    if (CONVENTIONAL_NAME[kind].test(name) && !found.has(name.toLowerCase())) {
      found.set(name.toLowerCase(), name);
    }
  }
  return [...found.values()];
}

async function sideParts(
  zip: JSZip,
  rels: Relationship[],
  kind: SideKind,
): Promise<Document[]> {
  const docs: Document[] = [];
  for (const path of sidePaths(zip, rels, kind)) {
    const doc = await readSidePart(zip, path, kind);
    if (doc) docs.push(doc);
  }
  return docs;
}

function countNotes(docs: Document[], entry: "footnote" | "endnote"): number {
  let n = 0;
  for (const doc of docs) {
    for (const note of all(doc, entry)) {
      if (!NOTE_FILLERS.has(note.getAttributeNS(W_NS, "type") ?? "")) n++;
    }
  }
  return n;
}

/**
 * Counts what is in a Word file that the review never shows the model: existing tracked
 * changes and comments, footnotes, endnotes, headers, footers, hidden text and images. It reads
 * the file under the same limits as the rest of the engine and does not throw for a part that is
 * odd, only for a file that cannot be read at all.
 */
export async function inspectDocx(
  buf: Uint8Array,
  limits?: Partial<DocxLimits>,
): Promise<DocxInspection> {
  const resolved = resolveLimits(limits);
  const zip = await openPackage(buf, resolved);
  const body = parseXml(await readDocumentXml(zip), DOCUMENT_PART, resolved);

  let hiddenRuns = 0;
  for (const p of bodyParagraphs(body)) hiddenRuns += scanParagraph(p).hiddenRuns;

  const rels = await relationshipsOrNone(zip);
  const comments = await sideParts(zip, rels, "comments");
  const footnotes = await sideParts(zip, rels, "footnotes");
  const endnotes = await sideParts(zip, rels, "endnotes");
  const headers = await sideParts(zip, rels, "header");
  const footers = await sideParts(zip, rels, "footer");

  const stories = [body, ...footnotes, ...endnotes, ...headers, ...footers];
  let trackedInsertions = 0;
  let trackedDeletions = 0;
  let images = 0;
  for (const story of stories) {
    const revisions = countRevisions(story);
    trackedInsertions += revisions.insertions;
    trackedDeletions += revisions.deletions;
    images += countImages(story);
  }

  return {
    trackedInsertions,
    trackedDeletions,
    comments: comments.reduce((n, doc) => n + all(doc, "comment").length, 0),
    footnotes: countNotes(footnotes, "footnote"),
    endnotes: countNotes(endnotes, "endnote"),
    headerFooterParts: [...headers, ...footers].filter(hasText).length,
    hiddenRuns,
    images,
  };
}
