import { createScriptedGenerator } from "@clausewise/llm/testing";
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../src/canonical.js";
import { AnalysisSchema, type AnalysisAnswer, type ContextBundle } from "../../src/contracts.js";
import { getFragment, getPrompt } from "../../src/prompts/registry.js";
import { renderRule } from "../../src/prompts/render.js";
import { runAnalyze } from "../../src/stages/analyze.js";
import {
  answerOf,
  bundleOf,
  ruleOf,
  splitContract,
  workedExample,
  type Fixture,
} from "./support-stages.js";

const fx = workedExample();
const prompt = getPrompt("analyze.p1");
const term = fx.spanStarting("6.1 ");
const deletion = fx.spanStarting("2. Section 6.1");
const survival = fx.spanStarting("9.3 ");
const bundleR2 = bundleOf(fx, "dur-1", { duration: [term.label] }, { policy: "R2" });
const bundleR1 = bundleOf(fx, "dur-1", { duration: [term.label] }, { policy: "R1" });

const V2_ANSWER: AnalysisAnswer = answerOf({
  status: "deviation",
  evidence: [
    {
      span: deletion.modelLabel,
      quote: "Section 6.1 of the Agreement is deleted in its entirety",
      role: "governing",
    },
    {
      span: term.modelLabel,
      quote: "shall continue for two (2) years from the date of each disclosure",
      role: "superseded",
    },
    {
      span: survival.modelLabel,
      quote: "Sections 4, 5 and 8 survive any termination or expiration of this Agreement",
      role: "supporting",
    },
  ],
  discrepancy:
    "Amendment No. 1 deletes Section 6.1, the only time limit on the obligations in Section 4.",
  explanation: "The original two-year term no longer applies.",
  fallbackLanguage:
    "6.1 The obligations of each Receiving Party under Section 4 shall continue for three (3) years from the date of each disclosure of Confidential Information.",
});

const modelSaying = (answer: AnalysisAnswer) => createScriptedGenerator(() => answer);

function analyze(
  generator: ReturnType<typeof modelSaying>,
  over: Partial<Parameters<typeof runAnalyze>[0]> = {},
  fixture: Fixture = fx,
  bundle: ContextBundle = bundleR2,
) {
  return runAnalyze({
    generator,
    bundle,
    ingest: fixture.ingest,
    manifest: fixture.manifest,
    prompt,
    repairAttempts: 1,
    ...over,
  });
}

describe("runAnalyze: the worked example under R2", () => {
  it("maps the cited labels to span ids and keeps the roles and the model's words", async () => {
    const result = await analyze(modelSaying(V2_ANSWER));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft).toEqual({
      ruleKey: "dur-1",
      status: "deviation",
      evidence: [
        { spanId: deletion.id, quote: V2_ANSWER.evidence[0]!.quote, role: "governing" },
        { spanId: term.id, quote: V2_ANSWER.evidence[1]!.quote, role: "superseded" },
        { spanId: survival.id, quote: V2_ANSWER.evidence[2]!.quote, role: "supporting" },
      ],
      discrepancy: V2_ANSWER.discrepancy,
      explanation: V2_ANSWER.explanation,
      fallbackLanguage: V2_ANSWER.fallbackLanguage,
      escalateWhenMatched: [],
      conflict: null,
      abstainReason: null,
    });
    expect(result.calls).toHaveLength(1);
  });

  it("makes one call and records it as ok", async () => {
    const generator = modelSaying(V2_ANSWER);
    const result = await analyze(generator);
    const request = generator.calls[0]!;
    expect(generator.calls).toHaveLength(1);
    expect(result.calls).toEqual([
      {
        stage: "analyze",
        ruleKey: "dur-1",
        promptVersionId: "analyze.p1",
        requestSha256: sha256Hex(request.system + request.prompt),
        attempt: 1,
        outcome: "ok",
        latencyMs: expect.any(Number),
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      },
    ]);
    expect(Number.isInteger(result.calls[0]!.latencyMs)).toBe(true);
  });

  it("passes the model the amendment clause under R2 and not under R1", async () => {
    const r2 = createScriptedGenerator(() => V2_ANSWER);
    const r1 = createScriptedGenerator(() => V2_ANSWER);
    await analyze(r2, {}, fx, bundleR2);
    await analyze(r1, {}, fx, bundleR1);
    expect(splitContract(r2.calls[0]!.prompt).inside).toContain(deletion.text);
    expect(splitContract(r1.calls[0]!.prompt).inside).not.toContain(deletion.text);
  });
});

