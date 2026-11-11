import type { MatterStatus } from "../contracts.js";
import {
  ConflictError,
  StoreError,
  type AuditChainResult,
  type FileStore,
  type Repository,
} from "../store/index.js";

/**
 * The retention job: finds the matters whose retention date has come and, when asked to, deletes
 * them (docs/parol/06, "Retention and deletion"). It runs when an operator runs it (`pnpm
 * parol:retain`, src/retain.ts); nothing in the server calls it, and nothing deletes by itself.
 *
 * A dry run changes nothing. An apply run, for each matter that is past its date and has no run in
 * flight, deletes its rows in one transaction (`Repository.deleteMatter`), then its folder; then
 * removes the folders that no row names; then compacts the database once, so that what was deleted
 * leaves the file and its log; then writes one `retention.run` event; then checks the audit chain.
 *
 * What the report holds is ids, statuses, ISO times, counts and error classes. It never holds a
 * matter's name, its client's name, a document title or any text, because it goes to a terminal, a
 * scheduler's mail or a log file that the deletion cannot reach.
 */

/** A safety valve against a wrong system clock, chosen here and not measured. */
export const DEFAULT_MAX_MATTERS_PER_RUN = 25;
export const MAX_MATTERS_CEILING = 1000;

/** The job was asked for something it will not do. The message names the option, never a value. */
export class RetentionUsageError extends Error {
  override name = "RetentionUsageError";
}

export interface RetentionDeps {
  repo: Repository;
  /**
   * The file store. A dry run needs only `listMatterIds`, so it can be given a view that cannot
   * write; `apply` with an object that lacks the two mutators is a `RetentionUsageError`.
   */
  files: Pick<FileStore, "listMatterIds"> &
    Partial<Pick<FileStore, "deleteMatter" | "sweepOrphans">>;
  now: () => Date;
}

export interface RetentionOptions {
  /** Default false: a dry run. */
  apply: boolean;
  /** How many matters one run may delete: 1 to `MAX_MATTERS_CEILING`. */
  maxMatters: number;
  /** The time expiry is judged at, for a dry run. With `apply` it is a `RetentionUsageError`. */
  asOf?: Date;
}

export type LineOutcome = "would_delete" | "would_skip" | "deleted" | "skipped" | "failed";
export type LineFailure = "store_refused" | "files_not_removed" | "unexpected";

export interface MatterLine {
  matterId: string;
  status: MatterStatus;
  createdBy: string;
  retainUntil: string;
  /**
   * `would_delete` and `would_skip` are what a dry run says, and what an `apply` run says of the
   * matters it did not touch because it refused (more were expired than `maxMatters`).
   */
  outcome: LineOutcome;
  reason?: "run_in_flight";
  /** An error CLASS, never a message. */
  failure?: LineFailure;
  /** The sum of the row counts that `deleteMatter` recorded in the deletion event. */
  rows?: number;
  /** The entries the matter's folder held when it was removed. */
  filesRemoved?: number;
}

export type Compaction = "done" | "not_needed" | "failed" | "not_run";

export interface RetentionReport {
  mode: "dry_run" | "apply";
  /** The time expiry was judged at. */
  at: string;
  /** The denominator of every count below: the matters in the database when the job started. */
  totalMatters: number;
  expired: number;
  deleted: number;
  skipped: number;
  failed: number;
  /** More were expired than `maxMatters`, so nothing was deleted. */
  refusedByLimit: boolean;
  /** Ids of the folders that no matter names, found. An apply run removes them. */
  orphanFolders: string[];
  orphansRemoved: number;
  /** Folders that no matter names and that could not be removed. */
  orphansFailed: number;
  compaction: Compaction;
  /** Checked after the writes, or now for a dry run. */
  chain: AuditChainResult;
  lines: MatterLine[];
}

/** The numbers in a deletion event's detail, apart from `files`, are the rows it deleted. */
function rowsDeleted(detail: Record<string, unknown>): number {
  let rows = 0;
  for (const [key, value] of Object.entries(detail))
    if (key !== "files" && typeof value === "number") rows += value;
  return rows;
}

