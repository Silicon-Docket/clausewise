/**
 * Turns the source paragraphs of a case document into the paragraphs a reader parses back out of
 * the file, and into the bytes of that file. The expansion is the single source of truth: the
 * DOCX and the TXT are written from it, and anchors are resolved against it, so what the builder
 * checks is what the file holds.
 *
 * Output is deterministic. The docx library stamps the core properties and every zip entry with
 * the clock, so both are replaced with a fixed date after packing; the same case then gives the
 * same bytes on every run.
 */
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import type { CaseDocument, SourceParagraph } from "./types.js";

export interface ExpandedParagraph {
  /** The index the Word parser gives the paragraph: every body paragraph, tables included. */
  index: number;
  kind: SourceParagraph["kind"] | "signature_line";
  /** Exactly what the parser reads back, typed number included. */
  text: string;
  /** The clause number the paragraph belongs to, or null outside any numbered clause. */
  clause: string | null;
  injected: boolean;
}

/** A number with a point inside it ("6.1") is typed as is; "2" is typed "2." like a list. */
export function clauseLabel(number: string): string {
  return number.includes(".") ? number : `${number}.`;
}

export const SIGNATURE_LINE = "By: ______________________";
export const SIGNATURE_TITLE = "Name and title:";

/**
 * The paragraphs of a document in reading order. A sub-item belongs to the paragraph before it,
 * whichever clause that is (or none), as `segment` joins a lettered item to the clause it follows.
 * `omitInjected` leaves out the injected paragraphs, which is how the twin of an injection case
 * is made.
 */
export function expandDocument(
  doc: Pick<CaseDocument, "paragraphs">,
  options: { omitInjected?: boolean } = {},
): ExpandedParagraph[] {
  const out: ExpandedParagraph[] = [];
  let current: string | null = null;
  const push = (
    kind: ExpandedParagraph["kind"],
    text: string,
    clause: string | null,
    injected: boolean,
  ): void => {
    out.push({ index: out.length, kind, text, clause, injected });
  };
  for (const paragraph of doc.paragraphs) {
    const injected = paragraph.injected === true;
    if (injected && options.omitInjected === true) continue;
    switch (paragraph.kind) {
      case "title":
      case "heading":
        current = null;
        push(paragraph.kind, paragraph.text, null, injected);
        break;
      case "text":
        current = null;
        push("text", paragraph.text, null, injected);
        break;
      case "clause":
        current = paragraph.number;
        push("clause", `${clauseLabel(paragraph.number)} ${paragraph.text}`, current, injected);
        break;
      case "item":
        push("item", `${paragraph.marker} ${paragraph.text}`, current, injected);
        break;
      case "signature":
        current = null;
        for (const party of paragraph.parties) {
          push("signature_line", party, null, injected);
          push("signature_line", SIGNATURE_LINE, null, injected);
          push("signature_line", SIGNATURE_TITLE, null, injected);
        }
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// TXT
// ---------------------------------------------------------------------------------------------

/** One paragraph per block, blank lines between, a final newline. UTF-8 without a mark. */
export function renderTxt(paragraphs: readonly ExpandedParagraph[]): Uint8Array {
  return new TextEncoder().encode(`${paragraphs.map((p) => p.text).join("\n\n")}\n`);
}

// ---------------------------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------------------------

/** Every timestamp in a rendered file. The year is the dataset's, not the day it was built. */
export const FIXED_ISO = "2026-01-01T00:00:00.000Z";
// MS-DOS date: ((year - 1980) << 9) | (month << 5) | day, and a time of midnight.
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

const CREATOR = "Parol fixtures";

const escapeXml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function coreProperties(title: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${escapeXml(title)}</dc:title><dc:creator>${CREATOR}</dc:creator>` +
    `<cp:lastModifiedBy>${CREATOR}</cp:lastModifiedBy><cp:revision>1</cp:revision>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${FIXED_ISO}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${FIXED_ISO}</dcterms:modified>` +
    "</cp:coreProperties>"
  );
}

/**
 * Sets the date and time of every entry in a zip, in its local header and in the central
 * directory, without touching the compressed data. Entries are found through the central
 * directory, never by scanning for a signature, which can occur inside compressed bytes.
 */
export function pinZipTimestamps(bytes: Uint8Array): Uint8Array {
  const out = Uint8Array.from(bytes);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let end = -1;
  for (let i = out.length - 22; i >= Math.max(0, out.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("pinZipTimestamps: not a zip archive");
  const entries = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  for (let n = 0; n < entries; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("pinZipTimestamps: bad directory");
    view.setUint16(at + 12, DOS_TIME, true);
    view.setUint16(at + 14, DOS_DATE, true);
    const local = view.getUint32(at + 42, true);
    if (view.getUint32(local, true) !== 0x04034b50) throw new Error("pinZipTimestamps: bad entry");
    view.setUint16(local + 10, DOS_TIME, true);
    view.setUint16(local + 12, DOS_DATE, true);
    // Fixed part, then the name, the extra field and the comment.
    at +=
      46 +
      view.getUint16(at + 28, true) +
      view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true);
  }
  return out;
}

function wordParagraph(paragraph: SourceParagraph): Paragraph | Table {
  const spacing = { after: 160 };
  switch (paragraph.kind) {
    case "title":
      return new Paragraph({
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: paragraph.text, bold: true })],
        spacing: { after: 240 },
      });
    case "heading":
      return new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: paragraph.text, bold: true })],
        spacing: { before: 240, after: 120 },
      });
    case "text":
      return new Paragraph({ children: [new TextRun(paragraph.text)], spacing });
    case "clause":
      return new Paragraph({
        spacing,
        children: [
          new TextRun({ text: `${clauseLabel(paragraph.number)} `, bold: true }),
          new TextRun(paragraph.text),
        ],
      });
    case "item":
      return new Paragraph({
        indent: { left: 720 },
        spacing,
        children: [new TextRun(`${paragraph.marker} ${paragraph.text}`)],
      });
    case "signature": {
      const cell = (name: string): TableCell =>
        new TableCell({
          width: { size: 50, type: WidthType.PERCENTAGE },
          children: [
            new Paragraph({ children: [new TextRun({ text: name, bold: true })] }),
            new Paragraph(SIGNATURE_LINE),
            new Paragraph(SIGNATURE_TITLE),
          ],
        });
      return new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [new TableRow({ children: paragraph.parties.map(cell) })],
      });
    }
  }
}

/** A Word file for the document. Same input, same bytes. */
export async function renderDocx(
  doc: Pick<CaseDocument, "paragraphs" | "title">,
  options: { omitInjected?: boolean } = {},
): Promise<Uint8Array> {
  const children = doc.paragraphs
    .filter((paragraph) => !(paragraph.injected === true && options.omitInjected === true))
    .map(wordParagraph);
  const document = new Document({
    creator: CREATOR,
    title: doc.title,
    sections: [{ children }],
  });
  const packed = await Packer.toBuffer(document, undefined, [
    { path: "docProps/core.xml", data: coreProperties(doc.title) },
  ]);
  return pinZipTimestamps(packed);
}
