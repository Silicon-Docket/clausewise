import { describe, expect, it } from "vitest";
import { getPrompt } from "../../src/prompts/registry.js";
import { workflowFor } from "../../src/prompts/workflows.js";
import { buildAnalyzeRequest, runAnalyze, shownSpans } from "../../src/stages/analyze.js";
import { buildExtractRequest, emptyExtractOutput, runExtract } from "../../src/stages/extract.js";
import { buildBundles } from "../../src/stages/retrieve.js";
import { buildCaseWorld, scriptedModel } from "../integration/pipeline.js";

/**
 * The spend planner counts the requests the stages send by building them with the stages' own
 * builders, so a builder that drifts from what a stage sends would make the planned bound a bound
 * on another request. These tests compare each builder with the request a scripted generator
 * receives from the stage, byte for byte.
 */

const world = await buildCaseWorld("PAROL-D05");
const wm = workflowFor("v2").manifest;
const prompts = { extract: getPrompt(wm.prompts.extract), analyze: getPrompt(wm.prompts.analyze) };

describe("the extract request", () => {
  it("is what runExtract sends", async () => {
    const generator = scriptedModel(world);
    await runExtract({
      generator,
      ingest: world.ingest,
      manifest: world.manifest,
      prompt: prompts.extract,
    });
    expect(generator.calls).toHaveLength(1);
    const built = buildExtractRequest({
      ingest: world.ingest,
      manifest: world.manifest,
      prompt: prompts.extract,
    });
    expect(built.system).toBe(generator.calls[0]?.system);
    expect(built.prompt).toBe(generator.calls[0]?.prompt);
    // It carries the documents, so it is not a short template.
    expect(built.prompt.length).toBeGreaterThan(1000);
  });

  it("changes when a clause of the documents changes, so that the planned bound follows the documents", () => {
    const changed = {
      ...world.ingest,
      spans: world.ingest.spans.map((span, index) =>
        index === 0 ? { ...span, text: `${span.text} And a sentence more.` } : span,
      ),
    };
    const base = buildExtractRequest({
      ingest: world.ingest,
      manifest: world.manifest,
      prompt: prompts.extract,
    });
    const other = buildExtractRequest({
      ingest: changed,
      manifest: world.manifest,
      prompt: prompts.extract,
    });
    expect(other.prompt).not.toBe(base.prompt);
  });
});

describe("the analyze request", () => {
  const bundles = buildBundles({
    ingest: world.ingest,
    extract: emptyExtractOutput(world.ingest, { degraded: false, notFoundReason: "none" }),
    rules: world.playbook.rules,
    policy: wm.retrieval,
    budgetTokens: wm.budgetTokens,
  });

  it("is what runAnalyze sends for each rule, with the shared prefix it names", async () => {
    expect(bundles.length).toBe(world.playbook.rules.length);
    for (const bundle of bundles) {
      const generator = scriptedModel(world);
      await runAnalyze({
        generator,
        bundle,
        ingest: world.ingest,
        manifest: world.manifest,
        prompt: prompts.analyze,
        repairAttempts: 0,
      });
      expect(generator.calls, bundle.ruleKey).toHaveLength(1);
      const built = buildAnalyzeRequest({
        bundle,
        ingest: world.ingest,
        manifest: world.manifest,
        prompt: prompts.analyze,
      });
      expect(built.system, bundle.ruleKey).toBe(generator.calls[0]?.system);
      expect(built.prompt, bundle.ruleKey).toBe(generator.calls[0]?.prompt);
      expect(built.sharedPrefix, bundle.ruleKey).toBe(generator.calls[0]?.sharedPrefix);
    }
  });

  it("is the first prompt of a repair, which is that prompt and a note after it", async () => {
    const bundle = bundles[0]!;
    const generator = scriptedModel(world, { firstAnswerCitesUnknownClause: [bundle.ruleKey] });
    await runAnalyze({
      generator,
      bundle,
      ingest: world.ingest,
      manifest: world.manifest,
      prompt: prompts.analyze,
      repairAttempts: 1,
    });
    expect(generator.calls).toHaveLength(2);
    const built = buildAnalyzeRequest({
      bundle,
      ingest: world.ingest,
      manifest: world.manifest,
      prompt: prompts.analyze,
    });
    expect(generator.calls[0]?.prompt).toBe(built.prompt);
    expect(generator.calls[1]?.prompt.startsWith(`${built.prompt}\n\n`)).toBe(true);
  });

  it("shows the spans of the bundle, in its order, and refuses a bundle that names a span the run does not have", () => {
    const bundle = bundles[0]!;
    expect(shownSpans(bundle, world.ingest).map((s) => s.id)).toEqual(
      bundle.spans.map((s) => s.spanId),
    );
    expect(() =>
      shownSpans({ ...bundle, spans: [{ spanId: "no-such-span", why: "hint" }] }, world.ingest),
    ).toThrow(/not in the run/);
  });
});