export function runRetention(deps: RetentionDeps, options: RetentionOptions): RetentionReport {
  const { repo, files } = deps;
  if (
    !Number.isInteger(options.maxMatters) ||
    options.maxMatters < 1 ||
    options.maxMatters > MAX_MATTERS_CEILING
  )
    throw new RetentionUsageError(
      `maxMatters must be a whole number from 1 to ${MAX_MATTERS_CEILING}`,
    );
  if (options.apply && options.asOf !== undefined)
    throw new RetentionUsageError("asOf is for a dry run: a deletion is judged at the clock");
  const removeMatterFiles = files.deleteMatter?.bind(files);
  const sweepOrphans = files.sweepOrphans?.bind(files);
  if (options.apply && (removeMatterFiles === undefined || sweepOrphans === undefined))
    throw new RetentionUsageError("an apply run needs a file store that can delete");

  // 1. Who is past their date, judged at one instant for the whole run.
  const at = options.asOf ?? deps.now();
  const expired = repo.listExpiredMatters(at);
  const totalMatters = repo.listMatterIds().length;

  // 2. Which of them can be deleted now. A run in flight is skipped, not cancelled: the operator did
  // not ask for a review to be stopped. The two tests are the ones `deleteMatter` itself makes.
  const lines: MatterLine[] = expired.map((matter) => {
    const inFlight = repo.getActiveRun(matter.id) !== undefined || matter.status === "running";
    return {
      matterId: matter.id,
      status: matter.status,
      createdBy: matter.createdBy,
      retainUntil: matter.retainUntil,
      outcome: inFlight ? "would_skip" : "would_delete",
      ...(inFlight ? { reason: "run_in_flight" as const } : {}),
    };
  });

  // 3. A clock far in the future would expire every matter at once. More than the limit: nothing is
  // deleted, and the run says so (in its report and in its event).
  const refusedByLimit = options.apply && expired.length > options.maxMatters;
  const doing = options.apply && !refusedByLimit;

  let deleted = 0;
  let skipped = 0;
  let failed = 0;
  let rowsGone = 0;

  // 4. Matter by matter, in the order of their dates. One that fails does not stop the others.
  if (doing) {
    for (const line of lines) {
      if (line.outcome === "would_skip") {
        line.outcome = "skipped";
        skipped += 1;
        continue;
      }
      try {
        repo.deleteMatter(line.matterId, { actorId: null, reason: "retention" });
      } catch (error) {
        if (error instanceof ConflictError && error.code === "matter_running") {
          // A run started between the check and the delete.
          line.outcome = "skipped";
          line.reason = "run_in_flight";
          skipped += 1;
        } else {
          line.outcome = "failed";
          line.failure = error instanceof StoreError ? "store_refused" : "unexpected";
          failed += 1;
        }
        continue;
      }
      rowsGone += 1;
      line.outcome = "deleted";
      const event = repo
        .listMatterAuditEvents(line.matterId, { action: "matter.delete" })
        .events.at(-1);
      if (event !== undefined) line.rows = rowsDeleted(event.detail);
      try {
        line.filesRemoved = (removeMatterFiles as (id: string) => number)(line.matterId);
        deleted += 1;
      } catch {
        // The rows are gone, so the folder is one that no row names: step 5 and the next run remove it.
        line.outcome = "failed";
        line.failure = "files_not_removed";
        failed += 1;
      }
    }
  }

  // 5. Folders that no matter names: the leftovers of a stop between the rows and the files, of a
  // folder that could not be removed above, and of nothing this job made.
  const known = new Set(repo.listMatterIds());
  const orphanFolders = files.listMatterIds().filter((id) => !known.has(id));
  let orphansRemoved = 0;
  let orphansFailed = 0;
  if (doing && orphanFolders.length > 0) {
    try {
      orphansRemoved = (sweepOrphans as (ids: Iterable<string>) => string[])(known).length;
    } catch {
      // Count what is still there, not what the sweep got to: it stops at the first folder it cannot remove.
    }
    const still = files.listMatterIds().filter((id) => !known.has(id)).length;
    orphansFailed = still;
    orphansRemoved = orphanFolders.length - still;
  }

  // 6. One compaction per run, after all the deletions, so the deleted text leaves the file and its
  // log. A run whose compaction failed makes the next one try again, even with nothing to delete.
  let compaction: Compaction = "not_run";
  if (doing) {
    const last = repo.latestAuditEvent("retention.run");
    const earlierFailed = last !== null && last.detail.compaction === "failed";
    if (rowsGone > 0 || orphansRemoved > 0 || earlierFailed) {
      try {
        repo.compact();
        compaction = "done";
      } catch {
        compaction = "failed";
      }
    } else compaction = "not_needed";
  }

  // 7. The run is on record, including one that found nothing: a daily job that finds nothing and a
  // job that never ran must be told apart. Ids, counts and closed words only.
  if (options.apply) {
    repo.appendAudit({
      actorId: null,
      matterId: null,
      action: "retention.run",
      targetType: "retention",
      targetId: "retention",
      detail: {
        mode: "apply",
        at: at.toISOString(),
        expired: expired.length,
        deleted,
        skipped,
        failed,
        orphansRemoved,
        orphansFailed,
        compaction,
        refused: refusedByLimit,
      },
    });
  }

  // 8. The chain, after the writes.
  return {
    mode: options.apply ? "apply" : "dry_run",
    at: at.toISOString(),
    totalMatters,
    expired: expired.length,
    deleted,
    skipped,
    failed,
    refusedByLimit,
    orphanFolders,
    orphansRemoved,
    orphansFailed,
    compaction,
    chain: repo.verifyAuditChain(),
    lines,
  };
}
