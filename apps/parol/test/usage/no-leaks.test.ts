import { afterAll, describe, expect, it } from "vitest";
import { baseWorld } from "../services/support.js";
import { cleanup, decideAll, newMatter, uploadCase } from "../services/support.js";
import { noteModel } from "../../src/usage/metering.js";
import { CallCollector, callStore, createRunScope, runStore } from "../../src/usage/scope.js";
import { createCallPricer, parsePriceTable } from "../../src/usage/prices.js";
import type { AnalysisAnswer } from "../../src/contracts.js";
import { SpendRefusedError } from "../../src/services/errors.js";
import { nearWorst, reviewBound, spendWorld } from "./spend-support.js";
import { meteredWorld } from "./support.js";

afterAll(cleanup);

/**
 * Nothing the application records about usage, logs about it or shows of it holds document text, a
 * prompt, a matter's name or what a model said. The counts are numbers, the model is a plain name,
 * and a price table is a hash. The test plants a marker where the texts are (a matter's name, a
 * model's answer) and a real sentence of the documents, runs a review, and looks everywhere a
 * usage figure is put: the call rows, the run's reported model, the summary a page shows, the
 * service's log and the audit trail.
 */

const MARK = "LEAKMARK-4f8e2a91";

const ANSWER: AnalysisAnswer = {
  status: "missing",
  evidence: [],
  discrepancy: `The documents hold no clause on this. ${MARK} in the model's own words.`,
  explanation: `No paragraph covers the subject of the rule. ${MARK}.`,
  fallbackLanguage: null,
  escalateWhenMatched: [],
  conflict: null,
  abstainReason: null,
};

describe("a review with usage recorded", () => {
  it("leaves no text in a call row, the reported model, the summary, the log or the audit trail", async () => {
    const w = meteredWorld({
      reporter: {
        usageFor: () => ({
          inputTokens: 1234,
          outputTokens: 56,
          cacheReadTokens: 7,
          cacheWriteTokens: 8,
        }),
        modelFor: () => "model-a-20260101",
      },
      model: { answers: { "ret-1": ANSWER } },
      pricing: createCallPricer(
        parsePriceTable({ "model-a": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } }),
      ),
    });
    const { matterId, am } = newMatter(w, `Matter named ${MARK}`);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, { workflowLabel: "v2" });
    await w.services.runs.idle();
    expect(w.services.runs.get(am, run.id).status).toBe("succeeded");

    // A real sentence of the documents, to look for where only numbers should be.
    const spans = w.repo.listSpans(
      matterId,
      w.repo.getRun(matterId, run.id)!.manifest.documents.map((d) => d.documentVersionId),
    );
    const sentence = spans
      .map((s) => s.text)
      .sort((a, b) => b.length - a.length)[0]!
      .slice(0, 40);
    expect(sentence.length).toBe(40);

    const places: Record<string, string> = {
      "the call rows": JSON.stringify(w.repo.listModelCalls(matterId, run.id)),
      "the aggregate": JSON.stringify(w.repo.summarizeRunUsage(matterId, run.id)),
      "the reported model": JSON.stringify(w.repo.getRun(matterId, run.id)?.modelReported),
      "the usage a page shows": JSON.stringify(w.services.runs.get(am, run.id).usage),
      "the service log": w.logs.join("\n"),
      "the audit trail": JSON.stringify(w.repo.listAuditEvents({ matterId, limit: 100_000 })),
    };
    for (const [where, text] of Object.entries(places)) {
      expect(text.length, where).toBeGreaterThan(2);
      expect(text, where).not.toContain(MARK);
      expect(text, where).not.toContain(sentence);
      expect(text, where).not.toContain("Matter named");
      expect(text, where).not.toContain(baseWorld.manifest.clientLegalName);
    }

    // The planting worked: the marker is in the places that are meant to hold it.
    expect(JSON.stringify(w.repo.listFindings(matterId, run.id))).toContain(MARK);
    expect(JSON.stringify(w.repo.getMatter(matterId))).toContain(MARK);
    expect(spans.map((s) => s.text).join("\n")).toContain(sentence);
  });

  it("gives a reviewer who has decided the findings the same numbers and sentences, and no text", async () => {
    const w = meteredWorld({
      reporter: {
        usageFor: () => ({
          inputTokens: 10,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
        modelFor: () => "model-a",
      },
    });
    const { matterId, am } = newMatter(w, `Matter named ${MARK}`);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, { workflowLabel: "v2" });
    await w.services.runs.idle();
    const reviewerAm = w.grant(w.reviewer, matterId);
    const issues = w.services.runs.issues(reviewerAm, run.id);
    decideAll(w, reviewerAm, issues);
    const usage = JSON.stringify(w.services.runs.get(reviewerAm, run.id).usage);
    expect(usage).not.toContain(MARK);
    expect(usage).toMatch(/recorded model calls/);
  });
});

