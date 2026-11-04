import { estimateTokens } from "@clausewise/review";
import { describe, expect, it } from "vitest";
import { CATEGORY_IDS, type ContextBundle } from "../../src/contracts.js";
import { renderRule, renderSpans } from "../../src/prompts/render.js";
import { buildBundles, headingNumber } from "../../src/stages/retrieve.js";
import {
  DEMO_RULES,
  SECTION_SIX_AMENDMENT_TEXT,
  NDA_TEXT,
  bundleOf,
  buildFixture,
  customRule,
  extractOutput,
  labelsIn,
  ruleOf,
  workedExample,
  type Fixture,
} from "./support-stages.js";

/** `D1-p12:located` for each span of a bundle, in the bundle's order. */
const described = (bundle: ContextBundle, fx: Fixture): string[] =>
  bundle.spans.map((s) => `${fx.ingest.spans.find((x) => x.id === s.spanId)!.label}:${s.why}`);

describe("the worked example (docs/parol/04): dur-1 under R1 and R2", () => {
  const fx = workedExample();
  const term = fx.spanStarting("6.1 ").label;
  const deletion = fx.spanStarting("2. Section 6.1").label;
  const located = { duration: [term] };

  it("holds the located term clause, its definitions and the survival clause under R1", () => {
    const bundle = bundleOf(fx, "dur-1", located, { policy: "R1" });
    const labels = labelsIn(bundle, fx);
    expect(labels).toContain(term);
    expect(labels).toContain(fx.spanStarting('1.2 "Confidential Information"').label);
    expect(labels).toContain(fx.spanStarting("9.3 ").label);
    expect(bundle.fullDocument).toBe(false);
  });

  it("does not hold the amendment clause that deletes 6.1 under R1", () => {
    const bundle = bundleOf(fx, "dur-1", located, { policy: "R1" });
    expect(labelsIn(bundle, fx)).not.toContain(deletion);
    expect(labelsIn(bundle, fx).filter((l) => l.startsWith("D2"))).toEqual([]);
  });

  it("holds the amendment clause under R2, with the reason cross_reference", () => {
    const bundle = bundleOf(fx, "dur-1", located, { policy: "R2" });
    const entry = bundle.spans.find((s) => s.spanId === fx.span(deletion).id);
    expect(entry?.why).toBe("cross_reference");
    // Only the clause that changes a bundled clause is added: not the one that amends 7.2.
    expect(labelsIn(bundle, fx).filter((l) => l.startsWith("D2"))).toEqual([deletion]);
  });

  it("gives every span the reason the design table gives it, in document order", () => {
    const r1 = bundleOf(fx, "dur-1", located, { policy: "R1" });
    expect(described(r1, fx)).toEqual([
      `${fx.spanStarting("This Mutual Nondisclosure").label}:definition`,
      `${fx.spanStarting('1.2 "Confidential').label}:definition`,
      `${term}:located`,
      `${fx.spanStarting("6.2 ").label}:hint`,
      `${fx.spanStarting("9.3 ").label}:hint`,
    ]);
    const r2 = bundleOf(fx, "dur-1", located, { policy: "R2" });
    expect(described(r2, fx)).toEqual([...described(r1, fx), `${deletion}:cross_reference`]);
  });

  it("leaves the other seven bundles' policy-independent parts alone", () => {
    const r1 = buildBundles({
      ingest: fx.ingest,
      extract: extractOutput(fx, located),
      rules: DEMO_RULES,
      policy: "R1",
      budgetTokens: 12000,
    });
    const r2 = buildBundles({
      ingest: fx.ingest,
      extract: extractOutput(fx, located),
      rules: DEMO_RULES,
      policy: "R2",
      budgetTokens: 12000,
    });
    expect(r1.map((b) => b.ruleKey)).toEqual(DEMO_RULES.map((r) => r.key));
    expect(r2.map((b) => b.ruleKey)).toEqual(DEMO_RULES.map((r) => r.key));
    // Nothing located for the other categories: all of them read the whole document either way,
    // and R2 only relabels the amendment spans that change a clause.
    for (const [i, rule] of DEMO_RULES.entries()) {
      if (rule.key === "dur-1") continue;
      expect(r1[i]!.fullDocument, rule.key).toBe(true);
      expect(
        r2[i]!.spans.map((s) => s.spanId),
        rule.key,
      ).toEqual(r1[i]!.spans.map((s) => s.spanId));
    }
  });
});

