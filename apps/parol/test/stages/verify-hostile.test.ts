import { describe, expect, it } from "vitest";
import type { DraftFinding, VerifiedFinding } from "../../src/contracts.js";
import { MAX_EVIDENCE_ITEMS, verifyFinding } from "../../src/stages/verify.js";
import {
  QUOTE_TERM,
  baselineDraft,
  bundle,
  check,
  cite,
  codes,
  draft,
  ingestOf,
  manifest,
  rule,
  scriptedChecker,
  spanOf,
  verify,
  workedExample,
} from "./support-verify.js";

const ingest = workedExample();

/** Everything a finding stores or shows that is not the model's own text, as one string. */
const trail = (finding: VerifiedFinding): string =>
  JSON.stringify([finding.checks, finding.escalations]);

const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
};

describe("bad model output never throws", () => {
  const garbage: [string, unknown][] = [
    ["evidence null", { evidence: null }],
    ["evidence a string", { evidence: "D1-p19" }],
    ["evidence an object", { evidence: { spanId: "x" } }],
    ["evidence full of nothing", { evidence: [null, undefined, 7, [], {}, "x"] }],
    ["status a number", { status: 42 }],
    ["status null", { status: null }],
    ["status unknown", { status: "mostly compliant" }],
    ["texts that are not strings", { discrepancy: 5, explanation: { a: 1 }, fallbackLanguage: 9 }],
    ["matched ids not an array", { escalateWhenMatched: "over-five-years" }],
    ["matched ids of every type", { escalateWhenMatched: [null, 1, {}, [], "over-five-years"] }],
    ["conflict a number", { conflict: 7 }],
    ["abstain reason an array", { abstainReason: ["x"] }],
  ];
  it.each(garbage)("%s", async (_, bad) => {
    const { finding } = await verify({ ...draft(), ...(bad as object) } as DraftFinding, {
      enabledChecks: ["C1", "C2"],
    });
    expect(finding.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Array.isArray(finding.evidence)).toBe(true);
    if (finding.status === "undetermined") expect(finding.escalations.length).toBeGreaterThan(0);
  });

  it("treats the names of Object.prototype as unknown spans and ids", async () => {
    const names = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"];
    const { finding } = await verify(
      draft({
        status: "deviation",
        evidence: names.map((spanId) => ({
          spanId,
          quote: QUOTE_TERM,
          role: "governing" as const,
        })),
        escalateWhenMatched: names,
      }),
      { enabledChecks: ["C1", "C2"] },
    );
    expect(finding.evidence).toEqual([]);
    expect(check(finding, "span_in_bundle").outcome).toBe("fail");
    expect(check(finding, "playbook_escalation").detail).toContain("5 ids the rule does not have");
    expect(codes(finding)).not.toContain("playbook_escalation");
  });

  it("does not let a document's words reach an object lookup", async () => {
    const odd = ingestOf(
      [
        {
          doc: "D1",
          paragraph: 2,
          text: "2.1 constructor __proto__ toString are only words here.",
          clause: "2.1",
        },
        {
          doc: "D2",
          paragraph: 2,
          text: "1. Section __proto__ is deleted. Section constructor is amended.",
          clause: "1",
        },
      ],
      [],
    );
    const { finding } = await verify(
      draft({
        status: "deviation",
        evidence: [cite(odd, "D1-p2", "constructor __proto__ toString are only")],
      }),
      { ingest: odd, bundleLabels: ["D1-p2"], enabledChecks: ["C1", "C2"] },
    );
    expect(finding.evidence[0]!.quoteCheck).toBe("verified");
  });
});

