import { describe, expect, it } from "vitest";
import { findingContentSha256 } from "../../src/canonical.js";
import { carriable } from "../../src/stages/checks/text.js";
import { QUOTE_TERM, check, cite, draft, spanOf, verify, workedExample } from "./support-verify.js";

const ingest = workedExample();
const NUL = "\u0000";
const LONE_HIGH = "\ud800";
const LONE_LOW = "\udc00";

describe("carriable", () => {
  it.each([
    ["a NUL", `a${NUL}b`, "a�b"],
    ["a lone high surrogate", `a${LONE_HIGH}b`, "a�b"],
    ["a lone low surrogate", `a${LONE_LOW}b`, "a�b"],
    ["a high surrogate that ends the text", `a${LONE_HIGH}`, "a�"],
    ["two high surrogates, then a pair", `${LONE_HIGH}😀`, "�😀"],
    ["each of several", `${NUL}${LONE_LOW}${LONE_HIGH}`, "���"],
  ])("replaces %s", (_name, text, expected) => {
    expect(carriable(text)).toBe(expected);
  });

  it("leaves a well-formed text, a pair and other control characters alone", () => {
    for (const text of ["", "plain", "😀 emoji", "tab\tand\nline", "\u0001\u001f", "￿"]) {
      expect(carriable(text)).toBe(text);
    }
  });
});

describe("a finding built from text with characters the store cannot carry", () => {
  it("holds none of them in any field, and its hash is that of what it holds", async () => {
    const hostile = `ZQ ${NUL} a ${LONE_HIGH} b ${LONE_LOW}`;
    const { finding } = await verify(
      draft({
        status: "deviation",
        evidence: [cite(ingest, "D1-p19", QUOTE_TERM, "governing")],
        discrepancy: hostile,
        explanation: hostile,
        fallbackLanguage: hostile,
        conflict: hostile,
        abstainReason: hostile,
      }),
    );
    const fields = [
      finding.discrepancy,
      finding.explanation,
      finding.fallbackLanguage,
      finding.conflict,
      finding.abstainReason,
    ];
    for (const field of fields) {
      expect(field).toBe("ZQ � a � b �");
    }
    expect(findingContentSha256(finding)).toBe(finding.contentSha256);
  });

  it("keeps a quote with a NUL from verifying, and stores it without the NUL", async () => {
    const quote = QUOTE_TERM.replace("two (2)", `two${NUL}(2)`);
    const { finding } = await verify(
      draft({ status: "compliant", evidence: [cite(ingest, "D1-p19", quote, "governing")] }),
    );
    expect(finding.evidence[0]!.quoteCheck).toBe("not_found");
    expect(finding.evidence[0]!.quote).toContain("�");
    expect(finding.evidence[0]!.quote).not.toContain(NUL);
    expect(check(finding, "quote_exists").outcome).toBe("fail");
    expect(spanOf(ingest, "D1-p19").text).not.toContain("�");
  });
});
