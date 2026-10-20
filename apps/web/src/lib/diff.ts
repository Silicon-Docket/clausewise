/**
 * A word-level diff for showing a suggested edit inside its paragraph. Written here because the
 * app takes no dependency for it, and because the rules are the ones a reader of a contract needs:
 * whole words (never half a word), runs of changed words shown as one removal and one addition
 * instead of a scatter of single words, and a hard limit on the work so that a pathological
 * paragraph can never freeze the page.
 */

export type DiffKind = "equal" | "delete" | "insert";

export interface DiffPart {
  kind: DiffKind;
  text: string;
}

export interface DiffResult {
  parts: DiffPart[];
  /**
   * True when the texts were too different or too long to compare word by word within the work
   * limit, and the changed middle was shown as one removal and one addition. The parts are still
   * correct: they rebuild both texts exactly.
   */
  approximate: boolean;
}

export interface DiffOptions {
  /** The most cells of the comparison table to fill. Beyond it the diff falls back. */
  maxCells?: number;
}

/** About 8 MB of table, and a paragraph of 2,000 words against another of 2,000 fits. */
export const DEFAULT_MAX_CELLS = 4_000_000;

// A larger request is cut back to this: the table's entries are 16 bits wide, which is enough
// while the shorter text has fewer than 65,536 tokens, and this limit keeps it far below that.
const HARD_MAX_CELLS = 16_000_000;

// A word is a run of letters, digits and marks. Every other visible character is a token of its
// own, so that "(3)" and "3" differ by two brackets and not by a whole word, and a run of spaces is
// one token so that spacing changes are visible but cheap.
const TOKEN = /[\p{L}\p{N}\p{M}_]+|\s+|[^\s\p{L}\p{N}\p{M}_]/gu;

export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

const isBlank = (text: string): boolean => /^\s*$/u.test(text);

export function diffWords(before: string, after: string, options: DiffOptions = {}): DiffResult {
  if (before === after) {
    return { parts: before === "" ? [] : [{ kind: "equal", text: before }], approximate: false };
  }
  const a = tokenize(before);
  const b = tokenize(after);

  // Most edits touch a few words in the middle of a paragraph. Trimming what the two share at
  // both ends keeps the table small for them.
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
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const raw: DiffPart[] = [];
  if (head > 0) raw.push({ kind: "equal", text: a.slice(0, head).join("") });

  let approximate = false;
  const maxCells = Math.min(options.maxCells ?? DEFAULT_MAX_CELLS, HARD_MAX_CELLS);
  if (midA.length === 0 || midB.length === 0 || (midA.length + 1) * (midB.length + 1) <= maxCells) {
    raw.push(...compare(midA, midB));
  } else {
    approximate = true;
    raw.push({ kind: "delete", text: midA.join("") }, { kind: "insert", text: midB.join("") });
  }

  if (tail > 0) raw.push({ kind: "equal", text: a.slice(a.length - tail).join("") });
  return { parts: tidy(raw), approximate };
}

// The longest common subsequence of two token lists, as a walk from the start. The table holds,
// for each pair of positions, the length of the best match of what follows; a Uint16Array is
// enough because that length cannot exceed the shorter list, which the cell limit keeps small.
function compare(a: string[], b: string[]): DiffPart[] {
  const parts: DiffPart[] = [];
  const push = (kind: DiffKind, text: string): void => {
    const last = parts[parts.length - 1];
    if (last !== undefined && last.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };
  if (a.length === 0 || b.length === 0) {
    if (a.length > 0) push("delete", a.join(""));
    if (b.length > 0) push("insert", b.join(""));
    return parts;
  }

  const width = b.length + 1;
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("equal", a[i] ?? "");
      i++;
      j++;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      push("delete", a[i] ?? "");
      i++;
    } else {
      push("insert", b[j] ?? "");
      j++;
    }
  }
  if (i < a.length) push("delete", a.slice(i).join(""));
  if (j < b.length) push("insert", b.slice(j).join(""));
  return parts;
}

// Reads better for a lawyer: between two changes, a gap of nothing but spaces is not worth
// showing as unchanged, so the two changes become one. Then each run of changes is written as the
// removal first and the addition after it.
function tidy(parts: DiffPart[]): DiffPart[] {
  // Group into alternating blocks of equal text and changes.
  type Block = { equal: string } | { del: string; ins: string };
  const blocks: Block[] = [];
  for (const part of parts) {
    if (part.kind === "equal") {
      const last = blocks[blocks.length - 1];
      if (last !== undefined && "equal" in last) last.equal += part.text;
      else blocks.push({ equal: part.text });
    } else {
      let last = blocks[blocks.length - 1];
      if (last === undefined || "equal" in last) {
        last = { del: "", ins: "" };
        blocks.push(last);
      }
      if (part.kind === "delete") last.del += part.text;
      else last.ins += part.text;
    }
  }

  const merged: Block[] = [];
  for (const block of blocks) {
    const last = merged[merged.length - 1];
    const beforeLast = merged[merged.length - 2];
    if (
      "del" in block &&
      last !== undefined &&
      "equal" in last &&
      isBlank(last.equal) &&
      beforeLast !== undefined &&
      "del" in beforeLast
    ) {
      merged.pop();
      beforeLast.del += last.equal + block.del;
      beforeLast.ins += last.equal + block.ins;
    } else {
      merged.push(block);
    }
  }

  const out: DiffPart[] = [];
  for (const block of merged) {
    if ("equal" in block) {
      if (block.equal !== "") out.push({ kind: "equal", text: block.equal });
    } else {
      if (block.del !== "") out.push({ kind: "delete", text: block.del });
      if (block.ins !== "") out.push({ kind: "insert", text: block.ins });
    }
  }
  return out;
}
