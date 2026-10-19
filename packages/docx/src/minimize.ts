const TOKEN = /\s+|\S+/g;

/**
 * Trims the words an edit leaves unchanged off both ends, so a redline shows
 * "three (3)" struck and "two (2)" inserted instead of the whole sentence replaced.
 * `offset` is how far the trimmed edit starts after the original start.
 */
export function trimEdit(
  original: string,
  replacement: string,
): { offset: number; removed: string; inserted: string } {
  const a = original.match(TOKEN) ?? [];
  const b = replacement.match(TOKEN) ?? [];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  return {
    offset: a.slice(0, head).join("").length,
    removed: a.slice(head, a.length - tail).join(""),
    inserted: b.slice(head, b.length - tail).join(""),
  };
}
