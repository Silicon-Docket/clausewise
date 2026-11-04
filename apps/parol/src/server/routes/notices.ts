import { ZodError } from "zod";
import { epochSeconds, safeEqual, sign } from "../../auth/crypto.js";
import { UploadError } from "../../module-contracts.js";
import type { UploadWarningView } from "../../services/views.js";
import { ConflictError, ValidationError } from "../../store/errors.js";
import { toSafeError } from "../middleware/errors.js";
import type { Notice } from "../pages/layout.js";

/**
 * The one-time messages of the pages ("the document was added"). A page shows a `Notice` that the
 * route passes in, but nothing carries one across the redirect that follows a form post. So the
 * redirect puts a short fixed code in the query string and the page the redirect lands on turns it
 * back into a phrase here.
 *
 * The code is looked up in a closed table. A value the request carries that is not a key of the
 * table is nothing, and no part of the query string is ever printed, so the notice cannot be used
 * to put text of someone's choosing on a page. The code is also signed (see "Proof that the action
 * happened" below), so a link cannot make a page claim that something was done.
 *
 * A form that is refused is not redirected: it is answered with its own page, the status of the
 * refusal and a notice of kind "error" that says why (see `refusalOf` at the end).
 */

export const NOTICE_PARAM = "notice";

const NOTICES = {
  "matter-created": { kind: "success", text: "The matter was created. Add the documents next." },
  "matter-deleted": { kind: "success", text: "The matter and everything in it was deleted." },
  "settings-saved": { kind: "success", text: "The settings were saved." },
  "member-added": { kind: "success", text: "The person was added to the matter." },
  "document-added": { kind: "success", text: "The document was added." },
  "document-added-warnings": {
    kind: "info",
    text: "The document was added. Some things in it need a look; they are listed under Warnings.",
  },
  "document-duplicate": {
    kind: "info",
    text: "That file is the same as one already in the matter, so it was not stored again.",
  },
  "document-near-duplicate": {
    kind: "info",
    text: "The document was added. Its text is the same as an earlier version saved as a different file; see Warnings.",
  },
  // A version whose text differs is made operative by the upload itself (and an earlier review goes
  // out of date with it). One whose text is the same has its own code, "document-near-duplicate".
  "version-added": {
    kind: "success",
    text: "The new version was added and is now the operative one. Any earlier review is out of date.",
  },
  "operative-saved": { kind: "success", text: "The operative version was saved." },
  "date-saved": { kind: "success", text: "The stated date was saved." },
  "document-removed": { kind: "success", text: "The document was removed." },
  "review-started": {
    kind: "success",
    text: "The review has started. This page shows its progress.",
  },
  "review-resumed": { kind: "success", text: "The review was started again where it stopped." },
  "review-cancelled": { kind: "info", text: "The review was cancelled." },
  "decision-saved": { kind: "success", text: "The decision was saved." },
  "memo-exported": { kind: "success", text: "The memo was exported." },
} as const satisfies Record<string, Notice>;

export type NoticeCode = keyof typeof NOTICES;

/** The notice for a code from a query string, or null for anything that is not one of ours. */
export function noticeFor(code: unknown): Notice | null {
  if (typeof code !== "string" || !Object.hasOwn(NOTICES, code)) return null;
  const found = NOTICES[code as NoticeCode];
  return { kind: found.kind, text: found.text };
}

/** `path` with the code added to its query string. `path` is one of our own URLs, never input. */
export function withNotice(path: string, code: NoticeCode): string {
  return `${path}${path.includes("?") ? "&" : "?"}${NOTICE_PARAM}=${code}`;
}

// ---------------------------------------------------------------------------------------------
// Proof that the action happened
// ---------------------------------------------------------------------------------------------

/**
 * A notice says that something was done ("the memo was exported"). A code alone proves nothing:
 * anyone can put one in a link, and the page would then claim an action that did not happen. So
 * the redirect that follows an action carries a signature too, made with the server's secret over
 * the person, the page and the code, and good for a short time. A link that someone else wrote
 * has no signature, and a signature cannot be moved to another person, page or code.
 */
export const NOTICE_SIGNATURE_PARAM = "nt";
/** The redirect is followed at once; two minutes leaves room for a slow connection and no more. */
export const NOTICE_MAX_AGE_SECONDS = 120;

const NOTICE_DOMAIN = "parol/notice/v1";
const SIGNATURE_SHAPE = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

export interface NoticeBinding {
  /** The server's secret (`AppConfig.cookieSecret`). */
  secret: string;
  /** The signed-in person the redirect is for. */
  userId: string;
  now: Date;
}

