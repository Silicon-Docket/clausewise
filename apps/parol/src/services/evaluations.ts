import type { Principal } from "../auth/types.js";
import type { ComparisonSource } from "../evaluations/source.js";

/**
 * The evaluation comparison page, as data (package W2.5). The service reads published comparison
 * files through a `ComparisonSource` and never receives a repository. Every function will call
 * `requireGlobalRole(principal, "evaluation.read")` first.
 *
 * Contract commit CC1: the service interface is the design's (W2.5 section 3.4). The two views are
 * minimal shapes that W2.5 completes; the pages reach them only through `services/views.ts`.
 */

export interface EvaluationQuery {
  id: string;
  split?: string;
  caseKey?: string;
  ruleKey?: string;
}

/** STUB(W2.5): the list of published comparisons. W2.5 adds the entry shape of its design. */
export interface EvaluationListView {
  entries: readonly unknown[];
  truncated: boolean;
}

/** STUB(W2.5): one comparison with its selected section. W2.5 adds the rest of its design. */
export interface ComparisonView {
  publishedAt: string;
}

export interface EvaluationService {
  list(principal: Principal): EvaluationListView;
  /** Throws `NotFoundError("evaluation comparison")` for an id that is malformed, unknown or unreadable. */
  comparison(principal: Principal, query: EvaluationQuery): ComparisonView;
}

/**
 * Builds the service over a source. It must not throw here: `createServices` calls it for every
 * process and every test. The methods are the stubs.
 */
export function createEvaluationService(_source: ComparisonSource): EvaluationService {
  return {
    list() {
      throw new Error("stub: W2.5"); // STUB(W2.5)
    },
    comparison() {
      throw new Error("stub: W2.5"); // STUB(W2.5)
    },
  };
}
