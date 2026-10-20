/**
 * Wraps `fetch` so that a redirect is reported to the caller instead of being followed. The
 * contract and, for Anthropic, the API key go to the address that was configured and disclosed.
 * Following a 307 or 308 would replay the whole request body at an address nobody named, and
 * undici keeps `x-api-key` on a hop to another origin.
 *
 * `manual` hands the 3xx answer back untouched. Both SDKs then treat it as an HTTP error that they
 * do not retry, whereas a thrown error would be retried and passed off as a connection problem.
 * The Location header is never read, so the target cannot end up in a message.
 */
export function refuseRedirects(base?: typeof globalThis.fetch): typeof globalThis.fetch {
  return (input, init) => (base ?? globalThis.fetch)(input, { ...init, redirect: "manual" });
}

/** True for the 3xx answers that `refuseRedirects` hands back. */
export function isRedirectStatus(status: number | undefined): boolean {
  return status !== undefined && status >= 300 && status < 400;
}

export const REDIRECT_HINT =
  "The endpoint answered with a redirect, which is never followed so that the contract only " +
  "goes to the address you configured. Set CLAUSEWISE_BASE_URL to the final address.";