describe("runAnalyze: what the model is sent", () => {
  const send = async (bundle: ContextBundle = bundleR2, fixture: Fixture = fx) => {
    const generator = modelSaying(V2_ANSWER);
    await analyze(generator, {}, fixture, bundle);
    return generator.calls[0]!;
  };

  it("sends the prompt's system text, the analysis schema and the schema name", async () => {
    const request = await send();
    expect(request.system).toBe(prompt.definition.system);
    expect(request.schema).toBe(AnalysisSchema);
    expect(request.schemaName).toBe(prompt.definition.schemaName);
  });

  it("renders only the spans of the bundle, each under its model label", async () => {
    const request = await send(bundleR1);
    const { inside } = splitContract(request.prompt);
    const inBundle = new Set(bundleR1.spans.map((s) => s.spanId));
    for (const span of fx.ingest.spans) {
      if (inBundle.has(span.id)) {
        expect(inside, span.label).toContain(`[${span.modelLabel}]`);
        expect(inside, span.label).toContain(span.text);
      } else {
        expect(inside, span.label).not.toContain(`[${span.modelLabel}]`);
        // A short text can be another clause's heading, which is shown with that clause.
        if (span.text.length > 40) expect(inside, span.label).not.toContain(span.text);
      }
    }
    const headers = inside.split("\n").filter((l) => /^\[c\d+\]/.test(l));
    expect(headers).toHaveLength(bundleR1.spans.length);
  });

  it("puts the contract block first and passes it as the shared prefix", async () => {
    const request = await send();
    const block = request.prompt.slice(
      0,
      request.prompt.indexOf("\n</contract>") + "\n</contract>".length,
    );
    expect(request.sharedPrefix).toBe(block);
    expect(request.prompt.startsWith(request.sharedPrefix!)).toBe(true);
    expect(request.sharedPrefix!.startsWith("<contract>\n")).toBe(true);
    expect(request.sharedPrefix!.endsWith("</contract>")).toBe(true);
  });

  it("shares one prefix between rules that read the same spans", async () => {
    const located = { "permitted-disclosures": [fx.spanStarting("3.1 ").label] };
    const pds1 = await send(bundleOf(fx, "pds-1", located));
    const pds2 = await send(bundleOf(fx, "pds-2", located));
    expect(pds1.sharedPrefix).toBe(pds2.sharedPrefix);
    expect(pds1.prompt).not.toBe(pds2.prompt);
  });

  it("follows the contract with the documents, the client, the rule and the instruction, in that order", async () => {
    const { prompt: sent } = await send();
    const at = [
      "</contract>",
      "Documents:\nD1 (the NDA): Mutual NDA, stated date 2026-02-02\nD2 (an amendment): Amendment No. 1, stated date 2026-09-15",
      "Our client: Lanternfish Software, Inc.",
      "The passages above are a selection from the documents, chosen for this rule.",
      "Rule:\nRule ID: dur-1",
      'Check the documents above against the rule with ID "dur-1" and return the structured object for that rule only.',
    ].map((needle) => sent.indexOf(needle));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(sent.endsWith("for that rule only.")).toBe(true);
  });

  it("states the rule in full: every field and each escalation id with its text", async () => {
    const { prompt: sent } = await send();
    expect(sent).toContain(renderRule(ruleOf("dur-1")));
    const rule = ruleOf("dur-1");
    for (const needle of [
      rule.title,
      rule.kind,
      rule.severity,
      rule.standard.trim(),
      rule.fallback!.trim(),
      rule.unacceptable!.trim(),
      rule.fallbackLanguage!.trim(),
      "over-five-years",
      rule.escalateWhen[0]!.text.trim(),
    ]) {
      expect(sent).toContain(needle);
    }
    expect(sent).toMatch(/Required: yes/);
  });

  it("includes the guidance a rule has", async () => {
    const located = { parties: [fx.spanStarting("This Mutual Nondisclosure").label] };
    const { prompt: sent } = await send(bundleOf(fx, "pty-1", located));
    expect(sent).toContain(`Guidance: ${ruleOf("pty-1").guidance!.trim()}`);
  });

  it("says whether the passages are every paragraph or a selection", async () => {
    const whole = await send(bundleOf(fx, "gov-1", {}));
    expect(whole.prompt).toContain("The passages above are every paragraph of every document.");
    expect(whole.prompt).not.toContain("are a selection");
    const part = await send();
    expect(part.prompt).toContain("The passages above are a selection from the documents");
    expect(part.prompt).not.toContain("every paragraph of every document");
  });

  it("takes the coverage sentence from the prompt's own prose, which its hash covers", async () => {
    const whole = await send(bundleOf(fx, "gov-1", {}));
    expect(whole.prompt).toContain(getFragment("analyze.p1", "coverageWhole"));
    const part = await send();
    expect(part.prompt).toContain(getFragment("analyze.p1", "coverageSelection"));
  });

  it("names the client and the documents outside the block, with the stated dates", async () => {
    const { outside, inside } = splitContract((await send()).prompt);
    expect(outside).toContain("Our client: Lanternfish Software, Inc.");
    expect(outside).toContain("stated date 2026-09-15");
    expect(inside).not.toContain("Our client");
    expect(inside).not.toContain("stated date");
  });

  it("tells the model when a stated date is missing", async () => {
    const dated = workedExample();
    dated.manifest.documents[1]!.statedDate = null;
    const { outside } = splitContract((await send(bundleR2, dated)).prompt);
    expect(outside).toContain("D2 (an amendment): Amendment No. 1, stated date not given");
  });

  it("does not send a span id, an annotation or a hint", async () => {
    const { prompt: sent } = await send();
    expect(sent).not.toContain("dv_d");
    expect(sent).not.toContain("keyword_hint");
    expect(sent).not.toContain("cross_reference");
    // Why a span is in the bundle is for the code and the reviewer, not the model.
    expect(sent).not.toMatch(/\bhint\b/);
  });

  it("sends the same request for the same input", async () => {
    const a = await send();
    const b = await send();
    expect(a.prompt).toBe(b.prompt);
    expect(a.system).toBe(b.system);
  });

  it("sends a different request when the bundle differs", async () => {
    expect((await send(bundleR1)).prompt).not.toBe((await send(bundleR2)).prompt);
  });
});