describe("huge input", () => {
  const within = async (limitMs: number, run: () => Promise<unknown>) => {
    const started = Date.now();
    await run();
    expect(Date.now() - started).toBeLessThan(limitMs);
  };

  it("refuses a megabyte quote without reading it, and keeps the finding a sensible size", async () => {
    const huge = "word ".repeat(300_000);
    await within(3000, async () => {
      const { finding } = await verify(
        draft({ status: "deviation", evidence: [cite(ingest, "D1-p19", huge)] }),
      );
      expect(finding.evidence[0]!.quoteCheck).toBe("not_found");
      expect(finding.evidence[0]!.quote.length).toBe(4000);
      expect(finding.escalations[0]!.detail).toBe("evidence 1 (D1-p19): quote_too_long");
      expect(JSON.stringify(finding).length).toBeLessThan(20_000);
    });
  });

  it("reads a quote that opens a sentence with a long run of digits in bounded time", async () => {
    // The defined_term check used to backtrack exponentially on a segment that starts with a long
    // run of digits followed by a character that is not a digit, a space or a list marker.
    const run = async (digits: number) => {
      const lead = "1".repeat(digits);
      const hostile = ingestOf([
        {
          doc: "D1",
          paragraph: 2,
          text: `6.1 Reference. ${lead}, Receiving Party shall continue for two (2) years from the date of each disclosure.`,
          clause: "6.1",
        },
      ]);
      const quote = `${lead}, Receiving Party shall continue for two (2) years from the date`;
      const started = Date.now();
      const { finding } = await verify(
        draft({
          status: "compliant",
          evidence: [cite(hostile, "D1-p2", quote, "governing")],
        }),
        { ingest: hostile, bundleLabels: ["D1-p2"], enabledChecks: ["C1", "C2"] },
      );
      expect(finding.evidence[0]!.quoteCheck).toBe("verified");
      return Date.now() - started;
    };
    expect(await run(26)).toBeLessThan(250);
    // The longest run a quote can hold. A quadratic scan would still be fast here; a backtracking
    // one would not finish.
    expect(await run(1900)).toBeLessThan(1000);
  });

  it("keeps a quote of any kind to a sensible size in the finding", async () => {
    // Refused for its length is not the only way to be refused: a quote for a span the model was
    // not shown, an empty quote and a quote that is not in its span must not bloat the finding.
    const padded = `wxyz${" ".repeat(10_000)}abcdefghijklmnop`;
    const cases: [string, string, string][] = [
      ["a span outside the bundle", "D2-p3", "x".repeat(900_000)],
      ["an empty quote", "D1-p19", " ".repeat(15_000)],
      ["a quote that is not in its span", "D1-p19", padded],
    ];
    for (const [name, label, quote] of cases) {
      const { finding } = await verify(
        draft({
          status: "deviation",
          evidence: [
            cite(ingest, "D1-p29", "Sections 4, 5 and 8 survive"),
            cite(ingest, label, quote),
          ],
        }),
      );
      const stored = finding.evidence.find((e) => e.quoteCheck === "not_found")!;
      expect(stored.quote.length, name).toBeLessThanOrEqual(4000);
      expect(JSON.stringify(finding).length, name).toBeLessThan(20_000);
    }
  });

  it("does not repeat a very long span id, and does not choke on one", async () => {
    const id = `dv_x:p${"9".repeat(500_000)}`;
    await within(3000, async () => {
      const { finding } = await verify(
        draft({
          status: "deviation",
          evidence: [{ spanId: id, quote: QUOTE_TERM, role: "governing" }],
        }),
      );
      expect(finding.evidence).toEqual([]);
      expect(JSON.stringify(finding)).not.toContain("99999");
    });
  });

  it("reads a few thousand evidence items without going past the limit", async () => {
    const items = Array.from({ length: 20_000 }, (_, i) => ({
      spanId: spanOf(ingest, "D1-p19").id,
      quote: `${QUOTE_TERM} ${i}`,
      role: "supporting" as const,
    }));
    await within(3000, async () => {
      const { finding } = await verify(draft({ status: "deviation", evidence: items }));
      expect(finding.evidence.length).toBeLessThanOrEqual(MAX_EVIDENCE_ITEMS);
      expect(finding.escalations.some((e) => e.detail.includes("beyond the limit"))).toBe(true);
    });
  });

  it("reads a discrepancy of several megabytes in bounded time", async () => {
    const long = `The obligations last for two (2) years. ${"padding ".repeat(800_000)} nine (9) years`;
    await within(5000, async () => {
      const { finding } = await verify(
        draft({
          status: "deviation",
          evidence: [cite(ingest, "D1-p19", QUOTE_TERM)],
          discrepancy: long,
          explanation: long,
          fallbackLanguage: long,
        }),
      );
      // Only the start of such a text is read, which is the part that states the claim.
      expect(check(finding, "numeric_consistency").outcome).toBe("pass");
      expect(finding.fallbackBasis).toBe("generated");
    });
  });

  it("handles a hundred thousand escalation ids", async () => {
    const ids = Array.from({ length: 100_000 }, (_, i) => `id-${i}`);
    await within(3000, async () => {
      const { finding } = await verify(
        draft({
          status: "deviation",
          evidence: [cite(ingest, "D1-p19", QUOTE_TERM)],
          escalateWhenMatched: [...ids, "over-five-years"],
        }),
      );
      expect(check(finding, "playbook_escalation").detail).toContain(
        "100000 ids the rule does not have",
      );
      expect(finding.escalations).toEqual([
        { code: "playbook_escalation", detail: "escalateWhen: over-five-years" },
      ]);
    });
  });

  it("verifies against a run of thirty thousand spans", async () => {
    const specs = Array.from({ length: 30_000 }, (_, i) => ({
      doc: i % 2 === 0 ? ("D1" as const) : ("D2" as const),
      paragraph: Math.floor(i / 2),
      text: `${Math.floor(i / 2) + 1}.${(i % 2) + 1} The Receiving Party shall keep item ${i} secret.`,
      clause: `${Math.floor(i / 2) + 1}.${(i % 2) + 1}`,
    }));
    const big = ingestOf(
      specs,
      specs.slice(0, 5000).map((s) => ({
        kind: "keyword_hint" as const,
        spanId: `dv_${s.doc.toLowerCase()}:p${s.paragraph}`,
        category: "duration" as const,
      })),
    );
    const r = rule();
    // Built by hand: the helper that looks a label up would be quadratic and is not what is timed.
    const wholeDocument = {
      ruleKey: r.key,
      category: r.category,
      rule: r,
      spans: big.spans.map((s) => ({ spanId: s.id, why: "full_document" as const })),
      fullDocument: true,
      estimatedTokens: 1,
      budgetTokens: 12_000,
      overBudget: false,
    };
    await within(1500, async () => {
      const { finding } = await verifyFinding({
        draft: draft({ status: "missing" }),
        bundle: wholeDocument,
        rule: r,
        ingest: big,
        manifest: manifest(),
        enabledChecks: ["C1", "C2"],
      });
      expect(codes(finding)).toEqual(["missing_not_confirmed"]);
      // Thousands of hinted spans are named by a handful and a count.
      expect(finding.escalations[0]!.detail).toMatch(/and \d+ more/);
      expect(finding.escalations[0]!.detail.length).toBeLessThan(700);
    });
  });
});

