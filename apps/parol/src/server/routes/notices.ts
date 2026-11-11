import { ZodError } from "zod";
import { epochSeconds, safeEqual, sign } from "../../auth/crypto.js";
import { UploadError } from "../../module-contracts.js";
import { SpendRefusedError } from "../../services/errors.js";
import type { UploadWarningView } from "../../services/views.js";
import { ConflictError, ValidationError } from "../../store/errors.js";
import { toSafeError } from "../middleware/errors.js";
import { isFragmentHref, type FragmentHref, type Notice } from "../pages/layout.js";
import { REFUSALS_FEEDBACK } from "./refusals-feedback.js";
import { REFUSALS_PILOT } from "./refusals-pilot.js";
import { REFUSALS_RETENTION } from "./refusals-retention.js";
import { REFUSALS_TRAINING } from "./refusals-training.js";

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
 *
 * The notices, the phrases of the refusals and what a refusal tells the person to do are written
 * in fragments: one for the core of the application (below), and one for each package that adds
 * codes of its own (`refusals-feedback.ts`, `refusals-pilot.ts`, `refusals-retention.ts` and
 * `refusals-training.ts`). The tables the rest of the code reads are the merge of all of them,
 * made once when this file is loaded, and a code that two fragments define is an error then.
 */

export const NOTICE_PARAM = "notice";

// ---------------------------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------------------------

/** A one-time notice a fragment writes: a plain string is a success notice. */
export type FragmentNotice = string | { kind: "success" | "info"; text: string };

/** A place on the page where a refusal is fixed, and the words of the link that leads there. */
export interface RefusalJump {
  href: FragmentHref;
  label: string;
}

/**
 * What one owner contributes to the tables. A code is defined once, in one fragment, with its
 * phrase, the sentence inside the phrase that says what to do (`todo`) and, if the person fixes it
 * at a place on the page, a `jump` to that place. `todo` and `jump` are keyed by the refusal code
 * of a phrase and live in the same fragment as the phrase.
 */
export interface RefusalFragment {
  /** Refusal code (the store's short code) to the phrase a person is shown. */
  phrases: Record<string, string>;
  /** Refusal code to the sentence of its phrase that says what to do. */
  todo: Record<string, string>;
  /** Refusal code to the place on the page where it is fixed. */
  jump?: Record<string, RefusalJump>;
  /** Notice code (carried across a redirect) to its text, or to its kind and text. */
  notices?: Record<string, FragmentNotice>;
}

export interface NamedRefusalFragment {
  name: string;
  fragment: RefusalFragment;
}

export interface RefusalTables {
  phrases: Readonly<Record<string, string>>;
  todo: Readonly<Record<string, string>>;
  jump: Readonly<Record<string, RefusalJump>>;
  notices: Readonly<Record<string, Notice>>;
}

/** The shape a refusal code has: what `toSafeError` lets through, so any other is never seen. */
const REFUSAL_CODE = /^[a-z][a-z0-9_]{0,63}$/;
/** The shape a notice code has: it travels in a query string. */
const NOTICE_CODE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * The tables of all the fragments, in one. It throws when a code is defined by two fragments (a
 * phrase, a todo, a jump or a notice), when a code has a shape that could never be produced, when
 * a todo is empty, and when a jump does not lead to a place on the page, so that the mistake is
 * found when the fragment is written and not when a person meets the form. The messages name codes
 * and fragments, which are written in the source, and nothing else.
 */