describe("an amendment that deletes Section 6 as a whole", () => {
  const fx = buildFixture([NDA_TEXT, SECTION_SIX_AMENDMENT_TEXT]);
  const deleteSix = fx.spanStarting("1. Section 6 of the Agreement is deleted").label;
  const amendSeven = fx.spanStarting("2. Section 7.2").label;

  it("is a cross reference to 6 that the ingest module annotates as deleting", () => {
    expect(
      fx.ingest.annotations.filter(
        (a) => a.kind === "cross_reference" && a.spanId === fx.span(deleteSix).id,
      ),
    ).toEqual([
      { kind: "cross_reference", spanId: fx.span(deleteSix).id, target: "6", verb: "deletes" },
    ]);
  });

  it("is added under R2 when 6.1 is in the bundle, because target 6 reaches 6.1", () => {
    const bundle = bundleOf(
      fx,
      "dur-1",
      { duration: [fx.spanStarting("6.1 ").label] },
      { policy: "R2" },
    );
    expect(described(bundle, fx)).toContain(`${deleteSix}:cross_reference`);
    expect(labelsIn(bundle, fx)).not.toContain(amendSeven);
  });

  it("is added when only 6.2 is in the bundle: any clause under Section 6 counts", () => {
    const bundle = bundleOf(
      fx,
      "dur-1",
      { duration: [fx.spanStarting("6.2 ").label] },
      { policy: "R2" },
    );
    expect(described(bundle, fx)).toContain(`${deleteSix}:cross_reference`);
  });

  it("is added when 6.1 is in the bundle only as a keyword hint", () => {
    // Nothing located for governing-law except a clause that carries no number, so no hint rules.
    const bundle = bundleOf(
      fx,
      "dur-1",
      { duration: [fx.spanStarting("6.2 ").label] },
      { policy: "R2" },
    );
    expect(described(bundle, fx)).toContain(`${fx.spanStarting("6.1 ").label}:hint`);
    expect(described(bundle, fx)).toContain(`${deleteSix}:cross_reference`);
  });

  it("is not added under R1", () => {
    const bundle = bundleOf(
      fx,
      "dur-1",
      { duration: [fx.spanStarting("6.1 ").label] },
      { policy: "R1" },
    );
    expect(labelsIn(bundle, fx)).not.toContain(deleteSix);
  });

  it("is not added to a bundle that holds no clause of Section 6", () => {
    const bundle = bundleOf(
      fx,
      "exc-1",
      { exclusions: [fx.spanStarting("2.1 ").label] },
      { policy: "R2" },
    );
    expect(labelsIn(bundle, fx)).not.toContain(deleteSix);
  });

  it("adds the clause that amends 7.2 to the bundle of a rule that located 7.2", () => {
    const bundle = bundleOf(
      fx,
      "ret-1",
      { "return-destruction": [fx.spanStarting("7.2 ").label] },
      { policy: "R2" },
    );
    expect(described(bundle, fx)).toContain(`${amendSeven}:cross_reference`);
    expect(labelsIn(bundle, fx)).not.toContain(deleteSix);
  });
});