describe("no document text, and no model text, in a check or an escalation", () => {
  const CANARY = "CANARY-7f3a";
  const secret = ingestOf(
    [
      {
        doc: "D1",
        paragraph: 2,
        text: `2.1 The Receiving Party shall protect Proprietary Information ${CANARY}-document for nine (9) years in Narnia.`,
        clause: "2.1",
      },
      {
        doc: "D2",
        paragraph: 2,
        text: `1. Section 2.1 is deleted ${CANARY}-amendment in its entirety.`,
        clause: "1",
      },
    ],
    [{ kind: "cross_reference", spanId: "dv_d2:p2", target: "2.1", verb: "deletes" }],
  );

  it("holds none of it, however many checks fail", async () => {
    const { checker, generator } = scriptedChecker("not_supported");
    const { finding } = await verify(
      draft({
        status: "compliant",
        evidence: [
          cite(
            secret,
            "D1-p2",
            `protect Proprietary Information ${CANARY}-document for nine (9) years`,
            "governing",
          ),
          cite(secret, "D1-p2", `${CANARY}-quote that is not in the span anywhere`, "supporting"),
          { spanId: `${CANARY}-spanid`, quote: `${CANARY}-q`, role: "governing" },
        ],
        discrepancy: `${CANARY}-discrepancy lasts 12 years under Atlantis law`,
        explanation: `${CANARY}-explanation 40% of $9,999 in Texas`,
        fallbackLanguage: `${CANARY}-fallback`,
        escalateWhenMatched: [`${CANARY}-id`, "over-five-years"],
        conflict: `${CANARY}-conflict`,
        abstainReason: `${CANARY}-abstain`,
      }),
      {
        ingest: secret,
        bundleLabels: ["D1-p2"],
        enabledChecks: ["C1", "C2"],
        supportChecker: checker,
        generator,
      },
    );
    expect(finding.escalations.length).toBeGreaterThan(4);
    const text = trail(finding);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain("Proprietary");
    expect(text).not.toContain("Narnia");
    expect(text).not.toContain("Atlantis");
    // The model's own prose is kept on the finding, where the reviewer reads it as the model's.
    expect(finding.discrepancy).toContain(CANARY);
    expect(finding.abstainReason).toContain(CANARY);
  });

  it("holds none of it in an undetermined finding's escalation", async () => {
    const { finding } = await verify(
      draft({ status: "undetermined", abstainReason: `${CANARY}-reason` }),
      { ingest: secret, bundleLabels: ["D1-p2"] },
    );
    expect(trail(finding)).not.toContain(CANARY);
  });

  it("holds none of it in the error for a mismatch of rules", async () => {
    const error = await verify(draft({ ruleKey: `${CANARY}-rule` })).catch((e: unknown) => e);
    expect(String((error as Error).message)).not.toContain(CANARY);
  });

  it("keeps the details short", async () => {
    const { finding } = await verify(baselineDraft(ingest), { enabledChecks: ["C1", "C2"] });
    for (const row of finding.checks) expect(row.detail.length).toBeLessThanOrEqual(703);
  });
});

