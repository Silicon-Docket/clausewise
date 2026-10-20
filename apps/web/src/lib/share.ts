import type { ReviewDetail } from "@clausewise/api";

/**
 * Keeping what did not change. Every read of a review gives new objects, equal in content to the
 * ones before when nothing happened. Handing those to the screen as they are would draw every
 * finding again, with its long clause texts, for a poll that learned nothing. These functions give
 * back the objects the screen already holds wherever the content is the same, so that React can
 * see that nothing changed and skip the work.
 */

/** Whether two values read from JSON hold the same content. Identical objects are equal at once. */
export function isSameJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item: unknown, index) => isSameJson(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => key in right && isSameJson(left[key], right[key]));
}

/**
 * `next` with every part that equals the same part of `previous` replaced by `previous`'s own
 * object: the whole review when nothing changed, else the findings that did not change, and the
 * list of findings itself when none did.
 */
export function shareUnchanged(previous: ReviewDetail | null, next: ReviewDetail): ReviewDetail {
  if (previous === null) return next;

  const before = new Map(previous.findings.map((finding) => [finding.ruleId, finding]));
  let sameList = previous.findings.length === next.findings.length;
  const findings = next.findings.map((finding, index) => {
    const known = before.get(finding.ruleId);
    const kept = known !== undefined && isSameJson(known, finding) ? known : finding;
    if (kept !== previous.findings[index]) sameList = false;
    return kept;
  });

  const merged: ReviewDetail = { ...next, findings: sameList ? previous.findings : findings };
  return isSameJson(previous, merged) ? previous : merged;
}
