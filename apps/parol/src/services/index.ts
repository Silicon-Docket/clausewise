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
  const present = createPresenter(deps.repo, deps.config, engine.progressOf);
  const uploads = createUploads(deps, present);
  return {
    matters: createMatterService(deps, present, uploads, engine),
    runs: createRunService(deps, present, engine),
    reviews: createReviewService(deps, present),
  };
}

export {
  DEFAULT_MAX_CONCURRENT_RUNS,
  requireRole,
  type ServiceConfig,
  type ServiceDeps,
} from "./deps.js";
export { ForbiddenError, RunNotReadyError } from "./errors.js";
export { RUN_ERROR_KINDS, type RunErrorKind } from "./run-support.js";
export type { Services, MatterService, RunService, ReviewService } from "./types.js";
export type * from "./views.js";
