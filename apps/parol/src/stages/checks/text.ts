import { normalizeForAnchor } from "@clausewise/review";

/**
 * Small text helpers shared by the verify checks. Nothing here keeps or returns more of a text
 * than a caller asks for, and every scan is linear, because the strings come from a model.
 */

/** The comparison form of a name or a phrase: quotes and dashes folded, spaces collapsed, lower case. */
export const fold = (text: string): string => normalizeForAnchor(text).trim().toLowerCase();

// A NUL, which the store refuses, and a surrogate with no partner, which JSON writes as an escape
// but a database stores as the replacement character. Left in, the first fails the whole run for
// one rule's answer, and the second changes the text between the hash taken when the finding is
// made and the hash taken when the memo is exported, so the finding could never be exported.
const UNCARRIABLE =
  /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Text from a model in a form the store and the hashes carry unchanged: a NUL and a lone surrogate
 * become U+FFFD, which a reader sees as a replacement mark. Everything else is left as it is.
 */
export const carriable = (text: string): string => text.replace(UNCARRIABLE, "\ufffd");

export const asText = (value: unknown): string =>
  typeof value === "string" ? carriable(value) : "";

/** A string, or null for anything else. A blank string is null too: it says nothing. */
export const asTextOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? carriable(value) : null;

/** First `max` UTF-16 units. Callers use it only on text they will not compare afterwards. */
export const clip = (text: string, max: number): string =>
  text.length > max ? text.slice(0, max) : text;

/** The longest detail a check or an escalation may hold. A detail is ids and counts, so this is generous. */
export const DETAIL_LIMIT = 700;

/** Cuts a detail to `DETAIL_LIMIT`, marking the cut, so that no input can make a detail long. */
export const clipDetail = (text: string): string =>
  text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT - 3)}...` : text;

/** `a`, `a and b`, `a, b and c`. */
export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Names the first few and counts the rest, so a detail stays short whatever the input. */
export function listCapped(items: readonly string[], shown = 8): string {
  if (items.length <= shown) return listOf(items);
  return `${items.slice(0, shown).join(", ")} and ${items.length - shown} more`;
}

const WORDS = /[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)?/gu;

/** Lower-case word tokens, with quotes folded so "Party's" is one token whichever apostrophe it has. */
export function wordTokens(text: string): string[] {
  return normalizeForAnchor(text).toLowerCase().match(WORDS) ?? [];
}

/**
 * Dice coefficient over multisets of tokens: twice the tokens the two share, divided by the total
 * number of tokens. One for the same words in any order and zero for no word in common. It is
 * linear, order-blind and symmetric. Order-blind is acceptable here because the question is only
 * whether text was derived from approved wording, and a reordering that keeps every word is still
 * that wording; the reviewer sees the label and the text.
 */
export function dice(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const token of a) counts.set(token, (counts.get(token) ?? 0) + 1);
  let shared = 0;
  for (const token of b) {
    const left = counts.get(token) ?? 0;
    if (left > 0) {
      shared++;
      counts.set(token, left - 1);
    }
  }
  return (2 * shared) / (a.length + b.length);
}

/** Two decimals, with no locale involved. */
export const ratio = (value: number): string => (Math.round(value * 100) / 100).toFixed(2);
