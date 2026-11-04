import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { csrfToken } from "../../auth/csrf.js";
import { authorizeMatterDelete } from "../../auth/authorize.js";
import { requestState } from "../../auth/request.js";
import type { Principal } from "../../auth/types.js";
import { ForbiddenError } from "../../services/errors.js";
import type { MatterView } from "../../services/views.js";
import { NotFoundError, ValidationError } from "../../store/errors.js";
import type { Repository } from "../../store/index.js";
import { bodyMediaType, type FormFields } from "../http.js";
import { CSRF_FIELD, FIELDS } from "../pages/forms.js";
import { render, type Chrome } from "../pages/layout.js";
import {
  NOTICE_PARAM,
  NOTICE_SIGNATURE_PARAM,
  signedNoticePath,
  verifiedNotice,
  type NoticeBinding,
  type NoticeCode,
} from "./notices.js";

/**
 * What the page routes and the JSON routes both need: the frame of a page, the body of a JSON
 * request, the file in an upload, and the two decisions about a matter that the services do not
 * make for a page.
 */

export const DOCX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * A page, sent. The pages are synchronous, so `render` never waits. A form that was refused is
 * answered with its page again and the status of the refusal.
 */
export function sendPage(
  c: Context,
  page: { toString(): string | Promise<string> },
  status: 200 | 400 | 409 | 422 = 200,
): Response {
  return c.html(render(page), status);
}

/** What proves a notice for this person: the server's secret, who they are, and the time. */
function noticeBinding(c: Context, principal: Principal): NoticeBinding {
  const { deps } = requestState(c);
  return { secret: deps.config.cookieSecret, userId: principal.userId, now: deps.now() };
}

/**
 * What every page takes: the name of the signed-in person, the token for the forms of this
 * session, and the notice the last action asked for. The notice is shown only when the query
 * string carries a signature that this server made for this person and this page (notices.ts), so
 * a link cannot make a page claim that something was done.
 */
export function pageChrome(c: Context, principal: Principal): Chrome {
  return {
    userName: principal.displayName,
    csrfToken: csrfToken(c),
    notice: verifiedNotice(
      {
        pathname: c.req.path,
        code: c.req.query(NOTICE_PARAM),
        signature: c.req.query(NOTICE_SIGNATURE_PARAM),
      },
      noticeBinding(c, principal),
    ),
  };
}

/** The redirect that follows an action: to `path`, with the notice of `code` and its proof. */
export function redirectWithNotice(
  c: Context,
  principal: Principal,
  path: string,
  code: NoticeCode,
): Response {
  return c.redirect(signedNoticePath(path, code, noticeBinding(c, principal)), 303);
}

/** Far more than any JSON body of the API needs, and far less than the shell lets through. */
export const MAX_JSON_CHARS = 128 * 1024;

/** A field of a form that was left blank is a field that was not given. */
export const blankToNull = (value: string | undefined): string | null =>
  value === undefined || value.trim() === "" ? null : value;

/** The same, for a field that is optional and not nullable. */
export const blankToUndefined = (value: string | undefined): string | undefined =>
  blankToNull(value) === null ? undefined : value;

/**
 * The JSON body of a request. An empty body is an empty object, so an operation whose fields are
 * all optional (start a review) can be called with none. Anything that cannot be read is a
 * `ValidationError`: the parser's own message can quote the body, so it is not passed on.
 */
export async function readJsonBody(c: Context): Promise<unknown> {
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    throw new ValidationError("bad_body", "the request body could not be read");
  }
  if (text.trim() === "") return {};
  // The largest legitimate body is a decision with two edited texts. The shell's limit is for
  // uploads, and a JSON body has no business near it.
  if (text.length > MAX_JSON_CHARS) throw new HTTPException(413);
  if (bodyMediaType(c) !== "application/json")
    throw new ValidationError("bad_content_type", "send the body as application/json");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError("bad_body", "the request body is not valid JSON");
  }
}

/** The form fields a JSON API upload may carry: the CSRF field, the file, and the named ones. */
export function onlyFields(form: FormFields, allowed: readonly string[]): void {
  for (const name of Object.keys(form))
    if (name !== CSRF_FIELD && !allowed.includes(name))
      throw new ValidationError("unknown_field", "the request has a field that is not accepted");
}

/**
 * The file of an upload form. The name is passed on to be read for its extension and nowhere else:
 * the stored file gets a name of its own, and the name the browser sent never reaches a log, an
 * error or a path. A file past the limit is refused before it is read.
 */
export async function readUpload(
  form: FormFields,
  maxBytes: number,
): Promise<{ fileName: string; bytes: Uint8Array }> {
  const file = form[FIELDS.file];
  if (!(file instanceof File)) throw new ValidationError("no_file", "choose a file to upload");
  if (file.size > maxBytes) throw new HTTPException(413);
  return { fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/** The same fields as a form posts them, read as the text the operations expect. */
export const textField = (form: FormFields, name: string): string | undefined => {
  const value = form[name];
  return typeof value === "string" ? value : undefined;
};

const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * The headers of a memo download. The name is made by the service from the matter's id and the
 * day, and is checked here all the same, so that nothing but plain characters can reach a header.
 * `nosniff` and the rest of the policy are added to every response by the shell.
 */
export function memoDownloadHeaders(fileName: string, size: number): Record<string, string> {
  const name = SAFE_FILE_NAME.test(fileName) ? fileName : "parol-memo.docx";
  return {
    "content-type": DOCX_MEDIA_TYPE,
    "content-disposition": `attachment; filename="${name}"`,
    "content-length": String(size),
  };
}

/**
 * Whether the signed-in person may delete the matter: the person who created it, or an
 * administrator, read from the database. It asks `authorizeMatterDelete`, the function that will
 * decide the request, so the page offers the button to exactly the people who will be let through.
 */
export function mayDeleteMatter(repo: Repository, principal: Principal, matterId: string): boolean {
  try {
    authorizeMatterDelete(repo, principal, matterId);
    return true;
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof NotFoundError) return false;
    throw error;
  }
}

/**
 * Why the memo cannot be exported right now, as a fixed phrase, or null when it can. The words are
 * those of the matter page (pages/matter.tsx), in the same order: a test pins that the two pages
 * say the same thing.
 */
export function exportBlockedReason(view: MatterView): string | null {
  const status = view.matter.status;
  if (status === "stale") return "The results are out of date. Run the review again first.";
  if (view.currentRun === null) return "There is no current review to export.";
  if (status === "in_review")
    return "Every finding needs a current decision before the memo can be exported.";
  if (status !== "review_complete" && status !== "exported")
    return "The review is not ready to export yet.";
  return null;
}
