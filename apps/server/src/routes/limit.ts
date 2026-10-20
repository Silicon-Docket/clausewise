import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { badRequest } from "../errors.js";

/** How many rows a list answers with when the request does not say, and the most it may ask for. */
export const LIST_LIMIT = { fallback: 100, max: 500 } as const;

/**
 * The `limit` of a list request. Only plain digits count: a sign, a decimal point, an exponent or
 * a hex prefix is refused rather than guessed at, and so is a number outside 1 to 500, because an
 * answer silently cut short reads as the whole list.
 */
export function limitParam(c: Context<AppEnv>): number {
  const raw = c.req.query("limit");
  if (raw === undefined) return LIST_LIMIT.fallback;
  const value = /^[0-9]{1,6}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(value >= 1 && value <= LIST_LIMIT.max)) {
    throw badRequest(`limit must be a whole number from 1 to ${LIST_LIMIT.max}.`);
  }
  return value;
}
