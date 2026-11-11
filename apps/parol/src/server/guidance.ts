/**
 * The sentences of the error pages. Pure data, so that the page layer (which may import almost
 * nothing) and the middleware that chooses the sentence can both use it. The one thing it imports
 * is the table of global actions, which the page layer may import too, and which the sentences for
 * a page that only some global roles may open are made from.
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

import { GLOBAL_ACTIONS, type GlobalAction } from "../auth/actions.js";

/** The keys that are fixed: each is a kind of failure with one sentence, whatever else is true. */
const FIXED_KEYS = [
  "bad_request",
  "sign_in",
  "csrf",
  "host",
  "role",
  "not_found",
  "timeout",
  "conflict",
  "too_large",
  "bad_file",
  "headers_large",
  "server",
  "other",
] as const;

type FixedKey = (typeof FIXED_KEYS)[number];

/** The roles of a global action, as the table lists them. */
type RolesOf<A extends GlobalAction> = (typeof GLOBAL_ACTIONS)[A];
type Joined<T extends readonly string[]> = T extends readonly [infer Only extends string]
  ? Only
  : T extends readonly [infer First extends string, ...infer Rest extends readonly string[]]
    ? `${First}_${Joined<Rest>}`
    : never;

/**
 * The key for a page that only some global roles may open: `global_` and the roles that may, in
 * the order the table of global actions lists them. The keys are made from that table and are not
 * written here, so a page cannot name roles other than the ones that hold its action. Two actions
 * with the same roles have the same key and so the same sentence.
 */
export type GlobalGuidanceKey = {
  [A in GlobalAction]: `global_${Joined<RolesOf<A>>}`;
}[GlobalAction];

const globalKeyOf = (roles: readonly string[]): GlobalGuidanceKey =>
  `global_${roles.join("_")}` as GlobalGuidanceKey;

/** Every global key, once, in the order the actions are listed. */
const GLOBAL_KEYS: readonly GlobalGuidanceKey[] = [
  ...new Set(Object.values(GLOBAL_ACTIONS).map((roles) => globalKeyOf(roles))),
];

export type GuidanceKey = FixedKey | GlobalGuidanceKey;

/** Whether a key is for a page that only some global roles may open. */
export const isGlobalGuidanceKey = (key: GuidanceKey): key is GlobalGuidanceKey =>
  (GLOBAL_KEYS as readonly string[]).includes(key);

/** The key of the sentence for the page of a global action: the roles that hold it, and no others. */
export const globalGuidanceKey = (action: GlobalAction): GlobalGuidanceKey =>
  globalKeyOf(GLOBAL_ACTIONS[action]);

/** The words for each role that a global action lists. A role the table lists and this does not is a type error. */
const ROLE_WORDS: Readonly<Record<RolesOf<GlobalAction>[number], string>> = {
  legal_engineer: "the legal engineer",
  admin: "an administrator",
};

/** "a", "a or b", "a, b or c". */
function orList(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;
}

/**
 * The sentence for a page that the given roles may open. It says who the page is for and what to
 * do, and the part that says what to do ends it, so it is the `todo`.
 */
function globalRoleGuidance(roles: readonly (keyof typeof ROLE_WORDS)[]): Guidance {
  const words = roles.map((role) => ROLE_WORDS[role]);
  const todo =
    words.length === 1
      ? `Ask ${words[0]}, or go back to your matters.`
      : "Ask one of them, or go back to your matters.";
  return { text: `This page is for ${orList(words)}. ${todo}`, todo };
}

/** Every key: the fixed ones, with the keys for the global roles after `role`. */
export const GUIDANCE_KEYS: readonly GuidanceKey[] = [
  ...FIXED_KEYS.slice(0, FIXED_KEYS.indexOf("role") + 1),
  ...GLOBAL_KEYS,
  ...FIXED_KEYS.slice(FIXED_KEYS.indexOf("role") + 1),
];

/** `todo` is a sentence that occurs inside `text`. A test pins that. */
export interface Guidance {
  readonly text: string;
  readonly todo: string;
}

const FIXED_GUIDANCE: Readonly<Record<FixedKey, Guidance>> = {
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

/** The sentence of each global key, made from the roles in its name's action. */
const GLOBAL_GUIDANCE = Object.fromEntries(
  Object.values(GLOBAL_ACTIONS).map((roles) => [globalKeyOf(roles), globalRoleGuidance(roles)]),
) as Readonly<Record<GlobalGuidanceKey, Guidance>>;

export const GUIDANCE: Readonly<Record<GuidanceKey, Guidance>> = {
  ...FIXED_GUIDANCE,
  ...GLOBAL_GUIDANCE,
};

/**
 * The key for each status the shell answers with. A status that is not here has the key `other`.
 * 403 is `role`, the most common cause; the shell names the others (`csrf`, `host`, and the key of a
 * global action's roles) from the kind of error and passes the key along.
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
