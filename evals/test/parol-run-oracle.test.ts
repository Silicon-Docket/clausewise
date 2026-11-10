import { readFileSync } from "node:fs";
import { ModelRequestError } from "@clausewise/llm";
import { createScriptedGenerator } from "@clausewise/llm/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { AnalysisSchema, LocateSchema, SupportSchema } from "../../apps/parol/src/contracts.js";
import { loadPlaybook } from "../../apps/parol/src/playbooks/load.js";
import { workflowFor } from "../../apps/parol/src/prompts/workflows.js";
import type { LoadedPlaybook, RegisteredWorkflow } from "../../apps/parol/src/module-contracts.js";
import { renderContractBlock } from "../../apps/parol/src/prompts/render.js";
import { RULE_CONCURRENCY as SERVICE_CONCURRENCY } from "../../apps/parol/src/services/runner.js";
import { loadDataset, selectCases, type Dataset } from "../src/parol/dataset.js";
import { ORACLE_MODEL, createKeyOracle, shownLabels } from "../src/parol/oracle.js";
import {
  EvaluationProviderFailure,
  Meter,
  RULE_CONCURRENCY,
  anchorProblems,
  observeRun,
  prepareCase,
  runStages,
  runnableCases,
  type ParsedFiles,
  type RunnableCase,
} from "../src/parol/runner.js";
import { scoreGroup, type ObservedRun } from "../src/parol/results.js";
import { REPO_ROOT } from "../src/parol/testing-run.js";

let dataset: Dataset;
let playbook: LoadedPlaybook;
beforeAll(async () => {
  const loaded = await loadDataset(REPO_ROOT);
  if (!loaded.ok) throw new Error(loaded.problems.join("; "));
  dataset = loaded.dataset;
  playbook = loadPlaybook({
    yaml: readFileSync(`${REPO_ROOT}/apps/parol/playbooks/parol-nda-recipient.yaml`, "utf8"),
    slug: "parol-nda-recipient",
  });
});

const signal = (): AbortSignal => new AbortController().signal;

async function prepared(caseKey: string, workflow = workflowFor("v1"), repeat = 1) {
  const [group] = selectCases(dataset, "dev", [caseKey]);
  const runnable = runnableCases(group!).find((r) => r.caseKey === caseKey)!;
  const parsed: ParsedFiles = new Map();
  return {
    runnable,
    prepared: await prepareCase({ dataset, runnable, repeat, playbook, workflow, parsed }),
  };
}

