/**
 * A review that cannot start or cannot go on. Messages are written to be shown to the user and
 * never repeat contract text, so they are safe to print and to log.
 */
export class ReviewError extends Error {
  override name = "ReviewError";
}
