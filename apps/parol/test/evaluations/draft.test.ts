import { describe, expect, it } from "vitest";
import {
  DECISION_LABEL,
  GATE_IDS,
  HELDOUT_OPENED,
  MODE_WORDS,
  NOT_A_RECOMMENDATION,
  NOT_CLEAN,
  draftPromotionRecord,
  type ComparisonBody,
  type RunMode,
} from "../../src/evaluations/index.js";
import {
  comparisonBody,
  comparisonPage,
  devSection,
  gateViews,
  heldoutSection,
  sideFacts,
} from "./fixtures.js";

/**
 * The draft promotion record is text, made from a comparison and nothing else. It records
 * nothing, promotes nothing and is signed by no one; these tests hold it to that.
 */

const withModes = (baseline: RunMode, candidate: RunMode): ComparisonBody =>
  comparisonBody({
    sides: {
      baseline: sideFacts("v1", { mode: baseline }),
      candidate: sideFacts("v2", { mode: candidate }),
    },
  });

const draftOf = (body: ComparisonBody, split: "dev" | "heldout" = "dev"): string =>
  draftPromotionRecord(comparisonPage(body), split);

describe("the draft promotion record", () => {
  it("is the same text for the same page and split", () => {
    const page = comparisonPage();
    expect(draftPromotionRecord(page, "dev")).toBe(draftPromotionRecord(page, "dev"));
  });

  it("says in its first lines that it is a draft that decides and promotes nothing", () => {
    const text = draftOf(comparisonBody());
    const head = text.split("\n").slice(0, 3);
    expect(head[0]).toBe("# Promotion record (DRAFT, not signed)");
    expect(head[2]).toBe(
      "DRAFT TEXT FROM A COMPARISON FILE. IT IS NOT A DECISION AND IT PROMOTES NOTHING.",
    );
  });

  it("carries the capital words of each scripted or replayed mode, once and in order", () => {
    const text = draftOf(withModes("selftest", "replay"));
    expect(text).toContain(MODE_WORDS.selftest);
    expect(text).toContain(MODE_WORDS.replay);
    expect(text).not.toContain(MODE_WORDS.simulated);
    expect(text.indexOf(MODE_WORDS.selftest)).toBeLessThan(text.indexOf(MODE_WORDS.replay));
    const simulated = draftOf(withModes("simulated", "simulated"));
    expect(simulated.split(MODE_WORDS.simulated)).toHaveLength(2);
  });

  it("carries none of those words for a document of live runs", () => {
    const text = draftOf(withModes("live", "live"));
    for (const words of Object.values(MODE_WORDS)) expect(text).not.toContain(words);
    expect(text).toContain("mode live");
  });

  it("lists all fourteen gates, and for a gate that was not evaluated its reason", () => {
    const text = draftOf(comparisonBody());
    for (const id of GATE_IDS) expect(text).toMatch(new RegExp(`\\| ${id} \\|`));
    for (const gate of gateViews().filter((g) => g.outcome === "not_evaluated"))
      expect(text).toContain(`Not evaluated: ${gate.detail}`);
    // A gate that passed or failed says so in a word and gives no reason beside it.
    expect(text).toMatch(/\| G2 \|[^\n]*\| Pass \| Pass \|/);
    expect(text).toMatch(/\| G6 \|[^\n]*\| Fail \| Fail \|/);
  });

  it("says a gate has no report where a side has none", () => {
    const body = comparisonBody({
      sections: [devSection({ gates: { baseline: null, candidate: gateViews() } })],
    });
    expect(draftOf(body)).toMatch(/\| G1 \|[^\n]*\| no gate report \| Not evaluated:/);
    const none = comparisonBody({
      sections: [devSection({ gates: { baseline: null, candidate: null } })],
    });
    expect(draftOf(none)).toContain("No gate report was recorded for this split.");
  });

  it("leaves the sign-off blank", () => {
    const text = draftOf(comparisonBody());
    for (const blank of [
      "Decision: ____",
      "Conditions and review date: ____",
      "Signed off by (legal engineer): ____ Date: ____",
      "Supervising attorney (a real pilot only): ____ Date: ____",
    ])
      expect(text).toContain(blank);
  });

  it("names what it does not show", () => {
    const text = draftOf(comparisonBody());
    expect(text).toContain("What this record does not show");
    expect(text).toContain("Results files hold no model answers");
    expect(text).toContain("A comparison file proves nothing about who made it.");
    expect(text).toContain("A scripted or replayed run is not a measurement of a model.");
  });

  it("states how many of the paired slots changed, with the denominator", () => {
    const text = draftOf(comparisonBody());
    expect(text).toContain("2 of 8 paired slots changed (0 not paired).");
    expect(text).toContain("improvement: PAROL-D05 dur-1");
    expect(text).toContain(
      "baseline compliant x1, 0 of 1 right; candidate deviation x1, 1 of 1 right",
    );
  });

  it("says the decision rule was not applied, with the reason, when it was not", () => {
    const text = draftOf(comparisonBody());
    expect(text).toContain("Not applied: The decision rule was not applied: it needs a live run");
    expect(text).not.toContain("Conditions of the rule that this comparison cannot check");
  });

  it("states the result of the decision rule as a gate result, and not as a recommendation", () => {
    const decision = {
      outcome: "promote" as const,
      reasons: ["Every gate passed."],
      conditions: ["Review again in 30 days."],
      unchecked: ["The pilot has not run."],
    };
    const text = draftOf(
      comparisonBody({ sections: [devSection({ decision, decisionNote: null })] }),
    );
    expect(text).toContain(`${DECISION_LABEL.promote}. ${NOT_A_RECOMMENDATION}`);
    expect(text).toContain("- Every gate passed.");
    expect(text).toContain("- Condition: Review again in 30 days.");
    expect(text).toContain("Conditions of the rule that this comparison cannot check:");
    expect(text).toContain("- The pilot has not run.");
    expect(text).not.toContain("Not applied:");
    // The word is the application's and sits in one sentence only.
    expect(text.split(NOT_A_RECOMMENDATION).join("")).not.toMatch(/recommend/i);
  });

  it("never uses the word recommend, outside the one fixed sentence", () => {
    for (const body of [
      comparisonBody(),
      withModes("live", "live"),
      withModes("selftest", "replay"),
    ])
      expect(draftOf(body).split(NOT_A_RECOMMENDATION).join("")).not.toMatch(/recommend/i);
  });

  it("prints the held-out opened line when the file says the trails were opened, and not otherwise", () => {
    expect(draftOf(comparisonBody({ heldoutTrailsOpened: true }))).toContain(HELDOUT_OPENED);
    expect(draftOf(comparisonBody())).not.toContain(HELDOUT_OPENED);
  });

  it("prints a note of contamination only for the held-out split", () => {
    const note = "Two earlier live runs of this split used this workflow.";
    const body = comparisonBody({
      sides: {
        baseline: sideFacts("v1"),
        candidate: sideFacts("v2", { contamination: note }),
      },
      sections: [devSection(), heldoutSection()],
    });
    expect(draftOf(body, "dev")).not.toContain(note);
    expect(draftOf(body, "heldout")).toContain(`Candidate contamination note: ${note}`);
  });

  it("repeats NOT A CLEAN MEASUREMENT for a run that was not clean", () => {
    const body = comparisonBody({
      sides: {
        baseline: sideFacts("v1"),
        candidate: sideFacts("v2", {
          health: { clean: false, problems: ["3 calls failed on the wire."] },
        }),
      },
    });
    expect(draftOf(body)).toContain(`${NOT_CLEAN}: the candidate run. 3 calls failed on the wire.`);
    expect(draftOf(comparisonBody())).not.toContain(NOT_CLEAN);
  });

  it("names the workflows, the model as requested and as reported, the dataset and the commit", () => {
    const text = draftOf(
      comparisonBody({
        sides: {
          baseline: sideFacts("v1"),
          candidate: sideFacts("v2", {
            model: {
              provider: "stand-in",
              requested: "stand-in-reader",
              endpoint: null,
              reported: ["stand-in-reader-2"],
              reportedNote: "",
            },
            code: { commit: "abcdef0123456789", dirty: true },
          }),
        },
      }),
    );
    expect(text).toContain("Baseline version: workflow v1 (");
    expect(text).toContain("model requested stand-in-reader, reported stand-in-reader-2");
    expect(text).toContain("code abcdef0123456789, uncommitted changes");
    expect(text).toContain("model requested parol-simulated-reader, reported not reported");
    expect(text).toContain("Dataset: parol-cases v1;");
    expect(text).toContain("Playbook: parol-nda-recipient 1.0.1 (");
    expect(text).toContain("Evaluation version: parol-eval v2 (");
    expect(text).toContain("Baseline: 1 of 14 cases of the split, 1 repeat completed");
  });

  it("has no dash character, even when the file's own words have one", () => {
    const dashed = "A reason with an em dash \u2014 and an en dash \u2013 in it.";
    const body = comparisonBody({
      notes: [dashed],
      sections: [
        devSection({
          gates: { baseline: null, candidate: gateViews({ G1: { detail: dashed } }) },
          decisionNote: dashed,
        }),
      ],
    });
    const text = draftOf(body);
    expect(text).toContain("A reason with an em dash - and an en dash - in it.");
    expect(text).not.toMatch(/[\u2013\u2014]/);
    expect(draftOf(comparisonBody())).not.toMatch(/[\u2013\u2014]/);
  });

  it("keeps each table row on one line and shows an invisible character as a marker", () => {
    const hostile = "line one\nline two | with a bar \u202e and an override";
    const body = comparisonBody({
      sections: [
        devSection({
          gates: { baseline: null, candidate: gateViews({ G1: { detail: hostile } }) },
        }),
      ],
    });
    const text = draftOf(body);
    const row = text.split("\n").find((l) => l.startsWith("| G1 |"));
    expect(row).toBeDefined();
    expect(row).toContain("line one line two \\| with a bar [U+202E] and an override");
    expect(text).not.toContain("\u202e");
  });

  it("is for the section asked for, and for the first when the document has no such section", () => {
    const body = comparisonBody({ sections: [devSection(), heldoutSection()] });
    expect(draftOf(body, "dev")).toContain("Split: dev");
    expect(draftOf(body, "heldout")).toContain("Split: heldout");
    expect(draftOf(comparisonBody(), "heldout")).toContain("Split: dev");
  });
});
