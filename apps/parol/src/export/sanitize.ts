/**
 * Text that reaches the memo from a document, a model or a person is data. It goes into Word text
 * runs and nowhere else, and these functions make sure a run can always be written as XML 1.0.
 */

/** A quotation longer than this is shortened for display. The full quote is still verified. */
export const MAX_QUOTE_CHARS = 1500;

// XML 1.0 forbids most control characters and the two non-characters at the end of the Basic
// Multilingual Plane. Word also mishandles DEL and the C1 controls, which XML only discourages, so
// they go too. Tab, line feed and carriage return are valid and handled separately.
//
// Vertical tab, form feed and next line are the exception to "they go": the quote verifier counts
// them as white space between words, so a quotation that verified with one in it must show a space
// there. Dropping them would print "6.1of" for a paragraph that says "6.1<VT>of", which is not the
// text that was verified. They become a space instead, as in the docx package.
const SPACE_LIKE_CONTROL = /[\u000B\u000C\u0085]/g;
const INVALID_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFE\uFFFF]/g;
// A surrogate half with no partner cannot be encoded as UTF-8 at all, so a serialiser would either
// throw or write a replacement character. Dropping it keeps the rest of the text intact.
const LONE_HIGH = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g;
const LONE_LOW = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Removes what XML 1.0 cannot carry and settles line endings: carriage returns become line feeds
 * and tabs become spaces, so the only structure left in the text is the line break. A vertical tab,
 * a form feed and a next line character also become spaces, because they are white space to the
 * quote verifier and removing them would fuse the words either side. Right-to-left marks and
 * zero-width characters are valid and are kept, because a quotation must show what the document
 * holds.
 */
export function sanitizeXmlText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(LONE_HIGH, "")
    .replace(LONE_LOW, "")
    .replace(SPACE_LIKE_CONTROL, " ")
    .replace(INVALID_CONTROL, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ");
}

const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/;

/**
 * Closes every bidirectional override, embedding and isolate a text opens and does not close. An
 * unclosed right-to-left override runs to the end of its paragraph and would reorder the location
 * printed after a quotation, so the text is made to end its own formatting.
 *
 * What is still open is found the way the Unicode Bidirectional Algorithm (UAX #9) finds it: a
 * stack. An initiator is pushed. A PDF (U+202C) pops an embedding or override, but is ignored while
 * an isolate is on top. A PDI (U+2069) pops the nearest isolate and everything opened inside it,
 * and is ignored when there is none. The closers are then written from the top of the stack down,
 * so each one closes the thing it is meant to close, and there is no limit on how many: a count of
 * openers, or a cap, leaves something open in the cases the algorithm treats differently. Text
 * without such characters, which is almost all text, is returned as it is, and right-to-left words
 * themselves are untouched.
 */
export function containBidi(text: string): string {
  if (!BIDI_CONTROL.test(text)) return text;
  // true for an isolate, false for an embedding or override.
  const stack: boolean[] = [];
  // Where in the stack each open isolate is, so a PDI does not have to search for it.
  const isolates: number[] = [];
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (code >= 0x202a && code <= 0x202e && code !== 0x202c) {
      stack.push(false);
    } else if (code >= 0x2066 && code <= 0x2068) {
      isolates.push(stack.length);
      stack.push(true);
    } else if (code === 0x202c) {
      if (stack.length > 0 && !stack[stack.length - 1]) stack.pop();
    } else if (code === 0x2069) {
      const opened = isolates.pop();
      if (opened !== undefined) stack.length = opened;
    }
  }
  let closers = "";
  for (let at = stack.length - 1; at >= 0; at -= 1) closers += stack[at] ? "\u2069" : "\u202C";
  return text + closers;
}

/**
 * The first `MAX_QUOTE_CHARS` characters followed by three full stops, or the whole text when it
 * is no longer. The cut never separates the halves of a surrogate pair.
 */
export function truncateQuote(text: string, max: number = MAX_QUOTE_CHARS): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}...`;
}

/** Lines of a text, for rendering a line break between them and not a newline inside a run. */
export function splitLines(text: string): string[] {
  return text.split("\n");
}

/**
 * Identifiers go into error messages, which must never quote a document. An id that does not look
 * like an id is replaced, so a hostile value in an id position cannot get into a message either.
 */
export function printableId(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(value)
    ? value
    : "(unprintable id)";
}
