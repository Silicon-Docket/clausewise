import { describe, expect, it } from "vitest";
import { buildBundles } from "../../src/stages/retrieve.js";
import {
  DEMO_RULES,
  NDA_TEXT,
  buildFixture,
  extractOutput,
  labelsIn,
  ruleOf,
} from "./support-stages.js";

/**
 * Extract locates passages for a category, and the demo playbook has two rules in
 * `permitted-disclosures`. What was located for the category may be the clause of one of them, so
 * the other rule reads the whole document: otherwise it could never be judged `missing`, since it
 * would always be shown a sibling's clause and told, by the prompt, that it sees a selection.
 */

describe("rules that share a category", () => {
  const fx = buildFixture([NDA_TEXT]);
  const disclosure = fx.spanStarting("3.1 ").label;

  const bundles = (rules = DEMO_RULES) =>
    buildBundles({
      ingest: fx.ingest,
      extract: extractOutput(fx, {
        "permitted-disclosures": [disclosure],
        duration: [fx.spanStarting("6.1 ").label],
      }),
      rules,
      policy: "R1",
      budgetTokens: 12000,
    });

  it("reads the whole document for each of them, although a passage was located for the category", () => {
    const all = bundles();
    for (const key of ["pds-1", "pds-2"]) {
      const bundle = all.find((b) => b.ruleKey === key)!;
      expect(bundle.fullDocument, key).toBe(true);
      expect(labelsIn(bundle, fx)).toHaveLength(fx.ingest.spans.length);
      expect(
        bundle.spans.find(
          (s) => fx.ingest.spans.find((x) => x.id === s.spanId)!.label === disclosure,
        )?.why,
      ).toBe("located");
    }
  });

  it("keeps a selection for a rule that is alone in its category", () => {
    const duration = bundles().find((b) => b.ruleKey === "dur-1")!;
    expect(duration.fullDocument).toBe(false);
    expect(labelsIn(duration, fx).length).toBeLessThan(fx.ingest.spans.length);
  });

  it("keeps a selection for the rule once its sibling is out of the playbook", () => {
    const alone = bundles([ruleOf("pds-1"), ruleOf("dur-1")]);
    expect(alone.find((b) => b.ruleKey === "pds-1")!.fullDocument).toBe(false);
  });

  it("still reads the whole document when nothing was located, as before", () => {
    const none = buildBundles({
      ingest: fx.ingest,
      extract: extractOutput(fx, {}),
      rules: [ruleOf("dur-1")],
      policy: "R1",
      budgetTokens: 12000,
    });
    expect(none[0]!.fullDocument).toBe(true);
  });
});