const pathnameOf = (path: string): string => path.split(/[?#]/, 1)[0] ?? "";

const noticeMac = (
  { secret, userId }: NoticeBinding,
  pathname: string,
  code: string,
  issued: number,
): string => sign(secret, NOTICE_DOMAIN, [userId, pathname, code, String(issued)].join("\n"));

/** `path` with the code and the proof that it was this person's action, for a redirect. */
export function signedNoticePath(path: string, code: NoticeCode, binding: NoticeBinding): string {
  const issued = epochSeconds(binding.now);
  const mac = noticeMac(binding, pathnameOf(path), code, issued);
  return `${withNotice(path, code)}&${NOTICE_SIGNATURE_PARAM}=${issued}.${mac}`;
}

/**
 * The notice a request may show: that of its code, if its signature was made by this server for
 * this person and this page and code, not more than `NOTICE_MAX_AGE_SECONDS` ago. Anything else,
 * a missing or malformed signature included, is no notice.
 */
export function verifiedNotice(
  request: { pathname: string; code: unknown; signature: unknown },
  binding: NoticeBinding,
): Notice | null {
  const notice = noticeFor(request.code);
  if (notice === null || typeof request.signature !== "string") return null;
  const parts = SIGNATURE_SHAPE.exec(request.signature);
  if (parts === null) return null;
  const issued = Number(parts[1]);
  const age = epochSeconds(binding.now) - issued;
  if (age > NOTICE_MAX_AGE_SECONDS || age < -60) return null;
  const expected = noticeMac(binding, request.pathname, request.code as string, issued);
  return safeEqual(parts[2] as string, expected) ? notice : null;
}

/**
 * The status of an upload that was accepted: 200 when the file was already in the matter and
 * nothing was stored, 201 when a document or a version was made.
 */
export function uploadStatus(warnings: readonly Pick<UploadWarningView, "code">[]): 200 | 201 {
  return warnings.some((w) => w.code === "duplicate_document") ? 200 : 201;
}

/**
 * What to tell a person who has just uploaded a file. A duplicate is stored once and the message
 * says which; a warning about the text is pointed at, not repeated, because the matter page lists
 * every warning with its meaning.
 */
export function uploadNotice(
  warnings: readonly Pick<UploadWarningView, "code">[],
  added: "document-added" | "version-added",
): NoticeCode {
  const has = (code: UploadWarningView["code"]): boolean => warnings.some((w) => w.code === code);
  if (has("duplicate_document")) return "document-duplicate";
  if (has("near_duplicate_version")) return "document-near-duplicate";
  return warnings.length > 0 ? "document-added-warnings" : added;
}

// ---------------------------------------------------------------------------------------------
// A form that was refused
// ---------------------------------------------------------------------------------------------

/** What a refused form is answered with: the status the shell gives it, and the reason in words. */
export interface Refusal {
  status: 400 | 409 | 422;
  notice: Notice;
  /** The store's short code, when it gave one, so a route can tell kinds of refusal apart. */
  code: string | null;
}

/**
 * The reasons a person can act on, by the short code the store gives them. Every phrase is fixed
 * and written here, so a refusal never repeats what the request said. A code that is not in the
 * table is answered with the general phrase for its status.
 */
const EDIT_CHANGES_NOTHING =
  "Nothing was changed. Change the status, a text or a label to edit this finding, or choose another decision.";

const REFUSAL_PHRASES: Readonly<Record<string, string>> = {
  reason_required: "Give a reason. A decision to edit, reject or escalate needs one.",
  // The form sends no edits at all when nothing differs from the finding, so the two codes mean
  // the same thing to the person at the form.
  edits_required: EDIT_CHANGES_NOTHING,
  edit_changes_nothing: EDIT_CHANGES_NOTHING,
  edits_not_allowed: "Only an edit decision carries edits.",
  bad_decision: "Choose a decision.",
  bad_hash:
    "The form does not say which version of the finding it was made on. Reload the page and try again.",
  bad_status: "Choose one of the listed statuses.",
  bad_role: "Choose one of the listed labels.",
  too_many_roles: "The form names more passages than the finding has.",
  content_mismatch:
    "The finding changed after this page was opened. It is shown again as it is now. Read it and decide again.",
  stale_finding:
    "This finding is out of date because the documents or the playbook changed. Run the review again to decide it.",
  matter_exported:
    "The memo has been exported, so decisions can change only after the review is run again.",
  matter_not_in_review: "The matter is not open for review.",
  run_not_succeeded: "The review has not finished, so its findings cannot be decided yet.",
  no_file: "Choose a file to upload.",
  nda_first: "Upload the NDA before an amendment.",
  nda_exists: "The matter already has an NDA.",
  amendment_limit: "The matter already has two amendments.",
  document_limit: "The matter already has three documents.",
  document_layout: "The documents of a matter must be an NDA followed by its amendments.",
  matter_changed:
    "The documents of the matter changed while the file was being read. Upload it again.",
  bad_date: "The stated date must be a real date.",
};

const REFUSAL_BY_STATUS: Readonly<Record<400 | 409 | 422, string>> = {
  400: "That request was not valid. Check the form and try again.",
  409: "That conflicts with the current state of the matter. Reload the page and try again.",
  422: "That file could not be accepted.",
};

/**
 * What a person using a form should be told about an error their request ended in, or null when
 * the error is not theirs to act on (a missing page, a forbidden action, a server fault, a body
 * that is too large) and the shell's own answer stands.
 *
 * The status is the shell's (`toSafeError`), so a form is refused with the status the JSON API
 * gives for the same mistake. The words are the fixed phrases above. The one text that is not ours
 * is that of an `UploadError`, which is written for the person who uploaded the file ("save it as
 * a regular .docx") and which the shell already sends in the JSON body, cleaned of control
 * characters and cut to a length.
 */
export function refusalOf(error: unknown): Refusal | null {
  const theirs =
    error instanceof ValidationError ||
    error instanceof ConflictError ||
    error instanceof UploadError ||
    error instanceof ZodError;
  if (!theirs) return null;
  const safe = toSafeError(error);
  if (safe.status !== 400 && safe.status !== 409 && safe.status !== 422) return null;
  const code = typeof safe.extra.code === "string" ? safe.extra.code : null;
  const text =
    error instanceof UploadError
      ? safe.message
      : code !== null && Object.hasOwn(REFUSAL_PHRASES, code)
        ? (REFUSAL_PHRASES[code] as string)
        : REFUSAL_BY_STATUS[safe.status];
  return { status: safe.status, notice: { kind: "error", text }, code };
}
