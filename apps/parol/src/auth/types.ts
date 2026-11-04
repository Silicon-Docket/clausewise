import type { GlobalRole, MatterRole } from "../contracts.js";

declare const authorized: unique symbol;

/** Who is asking. Made by the identity layer from a signed cookie, never from a request body. */
export interface Principal {
  readonly userId: string;
  readonly displayName: string;
  readonly globalRole: GlobalRole;
}

/**
 * Proof that a principal may act on one matter in one role. Only `authorizeMatter` in
 * src/auth/authorize.ts makes one, after it has checked membership against the database. Every
 * service function that reads matter data, calls a model or writes a file takes one, so code that
 * reaches the store without authorization does not compile. The brand is a compile-time guard:
 * a test scans the source for any other place that makes one.
 */
export interface AuthorizedMatter {
  readonly [authorized]: true;
  readonly matterId: string;
  readonly principal: Principal;
  readonly role: MatterRole;
}