describe("R2 matching of references to clause numbers", () => {
  const fx = workedExample();
  const term = fx.spanStarting("6.1 ").label;

  /** The worked example with annotations replaced, to test the matching alone. */
  const withReferences = (references: { label: string; target: string; verb: string }[]) => ({
    ...fx.ingest,
    annotations: [
      ...fx.ingest.annotations.filter((a) => a.kind !== "cross_reference"),
      ...references.map(({ label, target, verb }) => ({
        kind: "cross_reference" as const,
        spanId: fx.span(label).id,
        target,
        verb: verb as "deletes",
      })),
    ],
  });

  const bundleWith = (references: { label: string; target: string; verb: string }[]) =>
    buildBundles({
      ingest: withReferences(references),
      extract: extractOutput(fx, { duration: [term] }),
      rules: [ruleOf("dur-1")],
      policy: "R2",
      budgetTokens: 12000,
    })[0]!;

  const amendment = fx.spanStarting("2. Section 6.1").label;
  const addedBy = (target: string, verb = "deletes"): boolean =>
    bundleWith([{ label: amendment, target, verb }]).spans.some(
      (s) => s.spanId === fx.span(amendment).id && s.why === "cross_reference",
    );

  it("matches the clause number exactly", () => {
    expect(addedBy("6.1")).toBe(true);
  });

  it("matches a parent number as a dotted prefix", () => {
    expect(addedBy("6")).toBe(true);
  });

  it("does not match a child, a sibling or a number that only starts the same way", () => {
    expect(addedBy("6.1.1")).toBe(false);
    expect(addedBy("6.3")).toBe(false);
    expect(addedBy("6.10")).toBe(false);
    expect(addedBy("61")).toBe(false);
    expect(addedBy("5")).toBe(false);
    expect(addedBy("")).toBe(false);
  });

  it("takes deletes, replaces and amends, and not refers", () => {
    expect(addedBy("6.1", "deletes")).toBe(true);
    expect(addedBy("6.1", "replaces")).toBe(true);
    expect(addedBy("6.1", "amends")).toBe(true);
    expect(addedBy("6.1", "refers")).toBe(false);
  });

  it("takes any one of several references in a span", () => {
    const bundle = bundleWith([
      { label: amendment, target: "9", verb: "deletes" },
      { label: amendment, target: "6.1", verb: "refers" },
      { label: amendment, target: "6", verb: "amends" },
    ]);
    expect(bundle.spans.find((s) => s.spanId === fx.span(amendment).id)?.why).toBe(
      "cross_reference",
    );
  });

  it("never takes a span of the NDA, whatever it says about itself", () => {
    const survival = fx.spanStarting("9.3 ").label;
    const bundle = buildBundles({
      ingest: withReferences([{ label: survival, target: "6.1", verb: "deletes" }]),
      extract: extractOutput(fx, { duration: [term] }),
      rules: [ruleOf("dur-1")],
      policy: "R2",
      budgetTokens: 12000,
    })[0]!;
    // 9.3 is in the bundle as a keyword hint and stays one: it is not reclassified.
    expect(bundle.spans.find((s) => s.spanId === fx.span(survival).id)?.why).toBe("hint");
    expect(bundle.spans.filter((s) => s.why === "cross_reference")).toEqual([]);
  });

  it("resolves against the NDA's numbers: an amendment's own clause 2 is not the NDA's clause 2", () => {
    // Two amendments. D3 deletes "Section 2", meaning the NDA's Section 2 (its exclusions).
    // Locating Amendment No. 1's own clause 2 must not bring D3 in, because D3's reference is
    // not to that clause.
    const two = buildFixture([
      NDA_TEXT,
      SECTION_SIX_AMENDMENT_TEXT.replace("1. Section 6 of", "2. Section 6 of"),
      "AMENDMENT NO. 2 TO MUTUAL NONDISCLOSURE AGREEMENT\n\n1. Section 2 of the Agreement is deleted.\n",
    ]);
    const own = two.spanStarting("2. Section 6 of the Agreement is deleted");
    expect(own.clauseNumber).toBe("2");
    const d3 = two.spanStarting("1. Section 2 of the Agreement is deleted");
    const run = (located: string[]) =>
      buildBundles({
        ingest: two.ingest,
        extract: extractOutput(two, { duration: located }),
        rules: [ruleOf("dur-1")],
        policy: "R2",
        budgetTokens: 12000,
      })[0]!;
    // Located: only the amendment's own "clause 2" (and, through hints, NDA clauses 6.1 6.2 9.3,
    // none of which is clause 2).
    expect(run([own.label]).spans.some((s) => s.spanId === d3.id)).toBe(false);
    // Located: the NDA's 2.1, which is under Section 2. Now D3 applies.
    const exclusion = two.spanStarting("2.1 ");
    const bundle = buildBundles({
      ingest: two.ingest,
      extract: extractOutput(two, { exclusions: [exclusion.label] }),
      rules: [ruleOf("exc-1")],
      policy: "R2",
      budgetTokens: 12000,
    })[0]!;
    expect(bundle.spans.find((s) => s.spanId === d3.id)?.why).toBe("cross_reference");
  });

  it("takes one hop only: what changes an added amendment clause is not added in turn", () => {
    // D3 changes D2's clause. Under the NDA-only resolution there is no way to say so, and even
    // when D3 targets the number D2's clause carries, nothing is added for it.
    const three = buildFixture([
      NDA_TEXT,
      AMENDMENT_FOR_HOP,
      "AMENDMENT NO. 2 TO MUTUAL NONDISCLOSURE AGREEMENT\n\n1. Section 2 of Amendment No. 1 is replaced.\n",
    ]);
    const term = three.spanStarting("6.1 ");
    const d3 = three.spanStarting("1. Section 2 of Amendment No. 1");
    const bundle = buildBundles({
      ingest: three.ingest,
      extract: extractOutput(three, { duration: [term.label] }),
      rules: [ruleOf("dur-1")],
      policy: "R2",
      budgetTokens: 12000,
    })[0]!;
    expect(bundle.spans.some((s) => s.why === "cross_reference")).toBe(true);
    expect(bundle.spans.some((s) => s.spanId === d3.id)).toBe(false);
  });

  it("compares letters and Roman numerals without regard to case", () => {
    // Ingest writes a clause number as the document does; a reference may be typed in another case.
    const clause = fx.spanStarting("6.1 ");
    const ingest = {
      ...fx.ingest,
      spans: fx.ingest.spans.map((s) => (s.id === clause.id ? { ...s, clauseNumber: "II.1" } : s)),
      annotations: [
        ...fx.ingest.annotations.filter((a) => a.kind !== "cross_reference"),
        {
          kind: "cross_reference" as const,
          spanId: fx.span(amendment).id,
          target: "ii",
          verb: "deletes" as const,
        },
      ],
    };
    const bundle = buildBundles({
      ingest,
      extract: extractOutput(fx, { duration: [clause.label] }),
      rules: [ruleOf("dur-1")],
      policy: "R2",
      budgetTokens: 12000,
    })[0]!;
    expect(bundle.spans.find((s) => s.spanId === fx.span(amendment).id)?.why).toBe(
      "cross_reference",
    );
  });
});

/** An NDA whose section numbers sit in the headings and whose body paragraphs carry none. */
const HEADING_NUMBERED_NDA = `MUTUAL NONDISCLOSURE AGREEMENT

This Mutual Nondisclosure Agreement (the "Agreement") is made on 2 February 2026 between Lanternfish Software, Inc. and Corvane Data Systems LLC.

2. Term

The obligations of the Receiving Party shall continue for two (2) years from the date of each disclosure.

3. Return of Materials

Upon written request the Receiving Party shall return or destroy Confidential Information within ten (10) days.

4. Governing Law

This Agreement is governed by the laws of Delaware.
`;

const HEADING_NUMBERED_AMENDMENT = `AMENDMENT NO. 1 TO MUTUAL NONDISCLOSURE AGREEMENT

1. Section 2 of the Agreement is deleted.

2. Section 3 of the Agreement is amended by replacing "ten (10) days" with "thirty (30) days".

3. Section 4 of the Agreement is amended by replacing "Delaware" with "Texas".
`;

