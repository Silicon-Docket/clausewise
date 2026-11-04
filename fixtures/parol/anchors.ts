/**
 * How an anchor is matched to text. The builder uses it on the text it generates, and the
 * evaluation resolver uses it on the spans of a run, so the two cannot disagree about what
 * "occurs exactly once" means.
 */

/**
 * Occurrences of `needle` in `text`, overlapping ones included, so that a short anchor that
 * could match twice inside a longer repeated word is not mistaken for a unique one. Matching is
 * exact and case sensitive: an anchor is copied from the document, not remembered.
 */
export function countOccurrences(text: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let from = text.indexOf(needle);
  while (from !== -1) {
    count += 1;
    from = text.indexOf(needle, from + 1);
  }
  return count;
}