export function mergeRefusalFragments(fragments: readonly NamedRefusalFragment[]): RefusalTables {
  const phrases: Record<string, string> = {};
  const todo: Record<string, string> = {};
  const jump: Record<string, RefusalJump> = {};
  const notices: Record<string, Notice> = {};
  const owners = {
    phrases: new Map<string, string>(),
    todo: new Map<string, string>(),
    jump: new Map<string, string>(),
    notices: new Map<string, string>(),
  };
  const claim = (table: keyof typeof owners, code: string, name: string): void => {
    const pattern = table === "notices" ? NOTICE_CODE : REFUSAL_CODE;
    if (!pattern.test(code))
      throw new Error(`the ${table} code "${code}" of the ${name} fragment is not a valid code`);
    const other = owners[table].get(code);
    if (other !== undefined)
      throw new Error(
        `the ${table} code "${code}" is defined by both the ${other} fragment and the ${name} fragment`,
      );
    owners[table].set(code, name);
  };
  for (const { name, fragment } of fragments) {
    for (const [code, text] of Object.entries(fragment.phrases)) {
      claim("phrases", code, name);
      phrases[code] = text;
    }
    for (const [code, sentence] of Object.entries(fragment.todo)) {
      claim("todo", code, name);
      if (sentence.trim() === "")
        throw new Error(`the todo of "${code}" in the ${name} fragment is empty`);
      todo[code] = sentence;
    }
    for (const [code, place] of Object.entries(fragment.jump ?? {})) {
      claim("jump", code, name);
      if (!isFragmentHref(place.href) || place.label.trim() === "")
        throw new Error(`the jump of "${code}" in the ${name} fragment is not a link to a place`);
      jump[code] = { href: place.href, label: place.label };
    }
    for (const [code, found] of Object.entries(fragment.notices ?? {})) {
      claim("notices", code, name);
      notices[code] =
        typeof found === "string"
          ? { kind: "success", text: found }
          : { kind: found.kind, text: found.text };
    }
  }
  return {
    phrases: Object.freeze(phrases),
    todo: Object.freeze(todo),
    jump: Object.freeze(jump),
    notices: Object.freeze(notices),
  };
}

const CORE_NOTICES = {
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
} as const satisfies Record<string, { kind: "success" | "info"; text: string }>;

/**
 * The reasons a person can act on, by the short code the store gives them. Every phrase is fixed
 * and written here, so a refusal never repeats what the request said. A code that is not in the
 * table is answered with the general phrase for its status.
 */
const EDIT_CHANGES_NOTHING =
  "Nothing was changed. Change the status, a text or a label to edit this finding, or choose another decision.";

const CORE_PHRASES = {
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
  decision_conflict:
    "Another reviewer has already decided this finding, so your decision was not recorded. Their decision stands until they change it or the review is run again.",
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
  duplicate_stated_date:
    "That file is already in the matter, so it was not stored again and the stated date you entered was not applied. Change the date on the existing version.",
  run_model_changed:
    "This review was started on a different provider or model than the one now in use, so it cannot be resumed. Start a new review instead.",
  // The store raises this for a note, a report, a location or a rating comment that is empty, too
  // long or holds a control character (a pasted clause can). The code is raised for many fields, so
  // it has no place on the page to jump to.
  bad_text:
    "The text cannot be kept as it is: it is empty, too long or has a control character in it. Check it and try again.",
  // The refusals of the forms of the matter page that a person meets in ordinary use (a second tab,
  // a click on a review that has just finished) and that used to be answered with the general
  // sentence of their status. Each says what has happened to the matter and what to do about it.
  member_exists:
    "That person is already on this matter, so they were not added again. Check the list of people for the role they have.",
  remove_later_first:
    "A document can be removed only after the documents that come after it have been removed. Remove the later documents first.",
  active_run:
    "A review is already running on this matter, so another was not started. Follow the review in progress, or cancel it and start a new one.",
  invalid_transition:
    "The review is no longer in a state where that can be done: it may have finished, failed or been cancelled already. Reload the page to see how the review stands.",
  stale_run:
    "That review is out of date, because the documents or the playbook changed after it started. Start a new review.",
} as const satisfies Record<string, string>;

/**
 * The core fragment: the codes the application had before packages added their own. The sentence
 * that says what to do (`todo`) is written for the codes that gained a phrase with the error pages;
 * the older codes have none yet, and test/a11y/errors.test.ts lists them so that the list can only
 * shrink. A jump leads to the place of the matter page where the refusal is fixed or explained.
 * `invalid_transition` and `stale_run` are about a review and not about a control, so they have
 * none.
 */
const CORE = {
  phrases: CORE_PHRASES,
  todo: {
    bad_text: "Check it and try again.",
    member_exists: "Check the list of people for the role they have.",
    remove_later_first: "Remove the later documents first.",
    active_run: "Follow the review in progress, or cancel it and start a new one.",
    invalid_transition: "Reload the page to see how the review stands.",
    stale_run: "Start a new review.",
  },
  jump: {
    member_exists: { href: "#people", label: "Go to the people on this matter" },
    remove_later_first: { href: "#documents", label: "Go to the documents" },
    active_run: { href: "#active-run", label: "Go to the review in progress" },
  },
  notices: CORE_NOTICES,
} as const satisfies RefusalFragment;