describe("R2 when the NDA carries its section numbers in the headings", () => {
  const fx = buildFixture([HEADING_NUMBERED_NDA, HEADING_NUMBERED_AMENDMENT]);
  const body = (prefix: string) => fx.spanStarting(prefix);
  const amendment = (prefix: string) => fx.spanStarting(prefix);
  const run = (category: "duration" | "return-destruction" | "governing-law", prefix: string) => {
    const located = body(prefix).label;
    const ruleKey = { duration: "dur-1", "return-destruction": "ret-1", "governing-law": "gov-1" }[
      category
    ];
    return {
      r1: bundleOf(fx, ruleKey, { [category]: [located] }, { policy: "R1" }),
      r2: bundleOf(fx, ruleKey, { [category]: [located] }, { policy: "R2" }),
    };
  };

  it("has body spans with no clause number, which is the layout under test", () => {
    for (const prefix of [
      "The obligations",
      "Upon written request",
      "This Agreement is governed",
    ]) {
      expect(body(prefix).clauseNumber).toBeNull();
    }
    expect(body("The obligations").heading).toBe("2. Term");
  });

  it("adds the amendment that deletes Section 2 to the duration bundle, under R2 only", () => {
    const { r1, r2 } = run("duration", "The obligations");
    const deletion = amendment("1. Section 2 of");
    expect(r1.spans.some((s) => s.spanId === deletion.id)).toBe(false);
    expect(r2.spans.find((s) => s.spanId === deletion.id)?.why).toBe("cross_reference");
  });

  it("adds the amendment of Section 3 to the return-destruction bundle", () => {
    const { r2 } = run("return-destruction", "Upon written request");
    expect(r2.spans.find((s) => s.spanId === amendment("2. Section 3 of").id)?.why).toBe(
      "cross_reference",
    );
    // Not the amendments of the other sections.
    expect(r2.spans.some((s) => s.spanId === amendment("1. Section 2 of").id)).toBe(false);
    expect(r2.spans.some((s) => s.spanId === amendment("3. Section 4 of").id)).toBe(false);
  });

  it("adds the amendment of Section 4 to the governing-law bundle", () => {
    const { r2 } = run("governing-law", "This Agreement is governed");
    expect(r2.spans.find((s) => s.spanId === amendment("3. Section 4 of").id)?.why).toBe(
      "cross_reference",
    );
    expect(r2.spans.some((s) => s.spanId === amendment("1. Section 2 of").id)).toBe(false);
  });

  it("reads a Roman numeral heading, and an Article heading over decimal clause numbers", () => {
    const roman = buildFixture([
      "AGREEMENT\n\nARTICLE II - TERM\n\nThe obligations continue for two (2) years from the date of each disclosure.\n",
      "AMENDMENT NO. 1\n\n1. Section II of the Agreement is deleted.\n",
    ]);
    const term = roman.spanStarting("The obligations");
    expect(term.clauseNumber).toBeNull();
    const romanBundle = bundleOf(roman, "dur-1", { duration: [term.label] }, { policy: "R2" });
    expect(
      romanBundle.spans.find((s) => s.spanId === roman.spanStarting("1. Section II").id)?.why,
    ).toBe("cross_reference");

    const article = buildFixture([
      "ARTICLE II - TERM\n\n2.01 The obligations continue for two (2) years.\n\n2.02 Either Party may terminate on notice.\n\nARTICLE III - GENERAL\n\n3.01 Governing law is Delaware.\n",
      "AMENDMENT NO. 1\n\n1. Article II of the Agreement is deleted.\n",
    ]);
    const clause = article.spanStarting("2.01 ");
    expect(clause.clauseNumber).toBe("2.01");
    const articleBundle = bundleOf(
      article,
      "dur-1",
      { duration: [clause.label] },
      { policy: "R2" },
    );
    expect(
      articleBundle.spans.find((s) => s.spanId === article.spanStarting("1. Article II").id)?.why,
    ).toBe("cross_reference");
    // Article III is a different article.
    const other = bundleOf(
      article,
      "gov-1",
      { "governing-law": [article.spanStarting("3.01 ").label] },
      { policy: "R2" },
    );
    expect(other.spans.some((s) => s.spanId === article.spanStarting("1. Article II").id)).toBe(
      false,
    );
  });

  it("does not take a number from a heading that is not a number", () => {
    const plain = buildFixture([
      "AGREEMENT\n\nTerm\n\nThe obligations continue for two (2) years from the date of each disclosure.\n",
      "AMENDMENT NO. 1\n\n1. Section 2 of the Agreement is deleted.\n",
    ]);
    const term = plain.spanStarting("The obligations");
    const bundle = bundleOf(plain, "dur-1", { duration: [term.label] }, { policy: "R2" });
    expect(bundle.spans.some((s) => s.why === "cross_reference")).toBe(false);
  });

  it("still reads a clause by its own number: a sibling of a numbered clause is not reached", () => {
    // 9.3 sits under the heading "7. GENERAL" in the shared fixture, and Amendment No. 1 amends
    // 7.2. A reference to 7.2 reaches 7.2 and nothing else under that heading.
    const worked = workedExample();
    const survival = worked.spanStarting("9.3 ");
    expect(survival.clauseNumber).toBe("9.3");
    expect(survival.heading).toMatch(/^7\./);
    const bundle = bundleOf(
      worked,
      "gov-1",
      { "governing-law": [survival.label] },
      { policy: "R2" },
    );
    expect(bundle.spans.some((s) => s.why === "cross_reference")).toBe(false);
  });

  it("reads a heading paragraph as the section it heads: Section 6 reaches it, Section 6.1 does not", () => {
    const text = (reference: string) =>
      buildFixture([
        "AGREEMENT\n\n6. TERM\n\n6.1 The obligations continue for two (2) years from the date of each disclosure.\n",
        `AMENDMENT NO. 1\n\n1. Section ${reference} of the Agreement is deleted.\n`,
      ]);
    const bundleFor = (reference: string) => {
      const fx = text(reference);
      const heading = fx.spanStarting("6. TERM");
      expect(heading.clauseNumber).toBeNull();
      return bundleOf(fx, "pty-1", { parties: [heading.label] }, { policy: "R2" });
    };
    expect(bundleFor("6").spans.map((s) => s.why)).toContain("cross_reference");
    expect(bundleFor("6.1").spans.map((s) => s.why)).not.toContain("cross_reference");
  });
});

