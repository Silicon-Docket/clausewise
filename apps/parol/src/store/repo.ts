import type { MatterStatus } from "../contracts.js";
import {
  appendAudit,
  listAuditEvents,
  verifyAuditChain,
  type AuditFilter,
  type AuditInput,
} from "./audit.js";
import { createContext, type RepositoryOptions } from "./context.js";
import type { Database } from "./db.js";
import {
  ConflictError,
  InputsIncompleteError,
  InvalidTransitionError,
  ValidationError,
} from "./errors.js";
import { createEvalApi } from "./repo-eval.js";
import { createFindingsApi } from "./repo-findings.js";
import { createMattersApi } from "./repo-matters.js";
import { createPlaybooksApi } from "./repo-playbooks.js";
import { createRunsApi } from "./repo-runs.js";
import { canTransition } from "./states.js";
import type { MatterRow } from "./types.js";

/**
 * The repository: typed methods for every table, behind one object. Every method that touches
 * matter data takes the matter id first and filters on it, and treats an id that belongs to another
 * matter exactly as it treats one that does not exist.
 *
 * Methods that change state run in a transaction and append their audit event inside it, so the
 * change and its record commit or roll back together.
 */
export function createRepository(db: Database, options: RepositoryOptions = {}) {
  const ctx = createContext(db, options);
  const matters = createMattersApi(ctx);
  const playbooks = createPlaybooksApi(ctx, matters.internal.requireUser);
  const runs = createRunsApi(ctx, matters, playbooks);
  const findings = createFindingsApi(ctx, matters, playbooks, runs);
  const evals = createEvalApi(ctx, matters, playbooks, runs);
  const { requireMatter, transitionMatter } = matters.internal;

  /**
   * A guarded status change for callers outside the repository. The edge must be one of
   * `canTransition`'s, and the state it moves to must be true: `ready` needs complete inputs,
   * `running` an active run, `review_complete` a run whose findings are all decided, `exported` a
   * current memo. Deletion has its own method.
   */
  function setMatterStatus(
    matterId: string,
    to: MatterStatus,
    opts: { actorId: string | null },
  ): MatterRow {
    return ctx.tx(() => {
      const matter = requireMatter(matterId);
      if (to === "deleted")
        throw new ValidationError("use_delete_matter", "use deleteMatter to delete a matter");
      if (matter.status === to) return matter;
      if (!canTransition(matter.status, to)) throw new InvalidTransitionError("matter", matter.status, to);

      if (to === "ready" && matters.computeInputsDigest(matterId) === null)
        throw new InputsIncompleteError(matterId);
      if (to === "running" && !runs.getActiveRun(matterId))
        throw new ConflictError("no_active_run", `matter ${matterId} has no run in flight`);
      if (to === "review_complete" || to === "exported") {
        const current = runs.getCurrentRun(matterId);
        if (!current || !findings.getExportReadiness(matterId, current.id).ready)
          throw new ConflictError("not_fully_decided", `matter ${matterId} has undecided or stale findings`);
        if (to === "exported" && !findings.getCurrentMemo(matterId))
          throw new ConflictError("no_memo", `matter ${matterId} has no current memo`);
      }
      if (to === "in_review" && matter.status === "running" && !runs.getCurrentRun(matterId))
        throw new ConflictError("no_current_run", `matter ${matterId} has no succeeded run on its current inputs`);

      transitionMatter(matterId, to);
      ctx.audit({
        actorId: opts.actorId,
        matterId,
        action: "matter.status",
        targetType: "matter",
        targetId: matterId,
        detail: { from: matter.status, to },
      });
      return requireMatter(matterId);
    });
  }

  /**
   * Checkpoints the write-ahead log and rewrites the file, so the pages a deleted matter occupied
   * are returned and (with `secure_delete`) already zeroed. Run it after `deleteMatter`, outside
   * any transaction.
   */
  function compact(): void {
    if (db.isTransaction) throw new ConflictError("in_transaction", "compact cannot run inside a transaction");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
  }

  const { internal: _m, ...mattersApi } = matters;
  const { internal: _r, ...runsApi } = runs;
  void _m;
  void _r;

  return {
    ...mattersApi,
    setMatterStatus,
    ...playbooks,
    ...runsApi,
    ...findings,
    ...evals,
    // audit
    appendAudit: (input: Omit<AuditInput, "at">) => ctx.audit(input),
    listAuditEvents: (filter?: AuditFilter) => listAuditEvents(db, filter),
    verifyAuditChain: () => verifyAuditChain(db),
    // plumbing
    transaction: <T>(fn: () => T): T => ctx.tx(fn),
    compact,
    /** The connection, for tests and for the scripts that open it. Application code uses the methods. */
    db,
  };
}

export type Repository = ReturnType<typeof createRepository>;
export { appendAudit };
