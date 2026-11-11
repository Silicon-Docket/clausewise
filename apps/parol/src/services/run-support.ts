import { ModelRequestError, type ObjectGenerator } from "@clausewise/llm";
import type { PlaybookRuleRecord } from "../contracts.js";
import type { StoredRule } from "../store/index.js";
import type { SpendStop } from "../usage/errors.js";

/**
 * The kinds a provider's failure gives a run, and the two the engine itself gives one that is
 * stopped without a cause of its own: `interrupted` (the server stopped) and `internal` (a fault
 * in Parol). The evaluation runner shares this type for the fatal errors it meets, so it holds
 * only what a provider or a fault can do.
 */
export type RunErrorKind =
  | "provider_auth"
  | "provider_permission"
  | "provider_model"
  | "provider_billing"
  | "provider_redirect"
  | "interrupted"
  | "internal";

/**
 * The kinds a review that reached a spend limit ends with (usage/guard.ts). They are not a
 * provider's doing and the evaluation, which has its own guard, never meets them.
 */
export type SpendErrorKind = "spend_review_limit" | "spend_daily_limit";

/**
 * The error kinds a run can end with. A closed set, stored as `runs.error_kind` and shown to the
 * user as a code: a provider's own message is never kept, because it can quote the request.
 */
export const RUN_ERROR_KINDS = [
  "provider_auth",
  "provider_permission",
  "provider_model",
  "provider_billing",
  "provider_redirect",
  "spend_review_limit",
  "spend_daily_limit",
  "interrupted",
  "internal",
] as const satisfies readonly (RunErrorKind | SpendErrorKind)[];
export type StoredRunErrorKind = (typeof RUN_ERROR_KINDS)[number];

/**
 * The kind a fatal provider error stands for. `fatal` is the llm package's own judgment that every
 * other call of the run would fail the same way. A redirect arrives as a 3xx status (the transport
 * refuses to follow it), and has no kind of its own in the package.
 */
export function fatalKindOf(error: ModelRequestError): RunErrorKind {
  const status = error.statusCode;
  if (status !== undefined && status >= 300 && status < 400) return "provider_redirect";
  switch (error.kind) {
    case "auth":
      return "provider_auth";
    case "permission":
      return "provider_permission";
    case "not_found":
      return "provider_model";
    case "billing":
      return "provider_billing";
    default:
      return "internal";
  }
}

/**
 * The kind a spend stop ends the run with: the review reached its own limit, or the day's. The
 * other reasons a request is held back (it could not be sized, it belonged to no run) are faults of
 * Parol and end the run as `internal`.
 */
export function spendKindOf(stop: SpendStop): RunErrorKind | SpendErrorKind {
  if (stop.kind === "review_limit") return "spend_review_limit";
  if (stop.kind === "daily_limit") return "spend_daily_limit";
  return "internal";
}

/** A rule as the stages read it: the playbook's fields, without the store's ids. */
export const plainRule = (rule: StoredRule): PlaybookRuleRecord => ({
  key: rule.key,
  category: rule.category,
  title: rule.title,
  severity: rule.severity,
  required: rule.required,
  kind: rule.kind,
  standard: rule.standard,
  fallback: rule.fallback,
  unacceptable: rule.unacceptable,
  guidance: rule.guidance,
  fallbackLanguage: rule.fallbackLanguage,
  escalateWhen: rule.escalateWhen,
  // The topics of keyword hint that matter to the rule. Dropping them makes every hint of the
  // category count for every rule, which is the defect topics remove (see hint-topics-runner.test).
  ...(rule.hintTopics === undefined ? {} : { hintTopics: rule.hintTopics }),
});

export type StopReason = "cancelled" | "superseded" | "ended" | "failed";

/**
 * Thrown inside a run to unwind it. It is not a failure of the run: the run was cancelled, its
 * inputs changed, it already ended, or another unit of it failed and the rest are being stopped.
 * The message is fixed.
 */
export class RunStopped extends Error {
  override name = "RunStopped";
  constructor(readonly reason: StopReason) {
    super("the run was stopped");
  }
}

/** A provider error that ends the run. Carries only the closed kind. */
export class ProviderFailure extends Error {
  override name = "ProviderFailure";
  constructor(readonly kind: StoredRunErrorKind) {
    super("the model provider rejected the request");
  }
}

/**
 * The run's generator: the process's own, watched. A fatal provider error is noted before it is
 * rethrown, so the runner learns the closed kind even though the stages turn the error into a
 * recorded call outcome and carry on (extract degrades, analyze reports a failed answer). The
 * unit that met the error records its failed call and stops the run, and is not saved as an
 * answer.
 */
export function watchGenerator(
  base: ObjectGenerator,
  onFatal: (kind: RunErrorKind) => void,
): ObjectGenerator {
  return {
    provider: base.provider,
    model: base.model,
    disclosure: base.disclosure,
    ...(base.cachesSharedPrefix === undefined
      ? {}
      : { cachesSharedPrefix: base.cachesSharedPrefix }),
    ...(base.minCacheableChars === undefined ? {} : { minCacheableChars: base.minCacheableChars }),
    async generate(request) {
      try {
        return await base.generate(request);
      } catch (error) {
        if (error instanceof ModelRequestError && error.fatal) onFatal(fatalKindOf(error));
        throw error;
      }
    },
  };
}

/**
 * Runs `work` over `items` with at most `limit` in flight, and returns the results in order. The
 * first failure stops anything not yet started, `onFail` is told (so the caller can abort the
 * units in flight), and the failure is rethrown once those have settled.
 *
 * `warmUp` runs the first item alone. A provider that caches a shared prefix only makes the cache
 * readable once the first response starts, so the rest of the batch would pay for the prefix again
 * if it began at the same moment.
 */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
  options: { warmUp?: boolean; onFail?: (error: unknown) => void } = {},
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;

  const one = async (index: number): Promise<void> => {
    try {
      results[index] = await work(items[index] as T, index);
    } catch (error) {
      if (!failed) {
        failed = true;
        firstError = error;
        options.onFail?.(error);
      }
    }
  };

  if (options.warmUp === true && items.length > 1) {
    await one(0);
    next = 1;
  }
  const lanes = Math.max(1, Math.min(limit, items.length - next));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (!failed) {
        const index = next++;
        if (index >= items.length) return;
        await one(index);
      }
    }),
  );
  if (failed) throw firstError;
  return results;
}
