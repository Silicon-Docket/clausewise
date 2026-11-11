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
 * decision the memo prints, and not through the records the builder is handed along with it.
 *
 * Slice B: the same holds for the report of a missed issue. What a member says the review left out
 * is for the people who run the pilot; it is not part of the memo, so the memo input, the file built
 * from it and the words in the file are the same with reports and without.
 *
 * Slice C: the same holds for the rating of a matter. A rating is given after the memo is exported,
 * so the check is made both ways: a memo exported with ratings on record is the file it would have
 * been without them, and a memo exported again after members have rated is built from the same
 * input as before.
 *
 * Slice D: the same holds for a note on a finding. A note is for the reviewer who reads it, and is
 * not part of the decision or of the memo, so the memo input, the file built from it and the words
 * in the file are the same with notes and without, whether the notes come before the export or
 * after it.
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

describe("the memo of a review that has reports of missed issues", () => {
  it("is built from the same input, byte for byte, with the reports as without them, and says none of their words", async () => {
    const w = makeWorld();
    const { matterId, am, reviewerAm, runId } = await reviewed(w);
    for (const issue of w.services.runs.issues(am, runId)) {
      const view = w.services.runs.finding(reviewerAm, issue.findingId);
      w.services.reviews.decide(reviewerAm, issue.findingId, decisionFor(view));
    }
    const run = w.repo.getCurrentRun(matterId)!;
    const inputOf = () =>
      buildMemoInput({
        repo: w.repo,
        matterId,
        run,
        exporterId: reviewerAm.principal.userId,
        exportedAt: "2026-11-04T09:00:00.000Z",
      }).input;

    const before = inputOf();
    const fileBefore = await buildMemo(before);

    const note = "ZQ-MEMO-NOTE a clause the review did not flag";
    const place = "ZQ-MEMO-PLACE section 6.1";
    w.services.feedback.reportMissedIssue(reviewerAm, runId, {
      ruleKey: "dur-1",
      location: place,
      note,
    });
    w.services.feedback.reportMissedIssue(am, runId, {
      ruleKey: null,
      location: null,
      note: "ZQ-MEMO-NOTE-2 nothing covers it",
    });
    // The reports are in the store, so the check below is not an empty one.
    expect(w.repo.listFeedback(matterId, { kind: "missed_issue" })).toHaveLength(2);

    const after = inputOf();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    const fileAfter = await buildMemo(after);
    expect(Buffer.from(fileAfter).equals(Buffer.from(fileBefore))).toBe(true);

    // The file the service exports, with the reports on record, says none of it.
    const memo = await w.services.reviews.exportMemo(reviewerAm);
    const text = await textOfMemo((await w.services.reviews.memoFile(am, memo.memoId)).bytes);
    for (const word of ["ZQ-MEMO", "missed issue", "Missed issue", place])
      expect(text, word).not.toContain(word);
  });
});

describe("the memo of a matter that has been rated", () => {
  it("is built from the same input, byte for byte, with the ratings as without them, and says none of their words", async () => {
    const w = makeWorld();
    const { matterId, am, reviewerAm, runId } = await reviewed(w);
    for (const issue of w.services.runs.issues(am, runId)) {
      const view = w.services.runs.finding(reviewerAm, issue.findingId);
      w.services.reviews.decide(reviewerAm, issue.findingId, decisionFor(view));
    }
    const run = w.repo.getCurrentRun(matterId)!;
    const inputOf = () =>
      buildMemoInput({
        repo: w.repo,
        matterId,
        run,
        exporterId: reviewerAm.principal.userId,
        exportedAt: "2026-11-04T09:00:00.000Z",
      }).input;

    const before = inputOf();
    const fileBefore = await buildMemo(before);

    // A matter is rated once it has a memo, so the first memo is exported, and then it is rated.
    const first = await w.services.reviews.exportMemo(reviewerAm);
    const firstText = await textOfMemo((await w.services.reviews.memoFile(am, first.memoId)).bytes);
    const words = "ZQ-MEMO-RATING a comment on the review";
    w.services.feedback.rate(reviewerAm, { rating: 2, comment: words });
    w.services.feedback.rate(am, { rating: 5, comment: "ZQ-MEMO-RATING-2 it was right" });
    // The ratings are in the store, so the check below is not an empty one.
    expect(w.repo.listFeedback(matterId, { kind: "rating" })).toHaveLength(2);

    const after = inputOf();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    const fileAfter = await buildMemo(after);
    expect(Buffer.from(fileAfter).equals(Buffer.from(fileBefore))).toBe(true);

    // The file on record is not touched by the ratings, and says none of their words or marks'.
    const again = await w.services.reviews.memoFile(am, first.memoId);
    expect(await textOfMemo(again.bytes)).toBe(firstText);
    for (const word of ["ZQ-MEMO", "rating", "Rating", "I would use this for my next NDA"])
      expect(firstText, word).not.toContain(word);
    // And the ratings did not make the memo stale or its export ready or not ready.
    expect(w.services.reviews.listMemos(am).map((m) => m.status)).toEqual(["current"]);
  });
});

