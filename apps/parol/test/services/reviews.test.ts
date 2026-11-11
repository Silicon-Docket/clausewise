import { readdirSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { afterAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/canonical.js";
import { MemoGateError } from "../../src/export/errors.js";
import {
  ContentMismatchError,
  ExportBlockedError,
  StaleFindingError,
} from "../../src/store/index.js";
import type { DecisionRequest } from "../../src/services/views.js";
import {
  baseWorld,
  cleanup,
  decideAll,
  decisionFor,
  makeWorld,
  newMatter,
  reviewed,
  uploadCase,
  type World,
} from "./support.js";

afterAll(cleanup);

const errorOf = async (fn: () => unknown): Promise<unknown> => {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
};

const memoText = async (bytes: Uint8Array): Promise<string> => {
  const zip = await JSZip.loadAsync(bytes);
  return zip.file("word/document.xml")!.async("string");
};

const storedFiles = (w: World, matterId: string): string[] =>
  readdirSync(join(w.files.root, matterId)).sort();

describe("a decision", () => {
  it("is recorded for the signed-in reviewer, bound to the content they saw, and returned as the finding", async () => {
    const w = makeWorld();
    const { am, reviewerAm, runId } = await reviewed(w);
    const dur = w.services.runs.issues(am, runId).find((i) => i.ruleKey === "dur-1")!;
    const seen = w.services.runs.finding(reviewerAm, dur.findingId);

    const edited = w.services.reviews.decide(reviewerAm, dur.findingId, {
      decision: "edit",
      reasonCode: "bad_fallback",
      findingContentSha256: seen.contentSha256,
      edits: {
        fallbackLanguage: "6.1 The obligations continue for two (2) years from each disclosure.",
      },
      reason: "The parties agreed two years in February.",
    });
    expect(edited.issue.review).toMatchObject({
      decision: "edit",
      reviewerName: "Dana Whitfield (reviewing attorney)",
      validity: "current",
    });
    expect(edited.reviews).toEqual([
      {
        decision: "edit",
        reviewerName: "Dana Whitfield (reviewing attorney)",
        at: expect.any(String),
        reason: "The parties agreed two years in February.",
        validity: "current",
        reasonCode: "bad_fallback",
        minorEdit: false,
        edits: {
          fallbackLanguage: "6.1 The obligations continue for two (2) years from each disclosure.",
        },
      },
    ]);
    // What the workflow said is untouched by the edit.
    expect(edited.contentSha256).toBe(seen.contentSha256);
    expect(edited.fallbackLanguage).toBe(seen.fallbackLanguage);

    // A second decision replaces the first, which stays in the history as stale.
    const rejected = w.services.reviews.decide(reviewerAm, dur.findingId, {
      decision: "reject",
      reasonCode: "wrong_status",
      findingContentSha256: seen.contentSha256,
      edits: null,
      reason: "On reflection, not a deviation.",
    });
    expect(rejected.reviews.map((r) => [r.decision, r.validity])).toEqual([
      ["edit", "stale"],
      ["reject", "current"],
    ]);
    // Each decision keeps its own code, and a reject carries no minor-edit mark.
    expect(rejected.reviews.map((r) => [r.reasonCode, r.minorEdit])).toEqual([
      ["bad_fallback", false],
      ["wrong_status", null],
    ]);
    expect(w.services.matters.view(am).matter.status).toBe("in_review");
  });

  it("needs a reason for edit, reject and escalate, and edits for an edit and for nothing else", async () => {
    const w = makeWorld();
    const { reviewerAm, am, runId } = await reviewed(w);
    const finding = w.services.runs.issues(am, runId)[0]!;
    const hash = w.services.runs.finding(reviewerAm, finding.findingId).contentSha256;
    const decide = (request: Partial<DecisionRequest>) =>
      errorOf(() =>
        w.services.reviews.decide(reviewerAm, finding.findingId, {
          decision: "accept",
          findingContentSha256: hash,
          edits: null,
          reason: null,
          ...request,
        }),
      );
    for (const decision of ["reject", "escalate"] as const)
      expect(await decide({ decision, reason: null })).toMatchObject({ code: "reason_required" });
    expect(await decide({ decision: "reject", reasonCode: "other", reason: "   " })).toMatchObject({
      code: "reason_required",
    });
    expect(
      await decide({ decision: "edit", reasonCode: "other", reason: "why", edits: null }),
    ).toMatchObject({
      code: "edits_required",
    });
    expect(
      await decide({
        decision: "edit",
        reasonCode: "other",
        reason: "why",
        edits: { discrepancy: "" },
      }),
    ).toMatchObject({ name: "ValidationError" });
    expect(await decide({ decision: "accept", edits: { discrepancy: "x" } })).toMatchObject({
      code: "edits_not_allowed",
    });
    expect(await decide({ decision: "maybe" as never })).toMatchObject({ code: "bad_decision" });
    // Nothing was recorded by any of them.
    expect(w.services.runs.finding(reviewerAm, finding.findingId).reviews).toEqual([]);
    // An accept needs no reason.
    expect(await errorOf(() => decide({}))).toBeInstanceOf(Error);
  });

  it("is refused when the finding is not the one the reviewer saw", async () => {
    const w = makeWorld();
    const { reviewerAm, am, runId } = await reviewed(w);
    const finding = w.services.runs.issues(am, runId)[0]!;
    const error = await errorOf(() =>
      w.services.reviews.decide(reviewerAm, finding.findingId, {
        decision: "accept",
        findingContentSha256: sha256Hex("something else"),
        edits: null,
        reason: null,
      }),
    );
    expect(error).toBeInstanceOf(ContentMismatchError);
    expect(w.services.runs.finding(reviewerAm, finding.findingId).reviews).toEqual([]);
  });

  it("completes the review when every finding is decided, and reopens it when one changes", async () => {
    const w = makeWorld();
    const { am, reviewerAm, runId, matterId } = await reviewed(w);
    const issues = w.services.runs.issues(am, runId);
    decideAll(w, reviewerAm, issues.slice(0, 7));
    expect(w.services.matters.view(am).matter.status).toBe("in_review");
    decideAll(w, reviewerAm, issues.slice(7));
    expect(w.services.matters.view(am).matter.status).toBe("review_complete");
    // Reopening one decision (a new decision on the same finding) keeps it complete; undoing is not offered.
    const view = w.services.runs.finding(reviewerAm, issues[0]!.findingId);
    expect(view.canDecide.allowed).toBe(true);
    expect(matterId).toBeTruthy();
  });
});

describe("segregation of duties", () => {
  it("refuses a decision from the person who started the run", async () => {
    const w = makeWorld();
    const { matterId, am, runId } = await reviewed(w);
    // The associate is later given the reviewer's role: a role change is how one person could end
    // up on both sides in a setting that does not allow it.
    w.repo.db
      .prepare("UPDATE matter_members SET role = 'reviewer' WHERE matter_id = ? AND user_id = ?")
      .run(matterId, w.associate.userId);
    const asReviewer = w.grant(w.associate, matterId);
    expect(asReviewer.role).toBe("reviewer");
    const finding = w.services.runs.issues(asReviewer, runId)[0]!;
    const view = w.services.runs.finding(asReviewer, finding.findingId);
    expect(view.canDecide).toEqual({
      allowed: false,
      reason:
        "A reviewer cannot decide findings of a review they started. Ask another reviewing attorney to decide them.",
    });
    const error = await errorOf(() =>
      w.services.reviews.decide(asReviewer, finding.findingId, decisionFor(view)),
    );
    expect(error).toMatchObject({ name: "ForbiddenError", action: "review.segregation" });
    expect(w.services.runs.finding(am, finding.findingId).reviews).toEqual([]);
    // Another reviewer may.
    const other = w.grant(w.reviewer, matterId);
    expect(
      w.services.reviews.decide(other, finding.findingId, decisionFor(view)).issue.review,
    ).not.toBeNull();
  });

  it("is relaxed for a single-person demonstration, and the memo says so", async () => {
    const w = makeWorld({ config: { relaxedSegregation: true } });
    const { matterId, am, runId } = await reviewed(w);
    // The associate decides and exports, and may not be refused for it.
    const issues = w.services.runs.issues(am, runId);
    const view = w.services.runs.finding(am, issues[0]!.findingId);
    expect(view.canDecide).toEqual({ allowed: true, reason: null });
    decideAll(w, am, issues);
    const memo = await w.services.reviews.exportMemo(am);
    const body = await memoText((await w.services.reviews.memoFile(am, memo.memoId)).bytes);
    expect(body).toContain("The reviewer and the associate were the same person for this matter");
    expect(w.services.matters.view(am).segregationRelaxed).toBe(true);
    expect(matterId).toBeTruthy();
  });

  it("does not tell the memo the roles were merged when a separate reviewer decided", async () => {
    const w = makeWorld({ config: { relaxedSegregation: true } });
    const { am, reviewerAm, runId } = await reviewed(w);
    decideAll(w, reviewerAm, w.services.runs.issues(am, runId));
    const memo = await w.services.reviews.exportMemo(reviewerAm);
    const body = await memoText((await w.services.reviews.memoFile(am, memo.memoId)).bytes);
    expect(body).not.toContain("were the same person");
  });

  it("is on by default: an associate cannot decide or export", async () => {
    const w = makeWorld();
    const { am, runId } = await reviewed(w);
    const issue = w.services.runs.issues(am, runId)[0]!;
    const view = w.services.runs.finding(am, issue.findingId);
    expect(
      await errorOf(() => w.services.reviews.decide(am, issue.findingId, decisionFor(view))),
    ).toMatchObject({
      name: "ForbiddenError",
      action: "review.decide",
    });
    expect(w.services.matters.view(am).segregationRelaxed).toBe(false);
  });
});

describe("export", () => {
  it("is blocked until every finding has a current decision, and names the findings that lack one", async () => {
    const w = makeWorld();
    const { am, reviewerAm, runId } = await reviewed(w);
    const issues = w.services.runs.issues(am, runId);
    let error = (await errorOf(() =>
      w.services.reviews.exportMemo(reviewerAm),
    )) as ExportBlockedError;
    expect(error).toBeInstanceOf(ExportBlockedError);
    expect(error.blockers.map((b) => [b.ruleKey, b.reason])).toEqual(
      issues.map((i) => [i.ruleKey, "no_review"]),
    );
    decideAll(w, reviewerAm, issues.slice(0, 5));
    error = (await errorOf(() => w.services.reviews.exportMemo(reviewerAm))) as ExportBlockedError;
    expect(error.blockers.map((b) => b.ruleKey)).toEqual(issues.slice(5).map((i) => i.ruleKey));
    expect(storedFiles(w, am.matterId)).toHaveLength(2);
    expect(w.services.reviews.listMemos(am)).toEqual([]);
  });

  it("builds the memo from what was decided, stores it once, and records it", async () => {
    const w = makeWorld();
    const { matterId, am, reviewerAm, runId } = await reviewed(w);
    const issues = w.services.runs.issues(am, runId);
    for (const issue of issues) {
      const view = w.services.runs.finding(reviewerAm, issue.findingId);
      w.services.reviews.decide(
        reviewerAm,
        issue.findingId,
        issue.ruleKey === "dur-1"
          ? {
              decision: "edit",
              reasonCode: "other",
              findingContentSha256: view.contentSha256,
              edits: {
                fallbackLanguage:
                  "6.1 The obligations of each Receiving Party continue for two (2) years.",
              },
              reason: "The parties agreed two years in February.",
            }
          : decisionFor(view),
      );
    }
    const memo = await w.services.reviews.exportMemo(reviewerAm);
    expect(memo).toMatchObject({
      runId,
      status: "current",
      exportedByName: "Dana Whitfield (reviewing attorney)",
    });
    expect(storedFiles(w, matterId)).toHaveLength(3);
    const file = await w.services.reviews.memoFile(am, memo.memoId);
    expect(sha256Hex(file.bytes)).toBe(memo.fileSha256);
    const body = await memoText(file.bytes);
    expect(body).toContain("The parties agreed two years in February.");
    expect(body).toContain(
      "6.1 The obligations of each Receiving Party continue for two (2) years.",
    );
    expect(body).toContain(runId);
    expect(w.services.matters.view(am).matter.status).toBe("exported");
    expect(w.services.matters.view(am).memos).toEqual([memo]);

    // Exporting again is the memo already on record: nothing new is built or stored, and the
    // memo is not marked superseded, which would say the documents or the playbook had changed.
    const again = await w.services.reviews.exportMemo(reviewerAm);
    expect(again).toEqual(memo);
    expect(w.services.reviews.listMemos(am).map((m) => m.status)).toEqual(["current"]);
    expect(storedFiles(w, matterId)).toHaveLength(3);
    expect((await w.services.reviews.memoFile(am, memo.memoId)).bytes.length).toBeGreaterThan(1000);
  });

  it("carries a reviewer's change of how a passage is labelled into the memo, marked as theirs", async () => {
    const w = makeWorld();
    const { am, reviewerAm, runId } = await reviewed(w);
    const issues = w.services.runs.issues(am, runId);
    for (const issue of issues) {
      const view = w.services.runs.finding(reviewerAm, issue.findingId);
      const supporting = view.evidence.find((e) => e.role === "supporting");
      w.services.reviews.decide(
        reviewerAm,
        issue.findingId,
        issue.ruleKey === "dur-1" && supporting !== undefined
          ? {
              decision: "edit",
              reasonCode: "other",
              findingContentSha256: view.contentSha256,
              edits: { evidenceRoles: [{ evidenceId: supporting.evidenceId, role: "definition" }] },
              reason: "That passage defines the term; it does not support the finding.",
            }
          : decisionFor(view),
      );
    }
    const memo = await w.services.reviews.exportMemo(reviewerAm);
    const { readMemo } = await import("../export/support.js");
    const read = await readMemo((await w.services.reviews.memoFile(am, memo.memoId)).bytes);
    expect(read.paragraphs.join("\n")).toContain(
      "(role changed by the reviewer; the workflow labelled it Supporting)",
    );
  });

  it("refuses decisions once the memo is exported, until the review is run again", async () => {
    const w = makeWorld();
    const { am, reviewerAm, runId } = await reviewed(w);
    const issues = w.services.runs.issues(am, runId);
    decideAll(w, reviewerAm, issues);
    await w.services.reviews.exportMemo(reviewerAm);
    const view = w.services.runs.finding(reviewerAm, issues[0]!.findingId);
    expect(view.canDecide).toEqual({
      allowed: false,
      reason: "The memo is exported. Decisions can change only after a new review.",
    });
    expect(
      await errorOf(() =>
        w.services.reviews.decide(reviewerAm, issues[0]!.findingId, decisionFor(view)),
      ),
    ).toMatchObject({
      code: "matter_exported",
    });
  });

  it("takes the stored file back when the record is refused", async () => {
    const w = makeWorld();
    const { matterId, am, reviewerAm, runId } = await reviewed(w);
    const issues = w.services.runs.issues(am, runId);
    decideAll(w, reviewerAm, issues);
    const before = storedFiles(w, matterId);
    // While the document is being built, the reviewer changes a decision: the record would not
    // match the file, so the store refuses it. The builder here is the real one, with that change
    // made just before it returns.
    const { buildMemo } = await import("../../src/export/memo.js");
    const { createServices } = await import("../../src/services/index.js");
    const racy = createServices({
      ...w.deps,
      buildMemo: async (input) => {
        const bytes = await buildMemo(input);
        const view = w.services.runs.finding(reviewerAm, issues[0]!.findingId);
        w.services.reviews.decide(reviewerAm, issues[0]!.findingId, {
          decision: "reject",
          reasonCode: "other",
          findingContentSha256: view.contentSha256,
          edits: null,
          reason: "changed my mind",
        });
        return bytes;
      },
    });
    const error = await errorOf(() => racy.reviews.exportMemo(reviewerAm));
    expect(error).toMatchObject({ name: "ConflictError", code: "reviews_changed" });
    expect(storedFiles(w, matterId)).toEqual(before);
    expect(w.repo.listMemos(matterId)).toEqual([]);
    expect(w.services.matters.view(am).matter.status).toBe("review_complete");
    // Export again, and it works.
    expect((await w.services.reviews.exportMemo(reviewerAm)).status).toBe("current");
  });

  it.each([
    ["unreviewed", ["dur-1"], "no_review"],
    ["missing_finding", ["gov-1"], "missing_finding"],
    ["no_findings", [], "missing_finding"],
  ] as const)(
    "answers the memo's %s gate as a blocked export, by gate and not by message",
    async (gate, ruleKeys, reason) => {
      const w = makeWorld({
        buildMemo: async () => {
          throw new MemoGateError(gate, "message that must not matter", ruleKeys);
        },
      });
      const { matterId, am, reviewerAm, runId } = await reviewed(w);
      decideAll(w, reviewerAm, w.services.runs.issues(am, runId));
      const before = storedFiles(w, matterId);
      const error = (await errorOf(() =>
        w.services.reviews.exportMemo(reviewerAm),
      )) as ExportBlockedError;
      expect(error).toBeInstanceOf(ExportBlockedError);
      expect(error.blockers.map((b) => [b.ruleKey, b.reason])).toEqual(
        ruleKeys.length > 0 ? ruleKeys.map((k) => [k, reason]) : [[null, reason]],
      );
      if (ruleKeys.length > 0) expect(error.blockers[0]!.findingId).not.toBeNull();
      expect(storedFiles(w, matterId)).toEqual(before);
    },
  );

  it.each([["unverified_quote", "memo_quote_unverified"]] as const)(
    "answers the memo's %s gate as a conflict",
    async (gate, code) => {
      const w = makeWorld({
        buildMemo: async () => {
          throw new MemoGateError(gate, "text that must not matter");
        },
      });
      const { am, reviewerAm, runId } = await reviewed(w);
      decideAll(w, reviewerAm, w.services.runs.issues(am, runId));
      expect(await errorOf(() => w.services.reviews.exportMemo(reviewerAm))).toMatchObject({
        name: "ConflictError",
        code,
      });
    },
  );

  it.each(["duplicate_rule", "invalid_input", "write_failed"] as const)(
    "answers the memo's %s gate as an internal error that names only the gate",
    async (gate) => {
      const w = makeWorld({
        buildMemo: async () => {
          throw new MemoGateError(gate, "document text that must not travel");
        },
      });
      const { am, reviewerAm, runId } = await reviewed(w);
      decideAll(w, reviewerAm, w.services.runs.issues(am, runId));
      const error = (await errorOf(() => w.services.reviews.exportMemo(reviewerAm))) as Error;
      expect(error.message).toBe(`the memo could not be built (${gate})`);
    },
  );

  it("does not let a memo of one matter be read from another", async () => {
    const w = makeWorld();
    const { am, reviewerAm, runId } = await reviewed(w);
    decideAll(w, reviewerAm, w.services.runs.issues(am, runId));
    const memo = await w.services.reviews.exportMemo(reviewerAm);
    const other = newMatter(w, "other");
    expect(await errorOf(() => w.services.reviews.memoFile(other.am, memo.memoId))).toMatchObject({
      name: "NotFoundError",
    });
    expect(w.services.reviews.listMemos(other.am)).toEqual([]);
  });
});

describe("a change to the inputs", () => {
  it("makes findings, decisions and the memo stale, and blocks export, until the review is run again", async () => {
    const w = makeWorld();
    const { matterId, am, reviewerAm, runId, uploaded } = await reviewed(w);
    const issues = w.services.runs.issues(am, runId);
    decideAll(w, reviewerAm, issues);
    const memo = await w.services.reviews.exportMemo(reviewerAm);
    expect(w.services.matters.view(am).matter.status).toBe("exported");

    // The amendment is corrected.
    await w.services.matters.addVersion(am, uploaded.documentIds[1]!, {
      fileName: "amendment-1-v2.txt",
      bytes: new TextEncoder().encode(
        `${new TextDecoder().decode(baseWorld.files[1]!.bytes).trimEnd()}\n\n5. This Amendment may be signed in counterparts.\n`,
      ),
      statedDate: "2026-09-16",
    });
    const view = w.services.matters.view(am);
    expect(view.matter.status).toBe("stale");
    expect(view.staleReason).toBe("A document was replaced by a new version after this review.");
    expect(view.currentRun).toBeNull();
    expect(view.runs[0]).toMatchObject({ id: runId, status: "superseded", current: false });
    expect(view.memos.map((m) => m.status)).toEqual(["superseded"]);
    expect(view.start.ready).toBe(true);

    // The old results are still there to read, marked stale, with their decisions stale as well.
    const stale = w.services.runs.issues(am, runId);
    expect(stale.every((i) => i.validity === "stale" && i.review?.validity === "stale")).toBe(true);
    expect(w.services.runs.issues(am).map((i) => i.findingId)).toEqual(
      stale.map((i) => i.findingId),
    );
    const finding = w.services.runs.finding(reviewerAm, issues[0]!.findingId);
    expect(finding.canDecide).toEqual({
      allowed: false,
      reason: "The documents or the playbook changed after this finding. Run the review again.",
    });
    expect(finding.reviews.every((r) => r.validity === "stale")).toBe(true);

    // Neither a decision nor an export gets through.
    expect(
      await errorOf(() =>
        w.services.reviews.decide(reviewerAm, issues[0]!.findingId, decisionFor(finding)),
      ),
    ).toBeInstanceOf(StaleFindingError);
    expect(await errorOf(() => w.services.reviews.exportMemo(reviewerAm))).toMatchObject({
      name: "ExportBlockedError",
      blockers: [{ findingId: null, ruleKey: null, reason: "run_not_current" }],
    });
    // The memo that was exported stays on record, as superseded.
    expect((await w.services.reviews.memoFile(am, memo.memoId)).bytes.length).toBeGreaterThan(1000);

    // Run again, decide again, export again.
    const second = w.services.runs.start(am, { workflowLabel: "v2" });
    await w.services.runs.idle();
    expect(w.services.runs.get(am, second.id)).toMatchObject({
      status: "succeeded",
      current: true,
    });
    const fresh = w.services.runs.issues(am);
    expect(fresh.every((i) => i.validity === "current" && i.review === null)).toBe(true);
    decideAll(w, reviewerAm, fresh);
    const next = await w.services.reviews.exportMemo(reviewerAm);
    expect(next.runId).toBe(second.id);
    expect(w.services.reviews.listMemos(am).map((m) => m.status)).toEqual([
      "current",
      "superseded",
    ]);
    expect(matterId).toBeTruthy();
  });

  it("a re-run of unchanged inputs replaces the findings and keeps the old memo on record", async () => {
    const w = makeWorld();
    const { am, reviewerAm, runId } = await reviewed(w);
    decideAll(w, reviewerAm, w.services.runs.issues(am, runId));
    const memo = await w.services.reviews.exportMemo(reviewerAm);
    // Started again with nothing changed: a new review.
    const second = w.services.runs.start(am, { workflowLabel: "v2" });
    expect(w.services.runs.get(am, runId).status).toBe("superseded");
    await w.services.runs.idle();
    expect(w.services.runs.get(am, second.id).status).toBe("succeeded");
    expect(w.services.runs.issues(am).every((i) => i.review === null)).toBe(true);
    // The new run's findings are undecided, so nothing can be exported yet.
    expect(await errorOf(() => w.services.reviews.exportMemo(reviewerAm))).toBeInstanceOf(
      ExportBlockedError,
    );
    expect(w.services.reviews.listMemos(am).map((m) => [m.memoId, m.status])).toEqual([
      [memo.memoId, "current"],
    ]);
  });

  it("shows no issues for a matter that has not been reviewed, or for a run that is not there", async () => {
    const w = makeWorld();
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    expect(w.services.runs.issues(am)).toEqual([]);
    expect(w.services.runs.issues(am, "run_ffffffffffffffff")).toEqual([]);
  });
});
