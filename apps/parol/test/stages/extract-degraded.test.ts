import { createScriptedGenerator } from "@clausewise/llm/testing";
import { describe, expect, it } from "vitest";
import { CATEGORY_IDS } from "../../src/contracts.js";
import { getPrompt } from "../../src/prompts/registry.js";
import { runAnalyze } from "../../src/stages/analyze.js";
import { runExtract } from "../../src/stages/extract.js";
import { buildBundles } from "../../src/stages/retrieve.js";
import {
  MODEL_FAILURES,
  DEMO_RULES,
  answerOf,
  splitContract,
  workedExample,
} from "./support-stages.js";

/**
 * The three stages together, with scripted models: a failed extract call must lead to analysis
 * of the whole documents, and nothing the stages produce may reach outside the run.
 */

const fx = workedExample();

async function pipeline(
  extractModel: ReturnType<typeof createScriptedGenerator>,
  policy: "R1" | "R2",
) {
  const extract = await runExtract({
    generator: extractModel,
    ingest: fx.ingest,
    manifest: fx.manifest,
    prompt: getPrompt("extract.p1"),
  });
  const bundles = buildBundles({
    ingest: fx.ingest,
    extract: extract.output,
    rules: DEMO_RULES,
    policy,
    budgetTokens: 100_000,
  });
  return { extract, bundles };
}

describe("a degraded extract leads to whole-document bundles", () => {
  for (const failure of MODEL_FAILURES) {
    it(`after ${failure.name}, every rule reads every span of every document`, async () => {
      const { extract, bundles } = await pipeline(
        createScriptedGenerator(() => {
          throw failure.make();
        }),
        "R1",
      );
      expect(extract.output.degraded).toBe(true);
      expect(bundles).toHaveLength(DEMO_RULES.length);
      for (const bundle of bundles) {
        expect(bundle.fullDocument, bundle.ruleKey).toBe(true);
        expect(
          bundle.spans.map((s) => s.spanId),
          bundle.ruleKey,
        ).toEqual(fx.ingest.spans.map((s) => s.id));
      }
    });
  }

  it("shows the analysis model every clause, so the amendment is read even though nothing was located", async () => {
    const { bundles } = await pipeline(
      createScriptedGenerator(() => {
        throw MODEL_FAILURES[0]!.make();
      }),
      "R1",
    );
    const dur = bundles.find((b) => b.ruleKey === "dur-1")!;
    const analysisModel = createScriptedGenerator(() =>
      answerOf({ status: "undetermined", abstainReason: "x" }),
    );
    await runAnalyze({
      generator: analysisModel,
      bundle: dur,
      ingest: fx.ingest,
      manifest: fx.manifest,
      prompt: getPrompt("analyze.p1"),
      repairAttempts: 1,
    });
    const { inside, outside } = splitContract(analysisModel.calls[0]!.prompt);
    for (const span of fx.ingest.spans) expect(inside).toContain(`[${span.modelLabel}]`);
    expect(inside).toContain("Section 6.1 of the Agreement is deleted in its entirety");
    expect(outside).toContain("The passages above are every paragraph of every document.");
  });

  it("is not whole-document when extract worked and located something", async () => {
    const term = fx.spanStarting("6.1 ");
    const { extract, bundles } = await pipeline(
      createScriptedGenerator(() => ({
        categories: [
          {
            category: "duration",
            passages: [{ span: term.modelLabel, quote: "two (2) years" }],
            notFoundReason: null,
          },
        ],
      })),
      "R1",
    );
    expect(extract.output.degraded).toBe(false);
    expect(bundles.find((b) => b.ruleKey === "dur-1")!.fullDocument).toBe(false);
    // The other categories were not located: whole document for them.
    const others = bundles.filter((b) => b.category !== "duration");
    expect(others.every((b) => b.fullDocument)).toBe(true);
    expect(CATEGORY_IDS).toContain("duration");
  });

  it("holds no span outside the run's documents when extract names ones that are not in it", async () => {
    const { bundles, extract } = await pipeline(
      createScriptedGenerator(() => ({
        categories: [
          {
            category: "duration",
            passages: [
              { span: "c999", quote: "x" },
              { span: "dv_other:p3", quote: "x" },
            ],
            notFoundReason: null,
          },
        ],
      })),
      "R2",
    );
    expect(extract.output.categories.duration.located).toEqual([]);
    const ids = new Set(fx.ingest.spans.map((s) => s.id));
    for (const bundle of bundles) {
      expect(
        bundle.spans.every((s) => ids.has(s.spanId)),
        bundle.ruleKey,
      ).toBe(true);
    }
    expect(bundles.find((b) => b.ruleKey === "dur-1")!.fullDocument).toBe(true);
  });
});
