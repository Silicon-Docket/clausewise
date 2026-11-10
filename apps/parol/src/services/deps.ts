import type { ObjectGenerator } from "@clausewise/llm";
import type { AuthorizedMatter, Principal } from "../auth/types.js";
import {
  globalRoleAllows,
  roleAllows,
  type GlobalAction,
  type MatterAction,
} from "../auth/actions.js";
import type { BuildMemo, SupportChecker } from "../module-contracts.js";
import type { FileStore, Repository } from "../store/index.js";
import { ForbiddenError } from "./errors.js";

export interface ServiceConfig {
  /**
   * Single-person demo: one user may both prepare and review, and the memo says so. Off by default
   * in every real setting, where a reviewer must be a different person from the associate.
   */
  relaxedSegregation: boolean;
  /** How many runs execute at once in this process. Others wait in the queue. Default 2. */
  maxConcurrentRuns?: number;
}

export interface ServiceDeps {
  repo: Repository;
  files: FileStore;
  /** One per process. The runner wraps it per run; it never replaces it. */
  generator: ObjectGenerator;
  config: ServiceConfig;
  now: () => Date;
  /**
   * One line at a time. Lines carry ids, codes and counts and never a name from an upload, a quote
   * or text from a model: nothing in this package passes such text to it.
   */
  log: (line: string) => void;
  /** For workflows that pin a support prompt. Default: the checker built from the registered prompt. */
  supportChecker?: SupportChecker;
  /** Replaces the memo builder. For tests that need a builder refusing at a gate. */
  buildMemo?: BuildMemo;
}

export const DEFAULT_MAX_CONCURRENT_RUNS = 2;

/**
 * Every service function that takes an `AuthorizedMatter` calls this first. The table is the one
 * the routes use, so a route cannot be more permissive than the code behind it, and the matter is
 * always `am.matterId`: no id from a request stands in for it.
 */
export function requireRole(
  am: AuthorizedMatter,
  action: MatterAction,
  config: Pick<ServiceConfig, "relaxedSegregation">,
): void {
  if (!roleAllows(am.role, action, { relaxedSegregation: config.relaxedSegregation }))
    throw new ForbiddenError(action);
}

/**
 * Every service function behind a page that names no matter calls this first, as the matter
 * services call `requireRole`. The table is the one the route guard uses (`GLOBAL_ACTIONS`), so the
 * service is never more permissive than the route. It reads the role of the principal and nothing
 * else: the identity layer read that role from the database for this request.
 */
export function requireGlobalRole(principal: Principal, action: GlobalAction): void {
  if (!globalRoleAllows(principal.globalRole, action)) throw new ForbiddenError(action);
}
