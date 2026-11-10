/**
 * What went wrong with a request, in terms an HTTP layer can map to a status. A review the user
 * may not see is reported as not found, so its existence is not given away.
 */
export type ServiceErrorCode = "not_found" | "invalid" | "conflict" | "too_large";

export class ServiceError extends Error {
  override name = "ServiceError";

  constructor(
    readonly code: ServiceErrorCode,
    message: string,
  ) {
    super(message);
  }
}
