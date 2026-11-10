import type { Principal } from "../auth/types.js";
import type { ServiceDeps } from "./deps.js";

/**
 * The audit log check, as data (package W2.7, slice C). `check` will call
 * `requireGlobalRole(principal, "audit.read")` first, then read the chain and the reconciliation
 * from the repository. It never receives a value from a request and never returns a name.
 *
 * Contract commit CC1: the service interface is the design's (W2.7 section 3.5). The view is a
 * minimal shape that W2.7 completes; the page reaches it only through `services/views.ts`.
 */

/** STUB(W2.7): the result of one check. W2.7 adds the chain, head, reconciliation and retention parts. */
export interface AuditPageView {
  checkedAt: string;
}

export interface AuditService {
  check(principal: Principal): AuditPageView;
}

/**
 * Builds the service. It must not throw here: `createServices` calls it for every process and
 * every test. The method is the stub.
 */
export function createAuditService(_deps: ServiceDeps): AuditService {
  return {
    check() {
      throw new Error("stub: W2.7"); // STUB(W2.7)
    },
  };
}
