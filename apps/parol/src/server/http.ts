import type { Context } from "hono";
import { ValidationError } from "../store/errors.js";

/**
 * Small helpers the shell and the route modules share, so "is this the JSON API" and "read the
 * form" are decided in one place.
 */

export const API_PREFIX = "/api";

/** JSON under `/api`; HTML everywhere else (docs/parol/03). */
export function isApiPath(path: string): boolean {
  return path === API_PREFIX || path.startsWith(`${API_PREFIX}/`);
}

export function isApiRequest(c: Context): boolean {
  return isApiPath(c.req.path);
}

export type FormFields = Record<string, string | File>;

/**
 * The fields of a form post (url-encoded or multipart). A body that cannot be parsed is a
 * `ValidationError`, which says nothing about the body: a parser's own message can quote it.
 * The CSRF check reads the same body first, and Hono keeps what it parsed, so this does not read
 * the request twice.
 */
export async function readForm(c: Context): Promise<FormFields> {
  try {
    return (await c.req.parseBody()) as FormFields;
  } catch {
    throw new ValidationError("bad_body", "the request body could not be read");
  }
}

/** A string field, or undefined when it is absent or a file. */
export function formString(form: FormFields, name: string): string | undefined {
  const value = form[name];
  return typeof value === "string" ? value : undefined;
}

/** The media type of the request body, lower case and without parameters. */
export function bodyMediaType(c: Context): string | undefined {
  return c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
}