describe("runAnalyze: normalising a valid answer", () => {
  it("accepts a label copied with brackets and removes repeated evidence", async () => {
    const result = await analyze(
      modelSaying(
        answerOf({
          status: "compliant",
          evidence: [
            { span: `[${term.modelLabel}]`, quote: "two (2) years", role: "governing" },
            { span: term.modelLabel, quote: "two (2) years", role: "governing" },
            { span: ` ${term.modelLabel} `, quote: "two (2) years", role: "supporting" },
          ],
        }),
      ),
    );
    expect(result.ok && result.draft.evidence).toEqual([
      { spanId: term.id, quote: "two (2) years", role: "governing" },
      { spanId: term.id, quote: "two (2) years", role: "supporting" },
    ]);
  });

  it("accepts a reason given with another status and drops it", async () => {
    const generator = modelSaying(answerOf({ status: "compliant", abstainReason: "just in case" }));
    const result = await analyze(generator);
    expect(result.ok && result.draft.abstainReason).toBeNull();
    expect(generator.calls).toHaveLength(1);
    expect(result.calls.map((c) => c.outcome)).toEqual(["ok"]);
  });

  it("keeps the reason of an undetermined status, tidied of blank values elsewhere", async () => {
    const result = await analyze(
      modelSaying(
        answerOf({
          status: "undetermined",
          abstainReason: "The two durations conflict.",
          conflict: "  ",
          fallbackLanguage: "",
        }),
      ),
    );
    expect(result.ok && result.draft).toMatchObject({
      status: "undetermined",
      abstainReason: "The two durations conflict.",
      conflict: null,
      fallbackLanguage: null,
    });
  });

  it("accepts escalation ids the rule has, once each", async () => {
    const result = await analyze(
      modelSaying(
        answerOf({
          status: "deviation",
          escalateWhenMatched: ["over-five-years", "over-five-years"],
        }),
      ),
    );
    expect(result.ok && result.draft.escalateWhenMatched).toEqual(["over-five-years"]);
  });

  it("accepts an answer with no evidence, as missing and not_applicable need", async () => {
    const result = await analyze(
      modelSaying(answerOf({ status: "missing", discrepancy: "No clause." })),
      {},
      fx,
      bundleOf(fx, "gov-1", {}),
    );
    expect(result.ok && result.draft.evidence).toEqual([]);
  });

  it("takes the rule key from the bundle, not from the model", async () => {
    const result = await analyze(modelSaying(answerOf()), {}, fx, bundleOf(fx, "ret-1", {}));
    expect(result.ok && result.draft.ruleKey).toBe("ret-1");
  });

  it("can cite a clause that is in a whole-document bundle but not in a selection", async () => {
    const whole = bundleOf(fx, "gov-1", {});
    const other = fx.spanStarting("4.1 ");
    const result = await analyze(
      modelSaying(
        answerOf({ evidence: [{ span: other.modelLabel, quote: "Purpose", role: "supporting" }] }),
      ),
      {},
      fx,
      whole,
    );
    expect(result.ok && result.draft.evidence[0]!.spanId).toBe(other.id);
  });
});

