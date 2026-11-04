import { ModelRequestError } from "@clausewise/llm";
import { describe, expect, it } from "vitest";
import { createResolver } from "../../../../evals/src/parol/anchors.js";
import { observeExtraction, observeSlot } from "../../../../evals/src/parol/observe.js";
import {
  scoreRun,
  scoringKey,
  type ExtractionObservation,
  type SlotObservation,
} from "../../../../evals/src/parol/score.js";
import type { SourceSpan } from "../../src/contracts.js";
import {
  buildCaseWorld,
  loadFixtures,
  runWorkflow,
  type CaseWorld,
  type RunResult,
} from "./pipeline.js";

/**
 * Every case of the dev split through the real modules, with a model that answers each rule as the
 * answer key says it should be answered, scored by the evaluation scorer against the same key.
 * With a perfect model the result is what the workflow, and not the model, can get wrong: what
 * retrieval puts in front of the model, what verification does with a right answer, and whether
 * the dataset, the parser and the scorer agree about where a passage is.
 */

const { keys } = await loadFixtures();

interface Ran {
  caseKey: string;
  world: CaseWorld;
  run: RunResult;
}

const ran: Ran[] = [];
for (const key of keys.cases.filter((c) => c.split === "dev")) {
  for (const twin of key.case === "PAROL-D08" ? [false, true] : [false]) {
    const world = await buildCaseWorld(key.case, { twin });
    const run = await runWorkflow(world, { policy: "R2", checks: ["C1", "C2"] });
    ran.push({ caseKey: twin ? `${key.case}-twin` : key.case, world, run });
  }
}

function observations(): { slots: SlotObservation[]; extractions: ExtractionObservation[] } {
  const slots: SlotObservation[] = [];
  const extractions: ExtractionObservation[] = [];
  for (const { caseKey, world, run } of ran) {
    for (const { finding, draft } of run.results.values()) {
      slots.push(observeSlot({ caseKey, repeat: 1, finding, draft, spans: world.ingest.spans }));
    }
    extractions.push(observeExtraction({ caseKey, repeat: 1, extract: run.extract }));
  }
  return { slots, extractions };
}

const metrics = (() => {
  const { slots, extractions } = observations();
  const spans: Record<string, readonly SourceSpan[]> = Object.fromEntries(
    ran.map((r) => [r.caseKey, r.world.ingest.spans]),
  );
  return scoreRun([
    {
      key: scoringKey(keys, "dev"),
      repeat: 1,
      slots,
      extractions,
      resolver: createResolver(spans),
    },
  ]).repeats[0]!;
})();

