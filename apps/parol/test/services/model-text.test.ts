import { afterAll, describe, expect, it } from "vitest";
import { findingContentSha256 } from "../../src/canonical.js";
import { keyAnswer } from "../integration/pipeline.js";
import { baseWorld, cleanup, decideAll, makeWorld, newMatter, uploadCase } from "./support.js";

afterAll(cleanup);

/**
 * A document can steer what a model writes, and the free text of an answer goes into the store and
 * into a hash that the export checks again after a round trip. Characters the store or the hash
 * cannot carry must cost one rule, or nothing, and never the whole review. The model here is a
 * scripted oracle that answers one rule with such characters in every free-text field; it says
 * nothing about any real model.
 */

const ODD = {
  nul: "ZQ-NUL a\u0000b",
  surrogate: "ZQ-SURR a\ud800b",
  both: "ZQ a\u0000b \udc00 c",
} as const;

function worldWith(rule: string, text: string) {
  const answer = {
    ...keyAnswer(baseWorld, rule),
    status: "deviation" as const,
    discrepancy: text,
    explanation: text,
    fallbackLanguage: text,
    conflict: text,
    abstainReason: text,
  };
  return makeWorld({ model: { answers: { [rule]: answer } } });
}

async function review(w: ReturnType<typeof makeWorld>) {
  const { matterId, am } = newMatter(w);
  await uploadCase(w, matterId);
  const run = w.services.runs.start(am, { workflowLabel: "v2" });
  await w.services.runs.idle();
  return { matterId, am, run, reviewerAm: w.grant(w.reviewer, matterId) };
}

describe("characters a model's free text cannot be allowed to carry", () => {
  it.each(Object.entries(ODD))(
    "%s in one rule's answer leaves the run finished and every rule with a finding",
    async (_name, text) => {
      const w = worldWith("ret-1", text);
      const { am, run } = await review(w);
      expect(w.services.runs.get(am, run.id).status).toBe("succeeded");
      const issues = w.services.runs.issues(am, run.id);
      expect(issues).toHaveLength(8);
      expect(w.logs.join("\n")).not.toContain("failed, internal");
      // The rule that was answered is still there, and no stored text carries a NUL.
      const finding = w.services.runs.finding(
        am,
        issues.find((i) => i.ruleKey === "ret-1")!.findingId,
      );
      expect(JSON.stringify(finding)).not.toContain("\\u0000");
    },
  );

  it("keeps the readable words of the answer, and marks what was replaced", async () => {
    const w = worldWith("ret-1", ODD.nul);
    const { matterId, run } = await review(w);
    const stored = w.repo.listFindings(matterId, run.id).find((f) => f.ruleKey === "ret-1")!;
    expect(stored.explanation).toBe("ZQ-NUL a�b");
    expect(stored.explanation).not.toContain("\u0000");
  });

  it("stores a lone surrogate so that the hash of the stored finding is the hash it was decided on", async () => {
    const w = worldWith("ret-1", ODD.surrogate);
    const { matterId, run } = await review(w);
    for (const stored of w.repo.listFindings(matterId, run.id)) {
      expect(findingContentSha256(stored), stored.ruleKey).toBe(stored.contentSha256);
    }
  });

  it("lets the memo be exported after every finding is decided, with a lone surrogate in one", async () => {
    const w = worldWith("ret-1", ODD.surrogate);
    const { run, reviewerAm } = await review(w);
    decideAll(w, reviewerAm, w.services.runs.issues(reviewerAm, run.id));
    const memo = await w.services.reviews.exportMemo(reviewerAm);
    expect(memo.memoId).toMatch(/^memo_/);
  });
});