describe("the number a heading starts with", () => {
  it("reads decimal, keyword and Roman numbers", () => {
    expect(headingNumber("2. Term")).toBe("2");
    expect(headingNumber("2.Term")).toBe("2");
    expect(headingNumber("6.1 Duration")).toBe("6.1");
    expect(headingNumber("Section 4 - Governing Law")).toBe("4");
    expect(headingNumber("ARTICLE II - TERM")).toBe("II");
    expect(headingNumber("Article IV")).toBe("IV");
    expect(headingNumber("II. Term")).toBe("II");
    expect(headingNumber("  3) Notices")).toBe("3");
    // En and em dashes after the number, written as escapes.
    expect(headingNumber("Section 4 \u2013 Governing Law")).toBe("4");
    expect(headingNumber("ARTICLE II \u2014 TERM")).toBe("II");
  });

  it("gives null for a heading that does not start with one", () => {
    for (const heading of [
      null,
      "",
      "Term",
      "Introduction",
      "IN WITNESS WHEREOF",
      "Vix Systems",
      "MUTUAL NONDISCLOSURE AGREEMENT",
      "D1 | 2. Term",
    ]) {
      expect(headingNumber(heading), String(heading)).toBeNull();
    }
  });
});

describe("R2 and the wording an amendment restates", () => {
  const RESTATING = `AMENDMENT NO. 1 TO MUTUAL NONDISCLOSURE AGREEMENT

This Amendment No. 1 (the "Amendment") is made as of 15 September 2026.

1. Section 6.1 of the Agreement is amended and restated to read in its entirety as follows:

The Receiving Party's obligations shall end when the Receiving Party ceases to carry on business.

2. Section 7.2 of the Agreement is deleted.

3. Except as amended by this Amendment, the Agreement remains in full force and effect.
`;
  const fx = buildFixture([NDA_TEXT, RESTATING]);
  const lead = fx.spanStarting("1. Section 6.1");
  const wording = fx.spanStarting("The Receiving Party's obligations shall end");
  const next = fx.spanStarting("2. Section 7.2");
  const bundle = bundleOf(
    fx,
    "dur-1",
    { duration: [fx.spanStarting("6.1 ").label] },
    { policy: "R2" },
  );

  it("has restated wording with no clause number and no annotation of its own", () => {
    expect(wording.clauseNumber).toBeNull();
    expect(
      fx.ingest.annotations.filter((a) => a.spanId === wording.id && a.kind === "cross_reference"),
    ).toEqual([]);
  });

  it("adds the unnumbered wording that follows the instruction, with the reason cross_reference", () => {
    expect(bundle.spans.find((s) => s.spanId === lead.id)?.why).toBe("cross_reference");
    expect(bundle.spans.find((s) => s.spanId === wording.id)?.why).toBe("cross_reference");
  });

  it("stops at the next numbered clause", () => {
    expect(bundle.spans.some((s) => s.spanId === next.id)).toBe(false);
    expect(bundle.spans.some((s) => s.spanId === fx.spanStarting("3. Except as amended").id)).toBe(
      false,
    );
  });

  it("does not add the wording under R1", () => {
    const r1 = bundleOf(
      fx,
      "dur-1",
      { duration: [fx.spanStarting("6.1 ").label] },
      { policy: "R1" },
    );
    expect(r1.spans.some((s) => s.spanId === wording.id)).toBe(false);
  });

  it("follows sub-paragraphs of the restated wording to the next numbered clause", () => {
    const items = buildFixture([
      NDA_TEXT,
      `AMENDMENT NO. 1

1. Section 6.1 of the Agreement is amended and restated to read as follows:

The obligations shall end when:

(a) the Receiving Party ceases to carry on business; or

(b) five (5) years have passed.

2. Section 7.2 of the Agreement is deleted.
`,
    ]);
    const b = bundleOf(
      items,
      "dur-1",
      { duration: [items.spanStarting("6.1 ").label] },
      { policy: "R2" },
    );
    for (const prefix of ["The obligations shall end", "(a) the Receiving", "(b) five"]) {
      expect(b.spans.find((s) => s.spanId === items.spanStarting(prefix).id)?.why, prefix).toBe(
        "cross_reference",
      );
    }
    expect(b.spans.some((s) => s.spanId === items.spanStarting("2. Section 7.2").id)).toBe(false);
  });

  it("does not follow the instruction into another document", () => {
    const two = buildFixture([
      NDA_TEXT,
      "AMENDMENT NO. 1\n\n1. Section 6.1 of the Agreement is deleted.\n",
      "AMENDMENT NO. 2\n\nThis Amendment is made in good faith.\n",
    ]);
    const b = bundleOf(
      two,
      "dur-1",
      { duration: [two.spanStarting("6.1 ").label] },
      { policy: "R2" },
    );
    expect(
      b.spans.some((s) => s.spanId === two.spanStarting("This Amendment is made in good").id),
    ).toBe(false);
  });
});

