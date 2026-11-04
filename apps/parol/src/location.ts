/**
 * How a source span is named to a person: "Amendment No. 1 (v1), Section 2, paragraph 3". The
 * paragraph is the index `parseDocx` gave it, counting from zero, so a reader can find it in the
 * inspector. A span with no clause number is named by its paragraph alone.
 */
export function formatLocation(span: {
  documentTitle: string;
  versionNo: number;
  clauseNumber: string | null;
  paragraphIndex: number;
}): string {
  const section = span.clauseNumber === null ? "" : `, Section ${span.clauseNumber}`;
  return `${span.documentTitle} (v${span.versionNo})${section}, paragraph ${span.paragraphIndex}`;
}
