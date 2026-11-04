/**
 * What a reader sees as nothing, in one place so that the text file reader, the upload check and
 * span building agree on it.
 *
 * The set is every default-ignorable code point (soft hyphen, zero-width space, joiners and
 * direction marks, the word joiner and invisible operators, variation selectors, the combining
 * grapheme joiner, the Hangul fillers, tag characters), every other format character, the control
 * characters that are not tab or line breaks, and three blanks that Unicode does not class as
 * ignorable: the Braille blank (U+2800), the object replacement character (U+FFFC) and the Hangul
 * filler forms (U+3164, U+FFA0). White space is separate: a paragraph of only white space and
 * these characters has no visible text.
 *
 * This is wider than the set the quote anchor in @clausewise/review deletes, on purpose. The
 * anchor only needs to ignore characters that Word inserts inside words; this decides whether a
 * paragraph or a whole file has anything to read, and a file of direction marks must not pass.
 * Characters the set misses (a letter that looks blank in some font) are not detectable here.
 */
const INVISIBLE_CLASS =
  "\\p{Default_Ignorable_Code_Point}\\p{Cf}\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u2800\\ufffc\\u3164\\uffa0";

const INVISIBLE_RUN = new RegExp(`[${INVISIBLE_CLASS}]+`, "gu");
const NOTHING_VISIBLE = new RegExp(`^[\\s${INVISIBLE_CLASS}]*$`, "u");

/** The text with its invisible characters taken out. White space stays. */
export const withoutInvisible = (text: string): string => text.replace(INVISIBLE_RUN, "");

/** Whether `text` is empty, white space, invisible characters, or any mix of them. */
export const hasNoVisibleText = (text: string): boolean => NOTHING_VISIBLE.test(text);
