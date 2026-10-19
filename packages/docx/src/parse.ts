import { parseXml } from "./ooxml.js";
import { openPackage, readDocumentXml } from "./package.js";
import {
  bodyParagraphs,
  isInTable,
  paragraphNumbering,
  paragraphStyle,
  paragraphText,
} from "./paragraphs.js";

export interface DocxParagraph {
  /** `p:<index>`, where index counts every body paragraph in document order, tables included. */
  id: string;
  index: number;
  /** The paragraph as it reads with all tracked changes accepted. */
  text: string;
  style: string | undefined;
  numbering: { id: string; level: number } | undefined;
  inTable: boolean;
}

export interface ParsedDocx {
  paragraphs: DocxParagraph[];
}

export function paragraphId(index: number): string {
  return `p:${index}`;
}

export async function parseDocx(buf: Uint8Array): Promise<ParsedDocx> {
  const zip = await openPackage(buf);
  const doc = parseXml(await readDocumentXml(zip), "word/document.xml");
  return {
    paragraphs: bodyParagraphs(doc).map((p, index) => ({
      id: paragraphId(index),
      index,
      text: paragraphText(p),
      style: paragraphStyle(p),
      numbering: paragraphNumbering(p),
      inTable: isInTable(p),
    })),
  };
}
