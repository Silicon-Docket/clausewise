/**
 * The names of the pilot forms' fields and the places on their pages that a refusal leads to
 * (package W2.6b). The pages lay the forms out and the routes read them, and both take the names
 * from here, as they take every other field from `forms.ts`, so a page and a route cannot drift
 * apart. This file is in the pages folder because a page may import only other pages (a route may
 * import from a page, as `pages.ts` imports `WORKFLOW_FIELD` from `pages/matter.js`; the other way
 * is not allowed). `forms.ts` is the lead's and holds the four plain names (`startDate`,
 * `outsideHigh`, `outsideMedium`, `outsideLow`); the two that carry an id in their name are here.
 *
 * Nothing here is trusted: a field name comes from a browser form, and a route looks the id or the
 * rule key in it up against the database before it uses it.
 */

/** What a ticked box of the roster posts. An unticked box posts nothing. */
export const TRAINED_VALUE = "yes";

/**
 * What the button of the timer posts as `intent` (the field is `FIELDS.intent`): the button that
 * starts a timer and the button that stops one. The route accepts these two values and no other.
 */
export const TIMER_INTENTS = { start: "start", stop: "stop" } as const;

const TRAINED_PREFIX = "trained:";
const SEVERITY_PREFIX = "severity:";

/** The checkbox that records one person as trained. */
export const trainedField = (userId: string): string => `${TRAINED_PREFIX}${userId}`;

/** The user id in a field name made by `trainedField`, or null for any other name. */
export function userIdOfTrainedField(name: string): string | null {
  return name.startsWith(TRAINED_PREFIX) && name.length > TRAINED_PREFIX.length
    ? name.slice(TRAINED_PREFIX.length)
    : null;
}

/** The select that holds the severity of one rule's issue in the reference list. */
export const referenceSeverityField = (ruleKey: string): string => `${SEVERITY_PREFIX}${ruleKey}`;

/** The rule key in a field name made by `referenceSeverityField`, or null for any other name. */
export function ruleKeyOfSeverityField(name: string): string | null {
  return name.startsWith(SEVERITY_PREFIX) && name.length > SEVERITY_PREFIX.length
    ? name.slice(SEVERITY_PREFIX.length)
    : null;
}

/**
 * The ids of the places a refusal of these forms leads to, without the `#`. The refusal fragment
 * (`routes/refusals-pilot.ts`) links to them and the pages give them to the controls, so a link
 * cannot lead to a control that is not there.
 */
export const PILOT_ANCHORS = {
  /** The date input of the calendar form on the pilot page. */
  startDate: "start-date",
  /** The roster of trained people on the pilot page. */
  participants: "participants",
  /** The section of the timer on the matter page. */
  timer: "time",
  /** The section of the reference list on the matter page. */
  referenceList: "reference-list",
  /** The three counts of issues no rule covers, in the reference list. */
  referenceOutside: "reference-outside",
} as const;
