import { DocxError, inspectDocx, parseDocx, type DocxParagraph } from "@clausewise/docx";
import { UploadError, type ParseDocument, type ParsedDocument } from "../module-contracts.js";
import { withoutInvisible } from "./invisible.js";
import { MAX_PARAGRAPHS, parseTxt } from "./txt.js";

/** A signed contract in Word is well under a megabyte. 10 MB leaves room for embedded images. */
export const MAX_DOCX_BYTES = 10 * 1024 * 1024;
/** Fewer characters than this is a cover page or a stray file, not something to review. */
export const MIN_REVIEWABLE_CHARS = 20;
/**
 * The engine's own limits are far above any contract (50 MiB of body XML), and a small zip can
 * expand to them: forty megabytes of one repeated letter deflate to about a hundred kilobytes, so
 * the byte limit on the file alone does not bound what is read. The body of a real 500 page
 * agreement is a few megabytes of XML, so these leave room and no more.
 */
export const MAX_DOCX_XML_BYTES = 16 * 1024 * 1024;
export const MAX_DOCX_PART_BYTES = 4 * 1024 * 1024;
/**
 * The most text a file may hold, in UTF-16 code units, whatever its type. This is the size limit
 * of a text file (2 MB, and no character is narrower than a byte), applied to a Word file after
 * its markup is gone. It also bounds the largest paragraph. Work and output downstream grow with
 * the amount of text, and this is what keeps them bounded.
 */
export const MAX_TEXT_CHARS = 2 * 1024 * 1024;

/**
 * Counts the characters a reader could see, leaving out table of contents lines, white space at
 * the ends of a paragraph and invisible characters (see invisible.ts), and stopping as soon as
 * the minimum is met so a large file costs nothing here.
 */
function hasReviewableText(paragraphs: DocxParagraph[]): boolean {
  let count = 0;
  for (const paragraph of paragraphs) {
    if (paragraph.isTocEntry === true) continue;
    const text = withoutInvisible(paragraph.text).trim();
    // Iterating a string walks code points, so a character outside the basic plane counts once.
    for (const character of text) {
      if (character !== "" && ++count >= MIN_REVIEWABLE_CHARS) return true;
    }
  }
  return false;
}

function totalCharacters(paragraphs: DocxParagraph[]): number {
  let total = 0;
  for (const paragraph of paragraphs) total += paragraph.text.length;
  return total;
}

/**
 * Maps the engine's error to one that is safe to show. The engine's own messages name parts of
 * the package and can echo attacker-controlled names, so they are never passed on. The category
 * is read from them and the wording below is ours.
 */
function uploadErrorFor(error: unknown): UploadError {
  const message = error instanceof DocxError ? error.message : "";
  if (/Strict Open XML/i.test(message)) {
    return new UploadError(
      "This Word file uses the Strict Open XML format, which is not supported. Open it in Word, " +
        'save it as a normal "Word Document (.docx)" and upload it again.',
    );
  }
  if (/password|encrypted|old-format/i.test(message)) {
    return new UploadError(
      "This file is password protected or in an old Word format. Remove the password or save it " +
        "as a normal .docx in Word, and upload it again.",
    );
  }
  if (/over the limit/i.test(message)) {
    return new UploadError("This file is too large or too complex to review.");
  }
  if (/two parts with the same name/i.test(message)) {
    return new UploadError(
      "This Word file holds two parts with the same name, so what Word shows could differ from what " +
        'would be reviewed. Open it in Word, save it as a normal "Word Document (.docx)" and upload it again.',
    );
  }
  return new UploadError(
    "This file could not be read as a Word document. It may be damaged, or it may not be a .docx.",
  );
}

async function parseWord(bytes: Uint8Array): Promise<ParsedDocument> {
  if (bytes.length > MAX_DOCX_BYTES) {
    throw new UploadError(
      `This Word file is over the ${MAX_DOCX_BYTES / (1024 * 1024)} MB limit. Check that it is the right file.`,
    );
  }
  if (bytes.length === 0) throw new UploadError("This file is empty.");
  try {
    const limits = {
      maxInputBytes: MAX_DOCX_BYTES,
      maxDocumentXmlBytes: MAX_DOCX_XML_BYTES,
      maxPartBytes: MAX_DOCX_PART_BYTES,
    };
    const { paragraphs } = await parseDocx(bytes, limits);
    const inspection = await inspectDocx(bytes, limits);
    return { paragraphs, inspection };
  } catch (error) {
    // Anything the engine throws on a hostile file ends here as an upload error. The original is
    // not attached as a cause: its message is the part that must not travel.
    throw uploadErrorFor(error);
  }
}

/**
 * Reads an uploaded file into paragraphs. Rejects with UploadError, whose message never quotes
 * the document.
 */
export const parseDocument: ParseDocument = async ({ bytes, mediaType }) => {
  let parsed: ParsedDocument;
  if (mediaType === "docx") {
    parsed = await parseWord(bytes);
  } else if (mediaType === "txt") {
    parsed = { paragraphs: parseTxt(bytes), inspection: null };
  } else {
    // The type says this cannot happen; a value that came from a request body can.
    throw new UploadError("Only .docx and .txt files can be uploaded.");
  }
  if (parsed.paragraphs.length > MAX_PARAGRAPHS) {
    throw new UploadError(
      `This file has more than ${MAX_PARAGRAPHS} paragraphs, which is more than a contract has.`,
    );
  }
  if (totalCharacters(parsed.paragraphs) > MAX_TEXT_CHARS) {
    throw new UploadError(
      `This file has more than ${MAX_TEXT_CHARS} characters of text, which is more than a contract has. ` +
        "Check that it is the right file.",
    );
  }
  if (!hasReviewableText(parsed.paragraphs)) {
    throw new UploadError(
      `This file has fewer than ${MIN_REVIEWABLE_CHARS} characters of text to review. ` +
        "Check that it is the right file and that its text is not only in images.",
    );
  }
  return parsed;
};
