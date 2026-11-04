import { describe, expect, it } from "vitest";
import type { DocLabel, SourceSpan } from "../../apps/parol/src/contracts.js";
import {
  AnchorResolutionError,
  createResolver,
  findAnchor,
  resolveAnchor,
} from "../src/parol/anchors.js";

let counter = 0;
function span(
  docLabel: DocLabel,
  clauseNumber: string | null,
  text: string,
  id = `dv_${docLabel}:p${counter++}`,
): SourceSpan {
  return {
    id,
    label: `${docLabel}-p${counter}`,
    modelLabel: `c${counter}`,
    documentVersionId: `dv_${docLabel}`,
    docLabel,
    paragraphIndex: counter,
    clauseId: "c1",
    clauseNumber,
    heading: null,
    text,
    textSha256: "0".repeat(64),
  };
}

const spans: SourceSpan[] = [
  span("D1", null, "Preamble naming Alpha Inc. and Beta LLC", "d1-preamble"),
  span("D1", "6.1", "6.1 Obligations continue for two (2) years.", "d1-6.1"),
  span("D1", "6.2", "6.2 Either Party may terminate on notice.", "d1-6.2"),
  span("D1", "7.2", "7.2 Return within ten (10) business days. Return again.", "d1-7.2"),
  span("D1", "7.2", "(a) a lettered item of 7.2 about backup copies", "d1-7.2a"),
  span("D2", "2", "2. Section 6.1 of the Agreement is deleted.", "d2-2"),
  span("D2", "6.1", "6.1 A clause numbered like the NDA's, in the amendment.", "d2-6.1"),
  span("D2", null, "Amendment preamble naming Alpha Inc.", "d2-preamble"),
];

describe("resolveAnchor", () => {
  it("finds the span by document label, clause number and the words in its text", () => {
    expect(resolveAnchor(spans, { doc: "D1", clause: "6.1", anchor: "two (2) years" })).toBe(
      "d1-6.1",
    );
    expect(resolveAnchor(spans, { doc: "D2", clause: "2", anchor: "is deleted" })).toBe("d2-2");
  });

  it("tells two documents apart by label, even when a clause number repeats", () => {
    expect(resolveAnchor(spans, { doc: "D1", clause: "6.1", anchor: "Obligations" })).toBe(
      "d1-6.1",
    );
    expect(resolveAnchor(spans, { doc: "D2", clause: "6.1", anchor: "amendment" })).toBe("d2-6.1");
    // The words are in D1 clause 6.1 only, so naming D2 for them finds nothing.
    expect(() => resolveAnchor(spans, { doc: "D2", clause: "6.1", anchor: "Obligations" })).toThrow(
      AnchorResolutionError,
    );
  });

  it("finds the paragraph of a clause that holds the words when the clause has several", () => {
    expect(resolveAnchor(spans, { doc: "D1", clause: "7.2", anchor: "backup copies" })).toBe(
      "d1-7.2a",
    );
    expect(resolveAnchor(spans, { doc: "D1", clause: "7.2", anchor: "ten (10) business" })).toBe(
      "d1-7.2",
    );
  });

  it("matches a null clause only with spans that have no clause number", () => {
    expect(resolveAnchor(spans, { doc: "D1", clause: null, anchor: "Beta LLC" })).toBe(
      "d1-preamble",
    );
    expect(() =>
      resolveAnchor(spans, { doc: "D1", clause: null, anchor: "two (2) years" }),
    ).toThrow("it occurs 0 times");
    expect(() => resolveAnchor(spans, { doc: "D1", clause: "6.1", anchor: "Beta LLC" })).toThrow(
      "it occurs 0 times",
    );
  });

  it("is exact and case sensitive", () => {
    expect(() =>
      resolveAnchor(spans, { doc: "D1", clause: "6.1", anchor: "TWO (2) YEARS" }),
    ).toThrow(AnchorResolutionError);
    expect(() =>
      resolveAnchor(spans, { doc: "D1", clause: "6.1", anchor: "two  (2) years" }),
    ).toThrow(AnchorResolutionError);
  });

  it("refuses a second occurrence in the same span, and one in a second span of the clause", () => {
    expect(() => resolveAnchor(spans, { doc: "D1", clause: "7.2", anchor: "Return" })).toThrow(
      "it occurs 2 times, expected once",
    );
    expect(() =>
      resolveAnchor(spans, { doc: "D1", clause: "7.2", anchor: "of 7.2" }),
    ).not.toThrow();
    const clashing = [
      ...spans,
      span("D1", "7.2", "(b) another item about backup copies", "d1-7.2b"),
    ];
    expect(() =>
      resolveAnchor(clashing, { doc: "D1", clause: "7.2", anchor: "backup copies" }),
    ).toThrow("it occurs 2 times, expected once");
  });

  it("counts overlapping occurrences", () => {
    const overlap = [span("D1", "1", "1. aaa", "x")];
    expect(() => resolveAnchor(overlap, { doc: "D1", clause: "1", anchor: "aa" })).toThrow(
      "it occurs 2 times",
    );
  });

  it("says what is missing: the document, the clause, or the words", () => {
    expect(() => resolveAnchor(spans, { doc: "D3", clause: "1", anchor: "x" })).toThrow(
      "the run has no such document",
    );
    expect(() => resolveAnchor(spans, { doc: "D1", clause: "99", anchor: "x" })).toThrow(
      "the run has no span there",
    );
    expect(() => resolveAnchor(spans, { doc: "D1", clause: "6.1", anchor: "x" })).toThrow(
      "it occurs 0 times, expected once",
    );
  });

  it("finds nothing for an empty anchor, which would otherwise match everywhere", () => {
    expect(() => resolveAnchor(spans, { doc: "D1", clause: "6.1", anchor: "" })).toThrow(
      "it occurs 0 times",
    );
  });

  it("never repeats the anchor or the text of a span in its message", () => {
    const secret = "unmistakable anchor words";
    const attempts = [
      () => resolveAnchor(spans, { doc: "D1", clause: "6.1", anchor: secret }, "PAROL-D05"),
      () => resolveAnchor(spans, { doc: "D1", clause: "7.2", anchor: "Return" }, "PAROL-D05"),
      () => resolveAnchor(spans, { doc: "D1", clause: "42", anchor: secret }, "PAROL-D05"),
      () => resolveAnchor(spans, { doc: "D3", clause: null, anchor: secret }, "PAROL-D05"),
    ];
    for (const attempt of attempts) {
      let message = "";
      try {
        attempt();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/^anchor in PAROL-D05 D/);
      expect(message).not.toContain(secret);
      expect(message).not.toContain("Obligations");
      expect(message).not.toContain("Return within");
    }
  });
});