describe("the oracle", () => {
  it("reads the labels of the clauses a prompt shows from the contract block only", () => {
    const prompt =
      "Rule ID: dur-1\n<contract>\n[c3] 1 (section: D1 | Term)\nfirst\n\n[c12] 2.1\nsecond\n</contract>\n[c99] outside";
    expect([...shownLabels(prompt)]).toEqual(["c3", "c12"]);
    expect(shownLabels("no contract block here").size).toBe(0);
  });

  it("answers each rule with the key's status and cites only the clauses it was shown", async () => {
    const { runnable, prepared: p } = await prepared("PAROL-D05");
    const oracle = createKeyOracle({
      caseKey: runnable.caseKey,
      expect: runnable.expect,
      spans: p.ingest.spans,
      rules: playbook.rules,
    });
    const expectation = runnable.expect["dur-1"]!;
    expect(expectation.status).toBe("deviation");
    const governingRef = expectation.governing[0]!;
    const governingSpan = p.ingest.spans.find(
      (s) => s.docLabel === governingRef.doc && s.text.includes(governingRef.anchor),
    )!;
    const rule = playbook.rules.find((r) => r.key === "dur-1")!;
    const ask = (spans: typeof p.ingest.spans) =>
      oracle.generate({
        system: "s",
        prompt: `${renderContractBlock([...spans])}\n\nRule ID: ${rule.key}`,
        schemaName: "analyze_rule",
        schema: AnalysisSchema,
      });

    // Shown the governing clause: it is cited, as governing.
    const full = await ask(p.ingest.spans);
    expect(full.status).toBe("deviation");
    expect(full.evidence).toContainEqual({
      span: governingSpan.modelLabel,
      quote: governingRef.anchor,
      role: "governing",
    });
    // Shown nothing but another clause: the status is still the key's, and no label that was not
    // shown is cited, because a model can cite only what it reads.
    const other = p.ingest.spans.find((s) => s.id !== governingSpan.id)!;
    const narrowed = await ask([other]);
    expect(narrowed.status).toBe("deviation");
    expect(narrowed.evidence.every((e) => e.span === other.modelLabel)).toBe(true);
    expect(narrowed.evidence.some((e) => e.role === "governing")).toBe(false);
  });

  it("answers extract with every passage the key names, support with `supported`, and nothing else", async () => {
    const { runnable, prepared: p } = await prepared("PAROL-D05");
    const oracle = createKeyOracle({
      caseKey: runnable.caseKey,
      expect: runnable.expect,
      spans: p.ingest.spans,
      rules: playbook.rules,
    });
    expect(oracle.provider).toBe("oracle");
    expect(oracle.model).toBe(ORACLE_MODEL);
    expect(oracle.disclosure).toContain("not a language model");
    const located = await oracle.generate({
      system: "s",
      prompt: "p",
      schemaName: "locate_passages",
      schema: LocateSchema,
    });
    // Duration locates the deleting amendment (D2) as well as the NDA: the oracle is a perfect
    // reader, and a real model has to find the amendment on its own.
    const duration = located.categories.find((c) => c.category === "duration")!;
    expect(duration.passages.length).toBeGreaterThanOrEqual(2);
    expect(duration.notFoundReason).toBeNull();
    expect(
      await oracle.generate({
        system: "s",
        prompt: "p",
        schemaName: "check_support",
        schema: SupportSchema,
      }),
    ).toEqual({ verdict: "supported", missingPremise: null });
    await expect(
      oracle.generate({
        system: "s",
        prompt: "p",
        schemaName: "something_else",
        schema: SupportSchema,
      }),
    ).rejects.toThrow("the oracle does not know this kind of request");
  });

  it("resolves every anchor when it is built, so a key that no longer fits stops the run loudly", async () => {
    const { runnable, prepared: p } = await prepared("PAROL-D05");
    const drifted: RunnableCase = {
      ...runnable,
      expect: {
        ...runnable.expect,
        "dur-1": {
          ...runnable.expect["dur-1"]!,
          governing: [
            { ...runnable.expect["dur-1"]!.governing[0]!, anchor: "words that are in no document" },
          ],
        },
      },
    };
    expect(() =>
      createKeyOracle({
        caseKey: drifted.caseKey,
        expect: drifted.expect,
        spans: p.ingest.spans,
        rules: playbook.rules,
      }),
    ).toThrow(/PAROL-D05 .*it occurs 0 times, expected once/);
    expect(() =>
      createKeyOracle({
        caseKey: "PAROL-D05",
        expect: {},
        spans: p.ingest.spans,
        rules: playbook.rules,
      }),
    ).toThrow("the key has no expectation for the rule");
  });
});

