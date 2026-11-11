import JSZip from "jszip";
import { afterAll, describe, expect, it } from "vitest";
import { buildMemo } from "../../src/export/memo.js";
import { REASON_CODES } from "../../src/contracts.js";
import type { MemoInput } from "../../src/module-contracts.js";
import { buildMemoInput } from "../../src/services/memo-input.js";
import { REASON_CODE_LABEL } from "../../src/server/views/feedback.js";
import { cleanup, decisionFor, makeWorld, reviewed } from "../services/support.js";
import { workedExample } from "./support.js";

afterAll(cleanup);

/**
 * The memo is the file that leaves the system, and what a reviewer says about why a finding was
 * edited or rejected is for the people who measure the pilot, not for the client (package W2.6a).
 * So the reason code and the minor-edit mark of a decision never reach the file: not through the
 * decision the memo prints, and not through the records the builder is handed along with it. The
 * later slices add the same test for a note, a missed issue and a rating below.
 */

/**
 * The codes whose words no sentence of a memo would use for another reason. "other" and "unclear"
 * are ordinary words, so their absence says nothing; the phrases "reason code" and "minor edit"
 * are checked for all.
 */
const DISTINCT = REASON_CODES.filter((code) => code.includes("_"));

const textOfMemo = async (bytes: Uint8Array): Promise<string> => {
  const zip = await JSZip.loadAsync(bytes);
  const parts: string[] = [];
  for (const name of Object.keys(zip.files).filter(
    (n) => n.endsWith(".xml") || n.endsWith(".rels"),
  ))
    parts.push(await zip.file(name)!.async("string"));
  return parts.join("\n");
};

describe("the memo builder", () => {
  it("makes the same file whatever codes and marks the records it is handed carry", async () => {
    const plain = await buildMemo(workedExample());
    for (const [code, minor] of [
      ["wrong_evidence", true],
      ["other", false],
      ["bad_fallback", null],
    ] as const) {
      const input = workedExample();
      // What a real run hands the builder: each finding is a record with its decisions, and each
      // decision carries the code and the mark. The builder is given them and may not print them.
      input.findings = input.findings.map((item) => {
        const decision = item.review;
        const carried = {
          reviews: decision === null ? [] : [{ ...decision, reasonCode: code, minorEdit: minor }],
          currentReview:
            decision === null ? null : { ...decision, reasonCode: code, minorEdit: minor },
        };
        return {
          ...item,
          finding: { ...item.finding, ...carried } as typeof item.finding,
          review:
            decision === null
              ? null
              : ({ ...decision, reasonCode: code, minorEdit: minor } as typeof decision),
        };
      });
      const bytes = await buildMemo(input as MemoInput);
      expect(Buffer.from(bytes).equals(Buffer.from(plain)), `${code} ${String(minor)}`).toBe(true);
    }
  });

  it("says nothing of a code or of the mark in the text it writes", async () => {
    const text = await textOfMemo(await buildMemo(workedExample()));
    for (const code of DISTINCT) {
      expect(text).not.toContain(code);
      expect(text).not.toContain(REASON_CODE_LABEL[code]);
    }
    expect(text.toLowerCase()).not.toContain("minor edit");
    expect(text.toLowerCase()).not.toContain("reason code");
  });
});

describe("the memo of a review whose decisions carry codes", () => {
  it("is made from the decision, the reviewer, the time, the reason and the edits, and from nothing else of the decision", async () => {
    const w = makeWorld();
    const { matterId, am, reviewerAm, runId } = await reviewed(w);
    const issues = w.services.runs.issues(am, runId);
    const dur = issues.find((i) => i.ruleKey === "dur-1")!;
    const other = issues.find((i) => i.ruleKey === "pty-1")!;
    for (const issue of issues) {
      const view = w.services.runs.finding(reviewerAm, issue.findingId);
      if (issue === dur)
        w.services.reviews.decide(reviewerAm, issue.findingId, {
          decision: "edit",
          findingContentSha256: view.contentSha256,
          edits: { fallbackLanguage: "6.1 The obligations continue for two (2) years." },
          reason: "The parties agreed two years in February.",
          reasonCode: "wrong_evidence",
          minorEdit: true,
        });
      else if (issue === other)
        w.services.reviews.decide(reviewerAm, issue.findingId, {
          decision: "reject",
          findingContentSha256: view.contentSha256,
          edits: null,
          reason: "The party is named elsewhere.",
          reasonCode: "missed_context",
        });
      else w.services.reviews.decide(reviewerAm, issue.findingId, decisionFor(view));
    }
    const run = w.repo.getCurrentRun(matterId)!;
    const { input } = buildMemoInput({
      repo: w.repo,
      matterId,
      run,
      exporterId: reviewerAm.principal.userId,
      exportedAt: "2026-11-04T09:00:00.000Z",
    });
    const decisions = input.findings.map((item) => item.review);
    expect(decisions.every((d) => d !== null)).toBe(true);
    for (const decision of decisions)
      expect(Object.keys(decision!).sort()).toEqual([
        "decidedAt",
        "decision",
        "edits",
        "reason",
        "reviewerName",
      ]);
    // The records really do carry the codes, so the check above is not an empty one.
    const carried = input.findings
      .map(
        (item) =>
          (item.finding as { currentReview?: { reasonCode: string | null } }).currentReview
            ?.reasonCode,
      )
      .filter((code) => code !== undefined && code !== null);
    expect(carried.sort()).toEqual(["missed_context", "wrong_evidence"]);

    // The file that leaves is the file the builder makes of that input, and has none of the words.
    const memo = await w.services.reviews.exportMemo(reviewerAm);
    const file = await w.services.reviews.memoFile(am, memo.memoId);
    const text = await textOfMemo(file.bytes);
    expect(text).toContain("The parties agreed two years in February.");
    for (const code of DISTINCT) {
      expect(text).not.toContain(code);
      expect(text).not.toContain(REASON_CODE_LABEL[code]);
    }
    expect(text.toLowerCase()).not.toContain("minor edit");
  });

  it("is ready to export on the same terms as before: a code is not a gate", async () => {
    const w = makeWorld();
    const { matterId, am, reviewerAm, runId } = await reviewed(w);
    const issues = w.services.runs.issues(am, runId);
    const readiness = () => w.repo.getExportReadiness(matterId, runId);
    expect(readiness().ready).toBe(false);
    for (const issue of issues) {
      const view = w.services.runs.finding(reviewerAm, issue.findingId);
      w.services.reviews.decide(reviewerAm, issue.findingId, {
        decision: "reject",
        findingContentSha256: view.contentSha256,
        edits: null,
        reason: "r",
        reasonCode: "other",
      });
    }
    expect(readiness()).toMatchObject({ ready: true, blockers: [] });
  });
});
