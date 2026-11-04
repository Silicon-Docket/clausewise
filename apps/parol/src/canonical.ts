import { createHash } from "node:crypto";
import type { Escalation, VerifiedEvidence } from "./contracts.js";

export const sha256Hex = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

/**
 * JSON with sorted keys and no white space, so that equal values always hash alike. `undefined`
 * object members are left out, as `JSON.stringify` does. Anything that is not JSON (a function, a
 * bigint, a non-finite number) is refused, because a hash over a silently changed value would let
 * two different inputs look the same.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value))
        return `[${value.map((item) => canonicalJson(item ?? null)).join(",")}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: cannot serialise a ${typeof value}`);
  }
}

export const hashOf = (value: unknown): string => sha256Hex(canonicalJson(value));

/**
 * What a reviewer saw when they decided: status, texts, evidence and escalations. Check details
 * and offsets are left out because they are derived from these. A review is bound to this hash, so
 * a changed finding is never silently covered by an old decision.
 */
export function findingContentSha256(finding: {
  ruleKey: string;
  status: string;
  discrepancy: string;
  explanation: string;
  fallbackLanguage: string | null;
  fallbackBasis: string;
  conflict: string | null;
  evidence: Pick<VerifiedEvidence, "spanId" | "quote" | "role" | "quoteCheck" | "supportCheck">[];
  escalations: Escalation[];
}): string {
  return hashOf({
    ruleKey: finding.ruleKey,
    status: finding.status,
    discrepancy: finding.discrepancy,
    explanation: finding.explanation,
    fallbackLanguage: finding.fallbackLanguage,
    fallbackBasis: finding.fallbackBasis,
    conflict: finding.conflict,
    evidence: finding.evidence.map((e) => ({
      spanId: e.spanId,
      quote: e.quote,
      role: e.role,
      quoteCheck: e.quoteCheck,
      supportCheck: e.supportCheck,
    })),
    escalations: finding.escalations.map((e) => ({ code: e.code, detail: e.detail })),
  });
}