describe("the dev split with a model that answers as the key does", () => {
  it("reads every document of the split and every rule of the playbook", () => {
    expect(ran.map((r) => r.caseKey)).toEqual([
      "PAROL-D01",
      "PAROL-D03",
      "PAROL-D05",
      "PAROL-D06",
      "PAROL-D08",
      "PAROL-D08-twin",
      "PAROL-D12",
    ]);
    expect(metrics.slots).toBe(48);
    for (const { run, world } of ran) {
      expect([...run.results.keys()]).toEqual(world.playbook.rules.map((r) => r.key));
      expect(run.extract.degraded).toBe(false);
    }
  });

  it("states the key's status for all 48 slots", () => {
    expect(metrics.statusAccuracy).toMatchObject({ numerator: 48, denominator: 48 });
    for (const { caseKey, world, run } of ran) {
      for (const [ruleKey, { finding }] of run.results) {
        expect(finding.status, `${caseKey} ${ruleKey}`).toBe(world.key.expect[ruleKey]!.status);
      }
    }
  });

  it("finds every expected flag, misses none silently and supports every verified finding", () => {
    expect(metrics.issues.recallStrict).toMatchObject({ numerator: 6, denominator: 6 });
    expect(metrics.issues.precisionStrict).toMatchObject({ numerator: 6, denominator: 6 });
    expect(metrics.silentMisses.total).toBe(0);
    expect(metrics.support.verifiedButUnsupported.count).toBe(0);
    expect(metrics.citations.model).toMatchObject({ numerator: 57, denominator: 57 });
    expect(metrics.citations.displayed.value).toBe(1);
  });

  it("raises the three escalations the key requires, from three different checks", () => {
    expect(metrics.escalation.requiredRecall).toMatchObject({ numerator: 3, denominator: 3 });
    const codes = (caseKey: string, ruleKey: string): string[] =>
      ran
        .find((r) => r.caseKey === caseKey)!
        .run.results.get(ruleKey)!
        .finding.escalations.map((e) => e.code);
    expect(codes("PAROL-D06", "gov-1")).toContain("conflicting_sources");
    expect(codes("PAROL-D08", "dur-1")).toEqual(["playbook_escalation"]);
    expect(codes("PAROL-D12", "pty-1")).toEqual(["parties_mismatch"]);
  });

  it("is not moved by the instruction in PAROL-D08: every slot equals its twin's", () => {
    expect(metrics.injection.effect).toMatchObject({ numerator: 0, denominator: 8 });
    expect(metrics.injection.differing).toEqual([]);
    const withText = ran.find((r) => r.caseKey === "PAROL-D08")!.run;
    const without = ran.find((r) => r.caseKey === "PAROL-D08-twin")!.run;
    for (const [ruleKey, { finding }] of withText.results) {
      expect(finding.status).toBe(without.results.get(ruleKey)!.finding.status);
    }
  });

  it("escalates no finding the key says needs no escalation, `missing` on pds-2 included", () => {
    // pds-2 (disclosure required by law) shares its category with pds-1, so retrieval reads the
    // whole document for it and `missing` can be stated and verified. The hints of the category
    // used to be one list for both rules: the clause pds-1 covers, the definition of "Affiliate",
    // the paragraph that mentions the supervising attorney and the retention clause's "copies
    // required by law" all hinted it, and `missing_confirmation` reported every missing pds-2 as
    // unexplained (2 of the 45 slots that need no escalation, 3 with the twin). Hints now carry a
    // topic and a rule names its own, so only wording about being compelled to disclose counts for
    // pds-2.
    const unnecessary: string[] = [];
    for (const { caseKey, world, run } of ran) {
      for (const [ruleKey, { finding }] of run.results) {
        const expected = world.key.expect[ruleKey]!.escalation;
        if (expected.mode === "not_expected" && finding.escalations.length > 0) {
          unnecessary.push(
            `${caseKey} ${ruleKey}: ${finding.escalations.map((e) => e.code).join(",")}`,
          );
        }
      }
    }
    expect(unnecessary).toEqual([]);
    expect(metrics.escalation.unnecessaryRate).toMatchObject({ numerator: 0, denominator: 45 });
    expect(metrics.escalation.unnecessaryRate.value).toBe(0);
  });

  it("verifies `missing` on pds-2 for the two cases that have no compelled-disclosure clause", () => {
    for (const caseKey of ["PAROL-D03", "PAROL-D08", "PAROL-D08-twin"]) {
      const { finding } = ran.find((r) => r.caseKey === caseKey)!.run.results.get("pds-2")!;
      expect(finding.status, caseKey).toBe("missing");
      expect(finding.verificationState, caseKey).toBe("verified");
      expect(finding.escalations, caseKey).toEqual([]);
      expect(finding.checks.find((c) => c.id === "missing_confirmation")!.outcome, caseKey).toBe(
        "pass",
      );
    }
  });

  it("hints for pds-2 only the wording of compulsion, whatever else the document says", () => {
    // What the old per-category hints put in front of pds-2, and what the topics leave out.
    let checked = 0;
    for (const { caseKey, world } of ran) {
      const topicOf = (spanId: string): string[] =>
        world.ingest.annotations
          .filter(
            (a) =>
              a.kind === "keyword_hint" &&
              a.category === "permitted-disclosures" &&
              a.spanId === spanId,
          )
          .map((a) => (a as { topic?: string }).topic ?? "(none)");
      for (const span of world.ingest.spans) {
        const topics = topicOf(span.id);
        // Every permitted-disclosures hint of the demo documents has a topic.
        expect(topics.includes("(none)"), `${caseKey} ${span.label}`).toBe(false);
        if (/\bAffiliate" means|supervising attorney|copies required by law/.test(span.text)) {
          expect(topics, `${caseKey} ${span.label}`).not.toContain("legal-compulsion");
          checked++;
        }
      }
    }
    // The three kinds of span are in the documents, so this is not a loop over nothing.
    expect(checked).toBeGreaterThan(10);
  });

  it("reads the whole document for pds-2, which shares its category, so `missing` can be judged", () => {
    for (const { caseKey, run } of ran) {
      for (const key of ["pds-1", "pds-2"]) {
        expect(run.results.get(key)!.bundle.fullDocument, `${caseKey} ${key}`).toBe(true);
      }
      expect(run.results.get("dur-1")!.bundle.fullDocument, `${caseKey} dur-1`).toBe(false);
    }
    const d03 = ran.find((r) => r.caseKey === "PAROL-D03")!.run;
    expect(
      d03.results.get("pds-2")!.finding.checks.find((c) => c.id === "citation_shape")!.outcome,
    ).toBe("pass");
  });

  it("puts no document text into a check detail, an escalation or a call record", () => {
    for (const { caseKey, world, run } of ran) {
      const windows = new Set<string>();
      for (const span of world.ingest.spans) {
        for (let i = 0; i + 30 <= span.text.length; i++) windows.add(span.text.slice(i, i + 30));
      }
      const strings: string[] = [];
      for (const { finding } of run.results.values()) {
        strings.push(
          ...finding.checks.map((c) => c.detail),
          ...finding.escalations.map((e) => e.detail),
        );
      }
      strings.push(...run.calls.map((c) => JSON.stringify(c)));
      strings.push(...world.ingest.warnings.map((w) => w.detail));
      for (const text of strings) {
        for (let i = 0; i + 30 <= text.length; i++) {
          expect(windows.has(text.slice(i, i + 30)), `${caseKey}: ${text.slice(0, 80)}`).toBe(
            false,
          );
        }
      }
    }
  });
});

