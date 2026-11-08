import { sha256Hex } from "../canonical.js";
import { MemoGateError } from "../export/errors.js";
import { buildMemo } from "../export/memo.js";
import {
  ConflictError,
  ExportBlockedError,
  FileStoreError,
  NotFoundError,
  type ExportBlocker,
  type FindingRecord,
} from "../store/index.js";
import { requireRole, type ServiceDeps } from "./deps.js";
import { ForbiddenError } from "./errors.js";
import { buildMemoInput } from "./memo-input.js";
import type { Presenter } from "./present.js";
import type { ReviewService } from "./types.js";

const memoNotFound = (): NotFoundError => new NotFoundError("memo");

/**
 * Decisions and the memo. A decision is recorded for the signed-in reviewer, never for a user a
 * request names, and is bound to the finding content the reviewer saw. The memo is built only from
 * what the store holds, after the store says every finding is decided, and its builder checks the
 * same gates again.
 */
export function createReviewService(deps: ServiceDeps, present: Presenter): ReviewService {
  const { repo, files, config } = deps;
  const build = deps.buildMemo ?? buildMemo;

  /** The memo builder refused at a gate. Each gate has a reader-facing meaning, so none is a 500. */
  function refusal(error: MemoGateError, findings: readonly FindingRecord[]): Error {
    const blockersFor = (
      keys: readonly string[],
      reason: ExportBlocker["reason"],
    ): ExportBlocker[] =>
      keys.map((ruleKey) => ({
        findingId: findings.find((f) => f.ruleKey === ruleKey)?.id ?? null,
        ruleKey,
        reason,
      }));
    switch (error.gate) {
      case "unreviewed":
        return new ExportBlockedError(blockersFor(error.ruleKeys, "no_review"));
      case "missing_finding":
      case "no_findings":
        return new ExportBlockedError(
          error.ruleKeys.length > 0
            ? blockersFor(error.ruleKeys, "missing_finding")
            : [{ findingId: null, ruleKey: null, reason: "missing_finding" }],
        );
      case "unverified_quote":
        return new ConflictError(
          "memo_quote_unverified",
          "a cited passage no longer matches the stored text",
        );
      default:
        // A duplicated rule, malformed input or a failed write: the gate is a closed word, safe to name.
        return new Error(`the memo could not be built (${error.gate})`);
    }
  }

  return {
    decide(am, findingId, request) {
      requireRole(am, "review.decide", config);
      const record = repo.getFinding(am.matterId, findingId);
      if (record === undefined) throw new NotFoundError("finding");
      const run = repo.getRun(am.matterId, record.runId);
      // Segregation of duties: whoever prepared the review does not decide it, unless the matter is
      // a single-person demonstration. Decided from the run's own row, not from anything sent.
      if (!config.relaxedSegregation && run?.startedBy === am.principal.userId)
        throw new ForbiddenError("review.segregation");
      repo.recordReview(am.matterId, findingId, {
        reviewerId: am.principal.userId,
        decision: request.decision,
        findingContentSha256: request.findingContentSha256,
        edits: request.edits ?? null,
        reason: request.reason ?? null,
      });
      const decided = repo.getFinding(am.matterId, findingId);
      if (decided === undefined) throw new NotFoundError("finding");
      return present.findingView(am, decided);
    },

    async exportMemo(am) {
      requireRole(am, "memo.export", config);
      const { matterId } = am;
      const run = repo.getCurrentRun(matterId);
      if (run === undefined)
        throw new ExportBlockedError([
          { findingId: null, ruleKey: null, reason: "run_not_current" },
        ]);
      const readiness = repo.getExportReadiness(matterId, run.id);
      if (!readiness.ready) throw new ExportBlockedError(readiness.blockers);

      const { input, findings } = buildMemoInput({
        repo,
        matterId,
        run,
        exporterId: am.principal.userId,
        exportedAt: deps.now().toISOString(),
      });
      let bytes: Uint8Array;
      try {
        bytes = await build(input);
      } catch (error) {
        if (error instanceof MemoGateError) throw refusal(error, findings);
        throw error;
      }

      // The file first, the row second, and the file taken back if the row is refused (a decision
      // changed while the document was being built, or an input changed).
      const storagePath = files.save(matterId, bytes);
      const takeBack = (): void => {
        try {
          files.remove(storagePath);
        } catch {
          deps.log(`memo export: a stored file could not be removed (matter ${matterId})`);
        }
      };
      let memo;
      try {
        memo = repo.recordMemo(matterId, {
          runId: run.id,
          reviewIds: findings.flatMap((f) =>
            f.currentReview === null ? [] : [f.currentReview.id],
          ),
          fileSha256: sha256Hex(bytes),
          storagePath,
          exportedBy: am.principal.userId,
        });
      } catch (error) {
        takeBack();
        throw error;
      }
      // This review's memo was already on record (a second click, a second request at the same
      // moment): the record kept the first, so the file just built is a copy to take back.
      if (memo.storagePath !== storagePath) takeBack();
      return present.memoSummary(memo);
    },

    listMemos(am) {
      requireRole(am, "memo.read", config);
      return repo.listMemos(am.matterId).map(present.memoSummary);
    },

    async memoFile(am, memoId) {
      requireRole(am, "memo.read", config);
      // A memo of another matter is looked up in this matter only, so it is as good as absent.
      const memo = repo.getMemo(am.matterId, memoId);
      if (memo === undefined) throw memoNotFound();
      let bytes: Buffer;
      try {
        bytes = files.read(memo.storagePath);
      } catch (error) {
        // The record outlived its file. Like a file that was changed, that is a disagreement
        // between the record and the disk and not a fault; the path is not repeated.
        const missing =
          (error instanceof FileStoreError && error.code === "missing") ||
          (error as NodeJS.ErrnoException).code === "ENOENT";
        if (missing)
          throw new ConflictError("memo_file_missing", "the stored memo file is missing");
        throw error;
      }
      if (sha256Hex(bytes) !== memo.fileSha256)
        throw new ConflictError(
          "memo_file_changed",
          "the stored memo no longer matches its record",
        );
      return { bytes: new Uint8Array(bytes), fileName: present.memoFileName(memo) };
    },
  };
}