describe("a provider's reply that names something that is not a model", () => {
  it("leaves nothing behind: a sentence, a line break or a long text is not a model name", () => {
    const scope = createRunScope("run_x");
    const collector = new CallCollector();
    const hostile = [
      "Some document text that a provider repeated back",
      "name\nwith a break",
      `model-${"x".repeat(100)}`,
      "<script>alert(1)</script>",
      "",
      MARK + " with words",
    ];
    runStore.run(scope, () =>
      callStore.run(collector, () => {
        for (const name of hostile) noteModel(name);
      }),
    );
    expect(collector.models()).toEqual([]);
    expect(scope.models.size).toBe(0);
    // A plain name is kept.
    runStore.run(scope, () => callStore.run(collector, () => noteModel(MARK)));
    expect(collector.models()).toEqual([MARK]);
  });
});

describe("a review the spend guard refuses or stops", () => {
  const BOUND = reviewBound("v2");

  it("leaves no text in the refusal, the ledger, the log, the audit trail or the usage a page shows", async () => {
    // A review that goes on until its limit stops it, so the ledger, the log and the audit trail
    // have all been written by the stop; and one that is refused before it begins.
    const w = spendWorld({
      limits: { perReviewUsd: BOUND, perDayUsd: BOUND * 10 },
      usage: nearWorst(0.9),
      model: { answers: { "ret-1": ANSWER } },
    });
    const { matterId, am } = newMatter(w, `Matter named ${MARK}`);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, { workflowLabel: "v2" });
    await w.services.runs.idle();
    expect(w.services.runs.get(am, run.id).errorKind).toBe("spend_review_limit");

    const strict = w.restart({ perReviewUsd: BOUND * 0.5 });
    let refusal: unknown;
    try {
      strict.services.runs.resume(strict.grant(w.associate, matterId), run.id);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(SpendRefusedError);
    const refused = refusal as SpendRefusedError;

    const sentence = w.repo
      .listSpans(
        matterId,
        w.repo.getRun(matterId, run.id)!.manifest.documents.map((d) => d.documentVersionId),
      )
      .map((s) => s.text)
      .sort((a, b) => b.length - a.length)[0]!
      .slice(0, 40);
    const places: Record<string, string> = {
      "the refusal's words": refused.userText(),
      "the refusal's message": refused.message,
      "the refusal's figures": JSON.stringify(refused.figures),
      "the ledger": JSON.stringify(w.repo.db.prepare("SELECT * FROM spend_ledger").all()),
      "the service log": w.logs.join("\n"),
      "the audit trail": JSON.stringify(w.repo.listAuditEvents({ matterId, limit: 100_000 })),
      "the call rows": JSON.stringify(w.repo.listModelCalls(matterId, run.id)),
      "the usage a page shows": JSON.stringify(w.services.runs.get(am, run.id).usage),
    };
    for (const [where, text] of Object.entries(places)) {
      expect(text.length, where).toBeGreaterThan(2);
      expect(text, where).not.toContain(MARK);
      expect(text, where).not.toContain(sentence);
      expect(text, where).not.toContain("Matter named");
      expect(text, where).not.toContain(baseWorld.manifest.clientLegalName);
    }
    // The stop is in the places that say why the run ended, so a clean result means something.
    expect(places["the service log"]).toContain("spend_review_limit");
    expect(JSON.stringify(w.repo.getMatter(matterId))).toContain(MARK);
  });
});
