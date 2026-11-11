/**
 * The sentences of the error pages. Pure data with no imports, so that the page layer (which may
 * import almost nothing) and the middleware that chooses the sentence can both use it.
 *
 * Every entry is a fixed sentence or two. None is built from the request, so the page for a failure
 * names a kind of problem and nothing about what was sent. Each says what happened and what the
 * person can do about it; `todo` is the part that says what to do, and it is a sentence that occurs
 * inside `text` (the page sets it in bold, and a test pins that it occurs).
 *
 * The 404 has one key for every cause. A matter that is not yours and a matter that does not exist
 * must read the same, byte for byte, so nothing here depends on whether a matter exists. The other
 * refusals are told apart because telling them apart reveals nothing: a missing form token and a
 * foreign `Host` header are decided before any matter is looked at, and the role and global role
 * sentences are shown only to a person the matter (or the page) already admits to exist.
 *
 * No sentence holds a dash character.
 */

export const GUIDANCE_KEYS = [
  "bad_request",
  "sign_in",
  "csrf",
  "host",
  "role",
  "global_role",
  "not_found",
  "timeout",
  "conflict",
  "too_large",
  "bad_file",
  "headers_large",
  "server",
  "other",
] as const;

export type GuidanceKey = (typeof GUIDANCE_KEYS)[number];

/** `todo` is a sentence that occurs inside `text`. A test pins that. */
export interface Guidance {
  readonly text: string;
  readonly todo: string;
}

export const GUIDANCE: Readonly<Record<GuidanceKey, Guidance>> = {
  bad_request: {
    text: "The request could not be understood. Go back, check the form and try again.",
    todo: "Go back, check the form and try again.",
  },
  sign_in: {
    text: "You need to sign in first. Choose a demo identity on the sign-in page.",
    todo: "Choose a demo identity on the sign-in page.",
  },
  csrf: {
    text: "This form has expired, or it was opened in another session. Reload the page and send the form again.",
    todo: "Reload the page and send the form again.",
  },
  host: {
    text: "Parol answers only at an address of this machine while the demo identity is on. Open Parol at http://localhost followed by the port you started it on.",
    todo: "Open Parol at http://localhost followed by the port you started it on.",
  },
  role: {
    text: "Your role on this matter does not allow that. Ask someone with the right role on the matter, or open the matter to see who has which role.",
    todo: "Ask someone with the right role on the matter, or open the matter to see who has which role.",
  },
  global_role: {
    text: "This page is for the legal engineer or an administrator. Ask one of them, or go back to your matters.",
    todo: "Ask one of them, or go back to your matters.",
  },
  not_found: {
    text: "There is nothing here, or you are not a member of the matter. Check the address, or open the matter from your list of matters.",
    todo: "Check the address, or open the matter from your list of matters.",
  },
  timeout: {
    text: "The request took too long to arrive. Reload the page and try again.",
    todo: "Reload the page and try again.",
  },
  conflict: {
    text: "The matter changed, or the request does not fit its state. Reload the page and try again.",
    todo: "Reload the page and try again.",
  },
  too_large: {
    text: "That upload is larger than Parol accepts. Choose a smaller .docx or .txt file, or ask whoever runs the server to raise the upload limit.",
    todo: "Choose a smaller .docx or .txt file, or ask whoever runs the server to raise the upload limit.",
  },
  bad_file: {
    text: "That file could not be accepted. Parol reads .docx and .txt files. Save the document as .docx or .txt and upload it again.",
    todo: "Save the document as .docx or .txt and upload it again.",
  },
  headers_large: {
    text: "Your browser sent more header data, usually cookies, than the server accepts. Clear this site's cookies and reload the page.",
    todo: "Clear this site's cookies and reload the page.",
  },
  server: {
    text: "Something went wrong on the server. Try again, and if it happens again quote the reference below to whoever runs the server.",
    todo: "Try again, and if it happens again quote the reference below to whoever runs the server.",
  },
  other: {
    text: "The request could not be completed. Go back and try again.",
    todo: "Go back and try again.",
  },
};

/**
 * The key for each status the shell answers with. A status that is not here has the key `other`.
 * 403 is `role`, the most common cause; the shell names the others (`csrf`, `host`, `global_role`)
 * from the kind of error and passes the key along.
 */
export const GUIDANCE_BY_STATUS: Readonly<Record<number, GuidanceKey>> = {
  400: "bad_request",
  401: "sign_in",
  403: "role",
  404: "not_found",
  408: "timeout",
  409: "conflict",
  413: "too_large",
  422: "bad_file",
  431: "headers_large",
  500: "server",
};

const isGuidanceKey = (value: unknown): value is GuidanceKey =>
  typeof value === "string" && (GUIDANCE_KEYS as readonly string[]).includes(value);

/** The key a status has when the error names none: its own, else `other`. */
export const keyForStatus = (status: number): GuidanceKey =>
  Object.hasOwn(GUIDANCE_BY_STATUS, status) ? (GUIDANCE_BY_STATUS[status] as GuidanceKey) : "other";

/**
 * The sentence for a failure. A key that names an entry wins; otherwise the status decides; a
 * status the table does not know gets the general sentence. Never throws, whatever it is given.
 */
export function guidanceFor(status: number, key?: GuidanceKey): Guidance {
  return GUIDANCE[isGuidanceKey(key) ? key : keyForStatus(status)];
}
