import { createScriptedGenerator } from "@clausewise/llm/testing";
import { describe, expect, it } from "vitest";
import type { SupportChecker } from "../../src/module-contracts.js";
import {
  D1_DEFINITION,
  D1_SURVIVAL,
  D1_TERM,
  QUOTE_SURVIVAL,
  QUOTE_TERM,
  baselineDraft,
  callRecord,
  check,
  cite,
  codes,
  draft,
  rule,
  scriptedChecker,
  spanOf,
  verify,
  workedExample,
} from "./support-verify.js";

const ingest = workedExample();

describe("the model support check", () => {
  it("records a supported verdict on every cited quote, the call, and raises nothing", async () => {
    const { checker, generator } = scriptedChecker("supported");
    const { finding, calls } = await verify(baselineDraft(ingest), {
      supportChecker: checker,
      generator,
    });
    expect(finding.evidence.map((e) => e.supportCheck)).toEqual(["supported"]);
    expect(check(finding, "support")).toMatchObject({
      kind: "model",
      outcome: "pass",
      detail: "the checker found the claim supported by 1 cited span",
    });
    expect(calls).toEqual([callRecord()]);
    expect(finding.escalations).toEqual([]);
    expect(finding.verificationState).toBe("verified");
  });

  it("shows the checker only the cited spans, and nothing else in the bundle", async () => {
    const { checker, generator, inputs } = scriptedChecker("supported");
    await verify(baselineDraft(ingest), { supportChecker: checker, generator });
    expect(inputs).toHaveLength(1);
    const input = inputs[0]!;
    // D1-p6 and D1-p29 were in the bundle and are not cited.
    expect(input.citedSpans.map((s) => s.label)).toEqual(["D1-p19"]);
    expect(input.rule.key).toBe("dur-1");
    expect(input.draft.status).toBe("compliant");
    expect(input.generator).toBe(generator);
    const prompt = generator.calls[0]!.prompt;
    expect(prompt).toContain(D1_TERM);
    expect(prompt).not.toContain(D1_DEFINITION);
    expect(prompt).not.toContain(D1_SURVIVAL);
  });

  it("sends once, with one entry for a span cited twice", async () => {
    const { checker, generator, inputs } = scriptedChecker("supported");
    await verify(
      draft({
        status: "deviation",
        evidence: [
          cite(ingest, "D1-p19", QUOTE_TERM, "governing"),
          cite(ingest, "D1-p19", "The obligations of each Receiving Party", "supporting"),
          cite(ingest, "D1-p29", QUOTE_SURVIVAL, "supporting"),
        ],
      }),
      { supportChecker: checker, generator },
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.citedSpans.map((s) => s.label)).toEqual(["D1-p19", "D1-p29"]);
  });

  it("does not show a quote that did not verify, and leaves its support as not_run", async () => {
    const { checker, generator, inputs } = scriptedChecker("supported");
    const { finding } = await verify(
      draft({
        status: "deviation",
        evidence: [
          cite(ingest, "D1-p19", QUOTE_TERM, "governing"),
          cite(ingest, "D1-p29", "a sentence that is nowhere in the span at all", "supporting"),
        ],
      }),
      { supportChecker: checker, generator },
    );
    expect(inputs[0]!.citedSpans.map((s) => s.label)).toEqual(["D1-p19"]);
    expect(inputs[0]!.draft.evidence.map((e) => e.quote)).toEqual([QUOTE_TERM]);
    expect(finding.evidence.map((e) => e.supportCheck)).toEqual(["supported", "not_run"]);
  });

  it.each(["not_supported", "insufficient"] as const)(
    "raises support_not_confirmed for %s and keeps the status",
    async (verdict) => {
      const { checker, generator } = scriptedChecker(verdict);
      const { finding, calls } = await verify(baselineDraft(ingest), {
        supportChecker: checker,
        generator,
      });
      expect(finding.evidence[0]!.supportCheck).toBe(verdict);
      expect(finding.escalations).toEqual([
        {
          code: "support_not_confirmed",
          detail: `the checker's verdict over 1 cited span is ${verdict}`,
        },
      ]);
      expect(check(finding, "support").outcome).toBe("fail");
      expect(finding.status).toBe("compliant");
      expect(finding.verificationState).toBe("escalated_by_system");
      expect(calls).toHaveLength(1);
    },
  );

  it("does not copy the checker's missing premise, which is model text, into a detail", async () => {
    const { checker, generator } = scriptedChecker("not_supported");
    const { finding } = await verify(baselineDraft(ingest), { supportChecker: checker, generator });
    expect(JSON.stringify(finding.escalations)).not.toContain("a premise");
    expect(JSON.stringify(finding.checks)).not.toContain("a premise");
  });

  it("turns a checker that throws into support_not_confirmed, without its message", async () => {
    const { checker, generator, inputs } = scriptedChecker("throws");
    const { finding, calls } = await verify(baselineDraft(ingest), {
      supportChecker: checker,
      generator,
    });
    expect(inputs).toHaveLength(1);
    expect(finding.escalations).toEqual([
      {
        code: "support_not_confirmed",
        detail: "the support checker failed and gave no verdict, over 1 cited span",
      },
    ]);
    expect(JSON.stringify(finding)).not.toContain("document text");
    expect(finding.evidence[0]!.supportCheck).toBe("not_run");
    expect(calls).toEqual([]);
  });

  it("rethrows an AbortError from the checker", async () => {
    const { checker, generator } = scriptedChecker("abort");
    await expect(
      verify(baselineDraft(ingest), { supportChecker: checker, generator }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rethrows whatever the checker throws once the signal has aborted", async () => {
    const controller = new AbortController();
    const checker: SupportChecker = async () => {
      controller.abort();
      throw new TypeError("fetch failed");
    };
    await expect(
      verify(baselineDraft(ingest), {
        supportChecker: checker,
        generator: createScriptedGenerator(() => ({})),
        signal: controller.signal,
      }),
    ).rejects.toThrow("fetch failed");
  });

  it("does not call the checker when the signal has already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { checker, generator, inputs } = scriptedChecker("supported");
    await expect(
      verify(baselineDraft(ingest), {
        supportChecker: checker,
        generator,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(inputs).toEqual([]);
  });

  it("passes the signal on to the checker", async () => {
    const controller = new AbortController();
    const { checker, generator, inputs } = scriptedChecker("supported");
    await verify(baselineDraft(ingest), {
      supportChecker: checker,
      generator,
      signal: controller.signal,
    });
    expect(inputs[0]!.signal).toBe(controller.signal);
  });

  it("treats an answer without a usable verdict as a failed check", async () => {
    for (const reply of [undefined, null, {}, { answer: null }, { answer: { verdict: "maybe" } }]) {
      const checker = (async () => reply) as unknown as SupportChecker;
      const { finding, calls } = await verify(baselineDraft(ingest), {
        supportChecker: checker,
        generator: createScriptedGenerator(() => ({})),
      });
      expect(codes(finding), JSON.stringify(reply)).toEqual(["support_not_confirmed"]);
      expect(finding.escalations[0]!.detail).toBe(
        "the checker returned no usable verdict, over 1 cited span",
      );
      expect(calls).toEqual([]);
    }
  });

  it("keeps the call record of an answer it cannot use", async () => {
    const checker = (async () => ({
      answer: { verdict: "maybe" },
      call: callRecord({ outcome: "semantic_error" }),
    })) as unknown as SupportChecker;
    const { calls } = await verify(baselineDraft(ingest), {
      supportChecker: checker,
      generator: createScriptedGenerator(() => ({})),
    });
    expect(calls).toEqual([callRecord({ outcome: "semantic_error" })]);
  });

  it("lets a checker that needs a generator fail visibly when verify was given none", async () => {
    const checker: SupportChecker = async (input) => {
      await input.generator.generate({
        system: "s",
        prompt: "p",
        schema: (await import("../../src/contracts.js")).SupportSchema,
      });
      return { answer: { verdict: "supported", missingPremise: null }, call: callRecord() };
    };
    const { finding } = await verify(baselineDraft(ingest), { supportChecker: checker });
    expect(codes(finding)).toEqual(["support_not_confirmed"]);
  });

  describe("when it is not called", () => {
    const notCalled = async (
      d: ReturnType<typeof draft>,
      fullDocument = false,
      ruleOf: ReturnType<typeof rule> = rule(),
    ) => {
      const { checker, generator, inputs } = scriptedChecker("supported");
      const { finding, calls } = await verify(d, {
        supportChecker: checker,
        generator,
        fullDocument,
        rule: ruleOf,
      });
      expect(inputs).toEqual([]);
      expect(calls).toEqual([]);
      return finding;
    };

    it.each(["missing", "not_applicable", "undetermined"] as const)(
      "for status %s",
      async (status) => {
        // The status is the playbook's to settle: not_applicable is only left alone on a rule that
        // is not required, and missing only on one that is.
        const finding = await notCalled(
          draft({ status, ...(status === "undetermined" ? { abstainReason: "unclear" } : {}) }),
          true,
          rule({ required: status !== "not_applicable" }),
        );
        expect(check(finding, "support")).toMatchObject({
          kind: "model",
          outcome: "not_applicable",
          detail: `status ${status} needs no support check`,
        });
        expect(finding.evidence).toEqual([]);
      },
    );

    it("when no quote verified, since there is nothing to show", async () => {
      const finding = await notCalled(
        draft({
          status: "compliant",
          evidence: [cite(ingest, "D1-p19", "words that are not in the clause")],
        }),
      );
      expect(check(finding, "support").detail).toBe("no verified quote to show the checker");
    });
  });

  describe("without a checker", () => {
    it("leaves support as not_run and records no support row", async () => {
      for (const supportChecker of [undefined, null]) {
        const { finding, calls } = await verify(baselineDraft(ingest), {
          ...(supportChecker === undefined ? {} : { supportChecker }),
        });
        expect(finding.evidence.map((e) => e.supportCheck)).toEqual(["not_run"]);
        expect(finding.checks.some((c) => c.id === "support")).toBe(false);
        expect(calls).toEqual([]);
      }
    });
  });

  it("runs whenever a checker is given, whatever check sets are enabled", async () => {
    const { checker, generator, inputs } = scriptedChecker("insufficient");
    const { finding } = await verify(baselineDraft(ingest), {
      supportChecker: checker,
      generator,
      enabledChecks: [],
    });
    expect(inputs).toHaveLength(1);
    expect(codes(finding)).toEqual(["support_not_confirmed"]);
    expect(finding.checks.map((c) => c.id)).toEqual(["support"]);
  });

  it("gives the checker the rule and the claimed texts, with the escalation ids the rule knows", async () => {
    const { checker, generator, inputs } = scriptedChecker("supported");
    await verify(
      draft({
        status: "deviation",
        evidence: [cite(ingest, "D1-p19", QUOTE_TERM)],
        discrepancy: "The clause is short.",
        explanation: "It sets a term.",
        escalateWhenMatched: ["over-five-years", "invented"],
      }),
      { supportChecker: checker, generator, rule: rule() },
    );
    expect(inputs[0]!.draft).toMatchObject({
      ruleKey: "dur-1",
      status: "deviation",
      discrepancy: "The clause is short.",
      explanation: "It sets a term.",
      escalateWhenMatched: ["over-five-years"],
    });
  });

  it("is combined with the other checks and does not hide them", async () => {
    const { checker, generator } = scriptedChecker("supported");
    const { finding } = await verify(baselineDraft(ingest), {
      supportChecker: checker,
      generator,
      enabledChecks: ["C1", "C2"],
    });
    // Supported by the cited clause alone, which is exactly the gap C2 exists for.
    expect(finding.evidence[0]!.supportCheck).toBe("supported");
    expect(codes(finding)).toEqual(["superseded_evidence"]);
    expect(spanOf(ingest, "D1-p19").label).toBe("D1-p19");
  });
});