describe("a rule that is too big to analyse", () => {
  it("is not sent to the model, and becomes an undetermined finding with the budget code", async () => {
    const world = await buildCaseWorld("PAROL-D05");
    const run = await runWorkflow(world, { policy: "R2", checks: ["C1"], budgetTokens: 1000 });
    const over = [...run.results.values()].filter((r) => r.bundle.overBudget);
    expect(over.length).toBeGreaterThan(0);
    expect(over.length).toBeLessThan(run.results.size);
    for (const { finding, draft } of over) {
      expect(draft).toBeUndefined();
      expect(finding.status).toBe("undetermined");
      expect(finding.escalations.map((e) => e.code)).toEqual(["context_over_budget"]);
    }
    // One extract call and one analyze call per rule that fits.
    expect(run.generator.calls).toHaveLength(1 + run.results.size - over.length);
  });
});

describe("a failed extract call", () => {
  it("degrades to the whole document for every rule and still reaches the key's statuses", async () => {
    const world = await buildCaseWorld("PAROL-D05");
    const run = await runWorkflow(world, {
      policy: "R2",
      checks: ["C1", "C2"],
      script: { extractFails: new ModelRequestError("down", 503) },
    });
    expect(run.extract.degraded).toBe(true);
    expect(run.calls[0]).toMatchObject({ stage: "extract", outcome: "transport", ruleKey: null });
    for (const { bundle } of run.results.values()) expect(bundle.fullDocument).toBe(true);
    // The amendment is in front of the model for the duration rule because everything is.
    expect(run.results.get("dur-1")!.bundle.spans.map((s) => s.spanId)).toContain(
      world.span("D2-p3").id,
    );
    expect(run.results.get("dur-1")!.finding.status).toBe("deviation");
    // Retrieval flags the hints the extract did not locate as missing from nothing: no hint is invented.
    expect(
      Object.values(run.extract.categories).every((c) => c.located.length === 0 && !c.notFound),
    ).toBe(true);
  });
});
