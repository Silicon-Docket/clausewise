import type { RunStatus } from "../../contracts.js";
import type { RunProgress, RunSummary } from "../../services/views.js";
import { isActiveRun, progressStageLabel, runStatusLabel } from "../views/labels.js";

/**
 * What /matters/:id/runs/:runId/status sends and /assets/parol.js reads. It lives beside the pages
 * so the words the script puts on screen come from the same tables as the words the server
 * renders, and the two cannot say different things about the same stage.
 */
export interface RunStatusPayload {
  status: RunStatus;
  /** The plain words for the stage, or for the status when there is no progress yet. */
  label: string;
  /** True once the run will not change again, so the page should reload to show the result. */
  finished: boolean;
  progress: RunProgress | null;
}

export function runStatusPayload(run: RunSummary): RunStatusPayload {
  return {
    status: run.status,
    label:
      run.progress === null ? runStatusLabel(run.status) : progressStageLabel(run.progress.stage),
    finished: !isActiveRun(run.status),
    progress: run.progress,
  };
}