describe("inputs", () => {
  it("are not changed: frozen inputs verify the same as live ones", async () => {
    const frozenIngest = deepFreeze(workedExample());
    const frozenDraft = deepFreeze(baselineDraft(ingest));
    const frozenManifest = deepFreeze(manifest());
    const frozenRule = deepFreeze(rule());
    const frozenBundle = deepFreeze(bundle(frozenIngest, ["D1-p19", "D1-p6", "D1-p29"]));
    const a = await verifyFinding({
      draft: frozenDraft,
      bundle: frozenBundle,
      rule: frozenRule,
      ingest: frozenIngest,
      manifest: frozenManifest,
      enabledChecks: Object.freeze(["C1", "C2"]) as unknown as string[],
    });
    const b = await verify(baselineDraft(ingest), { enabledChecks: ["C1", "C2"] });
    expect(a.finding).toEqual(b.finding);
  });

  it("do not share the evidence array with the finding", async () => {
    const d = baselineDraft(ingest);
    const before = JSON.stringify(d);
    const { finding } = await verify(d);
    finding.evidence[0]!.quote = "changed";
    expect(JSON.stringify(d)).toBe(before);
  });

  it("give the same finding whatever order the bundle lists its spans in", async () => {
    const a = await verify(baselineDraft(ingest), { bundleLabels: ["D1-p19", "D1-p6", "D1-p29"] });
    const b = await verify(baselineDraft(ingest), { bundleLabels: ["D1-p29", "D1-p19", "D1-p6"] });
    expect(a).toEqual(b);
  });
});
