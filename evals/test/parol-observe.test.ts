import { describe, expect, it } from "vitest";
import type {
  DraftFinding,
  ExtractOutput,
  SourceSpan,
  VerifiedFinding,
} from "../../apps/parol/src/contracts.js";
import { observeExtraction, observeSlot } from "../src/parol/observe.js";

const span = (id: string, text: string): SourceSpan => ({
  id,
  label: `D1-${id}`,
  modelLabel: "c1",
  documentVersionId: "dv",
  docLabel: "D1",
  paragraphIndex: 0,
  clauseId: "c1",
  clauseNumber: "6.1",
  heading: null,
  text,
  textSha256: "0".repeat(64),
});
const spans = [
  span("dv:p0", "The obligations continue for two years."),
  span("dv:p1", "Other words."),
];

const finding = (over: Partial<VerifiedFinding> = {}): VerifiedFinding => ({
  ruleKey: "dur-1",
  category: "duration",
  severity: "high",
  status: "deviation",
  evidence: [
    {
      spanId: "dv:p0",
      quote: "continue for two years",
      role: "governing",
      quoteCheck: "verified",
      offsets: { start: 16, end: 38 },
      supportCheck: "not_run",
    },
    {
      spanId: "dv:p1",
      quote: "not in the span",
      role: "supporting",
      quoteCheck: "not_found",
      offsets: null,
      supportCheck: "not_run",
    },
  ],
  discrepancy: "",
  explanation: "",
  fallbackLanguage: null,
  fallbackBasis: "none",
  conflict: null,
  abstainReason: null,
  checks: [],
  escalations: [{ code: "quote_not_verified", detail: "evidence 2 (D1-p1)" }],
  verificationState: "escalated_by_system",
  contentSha256: "1".repeat(64),
  ...over,
});

const draft = (evidence: DraftFinding["evidence"]): DraftFinding => ({
  ruleKey: "dur-1",
  status: "deviation",
  evidence,
  discrepancy: "",
  explanation: "",
  fallbackLanguage: null,
  escalateWhenMatched: [],
  conflict: null,
  abstainReason: null,
});

describe("observeSlot", () => {
  const given = [
    { spanId: "dv:p0", quote: "continue for two years", role: "governing" as const },
    { spanId: "dv:p0", quote: "continue for two years", role: "supporting" as const },
    { spanId: "dv:p1", quote: "not in the span", role: "supporting" as const },
    { spanId: "dv:nope", quote: "anything", role: "supporting" as const },
  ];

  it("reads the status, the state, the evidence and the escalation codes off the finding", () => {
    const slot = observeSlot({
      caseKey: "PAROL-X",
      repeat: 2,
      finding: finding(),
      draft: draft(given),
      spans,
    });
    expect(slot).toMatchObject({
      caseKey: "PAROL-X",
      ruleKey: "dur-1",
      repeat: 2,
      status: "deviation",
      verificationState: "escalated_by_system",
      escalationCodes: ["quote_not_verified"],
    });
    expect(slot.evidence).toEqual([
      { spanId: "dv:p0", role: "governing", quoteCheck: "verified", displayed: true },
      { spanId: "dv:p1", role: "supporting", quoteCheck: "not_found", displayed: false },
    ]);
  });

  it("counts the model's quotes against the run's spans, not against what verification kept", () => {
    const slot = observeSlot({
      caseKey: "c",
      repeat: 1,
      finding: finding(),
      draft: draft(given),
      spans,
    });
    // Four emitted. The first two occur in their span (a repeated passage is a good quote), the
    // third is not in its span, and the fourth names a span the run does not have.
    expect(slot.modelQuotes).toEqual({ emitted: 4, valid: 2 });
  });

  it("reports nothing emitted for a rule that was not analysed", () => {
    const slot = observeSlot({
      caseKey: "c",
      repeat: 1,
      finding: finding({ status: "undetermined", evidence: [], escalations: [] }),
      draft: undefined,
      spans,
    });
    expect(slot.modelQuotes).toEqual({ emitted: 0, valid: 0 });
    expect(slot.evidence).toEqual([]);
  });

  it("carries no text of the documents", () => {
    const slot = observeSlot({
      caseKey: "c",
      repeat: 1,
      finding: finding(),
      draft: draft(given),
      spans,
    });
    expect(JSON.stringify(slot)).not.toContain("obligations");
    expect(JSON.stringify(slot)).not.toContain("continue for");
  });
});

describe("observeExtraction", () => {
  const output = (quoteCheck: "verified" | "not_found"): ExtractOutput => ({
    categories: {
      parties: { located: [], notFound: true, notFoundReason: "none", hintSpans: [] },
      "ci-definition": { located: [], notFound: true, notFoundReason: null, hintSpans: [] },
      exclusions: { located: [], notFound: true, notFoundReason: null, hintSpans: [] },
      "permitted-disclosures": { located: [], notFound: true, notFoundReason: null, hintSpans: [] },
      duration: {
        located: [{ spanId: "dv:p0", quote: "q", quoteCheck }],
        notFound: false,
        notFoundReason: null,
        hintSpans: ["dv:p1"],
      },
      "return-destruction": { located: [], notFound: true, notFoundReason: null, hintSpans: [] },
      "governing-law": { located: [], notFound: true, notFoundReason: null, hintSpans: [] },
    },
    degraded: false,
  });

  it("lists the spans located per category, and whether the category was found", () => {
    const observed = observeExtraction({ caseKey: "c", repeat: 3, extract: output("verified") });
    expect(observed).toMatchObject({ caseKey: "c", repeat: 3, degraded: false });
    expect(observed.categories["duration"]).toEqual({ located: ["dv:p0"], notFound: false });
    expect(observed.categories["parties"]).toEqual({ located: [], notFound: true });
    expect(Object.keys(observed.categories)).toHaveLength(7);
  });

  it("does not credit a pointer whose quote was not found", () => {
    const observed = observeExtraction({ caseKey: "c", repeat: 1, extract: output("not_found") });
    expect(observed.categories["duration"]!.located).toEqual([]);
  });

  it("passes the degraded flag on", () => {
    const degraded = { ...output("verified"), degraded: true };
    expect(observeExtraction({ caseKey: "c", repeat: 1, extract: degraded }).degraded).toBe(true);
  });
});
