/**
 * The names of the form fields the pages post. Routes read them from here, so a page and a route
 * cannot drift apart. Every value is plain text from a browser form; none of them is trusted, and
 * none carries authority: who the user is and what they may do comes from the session and the
 * database, never from a field.
 */

/** The hidden field every form carries. Its value is the token the shell issued for the session. */
export const CSRF_FIELD = "_csrf";

export const FIELDS = {
  // Session. The sign-in form posts `userId` with intent `sign-in`; the sign-out form posts intent
  // `sign-out` and nothing else.
  intent: "intent",
  userId: "userId",

  // New matter and matter settings
  name: "name",
  clientLegalName: "clientLegalName",
  reviewerUserId: "reviewerUserId",
  playbookVersionId: "playbookVersionId",
  /** Days to keep a matter: on the new-matter form and on the retention form of a matter. */
  retainDays: "retainDays",

  // Documents. A stated date is `YYYY-MM-DD`; an empty value clears it.
  title: "title",
  kind: "kind",
  statedDate: "statedDate",
  file: "file",
  versionId: "versionId",
  /** A checkbox on destructive forms. The route requires the value `yes`. */
  confirm: "confirm",

  // Members
  memberUserId: "userId",
  memberRole: "role",

  // Review decision. `findingContentSha256` is the hash of the finding as the reviewer saw it.
  decision: "decision",
  reason: "reason",
  status: "status",
  discrepancy: "discrepancy",
  fallbackLanguage: "fallbackLanguage",
  findingContentSha256: "findingContentSha256",
} as const;

export const SIGN_IN_INTENT = "sign-in";
export const SIGN_OUT_INTENT = "sign-out";
export const CONFIRM_VALUE = "yes";

const ROLE_FIELD_PREFIX = "evidenceRole:";

/** The select that changes how one cited passage is labelled. Posted for every passage. */
export const evidenceRoleField = (evidenceId: string): string =>
  `${ROLE_FIELD_PREFIX}${evidenceId}`;

/** The evidence id in a field name made by `evidenceRoleField`, or null for any other name. */
export function evidenceIdOfRoleField(name: string): string | null {
  return name.startsWith(ROLE_FIELD_PREFIX) && name.length > ROLE_FIELD_PREFIX.length
    ? name.slice(ROLE_FIELD_PREFIX.length)
    : null;
}

/**
 * Browsers send every line break in a textarea as CR LF, whatever the text held when the page was
 * made. The edit fields on the decision form start out holding the finding's text, so an untouched
 * field comes back with different line breaks from the stored value. A route must pass every
 * posted text field through this before it compares the field with the finding or stores it;
 * otherwise a decision that changed only the status would record the discrepancy and the fallback
 * language as the reviewer's own edits.
 */
export const normalizeNewlines = (value: string): string => value.replace(/\r\n?/g, "\n");

/**
 * The path in `value`, when it is a path on this site: one slash first, no second slash or
 * backslash after it (which a browser reads as another host), and no control character or space.
 * Anything else, including a full URL or a `javascript:` string, is null.
 */
export function localPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return null;
  return /[\u0000-\u0020\u007f\\]/.test(value) ? null : value;
}
