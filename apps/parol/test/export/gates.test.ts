import { describe, expect, it } from "vitest";
import { MemoGateError, buildMemo } from "../../src/export/memo.js";
import { planMemo } from "../../src/export/plan.js";
import { MemoError, type MemoInput } from "../../src/module-contracts.js";
import {
  DUR_QUOTES,
  SPAN,
  SPAN_TEXTS,
  locationOf,
  memoFinding,
  passage,
  replaceFinding,
  review,
  verifiedFinding,
  withReview,
  workedExample,
} from "./support.js";

async function refusal(input: MemoInput): Promise<MemoGateError> {
  const error = await buildMemo(input).then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(MemoGateError);
  expect(error).toBeInstanceOf(MemoError);
  expect((error as Error).name).toBe("MemoError");
  return error as MemoGateError;
}

describe("the export gate: every finding needs a decision", () => {
  it("refuses a finding with no review and names its rule", async () => {
    const error = await refusal(withReview(workedExample(), "dur-1", null));
    expect(error.gate).toBe("unreviewed");
    expect(error.ruleKeys).toEqual(["dur-1"]);
    expect(error.message).toBe("1 finding(s) have no review decision: dur-1.");
  });

  it("names every undecided finding, not only the first", async () => {
    let input = withReview(workedExample(), "dur-1", null);
    input = withReview(input, "gov-1", null);
    input = withReview(input, "pty-1", null);
    const error = await refusal(input);
    expect(error.ruleKeys).toEqual(["pty-1", "dur-1", "gov-1"]);
    expect(error.message).toContain("3 finding(s) have no review decision: pty-1, dur-1, gov-1.");
  });

  it("treats a missing review the same as a null one", async () => {
    const input = replaceFinding(workedExample(), "dur-1", (item) => {
      const { review: _dropped, ...rest } = item;
      return rest as typeof item;
    });
    expect((await refusal(input)).gate).toBe("unreviewed");
  });

  it("is enforced by the planner alone, before any file is built", () => {
    expect(() => planMemo(withReview(workedExample(), "dur-1", null))).toThrow(MemoError);
  });

  it("does not refuse when every finding is decided, whatever the decision", async () => {
    let input = workedExample();
    for (const [key, decision] of [
      ["pty-1", "reject"],
      ["def-1", "escalate"],
      ["exc-1", "edit"],
      ["pds-1", "accept"],
    ] as const) {
      input = withReview(input, key, review(decision, { reason: "Because." }));
    }
    await expect(buildMemo(input)).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe("the export gate: a displayed quotation must verify against the stored text", () => {
  it("refuses a quotation that is no longer in its paragraph, naming rule, passage and span", async () => {
    const input = workedExample();
    // The stored paragraph changed after the finding was verified.
    input.spanTexts[SPAN.d2Deletes] =
      "Section 6.1 of the Agreement is amended to read three (3) years.";
    const error = await refusal(input);
    expect(error.gate).toBe("unverified_quote");
    expect(error.ruleKeys).toEqual(["dur-1"]);
    expect(error.message).toBe(
      `1 quotation(s) do not verify against the stored text: rule dur-1, passage 1, span ${SPAN.d2Deletes}.`,
    );
  });

  it("refuses when the span text is not supplied at all", async () => {
    const input = workedExample();
    delete input.spanTexts[SPAN.d1Duration];
    const error = await refusal(input);
    expect(error.gate).toBe("unverified_quote");
    expect(error.message).toContain(`rule dur-1, passage 2, span ${SPAN.d1Duration}`);
  });

  it("does not take a span id that happens to name an inherited property as supplied text", async () => {
    const finding = verifiedFinding({
      ruleKey: "dur-1",
      category: "duration",
      severity: "high",
      status: "deviation",
      evidence: [passage("constructor", "function", "governing")],
    });
    const input = replaceFinding(workedExample(), "dur-1", () =>
      memoFinding(finding, review("accept")),
    );
    expect((await refusal(input)).gate).toBe("unverified_quote");
  });

  it("reports every failing quotation, across findings", async () => {
    const input = workedExample();
    input.spanTexts[SPAN.d2Deletes] = "Changed.";
    input.spanTexts[SPAN.d1Law] = "Changed too.";
    const error = await refusal(input);
    expect(error.ruleKeys.slice().sort()).toEqual(["dur-1", "gov-1"]);
    expect(error.message).toContain("2 quotation(s) do not verify");
  });

  it("re-verifies a quotation whose stored check says verified", async () => {
    // The stored check is a claim from the past; only the text at export decides.
    const input = workedExample();
    const finding = input.findings[0]!.finding;
    expect(finding.evidence[0]!.quoteCheck).toBe("verified");
    input.spanTexts[finding.evidence[0]!.spanId] = "Something else entirely.";
    expect((await refusal(input)).gate).toBe("unverified_quote");
  });

  it("accepts a quotation that differs from the span only by quotation marks, dashes and spacing", async () => {
    // The same normalisation as the verify stage, so a clean quote is not refused for a curly mark.
    const input = workedExample();
    input.spanTexts[SPAN.d1Return] = SPAN_TEXTS[SPAN.d1Return]!.replace(
      "Within ten",
      "Within  ten",
    );
    await expect(buildMemo(input)).resolves.toBeInstanceOf(Uint8Array);
  });

  it("never prints a quotation that fails, and never puts it in the message", async () => {
    const secret = "Confidential wording that must not leak into an error";
    const finding = verifiedFinding({
      ruleKey: "dur-1",
      category: "duration",
      severity: "high",
      status: "deviation",
      evidence: [passage(SPAN.d1Duration, secret, "governing")],
    });
    const input = replaceFinding(workedExample(), "dur-1", () =>
      memoFinding(finding, review("accept")),
    );
    const error = await refusal(input);
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("Lanternfish");
    expect(error.message).not.toContain(SPAN_TEXTS[SPAN.d1Duration]!.slice(0, 30));
  });

  it("does not verify the quotations of a rejected finding, which are never shown", async () => {
    const input = withReview(workedExample(), "dur-1", review("reject", { reason: "No." }));
    input.spanTexts[SPAN.d2Deletes] = "Changed.";
    await expect(buildMemo(input)).resolves.toBeInstanceOf(Uint8Array);
  });

  it("does not verify a quotation whose stored check is not_found, which is omitted", async () => {
    const finding = verifiedFinding({
      ruleKey: "dur-1",
      category: "duration",
      severity: "high",
      status: "deviation",
      evidence: [
        passage(SPAN.d2Deletes, DUR_QUOTES.governing, "governing"),
        passage("dv_gone:p9", "text of a span that no longer exists", "supporting", "not_found"),
      ],
    });
    const input = replaceFinding(workedExample(), "dur-1", () => ({
      finding,
      locations: [locationOf(SPAN.d2Deletes), "Somewhere that no longer exists"],
      review: review("accept"),
    }));
    await expect(buildMemo(input)).resolves.toBeInstanceOf(Uint8Array);
  });

  it("refuses an empty quotation, which would verify nowhere", async () => {
    const finding = verifiedFinding({
      ruleKey: "dur-1",
      category: "duration",
      severity: "high",
      status: "deviation",
      evidence: [passage(SPAN.d2Deletes, "", "governing")],
    });
    const input = replaceFinding(workedExample(), "dur-1", () =>
      memoFinding(finding, review("accept")),
    );
    expect((await refusal(input)).gate).toBe("unverified_quote");
  });

  it("refuses a passage with no location, because a reader could not find it", async () => {
    const input = replaceFinding(workedExample(), "dur-1", (item) => ({
      ...item,
      locations: ["Amendment No. 1 (v1), Section 2, paragraph 3", "  ", "x"],
    }));
    const error = await refusal(input);
    expect(error.gate).toBe("unverified_quote");
    expect(error.message).toContain("rule dur-1, passage 2, no location");
  });

  it("refuses locations that do not line up with the passages", async () => {
    const input = replaceFinding(workedExample(), "dur-1", (item) => ({
      ...item,
      locations: item.locations.slice(0, 2),
    }));
    const error = await refusal(input);
    expect(error.gate).toBe("invalid_input");
    expect(error.message).toBe("Rule dur-1 has locations that do not match its passages.");
  });
});

describe("the export gate: the findings themselves", () => {
  it("refuses an empty list of findings", async () => {
    const error = await refusal({ ...workedExample(), findings: [], ruleSeverities: {} });
    expect(error.gate).toBe("no_findings");
    expect(error.message).toBe("The memo has no findings to report.");
  });

  it("refuses two findings that share a rule key", async () => {
    const input = workedExample();
    input.findings = [...input.findings, input.findings[5]!];
    const error = await refusal(input);
    expect(error.gate).toBe("duplicate_rule");
    expect(error.ruleKeys).toEqual(["dur-1"]);
    expect(error.message).toBe("More than one finding for rule dur-1.");
  });

  it("treats keys that differ only in case as the same rule", async () => {
    const input = workedExample();
    const twin = replaceFinding(input, "dur-1", (item) => ({
      ...item,
      finding: { ...item.finding, ruleKey: "DUR-1" },
    })).findings[5]!;
    input.findings = [...input.findings, twin];
    expect((await refusal(input)).gate).toBe("duplicate_rule");
  });

  it("refuses a rule that has no finding, so no rule is silently left out", async () => {
    const input = workedExample();
    input.ruleSeverities = { ...input.ruleSeverities, "xyz-9": "low" };
    const error = await refusal(input);
    expect(error.gate).toBe("missing_finding");
    expect(error.ruleKeys).toEqual(["xyz-9"]);
  });

  it("refuses a finding with no rule key", async () => {
    const input = workedExample();
    input.findings[0]!.finding.ruleKey = "  ";
    expect((await refusal(input)).gate).toBe("invalid_input");
  });

  it("refuses two different severities for one rule", async () => {
    const input = workedExample();
    input.ruleSeverities["dur-1"] = "low";
    const error = await refusal(input);
    expect(error.gate).toBe("invalid_input");
    expect(error.message).toBe("Rule dur-1 has two different severities.");
  });

  it("takes the severity from the finding when the caller gives none for the rule", async () => {
    const input = workedExample();
    delete input.ruleSeverities["dur-1"];
    await expect(buildMemo(input)).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe("the export gate: values the reviewer and the store supply", () => {
  it("refuses an edited status that is not a status", async () => {
    const input = replaceFinding(workedExample(), "dur-1", (item) => ({
      ...item,
      review: review("edit", { reason: "x", edits: { status: "mostly fine" } }),
    }));
    const error = await refusal(input);
    expect(error.gate).toBe("invalid_input");
    expect(error.message).toBe("The edited status on rule dur-1 is not a status.");
    expect(error.message).not.toContain("mostly fine");
  });

  it.each(["accept", "reject", "escalate"] as const)(
    "refuses a %s decision that carries edits, which only an edit decision may",
    async (decision) => {
      const input = replaceFinding(workedExample(), "pty-1", (item) => ({
        ...item,
        review: review(decision, { reason: "x", edits: { status: "deviation" } }),
      }));
      const error = await refusal(input);
      expect(error.gate).toBe("invalid_input");
      expect(error.ruleKeys).toEqual(["pty-1"]);
      expect(error.message).toBe("The decision on rule pty-1 is not an edit but carries edits.");
    },
  );

  it.each([
    ["status", { status: "deviation" }],
    ["discrepancy", { discrepancy: "A new discrepancy." }],
    ["fallbackLanguage", { fallbackLanguage: "" }],
  ])("refuses an accepted finding that carries an edited %s", async (_field, edits) => {
    const input = replaceFinding(workedExample(), "pty-1", (item) => ({
      ...item,
      review: review("accept", { edits }),
    }));
    expect((await refusal(input)).gate).toBe("invalid_input");
  });

  it("does not refuse a non-edit decision whose edits hold no field", async () => {
    for (const edits of [{}, { status: null, discrepancy: undefined, fallbackLanguage: null }]) {
      const input = replaceFinding(workedExample(), "pty-1", (item) => ({
        ...item,
        review: review("accept", { edits: edits as never }),
      }));
      await expect(buildMemo(input)).resolves.toBeInstanceOf(Uint8Array);
    }
  });

  it.each([
    ["discrepancy", { discrepancy: 4 }, "The edited discrepancy on rule dur-1 is not text."],
    [
      "language",
      { fallbackLanguage: { text: "x" } },
      "The edited proposed language on rule dur-1 is not text.",
    ],
    ["status", { status: 4 }, "The edited status on rule dur-1 is not a status."],
  ])("refuses an edited %s that is not text", async (_field, edits, message) => {
    const input = replaceFinding(workedExample(), "dur-1", (item) => ({
      ...item,
      review: review("edit", { reason: "x", edits: edits as never }),
    }));
    const error = await refusal(input);
    expect(error.gate).toBe("invalid_input");
    expect(error.message).toBe(message);
  });

  it("refuses a decision that is not one of the four", async () => {
    const input = replaceFinding(workedExample(), "dur-1", (item) => ({
      ...item,
      review: { ...review("accept"), decision: "approve" as never },
    }));
    expect((await refusal(input)).message).toBe("Rule dur-1 has an unknown decision.");
  });

  it("refuses a finding whose status is not a status", async () => {
    const input = workedExample();
    input.findings[0]!.finding.status = "fine" as never;
    expect((await refusal(input)).message).toBe("Rule pty-1 has an unknown status.");
  });

  it("refuses a decision with an impossible date", async () => {
    const input = replaceFinding(workedExample(), "dur-1", (item) => ({
      ...item,
      review: review("accept", { decidedAt: "2026-02-30T10:00:00Z" }),
    }));
    expect((await refusal(input)).message).toBe("The decision on rule dur-1 has no valid date.");
  });

  it.each(["not a date", "", "3 November 2026", "2026-13-01", "2026-11-03T25:00:00Z"])(
    "refuses an export date of %j",
    async (exportedAt) => {
      const error = await refusal({ ...workedExample(), exportedAt });
      expect(error.message).toBe("exportedAt is not an ISO 8601 date.");
    },
  );

  it("refuses a memo that names no documents", async () => {
    const error = await refusal({ ...workedExample(), documents: [] });
    expect(error.message).toBe("The memo names no documents.");
  });

  it("does not put a hostile rule key into a message", async () => {
    const input = workedExample();
    input.findings[0]!.finding.ruleKey = "<b>pty-1</b> {INCLUDETEXT}";
    input.findings[0]!.review = null;
    delete input.ruleSeverities["pty-1"];
    const error = await refusal(input);
    expect(error.message).toBe("1 finding(s) have no review decision: (unprintable id).");
  });
});
