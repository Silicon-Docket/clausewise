import { describe, expect, it } from "vitest";
import { findingContentSha256, hashOf } from "../src/canonical.js";

/**
 * The hash a decision is bound to. A finding that code did not change must hash exactly as it did
 * before status settlement existed, because decisions already stored carry the old hashes; the
 * status the workflow stated joins the hash only when it is set.
 */

const FINDING = {
  ruleKey: "dur-1",
  status: "deviation",
  discrepancy: "The term is longer than the standard allows.",
  explanation: "Section 4 states a term of five years.",
  fallbackLanguage: "The obligations shall continue for three (3) years.",
  fallbackBasis: "approved_adapted",
  conflict: null,
  evidence: [
    {
      spanId: "dv_a:p4",
      quote: "shall continue for five (5) years",
      role: "governing" as const,
      quoteCheck: "verified" as const,
      supportCheck: "not_run" as const,
    },
  ],
  escalations: [{ code: "playbook_escalation" as const, detail: "over-five-years" }],
};

const MISSING = {
  ...FINDING,
  status: "missing",
  evidence: [],
  escalations: [],
  discrepancy: "",
  fallbackLanguage: null,
  fallbackBasis: "none",
  explanation: "Nothing covers the topic.",
};

// Computed by the code of canonical.ts as it was before the model status joined the hash.
const GOLDEN_DEVIATION = "4df9a7aeb49f5a5e08f5f2b99ad8e5e106716d8c13e417c0dc6cecb9e7c718d5";
const GOLDEN_MISSING = "a2b0aee1b59ed79245fed747d9b1bc7d43894b73f3d5aa9bc3a092ce3f1a39ff";

describe("findingContentSha256", () => {
  it("is unchanged for a finding that code did not change", () => {
    expect(findingContentSha256(FINDING)).toBe(GOLDEN_DEVIATION);
    expect(findingContentSha256(MISSING)).toBe(GOLDEN_MISSING);
  });

  it("treats an absent model status and a null one as the same, and as no status at all", () => {
    expect(findingContentSha256({ ...FINDING, modelStatus: null })).toBe(GOLDEN_DEVIATION);
    expect(findingContentSha256({ ...FINDING, modelStatus: undefined })).toBe(GOLDEN_DEVIATION);
  });

  it("changes when a model status is set, and with the status it is", () => {
    const withMissing = findingContentSha256({
      ...MISSING,
      status: "not_applicable",
      modelStatus: "missing",
    });
    const without = findingContentSha256({ ...MISSING, status: "not_applicable" });
    const other = findingContentSha256({
      ...MISSING,
      status: "not_applicable",
      modelStatus: "compliant",
    });
    expect(new Set([withMissing, without, other]).size).toBe(3);
    expect(withMissing).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes the model status as one more member of the hashed object, nothing else", () => {
    const settled = { ...MISSING, status: "not_applicable", modelStatus: "missing" };
    expect(findingContentSha256(settled)).toBe(
      hashOf({
        ruleKey: settled.ruleKey,
        status: settled.status,
        discrepancy: settled.discrepancy,
        explanation: settled.explanation,
        fallbackLanguage: settled.fallbackLanguage,
        fallbackBasis: settled.fallbackBasis,
        conflict: settled.conflict,
        evidence: [],
        escalations: [],
        modelStatus: "missing",
      }),
    );
  });
});