describe("the memo of a review whose findings carry notes", () => {
  it("is built from the same input, byte for byte, with the notes as without them, and says none of their words", async () => {
    const w = makeWorld();
    const { matterId, am, reviewerAm, runId } = await reviewed(w);
    const issues = w.services.runs.issues(am, runId);
    for (const issue of issues) {
      const view = w.services.runs.finding(reviewerAm, issue.findingId);
      w.services.reviews.decide(reviewerAm, issue.findingId, decisionFor(view));
    }
    const run = w.repo.getCurrentRun(matterId)!;
    const inputOf = () =>
      buildMemoInput({
        repo: w.repo,
        matterId,
        run,
        exporterId: reviewerAm.principal.userId,
        exportedAt: "2026-11-04T09:00:00.000Z",
      }).input;

    const before = inputOf();
    const fileBefore = await buildMemo(before);

    const words = "ZQ-MEMO-NOTE I read Section 9.3 differently";
    w.services.feedback.addNote(am, issues[0]!.findingId, { note: words });
    w.services.feedback.addNote(reviewerAm, issues[0]!.findingId, {
      note: "ZQ-MEMO-NOTE-2 a reply to it",
    });
    w.services.feedback.addNote(am, issues[1]!.findingId, { note: "ZQ-MEMO-NOTE-3 elsewhere" });
    // The notes are in the store and on the findings the memo is built from, so the check below is
    // not an empty one.
    expect(w.repo.listFeedback(matterId, { kind: "comment" })).toHaveLength(3);
    expect(w.services.runs.finding(am, issues[0]!.findingId).notes).toHaveLength(2);

    const after = inputOf();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(JSON.stringify(after)).not.toContain("ZQ-MEMO");
    const fileAfter = await buildMemo(after);
    expect(Buffer.from(fileAfter).equals(Buffer.from(fileBefore))).toBe(true);

    // The file the service exports, with the notes on record, says none of it, and a note made
    // after the export leaves the file on record as it was.
    const memo = await w.services.reviews.exportMemo(reviewerAm);
    const text = await textOfMemo((await w.services.reviews.memoFile(am, memo.memoId)).bytes);
    for (const word of ["ZQ-MEMO", "Section 9.3 differently", "note for the reviewer"])
      expect(text, word).not.toContain(word);
    w.services.feedback.addNote(reviewerAm, issues[2]!.findingId, { note: "ZQ-MEMO-NOTE-4 late" });
    const again = await w.services.reviews.memoFile(am, memo.memoId);
    expect(await textOfMemo(again.bytes)).toBe(text);
    expect(w.services.reviews.listMemos(am).map((m) => m.status)).toEqual(["current"]);
  });

  it("is ready to export on the same terms as before: a note is not a gate", async () => {
    const w = makeWorld();
    const { matterId, am, reviewerAm, runId } = await reviewed(w);
    const issues = w.services.runs.issues(am, runId);
    for (const issue of issues)
      w.services.feedback.addNote(am, issue.findingId, { note: "I disagree with this one." });
    // Notes on every finding and no decision: the review is exactly as unready as without them.
    expect(w.repo.getExportReadiness(matterId, runId).ready).toBe(false);
    for (const issue of issues) {
      const view = w.services.runs.finding(reviewerAm, issue.findingId);
      w.services.reviews.decide(reviewerAm, issue.findingId, decisionFor(view));
    }
    expect(w.repo.getExportReadiness(matterId, runId)).toMatchObject({ ready: true, blockers: [] });
  });
});