describe("the stages, driven as the application's runner drives them", () => {
  it("uses the same rule concurrency as the application's runner", () => {
    expect(RULE_CONCURRENCY).toBe(SERVICE_CONCURRENCY);
  });

  // What a perfect oracle must score on each split of the committed dataset: the slots of its
  // cases, the expected flags, the required escalations and the required spans (the totals of
  // document 5, and the spans the keys name).
  const PERFECT = {
    dev: { split: "dev", slots: 112, flags: 18, required: 6, spans: 144, runs: 16 },
    heldout: { split: "heldout", slots: 96, flags: 18, required: 4, spans: 195, runs: 14 },
  } as const;

  it.each(Object.values(PERFECT))(
    "gives the oracle a perfect score on the $split split and its twins, under both workflows",
    async (expected) => {
      for (const label of ["v1", "v2"]) {
        const workflow = workflowFor(label);
        const [group] = selectCases(dataset, expected.split, []);
        const parsed: ParsedFiles = new Map();
        const observed: ObservedRun[] = [];
        for (const runnable of runnableCases(group!)) {
          const p = await prepareCase({ dataset, runnable, repeat: 1, playbook, workflow, parsed });
          const generator = createKeyOracle({
            caseKey: runnable.caseKey,
            expect: runnable.expect,
            spans: p.ingest.spans,
            rules: playbook.rules,
          });
          const result = await runStages({
            prepared: p,
            playbook,
            workflow,
            generator,
            signal: signal(),
          });
          // One extract call and one analyze call per rule, nothing repaired, nothing failed.
          expect(generator.calls).toHaveLength(9);
          expect(result.calls.every((c) => c.outcome === "ok")).toBe(true);
          const seen = observeRun(p, result);
          observed.push({
            split: expected.split,
            caseKey: runnable.caseKey,
            repeat: 1,
            slots: seen.slots,
            extraction: seen.extraction,
            spans: p.ingest.spans,
          });
        }
        expect(observed, label).toHaveLength(expected.runs);
        const scored = scoreGroup({
          rules: dataset.keys.playbook.rules,
          group: group!,
          repeats: 1,
          observed,
        });
        const m = scored.run!.repeats[0]!;
        expect(m.statusAccuracy, label).toMatchObject({
          numerator: expected.slots,
          denominator: expected.slots,
        });
        expect(m.silentMisses.total, label).toBe(0);
        expect(m.issues.recallStrict, label).toMatchObject({
          numerator: expected.flags,
          denominator: expected.flags,
        });
        expect(m.escalation.requiredRecall, label).toMatchObject({
          numerator: expected.required,
          denominator: expected.required,
        });
        expect(m.extraction.recall, label).toMatchObject({
          numerator: expected.spans,
          denominator: expected.spans,
        });
        expect(m.injection.effect, label).toMatchObject({ numerator: 0, denominator: 16 });
        expect(
          m.slotScores.every((s) => s.failure === null),
          label,
        ).toBe(true);
      }
    },
    120_000,
  );

  it("leaves out a document that a later version replaces, as a run does", async () => {
    const { runnable } = await prepared("PAROL-D05");
    const replaced: RunnableCase = {
      ...runnable,
      documents: runnable.documents.map((d) => (d.label === "D2" ? { ...d, operative: false } : d)),
    };
    const p = await prepareCase({
      dataset,
      runnable: replaced,
      repeat: 1,
      playbook,
      workflow: workflowFor("v1"),
      parsed: new Map(),
    });
    expect(p.manifest.documents.map((d) => d.label)).toEqual(["D1"]);
    expect(p.ingest.spans.every((s) => s.docLabel === "D1")).toBe(true);
    // The key still points into the amendment, which the run no longer has, and that is reported
    // before any model is paid for.
    expect(
      anchorProblems(p, replaced).some((x) => x.includes("the run has no such document")),
    ).toBe(true);
  });

  it("makes the twin run straight after its original and judges it by the original's key", async () => {
    const [group] = selectCases(dataset, "dev", ["PAROL-D08", "PAROL-D12"]);
    const runnables = runnableCases(group!);
    expect(runnables.map((r) => r.caseKey)).toEqual(["PAROL-D08", "PAROL-D08-twin", "PAROL-D12"]);
    expect(runnables[1]).toMatchObject({ twinOf: "PAROL-D08", split: "dev" });
    expect(runnables[1]!.expect).toBe(runnables[0]!.expect);
  });

  it("times the stages with the clock it is given", async () => {
    const { prepared: p } = await prepared("PAROL-D01");
    let t = 0;
    const generator = createKeyOracle({
      caseKey: "PAROL-D01",
      expect: (await prepared("PAROL-D01")).runnable.expect,
      spans: p.ingest.spans,
      rules: playbook.rules,
    });
    const result = await runStages({
      prepared: p,
      playbook,
      workflow: workflowFor("v1"),
      generator,
      signal: signal(),
      // Every reading advances the clock by 10 ms: started, the mark, then one reading per stage
      // (extract, retrieve, analyze, verify) and one for the total.
      clock: () => (t += 10),
    });
    expect(result.stagesMs).toEqual({ extract: 10, retrieve: 10, analyze: 10, verify: 10 });
    expect(result.totalMs).toBe(60);
  });

  it("does not send a rule that is over the context budget, and says why", async () => {
    const small: RegisteredWorkflow = {
      sha256: "0".repeat(64),
      manifest: { ...workflowFor("v1").manifest, budgetTokens: 1 },
    };
    const { runnable, prepared: p } = await prepared("PAROL-D01", small);
    const generator = createKeyOracle({
      caseKey: runnable.caseKey,
      expect: runnable.expect,
      spans: p.ingest.spans,
      rules: playbook.rules,
    });
    const result = await runStages({
      prepared: p,
      playbook,
      workflow: small,
      generator,
      signal: signal(),
    });
    // Only extract was asked. Every rule is undetermined with the budget code and no draft.
    expect(generator.calls).toHaveLength(1);
    expect(result.rulesOverBudget).toBe(8);
    expect(result.drafts.every((d) => d === undefined)).toBe(true);
    expect(result.findings.every((f) => f.status === "undetermined")).toBe(true);
    expect(
      result.findings.every(
        (f) => f.escalations.map((e) => e.code).join() === "context_over_budget",
      ),
    ).toBe(true);
  });

  it("turns an answer that never becomes valid into an undetermined finding and goes on", async () => {
    const { prepared: p, runnable } = await prepared("PAROL-D01");
    const oracle = createKeyOracle({
      caseKey: runnable.caseKey,
      expect: runnable.expect,
      spans: p.ingest.spans,
      rules: playbook.rules,
    });
    const broken = createScriptedGenerator(
      (request) =>
        request.schemaName === "analyze_rule" && request.prompt.includes("Rule ID: dur-1")
          ? { ...oracleAnswer(), evidence: [{ span: "c999999", quote: "x", role: "governing" }] }
          : oracle.generate(request as never),
      { provider: "oracle", model: "broken" },
    );
    function oracleAnswer() {
      return {
        status: "compliant",
        evidence: [],
        discrepancy: "",
        explanation: "",
        fallbackLanguage: null,
        escalateWhenMatched: [],
        conflict: null,
        abstainReason: null,
      };
    }
    const result = await runStages({
      prepared: p,
      playbook,
      workflow: workflowFor("v1"),
      generator: broken,
      signal: signal(),
    });
    const dur = result.findings.find((f) => f.ruleKey === "dur-1")!;
    expect(dur.status).toBe("undetermined");
    expect(dur.escalations.map((e) => e.code)).toEqual(["output_invalid"]);
    expect(result.drafts[result.findings.indexOf(dur)]).toBeUndefined();
    // The attempt and its one repair are both on record, both semantic errors.
    expect(result.calls.filter((c) => c.ruleKey === "dur-1").map((c) => c.outcome)).toEqual([
      "semantic_error",
      "semantic_error",
    ]);
    // The other seven rules were answered.
    expect(result.findings.filter((f) => f.status !== "undetermined").length).toBe(7);
  });

  it("stops with the provider failure when the provider rejects the key", async () => {
    const { prepared: p } = await prepared("PAROL-D01");
    const rejecting = createScriptedGenerator(() => {
      throw new ModelRequestError("rejected", 401);
    });
    const failure = await runStages({
      prepared: p,
      playbook,
      workflow: workflowFor("v1"),
      generator: rejecting,
      signal: signal(),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EvaluationProviderFailure);
    expect((failure as EvaluationProviderFailure).kind).toBe("provider_auth");
    // Stopped at extract: no rule was sent to a provider that would reject it again.
    expect(rejecting.calls).toHaveLength(1);
    expect((failure as Error).message).toBe("the model provider rejected the request");
  });

  it("stops when the signal is aborted, with the reason it was aborted for", async () => {
    const { prepared: p, runnable } = await prepared("PAROL-D01");
    const controller = new AbortController();
    const reason = new Error("the budget");
    controller.abort(reason);
    const generator = createKeyOracle({
      caseKey: runnable.caseKey,
      expect: runnable.expect,
      spans: p.ingest.spans,
      rules: playbook.rules,
    });
    await expect(
      runStages({
        prepared: p,
        playbook,
        workflow: workflowFor("v1"),
        generator,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(generator.calls).toHaveLength(0);
  });

  it("finds an anchor of the key that no longer resolves, without repeating the anchor", async () => {
    const { runnable, prepared: p } = await prepared("PAROL-D05");
    expect(anchorProblems(p, runnable)).toEqual([]);
    const drifted: RunnableCase = {
      ...runnable,
      expect: {
        ...runnable.expect,
        "dur-1": {
          ...runnable.expect["dur-1"]!,
          governing: [
            { ...runnable.expect["dur-1"]!.governing[0]!, anchor: "words that are in no document" },
          ],
          relevant: [{ doc: "D3", clause: "1", anchor: "x", paragraph: 0 }],
        },
      },
    };
    const problems = anchorProblems(p, drifted);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(
      /^PAROL-D05 dur-1 governing anchor 1 \(D2, clause \S+\): it occurs 0 times, expected once$/,
    );
    expect(problems[1]).toMatch(
      /^PAROL-D05 dur-1 relevant anchor 1 \(D3, clause 1\): the run has no such document$/,
    );
    expect(problems.join("\n")).not.toContain("words that are in no document");
  });
});

describe("the meter", () => {
  it("attributes usage to the run in progress and keeps the total", () => {
    const meter = new Meter();
    meter.begin();
    meter.countCall();
    meter.countCall();
    meter.onUsage({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 1 });
    expect(meter.take()).toEqual({
      calls: 2,
      usage: {
        responses: 1,
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 5,
        cacheWriteTokens: 1,
      },
    });
    meter.begin();
    meter.countCall();
    meter.onUsage({
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      attempts: [
        {
          model: "claude-a",
          inputTokens: 1,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        {
          model: undefined,
          inputTokens: 0,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
    });
    expect(meter.take().calls).toBe(1);
    expect(meter.take().usage.inputTokens).toBe(1);
    expect(meter.totalCalls).toBe(3);
    expect(meter.total).toMatchObject({
      responses: 2,
      inputTokens: 11,
      outputTokens: 3,
      cacheReadTokens: 5,
    });
    expect([...meter.reportedModels]).toEqual(["claude-a"]);
  });
});