describe("findAnchor", () => {
  it("returns the span, or the reason and how many times the words occur", () => {
    const found = findAnchor(spans, { doc: "D1", clause: "6.2", anchor: "terminate" });
    expect(found.ok && found.span.id).toBe("d1-6.2");
    expect(findAnchor(spans, { doc: "D1", clause: "7.2", anchor: "Return" })).toEqual({
      ok: false,
      reason: "ambiguous",
      occurrences: 2,
    });
    expect(findAnchor(spans, { doc: "D1", clause: "6.2", anchor: "nothing" })).toEqual({
      ok: false,
      reason: "not_found",
      occurrences: 0,
    });
    expect(findAnchor(spans, { doc: "D1", clause: "5", anchor: "x" })).toEqual({
      ok: false,
      reason: "no_clause",
      occurrences: 0,
    });
    expect(findAnchor([], { doc: "D1", clause: "5", anchor: "x" })).toEqual({
      ok: false,
      reason: "no_document",
      occurrences: 0,
    });
  });
});

describe("createResolver", () => {
  const other = [span("D1", "6.1", "6.1 Obligations continue for two (2) years.", "other-d1-6.1")];
  const resolve = createResolver({ "PAROL-D05": spans, "PAROL-D01": other });

  it("resolves in the spans of the named case, so the same words give each run's own ids", () => {
    const ref = { doc: "D1" as const, clause: "6.1", anchor: "two (2) years" };
    expect(resolve("PAROL-D05", ref)).toBe("d1-6.1");
    expect(resolve("PAROL-D01", ref)).toBe("other-d1-6.1");
  });

  it("fails for a case the run has no spans for, with the case in the message", () => {
    expect(() => resolve("PAROL-D99", { doc: "D1", clause: "6.1", anchor: "x" })).toThrow(
      "anchor in PAROL-D99: the run has no spans for the case",
    );
  });

  it("names the case when an anchor no longer resolves", () => {
    expect(() => resolve("PAROL-D01", { doc: "D1", clause: "6.1", anchor: "five years" })).toThrow(
      "anchor in PAROL-D01 D1 clause 6.1: it occurs 0 times, expected once",
    );
  });
});
