import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { notFound } from "../errors.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID.test(value);

/**
 * The id in the address. Postgres refuses text that is not a uuid with an error of its own, so
 * a malformed id is answered as the not-found it is, before the database is asked.
 */
export function uuidParam(c: Context<AppEnv>, name: string, what: string): string {
  const value = c.req.param(name);
  if (value === undefined || !isUuid(value)) throw notFound(`There is no such ${what}.`);
  return value.toLowerCase();
}