/**
 * Every fragment, in the order they are merged. The four after the core are empty until their
 * package fills them.
 */
export const REFUSAL_FRAGMENTS: readonly NamedRefusalFragment[] = [
  { name: "core", fragment: CORE },
  { name: "feedback", fragment: REFUSALS_FEEDBACK },
  { name: "pilot", fragment: REFUSALS_PILOT },
  { name: "retention", fragment: REFUSALS_RETENTION },
  { name: "training", fragment: REFUSALS_TRAINING },
];

/** The merge of the fragments, for the page routes. */
const MERGED = mergeRefusalFragments(REFUSAL_FRAGMENTS);

/** Refusal code to phrase. */
export const REFUSAL_PHRASES: Readonly<Record<string, string>> = MERGED.phrases;
/** Refusal code to the sentence of its phrase that says what to do. */
export const REFUSAL_TODO: Readonly<Record<string, string>> = MERGED.todo;
/** Refusal code to the place on the page where it is fixed. */
export const REFUSAL_JUMP: Readonly<Record<string, RefusalJump>> = MERGED.jump;
/** Notice code to notice. */
export const NOTICES: Readonly<Record<string, Notice>> = MERGED.notices;

/**
 * The codes of the notices, as the fragments' own types know them: a package that adds a notice to
 * its fragment can pass its code to `withNotice` and `redirectWithNotice` with no edit here.
 */
export type NoticeCode =
  | keyof (typeof CORE)["notices"]
  | keyof (typeof REFUSALS_FEEDBACK)["notices"]
  | keyof (typeof REFUSALS_PILOT)["notices"]
  | keyof (typeof REFUSALS_RETENTION)["notices"]
  | keyof (typeof REFUSALS_TRAINING)["notices"];

/** The notice for a code from a query string, or null for anything that is not one of ours. */
export function noticeFor(code: unknown): Notice | null {
  if (typeof code !== "string" || !Object.hasOwn(NOTICES, code)) return null;
  const found = NOTICES[code] as Notice;
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
 *
 * When the code has a phrase of its own and its fragment says what to do (`todo`) or where to fix
 * it (`jump`), the notice carries both, copied, so a page cannot change the tables. A phrase that
 * came from the status and not from a code carries neither.
 *
 * `tables` are the merged tables of the fragments; a test passes its own to prove the merge reaches
 * the notice.
 */
export function refusalOf(
  error: unknown,
  tables: Pick<RefusalTables, "phrases" | "todo" | "jump"> = MERGED,
): Refusal | null {
  // A review the spend guard refused. The person can act on it (a smaller review, a later day, a
  // word with whoever runs the server), and the words carry the figures the guard planned. Like
  // every other refusal here, the status and the words are the shell's: the JSON API sends the same
  // sentence in the same 409.
  if (error instanceof SpendRefusedError) {
    const safe = toSafeError(error);
    const notice: Notice = { kind: "error", text: safe.message };
    // What to do about it is a sentence inside the words, which the page shows apart. It is the
    // error's own, so the words and the todo cannot drift.
    if (safe.message.includes(error.todoText())) notice.todo = error.todoText();
    return {
      status: 409,
      notice,
      code: typeof safe.extra.code === "string" ? safe.extra.code : null,
    };
  }
  const theirs =
    error instanceof ValidationError ||
    error instanceof ConflictError ||
    error instanceof UploadError ||
    error instanceof ZodError;
  if (!theirs) return null;
  const safe = toSafeError(error);
  if (safe.status !== 400 && safe.status !== 409 && safe.status !== 422) return null;
  const code = typeof safe.extra.code === "string" ? safe.extra.code : null;
  if (error instanceof UploadError)
    return { status: safe.status, notice: { kind: "error", text: safe.message }, code };
  if (code === null || !Object.hasOwn(tables.phrases, code))
    return {
      status: safe.status,
      notice: { kind: "error", text: REFUSAL_BY_STATUS[safe.status] },
      code,
    };
  const todo = Object.hasOwn(tables.todo, code) ? tables.todo[code] : undefined;
  const jump = Object.hasOwn(tables.jump, code) ? tables.jump[code] : undefined;
  const notice: Notice = { kind: "error", text: tables.phrases[code] as string };
  if (todo !== undefined) notice.todo = todo;
  if (jump !== undefined) notice.jump = { href: jump.href, label: jump.label };
  return { status: safe.status, notice, code };
}