const AMENDMENT_FOR_HOP = `AMENDMENT NO. 1 TO MUTUAL NONDISCLOSURE AGREEMENT

2. Section 6.1 of the Agreement is deleted in its entirety.
`;

describe("when nothing was located, or extract failed: the whole document", () => {
  const fx = workedExample();

  it("reads every span of every document for a presence rule with nothing located", () => {
    const bundle = bundleOf(fx, "gov-1", {});
    expect(bundle.fullDocument).toBe(true);
    expect(bundle.spans.map((s) => s.spanId)).toEqual(fx.ingest.spans.map((s) => s.id));
  });

  it("does the same for an absence rule with nothing located", () => {
    const rule = customRule({
      key: "abs-1",
      category: "duration",
      kind: "absence",
      required: false,
    });
    const bundles = buildBundles({
      ingest: fx.ingest,
      extract: extractOutput(fx, {}),
      rules: [rule],
      policy: "R1",
      budgetTokens: 12000,
    });
    expect(bundles[0]!.fullDocument).toBe(true);
    expect(bundles[0]!.spans).toHaveLength(fx.ingest.spans.length);
  });

  it("reads the whole document for every rule when extract is degraded, even for a located category", () => {
    const degraded = buildBundles({
      ingest: fx.ingest,
      extract: extractOutput(fx, { duration: [fx.spanStarting("6.1 ").label] }, { degraded: true }),
      rules: DEMO_RULES,
      policy: "R1",
      budgetTokens: 100000,
    });
    expect(degraded).toHaveLength(DEMO_RULES.length);
    for (const bundle of degraded) {
      expect(bundle.fullDocument, bundle.ruleKey).toBe(true);
      expect(
        bundle.spans.map((s) => s.spanId),
        bundle.ruleKey,
      ).toEqual(fx.ingest.spans.map((s) => s.id));
    }
  });

  it("keeps the located, definition and hint reasons inside a whole-document bundle", () => {
    const bundle = bundleOf(fx, "dur-1", {}, { degraded: true });
    const whys = new Set(bundle.spans.map((s) => s.why));
    expect(whys).toEqual(new Set(["hint", "full_document"]));
    expect(described(bundle, fx)).toContain(`${fx.spanStarting("9.3 ").label}:hint`);
    expect(described(bundle, fx)).toContain(`${fx.spanStarting("1.1 ").label}:full_document`);
  });

  it("labels an amendment clause cross_reference even in a whole-document bundle under R2", () => {
    const bundle = bundleOf(fx, "gov-1", {}, { policy: "R2" });
    const deletion = fx.spanStarting("2. Section 6.1");
    expect(bundle.spans.find((s) => s.spanId === deletion.id)?.why).toBe("cross_reference");
    expect(bundle.spans.find((s) => s.spanId === fx.spanStarting("1.1 ").id)?.why).toBe(
      "full_document",
    );
  });

  it("is not a whole-document bundle when something was located", () => {
    const bundle = bundleOf(fx, "gov-1", { "governing-law": [fx.spanStarting("6.2 ").label] });
    expect(bundle.fullDocument).toBe(false);
    expect(bundle.spans.length).toBeLessThan(fx.ingest.spans.length);
  });

  it("does not count a located passage whose quote did not verify as located", () => {
    // The only passage the model named for the category has a quote that is not in its span. It
    // may be a mislabelled clause or an injected label, so it must not switch off the whole
    // document: the real clause may be anywhere.
    const extract = extractOutput(fx, { duration: [fx.spanStarting("6.2 ").label] });
    extract.categories.duration.located[0]!.quote = "";
    extract.categories.duration.located[0]!.quoteCheck = "not_found";
    const bundles = buildBundles({
      ingest: fx.ingest,
      extract,
      rules: [ruleOf("dur-1")],
      policy: "R1",
      budgetTokens: 100000,
    });
    expect(bundles[0]!.fullDocument).toBe(true);
    expect(bundles[0]!.spans.map((s) => s.spanId)).toEqual(fx.ingest.spans.map((s) => s.id));
    expect(bundles[0]!.spans.some((s) => s.why === "located")).toBe(false);
  });

  it("keeps a clause whose quote did not verify as a hint when another passage did verify", () => {
    // 3.1 is not a duration clause and no keyword points at it: the model's pointer is all there is.
    const wrong = fx.spanStarting("3.1 ");
    const right = fx.spanStarting("6.1 ");
    const extract = extractOutput(fx, { duration: [right.label, wrong.label] });
    extract.categories.duration.located[1]!.quoteCheck = "not_found";
    const bundle = buildBundles({
      ingest: fx.ingest,
      extract,
      rules: [ruleOf("dur-1")],
      policy: "R1",
      budgetTokens: 100000,
    })[0]!;
    expect(bundle.fullDocument).toBe(false);
    expect(bundle.spans.find((s) => s.spanId === right.id)?.why).toBe("located");
    expect(bundle.spans.find((s) => s.spanId === wrong.id)?.why).toBe("hint");
  });

  it("counts a passage as located when its quote is verified", () => {
    const bundle = bundleOf(fx, "dur-1", { duration: [fx.spanStarting("6.1 ").label] });
    expect(bundle.fullDocument).toBe(false);
    expect(bundle.spans.some((s) => s.why === "located")).toBe(true);
  });
});