describe("runAnalyze: guards", () => {
  it("does not call the model for a bundle that is over budget", async () => {
    const over = bundleOf(fx, "dur-1", { duration: [term.label] }, { budgetTokens: 10 });
    expect(over.overBudget).toBe(true);
    const generator = modelSaying(V2_ANSWER);
    const result = await analyze(generator, {}, fx, over);
    expect(generator.calls).toHaveLength(0);
    expect(result).toEqual({
      ok: false,
      detail: expect.stringMatching(
        /^context_over_budget: about \d+ tokens against a budget of 10$/,
      ),
      calls: [],
    });
  });

  it("throws, naming only the id, for a bundle that names a span outside the run", async () => {
    const bad: ContextBundle = {
      ...bundleR1,
      spans: [...bundleR1.spans, { spanId: "dv_elsewhere:p7", why: "located" }],
    };
    await expect(analyze(modelSaying(V2_ANSWER), {}, fx, bad)).rejects.toThrow(
      "analyze: the bundle names span dv_elsewhere:p7, which is not in the run",
    );
  });

  it("does not log", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    await analyze(modelSaying(V2_ANSWER));
    await analyze(modelSaying(answerOf({ status: "undetermined" })));
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it("does not change its inputs", async () => {
    const before = JSON.stringify([bundleR2, fx.ingest, fx.manifest]);
    await analyze(modelSaying(V2_ANSWER));
    expect(JSON.stringify([bundleR2, fx.ingest, fx.manifest])).toBe(before);
  });
});

describe("runAnalyze: determinism", () => {
  it("gives the same draft for the same answer", async () => {
    const first = await analyze(modelSaying(V2_ANSWER));
    const second = await analyze(modelSaying(V2_ANSWER));
    expect(second.ok && first.ok && second.draft).toEqual(first.ok && first.draft);
    expect(second.calls[0]!.requestSha256).toBe(first.calls[0]!.requestSha256);
  });
});
