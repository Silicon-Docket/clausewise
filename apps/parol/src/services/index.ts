import { EMPTY_SOURCE } from "../evaluations/index.js";
import { createAuditService } from "./audit.js";
import { createEvaluationService } from "./evaluations.js";
import { createFeedbackService } from "./feedback.js";
import { createMatterService } from "./matters.js";
import { createPresenter } from "./present.js";
import { createReviewService } from "./reviews.js";
import { createRunEngine } from "./runner.js";
import { createRunService } from "./runs.js";
import type { ServiceDeps } from "./deps.js";
import type { Services } from "./types.js";
import { createUploads } from "./uploads.js";

/**
 * The service layer. One call per process: the runner it creates owns the queue of runs, so two
 * sets of services over one database would each start runs the other does not know about.
 */
export function createServices(deps: ServiceDeps): Services {
  const engine = createRunEngine(deps);
  const present = createPresenter(deps.repo, deps.config, engine.progressOf, deps.generator);
  const uploads = createUploads(deps, present);
  return {
    matters: createMatterService(deps, present, uploads, engine),
    runs: createRunService(deps, present, engine),
    reviews: createReviewService(deps, present),
    evaluations: createEvaluationService(deps.evaluations ?? EMPTY_SOURCE),
    audit: createAuditService(deps),
    feedback: createFeedbackService(deps, present),
  };
}

export {
  DEFAULT_MAX_CONCURRENT_RUNS,
  requireRole,
  type ServiceConfig,
  type ServiceDeps,
} from "./deps.js";
export { ForbiddenError, RunNotReadyError, SpendRefusedError } from "./errors.js";
export {
  RUN_ERROR_KINDS,
  type RunErrorKind,
  type SpendErrorKind,
  type StoredRunErrorKind,
} from "./run-support.js";
export type { Services, MatterService, RunService, ReviewService } from "./types.js";
export type * from "./views.js";
