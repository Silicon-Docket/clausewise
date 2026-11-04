import { canonicalJson, sha256Hex } from "../canonical.js";

/**
 * The `text_sha256` of a document version: the hash of its extracted paragraph texts, in order
 * (docs/parol/03, `document_versions.text_sha256`: "of the extracted paragraph texts; catches
 * re-saves"). A file saved again by Word differs in bytes and not in text, so the upload service
 * compares this to tell a re-save from a new version, and the run manifest pins it so that a run
 * names the exact text it read.
 *
 * The paragraphs are encoded as a JSON array of strings, so no choice of separator can make two
 * different lists of paragraphs hash alike. Every paragraph counts, table of contents entries
 * included, because `parseDocument` returns them and a changed contents line is a changed file.
 *
 * `parseDocument` does not compute this, so every caller that stores a version (the upload
 * service, the evaluation runner, a test) uses this one function.
 */
export function documentTextSha256(paragraphs: readonly { text: string }[]): string {
  return sha256Hex(canonicalJson(paragraphs.map((paragraph) => paragraph.text)));
}
