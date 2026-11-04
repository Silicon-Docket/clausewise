import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildIngest } from "../../src/ingest/ingest.js";
import { parseDocument } from "../../src/ingest/parse.js";
import { findTermUses, isDefined } from "../../src/stages/checks/terms.js";
import { verifyFinding } from "../../src/stages/verify.js";
import {
  bundle,
  check,
  codes,
  draft,
  ingestOf,
  manifest,
  rule,
  spanOf,
  define,
} from "./support-verify.js";

const termsIn = (text: string, client = "Lanternfish Software, Inc."): string[] =>
  findTermUses(text, client).map((use) => use.folded);

describe("which phrases read as defined terms", () => {
  it("finds a capitalised phrase that ends in a head word", () => {
    expect(
      termsIn("The exclusions apply to Proprietary Information received by the recipient."),
    ).toEqual(["proprietary information"]);
    expect(termsIn("shall protect the Receiving Party and its Representatives")).toEqual([
      "receiving party",
      "representatives",
    ]);
  });

  it("reports where in the text the phrase is, and never the phrase", () => {
    const text = "applies to Proprietary Information received";
    const [use] = findTermUses(text, "Client Inc.");
    expect(text.slice(use!.start, use!.end)).toBe("Proprietary Information");
  });

  it("ends a phrase at a possessive", () => {
    expect(termsIn("the Disclosing Party's Confidential Information")).toEqual([
      "disclosing party",
      "confidential information",
    ]);
  });

  it("does not read a word that is capitalised only because it opens a sentence", () => {
    expect(termsIn("Information that is public is excluded.")).toEqual([]);
    expect(termsIn("It is excluded. Data that is public is not covered.")).toEqual([]);
  });

  it("drops an opening word like Each or The and keeps the term after it", () => {
    expect(termsIn("Each Party shall keep it secret.")).toEqual(["party"]);
    expect(termsIn("The Receiving Party shall keep it secret.")).toEqual(["receiving party"]);
  });

  it("keeps a sentence-opening phrase of two words, which a capital alone cannot explain", () => {
    expect(termsIn("Proprietary Information is excluded.")).toEqual(["proprietary information"]);
  });

  it("reads a quote that is only a phrase as a heading and says nothing about it", () => {
    expect(termsIn("4. Compelled Disclosure")).toEqual([]);
    expect(termsIn("Confidential Information")).toEqual([]);
    expect(termsIn("(a) Permitted Disclosure;")).toEqual([]);
  });

  it("ends a phrase at a hyphen, so a hyphenated compound is never part of a term", () => {
    expect(termsIn("this Mutual Non-Disclosure Agreement applies")).toEqual(["agreement"]);
  });

  it("leaves out section references", () => {
    expect(termsIn("as set out in Schedule Information and in Article Records")).toEqual([]);
  });

  it("leaves out places", () => {
    expect(termsIn("under the law of the State of Delaware Property Records")).toEqual([]);
  });

  it("leaves out a party name followed by a company suffix, and the client's own name", () => {
    expect(termsIn("between Tailspin Data, Inc. and Corvane Records LLC")).toEqual([]);
    expect(termsIn("between Northwind Data and the other party", "Northwind Data Ltd.")).toEqual(
      [],
    );
  });

  it("reads straight and curly quotes alike", () => {
    expect(
      termsIn("the Receiving Party\u2019s duties and the Disclosing Party\u2019s duties"),
    ).toEqual(["receiving party", "disclosing party"]);
  });

  it("finds nothing in lower case or in capitals", () => {
    expect(termsIn("the receiving party and the CONFIDENTIAL INFORMATION")).toEqual([]);
  });
});