describe("reasons", () => {
  const fx = workedExample();

  it("gives a span the first applicable reason: located before definition before hint", () => {
    // 1.2 defines Receiving Party and is a hint for ci-definition. Located, it is located.
    const definition = fx.spanStarting('1.2 "Confidential Information"');
    const bundle = bundleOf(fx, "def-1", { "ci-definition": [definition.label] });
    expect(bundle.spans.find((s) => s.spanId === definition.id)?.why).toBe("located");
    // Located elsewhere, the same span is a definition (not a hint) for the terms used.
    const other = bundleOf(fx, "def-1", { "ci-definition": [fx.spanStarting("2.1 ").label] });
    expect(other.spans.find((s) => s.spanId === definition.id)?.why).toBe("definition");
  });

  it("lists each span once", () => {
    const bundle = bundleOf(fx, "dur-1", {
      duration: [fx.spanStarting("6.1 ").label, fx.spanStarting("6.2 ").label],
    });
    const ids = bundle.spans.map((s) => s.spanId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes the definitions of terms in a span of another document", () => {
    // The amendment defines "Agreement" as the NDA does; a located clause that uses the term
    // brings in both definitions, whichever document they are in.
    const located = fx.spanStarting("6.2 ");
    const bundle = bundleOf(fx, "dur-1", { duration: [located.label] });
    const amendmentPreamble = fx.spanStarting('This Amendment No. 1 (the "Amendment")');
    const ndaPreamble = fx.spanStarting("This Mutual Nondisclosure Agreement");
    expect(bundle.spans.find((s) => s.spanId === amendmentPreamble.id)?.why).toBe("definition");
    expect(bundle.spans.find((s) => s.spanId === ndaPreamble.id)?.why).toBe("definition");
  });
});

describe("the budget", () => {
  const fx = workedExample();
  const located = { duration: [fx.spanStarting("6.1 ").label] };

  it("estimates the rendered spans plus the rule text", () => {
    const bundle = bundleOf(fx, "dur-1", located);
    const spans = bundle.spans.map((s) => fx.ingest.spans.find((x) => x.id === s.spanId)!);
    expect(bundle.estimatedTokens).toBe(
      estimateTokens(`${renderSpans(spans)}\n\n${renderRule(ruleOf("dur-1"))}`),
    );
    expect(bundle.estimatedTokens).toBeGreaterThan(estimateTokens(renderRule(ruleOf("dur-1"))));
  });

  it("is over budget only when the estimate is greater than the budget", () => {
    const base = bundleOf(fx, "dur-1", located);
    const exact = bundleOf(fx, "dur-1", located, { budgetTokens: base.estimatedTokens });
    const under = bundleOf(fx, "dur-1", located, { budgetTokens: base.estimatedTokens - 1 });
    expect(exact.overBudget).toBe(false);
    expect(exact.budgetTokens).toBe(base.estimatedTokens);
    expect(under.overBudget).toBe(true);
  });

  it("never truncates: an over-budget bundle keeps every span", () => {
    const roomy = bundleOf(fx, "gov-1", {}, { budgetTokens: 1_000_000 });
    const tiny = bundleOf(fx, "gov-1", {}, { budgetTokens: 10 });
    expect(tiny.overBudget).toBe(true);
    expect(tiny.spans).toEqual(roomy.spans);
    expect(tiny.estimatedTokens).toBe(roomy.estimatedTokens);
  });

  it("grows with the policy: R2 adds a span and its cost", () => {
    const r1 = bundleOf(fx, "dur-1", located, { policy: "R1" });
    const r2 = bundleOf(fx, "dur-1", located, { policy: "R2" });
    expect(r2.estimatedTokens).toBeGreaterThan(r1.estimatedTokens);
  });

  it("counts a whole-document bundle's size", () => {
    const whole = bundleOf(fx, "gov-1", {});
    const part = bundleOf(fx, "dur-1", located);
    expect(whole.estimatedTokens).toBeGreaterThan(part.estimatedTokens);
  });
});

describe("the corpus is the run", () => {
  const fx = workedExample();

  it("ignores located span ids that are not spans of this run", () => {
    const extract = extractOutput(fx, { duration: [fx.spanStarting("6.1 ").label] });
    extract.categories.duration.located.push({
      spanId: "dv_other_matter:p3",
      quote: "x",
      quoteCheck: "verified",
    });
    const bundle = buildBundles({
      ingest: fx.ingest,
      extract,
      rules: [ruleOf("dur-1")],
      policy: "R2",
      budgetTokens: 12000,
    })[0]!;
    const known = new Set(fx.ingest.spans.map((s) => s.id));
    expect(bundle.spans.every((s) => known.has(s.spanId))).toBe(true);
  });

  it("reads the whole document when the only located span is not in the run", () => {
    const extract = extractOutput(fx, {});
    extract.categories.duration.located.push({
      spanId: "dv_other_matter:p3",
      quote: "x",
      quoteCheck: "verified",
    });
    extract.categories.duration.notFound = false;
    const bundle = buildBundles({
      ingest: fx.ingest,
      extract,
      rules: [ruleOf("dur-1")],
      policy: "R1",
      budgetTokens: 12000,
    })[0]!;
    expect(bundle.fullDocument).toBe(true);
    expect(bundle.spans).toHaveLength(fx.ingest.spans.length);
  });

  it("ignores annotations on spans that are not in the run", () => {
    const ingest = {
      ...fx.ingest,
      annotations: [
        ...fx.ingest.annotations,
        {
          kind: "keyword_hint" as const,
          spanId: "dv_other_matter:p9",
          category: "duration" as const,
        },
        {
          kind: "defines_term" as const,
          spanId: "dv_other_matter:p9",
          term: "Receiving Party",
        },
        {
          kind: "cross_reference" as const,
          spanId: "dv_other_matter:p9",
          target: "6.1",
          verb: "deletes" as const,
        },
      ],
    };
    const bundle = buildBundles({
      ingest,
      extract: extractOutput(fx, { duration: [fx.spanStarting("6.1 ").label] }),
      rules: [ruleOf("dur-1")],
      policy: "R2",
      budgetTokens: 12000,
    })[0]!;
    const known = new Set(fx.ingest.spans.map((s) => s.id));
    expect(bundle.spans.every((s) => known.has(s.spanId))).toBe(true);
  });

  it("holds spans of the run's documents only, whatever the rule", () => {
    const ids = new Set(fx.ingest.spans.map((s) => s.id));
    for (const policy of ["R1", "R2"] as const) {
      for (const rule of DEMO_RULES) {
        const bundle = bundleOf(
          fx,
          rule.key,
          { [rule.category]: [fx.spanStarting("6.1 ").label] },
          { policy },
        );
        expect(
          bundle.spans.every((s) => ids.has(s.spanId)),
          `${policy} ${rule.key}`,
        ).toBe(true);
      }
    }
  });
});

describe("structure and determinism", () => {
  const fx = workedExample();

  it("returns one bundle per rule, in rule order, carrying the rule", () => {
    const rules = [ruleOf("gov-1"), ruleOf("dur-1"), ruleOf("pty-1")];
    const bundles = buildBundles({
      ingest: fx.ingest,
      extract: extractOutput(fx, {}),
      rules,
      policy: "R1",
      budgetTokens: 12000,
    });
    expect(bundles.map((b) => b.ruleKey)).toEqual(["gov-1", "dur-1", "pty-1"]);
    expect(bundles.map((b) => b.category)).toEqual(["governing-law", "duration", "parties"]);
    expect(bundles.map((b) => b.rule)).toEqual(rules);
    expect(bundles[0]!.rule).not.toBe(rules[0]);
    expect(bundles.every((b) => b.budgetTokens === 12000)).toBe(true);
  });

  it("gives two rules of one category bundles of the same spans", () => {
    const extract = extractOutput(fx, { "permitted-disclosures": [fx.spanStarting("3.1 ").label] });
    const [pds1, pds2] = buildBundles({
      ingest: fx.ingest,
      extract,
      rules: [ruleOf("pds-1"), ruleOf("pds-2")],
      policy: "R1",
      budgetTokens: 12000,
    });
    expect(pds1!.spans).toEqual(pds2!.spans);
    expect(pds1!.ruleKey).not.toBe(pds2!.ruleKey);
  });

  it("returns no bundles for no rules", () => {
    expect(
      buildBundles({
        ingest: fx.ingest,
        extract: extractOutput(fx, {}),
        rules: [],
        policy: "R1",
        budgetTokens: 1,
      }),
    ).toEqual([]);
  });

  it("is deterministic and does not change its inputs", () => {
    const args = {
      ingest: fx.ingest,
      extract: extractOutput(fx, { duration: [fx.spanStarting("6.1 ").label] }),
      rules: DEMO_RULES,
      policy: "R2" as const,
      budgetTokens: 12000,
    };
    const before = JSON.stringify(args);
    const first = buildBundles(args);
    const second = buildBundles(args);
    expect(second).toEqual(first);
    expect(JSON.stringify(args)).toBe(before);
  });

  it("orders spans by document and paragraph however the ingest list is ordered", () => {
    const shuffled = { ...fx.ingest, spans: [...fx.ingest.spans].reverse() };
    const args = {
      extract: extractOutput(fx, { duration: [fx.spanStarting("6.1 ").label] }),
      rules: [ruleOf("dur-1")],
      policy: "R2" as const,
      budgetTokens: 12000,
    };
    const ordered = buildBundles({ ...args, ingest: fx.ingest });
    expect(buildBundles({ ...args, ingest: shuffled })).toEqual(ordered);
    const labels = labelsIn(ordered[0]!, fx);
    expect(labels).toEqual(
      [...labels].sort((a, b) => {
        const [da, pa] = a.split("-p");
        const [db, pb] = b.split("-p");
        return da === db ? Number(pa) - Number(pb) : da! < db! ? -1 : 1;
      }),
    );
  });

  it("covers every category the extract output covers", () => {
    const bundles = buildBundles({
      ingest: fx.ingest,
      extract: extractOutput(fx, {}),
      rules: DEMO_RULES,
      policy: "R1",
      budgetTokens: 12000,
    });
    expect(new Set(bundles.map((b) => b.category))).toEqual(new Set(CATEGORY_IDS));
  });
});
