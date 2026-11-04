import type { MatterStatus, RunStatus } from "../contracts.js";

/**
 * The matter state machine from docs/parol/02-experience-and-architecture.md, plus the edges the
 * rest of the design needs and the diagram leaves out. Each addition has a reason:
 *
 * - `review_complete -> in_review`: the text under the diagram says a reopened decision returns it.
 * - `running -> stale`: an input can change while a run is in flight; that run is superseded.
 * - `ready <-> draft`: removing a document or the playbook makes a matter incomplete again, and
 *   `applyInputChange` moves it by completeness.
 * - `in_review | review_complete -> deleted`: retention applies to every matter, and the diagram
 *   only lists four of the states a matter can be in when it expires. `running` is left out on
 *   purpose: a run is still writing, so it is cancelled first.
 */
const MATTER_EDGES: Record<MatterStatus, readonly MatterStatus[]> = {
  draft: ["ready", "deleted"],
  ready: ["running", "draft", "deleted"],
  running: ["in_review", "ready", "stale"],
  in_review: ["review_complete", "stale", "deleted"],
  review_complete: ["in_review", "exported", "stale", "deleted"],
  exported: ["stale", "deleted"],
  stale: ["running", "deleted"],
  deleted: [],
};

export function canTransition(from: MatterStatus, to: MatterStatus): boolean {
  return MATTER_EDGES[from].includes(to);
}

export const ACTIVE_RUN_STATUSES = [
  "queued",
  "ingesting",
  "extracting",
  "retrieving",
  "analyzing",
  "verifying",
] as const satisfies readonly RunStatus[];

export const isActiveRunStatus = (status: RunStatus): boolean =>
  (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);

/**
 * The run state machine. Cancelling is allowed from any active state, not only the two the diagram
 * draws, because the runner checks its abort signal between stages. `retrieving -> failed` is
 * added for completeness; the stage is deterministic but can still hit a corrupt record.
 * `superseded` is reached only through `applyInputChange`, never through `updateRunStatus`.
 */
const RUN_EDGES: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["ingesting", "failed", "cancelled", "superseded"],
  ingesting: ["extracting", "failed", "cancelled", "superseded"],
  extracting: ["retrieving", "failed", "cancelled", "superseded"],
  retrieving: ["analyzing", "failed", "cancelled", "superseded"],
  analyzing: ["verifying", "failed", "cancelled", "superseded"],
  verifying: ["succeeded", "failed", "cancelled", "superseded"],
  succeeded: ["superseded"],
  failed: ["queued"],
  cancelled: [],
  superseded: [],
};

export function canRunTransition(from: RunStatus, to: RunStatus): boolean {
  return RUN_EDGES[from].includes(to);
}

export const isTerminalRunStatus = (status: RunStatus): boolean =>
  status === "succeeded" ||
  status === "failed" ||
  status === "cancelled" ||
  status === "superseded";