describe("hostile input", () => {
  // A segment that opens with a long run of digits and then a character that is not a digit, a
  // space or a list marker used to make the sentence-start test backtrack exponentially: about four
  // times longer for every two more digits, so a quote of a few dozen digits stalled the server.
  const clock = (run: () => unknown): number => {
    const started = performance.now();
    run();
    return performance.now() - started;
  };

  it("reads a sentence that opens with a long run of digits in linear time", () => {
    for (const lead of ["", "Reference. ", "(a) ", "x; "]) {
      const text = `${lead}${"1".repeat(26)}, Receiving Party shall continue for two (2) years`;
      expect(clock(() => findTermUses(text, "Client Inc."))).toBeLessThan(100);
    }
    const huge = `${"1".repeat(1900)}, Receiving Party shall continue for two (2) years`;
    expect(clock(() => findTermUses(huge, "Client Inc."))).toBeLessThan(500);
  });

  it("keeps its answers for a term that follows digits, list markers or a clause number", () => {
    expect(termsIn("12 (a) Receiving Party shall keep it secret.")).toEqual(["receiving party"]);
    expect(termsIn("2026, the Receiving Party shall keep it secret.")).toEqual(["receiving party"]);
    expect(termsIn("clause 6.1 Receiving Party shall keep it secret.")).toEqual([
      "receiving party",
    ]);
  });

  it("reads a run of digits and punctuation around a bare term as a heading", () => {
    expect(termsIn("12345. Confidential Information;")).toEqual([]);
    expect(termsIn(`${"7".repeat(40)} (b) Receiving Party`)).toEqual([]);
  });
});

