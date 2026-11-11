/** The caller is a member of the matter but the role may not do this. Maps to HTTP 403. */
export class ForbiddenError extends Error {
  override name = "ForbiddenError";
  constructor(readonly action: string) {
    super("this role may not do that");
  }
}

/** A run cannot start, for a reason the user can fix. `reasons` are fixed phrases, not document text. */
export class RunNotReadyError extends Error {
  override name = "RunNotReadyError";
  constructor(readonly reasons: string[]) {
    super("the matter is not ready for a review");
  }
}

/**
 * A review was refused before it began because the spend guard planned a bound above a limit
 * (`usage/errors.ts`). Maps to HTTP 409, and the words for a person are `userText()`.
 */
export { SpendRefusedError } from "../usage/errors.js";
