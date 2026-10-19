import JSZip from "jszip";
import { DocxError } from "./ooxml.js";

export const DOCUMENT_PART = "word/document.xml";

export async function openPackage(buf: Uint8Array): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(buf);
  } catch {
    throw new DocxError("Not a .docx file: it is not a valid zip archive");
  }
}

export async function readPart(zip: JSZip, path: string): Promise<string | undefined> {
  const file = zip.file(path);
  return file ? file.async("string") : undefined;
}

export async function readDocumentXml(zip: JSZip): Promise<string> {
  const xml = await readPart(zip, DOCUMENT_PART);
  if (xml === undefined) throw new DocxError(`Not a .docx file: ${DOCUMENT_PART} is missing`);
  return xml;
}

export function writePackage(zip: JSZip): Promise<Uint8Array> {
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
