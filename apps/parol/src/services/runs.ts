import type { AuthorizedMatter } from "../auth/types.js";
import {
  ActiveRunError,
  ConflictError,
  NotFoundError,
  type Repository,
  type RunRow,
  type WorkflowVersionRow,
} from "../store/index.js";
import { requireRole, type ServiceDeps } from "./deps.js";
import { RunNotReadyError } from "./errors.js";
import type { Presenter } from "./present.js";
import { startReadiness } from "./readiness.js";
import type { RunEngine } from "./runner.js";
import type { RunService } from "./types.js";
import type { IssueRow } from "./views.js";

/** The workflow a run uses when the caller names none: the promoted one, else the baseline. */
function defaultWorkflow(repo: Repository): WorkflowVersionRow {
  const pilots = repo
    .listWorkflowVersions()
    .filter((w) => w.status === "pilot")
    .sort((a, b) => (a.promotedAt ?? "").localeCompare(b.promotedAt ?? ""));
  const promoted = pilots[pilots.length - 1];
  if (promoted !== undefined) return promoted;
  const baseline = repo.getWorkflowVersionByLabel("v1");
  if (baseline === undefined) throw new NotFoundError("workflow version");
  return baseline;
}

/**
 * Starting, resuming, cancelling and reading runs. The stages run in the background, in the
 * engine; these functions decide whether a run may start, record it, and answer from the store.
 */
export function createRunService(
  deps: ServiceDeps,
  present: Presenter,
  engine: RunEngine,
): RunService {
  const { repo, config } = deps;

  const requireRun = (am: AuthorizedMatter, runId: string): RunRow => {
    const run = repo.getRun(am.matterId, runId);
    if (run === undefined) throw new NotFoundError("run");
    return run;
  };

  return {
    start(am, input) {
      requireRole(am, "run.start", config);
      const matter = repo.getMatter(am.matterId);
      if (matter === undefined) throw new NotFoundError("matter");
      // A run in flight is the store's own conflict, which carries the id so that a page can link
      // to it; the readiness reasons say the same in words for a page that wants to show them.
      const active = repo.getActiveRun(matter.id);
      if (active !== undefined) throw new ActiveRunError(active.id);
      const readiness = startReadiness(repo, matter.id);
      if (!readiness.ready) throw new RunNotReadyError(readiness.reasons);

      let workflow: WorkflowVersionRow | undefined;
      if (input.workflowLabel === undefined) workflow = defaultWorkflow(repo);
      else if (typeof input.workflowLabel === "string")
        workflow = repo.getWorkflowVersionByLabel(input.workflowLabel);
      if (workflow === undefined) throw new NotFoundError("workflow version");
      const chosen = workflow;

      const run = repo.transaction(() => {
        // A review that already has results, started again, is a re-run: its findings and
        // decisions become stale and its memo, if the inputs are unchanged, stays on record.
        if (
          matter.status === "in_review" ||
          matter.status === "review_complete" ||
          matter.status === "exported"
        )
          repo.applyInputChange(matter.id, {
            reason: "rerun_requested",
            actorId: am.principal.userId,
          });
        const manifest = repo.buildRunManifest(matter.id, {
          workflowVersionId: chosen.id,
          modelProvider: deps.generator.provider,
          model: deps.generator.model,
        });
        return repo.createRun(matter.id, { manifest, startedBy: am.principal.userId });
      });
      engine.enqueue(matter.id, run.id);
      deps.log(`run ${run.id} (matter ${matter.id}): queued, workflow ${chosen.label}`);
      return present.runSummary(run);
    },

    get(am, runId) {
      requireRole(am, "run.read", config);
      return present.runSummary(requireRun(am, runId));
    },

    list(am) {
      requireRole(am, "run.read", config);
      return repo.listRunsForMatter(am.matterId).map(present.runSummary);
    },

    resume(am, runId) {
      requireRole(am, "run.resume", config);
      const failed = requireRun(am, runId);
      // A run is reproducible from its manifest: its provenance, its memo and the destination that
      // was disclosed when it started all name one provider and model. Units finished on another
      // would make every one of those untrue, and send document text somewhere that was never
      // disclosed for this run. A review that should go to the new model is a new review.
      if (
        failed.modelProvider !== deps.generator.provider ||
        failed.modelRequested !== deps.generator.model
      )
        throw new ConflictError(
          "run_model_changed",
          "this run was started on a different provider or model than the one now configured; start a new review instead",
        );
      // Back to `queued` only from `failed`, only on the inputs the run was started on, and only
      // with nothing else in flight; the store refuses each, and the engine starts it again where
      // it stopped, skipping the units whose input hash it already has.
      const queued = repo.updateRunStatus(am.matterId, runId, "queued", {
        actorId: am.principal.userId,
      });
      engine.enqueue(am.matterId, runId);
      deps.log(`run ${runId} (matter ${am.matterId}): queued again`);
      return present.runSummary(queued);
    },

    cancel(am, runId) {
      requireRole(am, "run.start", config);
      requireRun(am, runId);
      const cancelled = repo.updateRunStatus(am.matterId, runId, "cancelled", {
        actorId: am.principal.userId,
      });
      engine.stop(runId, "cancelled");
      return present.runSummary(cancelled);
    },

    issues(am, runId): IssueRow[] {
      requireRole(am, "run.read", config);
      let run: RunRow | undefined;
      if (runId !== undefined) run = repo.getRun(am.matterId, runId);
      else {
        // The current run; failing that, the newest run that produced findings, so that the
        // results of a review whose documents have since changed are still there to read, marked stale.
        run =
          repo.getCurrentRun(am.matterId) ??
          repo
            .listRunsForMatter(am.matterId)
            .find((r) => repo.listFindings(am.matterId, r.id).length > 0);
      }
      if (run === undefined) return [];
      return repo.listFindings(am.matterId, run.id).map(present.issueRow);
    },

    finding(am, findingId) {
      requireRole(am, "finding.read", config);
      const record = repo.getFinding(am.matterId, findingId);
      if (record === undefined) throw new NotFoundError("finding");
      return present.findingView(am, record);
    },

    idle: () => engine.idle(),
  };
}
