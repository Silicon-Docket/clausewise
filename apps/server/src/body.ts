import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "./env.js";
import { HttpError, badRequest, tooLarge } from "./errors.js";
import { mediaType } from "./security.js";

export const JSON_BODY_LIMIT = 1024 * 1024;
export const PLAYBOOK_BODY_LIMIT = 300 * 1024;

const mb = (bytes: number): string => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;

/** "1 MB" for a large limit and "300 KB" for a small one. */
export function sizeLimitText(bytes: number): string {
  return bytes >= 1024 * 1024 ? mb(bytes) : `${Math.round(bytes / 1024)} KB`;
}

/**
 * Reads a request body up to `limit` bytes and not one more. The declared length is trusted only
 * to refuse early; the count of bytes actually received is what stops the read, because a client
 * can declare less than it sends or send in chunks with no length at all. When the limit is
 * passed the stream is left unread: nothing more is pulled from it, so nothing more is buffered,
 * and the HTTP server closes the connection after the reply.
 */
export async function readBody(
  request: Request,
  limit: number,
  message: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d{1,15}$/.test(declared) && Number(declared) > limit) {
    throw tooLarge(message);
  }
  const stream = request.body;
  if (stream === null) return new Uint8Array(0);

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw tooLarge(message);
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // The client went away or sent a broken body.
    throw badRequest("The request body could not be read.");
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

// Zod's messages name the expected type and never repeat the value that failed, so they are safe
// to send back, except that the message about a key that is not allowed names the key, and a
// client chooses how long that is. Only the first few messages are shown, each cut short.
const MAX_ISSUES = 3;
const MAX_ISSUE_CHARS = 160;

const brief = (text: string): string =>
  text.length > MAX_ISSUE_CHARS ? `${text.slice(0, MAX_ISSUE_CHARS)}...` : text;

export function describeIssues(error: z.ZodError): string {
  const shown = error.issues.slice(0, MAX_ISSUES).map((issue) => {
    const path = issue.path.map(String).join(".");
    return brief(path === "" ? issue.message : `${path}: ${issue.message}`);
  });
  const more = error.issues.length - shown.length;
  return `The request is not valid. ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}`;
}

/** Text that Postgres cannot store: it has no place for a NUL character. */
export const storableText = (message: string) =>
  z.string().refine((text) => !text.includes("\u0000"), { message });

/**
 * Reads the JSON body of a request and checks it against a schema. The body must be declared as
 * JSON: a browser form can post other types without asking permission.
 */
export async function readJson<S extends z.ZodType>(
  c: Context<AppEnv>,
  schema: S,
  limit: number = JSON_BODY_LIMIT,
): Promise<z.infer<S>> {
  if (mediaType(c.req.header("content-type")) !== "application/json") {
    throw new HttpError(
      415,
      "unsupported_media_type",
      "The request body must be JSON, sent with the content type application/json.",
    );
  }
  const bytes = await readBody(
    c.req.raw,
    limit,
    `The request is too large. The most this address takes is ${sizeLimitText(limit)}.`,
  );
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw badRequest("The request body is not valid JSON.");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw badRequest(describeIssues(parsed.error));
  return parsed.data;
}