describe("which defined terms cover a phrase", () => {
  const defined = ["confidential information", "disclosing party", "receiving party", "agreement"];

  it("accepts the term itself, in singular or plural", () => {
    expect(isDefined("confidential information", defined)).toBe(true);
    expect(isDefined("receiving party", defined)).toBe(true);
    expect(isDefined("receiving parties", defined)).toBe(true);
  });

  it("accepts a phrase that ends in a defined term", () => {
    expect(isDefined("mutual agreement", defined)).toBe(true);
    expect(isDefined("proprietary confidential information", defined)).toBe(true);
  });

  it("accepts a single word that ends a defined term, because it is shorthand for it", () => {
    expect(isDefined("party", defined)).toBe(true);
    expect(isDefined("parties", defined)).toBe(true);
    expect(isDefined("information", defined)).toBe(true);
  });

  it("does not accept a phrase that merely shares a head", () => {
    expect(isDefined("proprietary information", defined)).toBe(false);
    expect(isDefined("purpose", defined)).toBe(false);
    expect(isDefined("party", [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The balanced fixture: a well-drafted NDA must not raise defined_term_unresolved
// ---------------------------------------------------------------------------------------------

const fixture = (name: string): Uint8Array =>
  new Uint8Array(
    readFileSync(fileURLToPath(new URL(`../../../../fixtures/${name}`, import.meta.url))),
  );

describe("fixtures/nda-balanced.docx", async () => {
  const parsed = await parseDocument({ bytes: fixture("nda-balanced.docx"), mediaType: "docx" });
  const ingest = buildIngest({
    documents: [
      {
        documentVersionId: "dv_d1",
        label: "D1",
        kind: "nda",
        title: "Mutual NDA",
        versionNo: 1,
        statedDate: null,
        paragraphs: parsed.paragraphs,
        inspection: parsed.inspection,
      },
    ],
  });
  const defined = [
    ...new Set(
      ingest.annotations
        .filter((a) => a.kind === "defines_term")
        .map((a) => (a as { term: string }).term.toLowerCase()),
    ),
  ];
  const client = "Contoso Software, Inc.";

  it("defines the terms the document uses", () => {
    expect(defined.sort()).toEqual([
      "agreement",
      "confidential information",
      "disclosing party",
      "effective date",
      "purpose",
      "receiving party",
    ]);
  });

  it("raises nothing for any paragraph quoted whole, while still finding the terms it uses", () => {
    let found = 0;
    for (const span of ingest.spans) {
      const uses = findTermUses(span.text, client);
      found += uses.length;
      const open = uses.filter((use) => !isDefined(use.folded, defined));
      expect(
        open.map((u) => u.folded),
        span.label,
      ).toEqual([]);
    }
    // Not vacuous: the fixture uses these terms many times.
    expect(found).toBeGreaterThan(10);
  });

  it("raises nothing through verify for a quote of each paragraph, and catches an undefined term", async () => {
    const r = rule({ key: "exc-1", category: "exclusions" });
    for (const span of ingest.spans) {
      if (span.text.length < 12 || span.text.length > 2000) continue;
      const result = await verifyFinding({
        draft: draft({
          ruleKey: "exc-1",
          status: "compliant",
          evidence: [{ spanId: span.id, quote: span.text, role: "governing" }],
        }),
        bundle: bundle(ingest, [span.label], { rule: r }),
        rule: r,
        ingest,
        manifest: manifest({ clientLegalName: client }),
        enabledChecks: ["C1"],
      });
      expect(check(result.finding, "defined_term").outcome, span.label).not.toBe("fail");
    }

    // A control: the same exclusion clause with a term the document never defines.
    const exclusion = ingest.spans.find((s) => s.clauseNumber === "2.1")!;
    const altered = exclusion.text.replace("Confidential Information", "Proprietary Information");
    expect(altered).not.toBe(exclusion.text);
    const edited = {
      ...ingest,
      spans: ingest.spans.map((s) => (s.id === exclusion.id ? { ...s, text: altered } : s)),
    };
    const result = await verifyFinding({
      draft: draft({
        ruleKey: "exc-1",
        status: "compliant",
        evidence: [{ spanId: exclusion.id, quote: altered, role: "governing" }],
      }),
      bundle: bundle(edited, [exclusion.label], { rule: r }),
      rule: r,
      ingest: edited,
      manifest: manifest({ clientLegalName: client }),
      enabledChecks: ["C1"],
    });
    expect(codes(result.finding)).toContain("defined_term_unresolved");
  });
});

// ---------------------------------------------------------------------------------------------
// Through verify
// ---------------------------------------------------------------------------------------------

describe("the defined_term check", () => {
  const ingest = ingestOf(
    [
      {
        doc: "D1",
        paragraph: 2,
        text: 'Section 3 excludes Proprietary Information from the duty of confidence. "Confidential Information" means anything marked as confidential.',
        clause: "3",
      },
      {
        doc: "D1",
        paragraph: 3,
        text: "The Receiving Party shall keep the Confidential Information secret for the Term.",
        clause: "4",
      },
    ],
    [define("D1", 2, "Confidential Information"), define("D1", 3, "Receiving Party")],
  );
  const r = rule({ key: "exc-1", category: "exclusions" });
  const run = (label: string, quote: string) =>
    verifyFinding({
      draft: draft({
        ruleKey: "exc-1",
        status: "deviation",
        evidence: [{ spanId: spanOf(ingest, label).id, quote, role: "governing" }],
      }),
      bundle: bundle(ingest, [label], { rule: r }),
      rule: r,
      ingest,
      manifest: manifest(),
      enabledChecks: ["C1"],
    });

  it("passes a quote whose terms are defined", async () => {
    const { finding } = await run(
      "D1-p3",
      "shall keep the Confidential Information secret for the Term.",
    );
    expect(check(finding, "defined_term").outcome).toBe("pass");
    expect(codes(finding)).not.toContain("defined_term_unresolved");
  });

  it("fails a quote that uses a term no span defines, and names a place, not the term", async () => {
    const { finding } = await run("D1-p2", "excludes Proprietary Information from the duty");
    expect(check(finding, "defined_term").outcome).toBe("fail");
    expect(codes(finding)).toEqual(["defined_term_unresolved"]);
    const detail = finding.escalations[0]!.detail;
    expect(detail).toContain("D1-p2");
    expect(detail).toMatch(/at characters \d+-\d+ of the normalised quote/);
    expect(detail).not.toContain("Proprietary");
    expect(check(finding, "defined_term").detail).not.toContain("Proprietary");
    expect(finding.verificationState).toBe("escalated_by_system");
  });

  it("is not applicable when no quote is verified", async () => {
    const { finding } = await run("D1-p2", "this quote is not in the span at all");
    expect(check(finding, "defined_term").outcome).toBe("not_applicable");
  });
});
