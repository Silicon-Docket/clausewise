import { z } from "zod";
import { PILOT_SEVERITIES, isUsableStartDate, type ReferenceListInput } from "../../pilot/index.js";
import { ValidationError } from "../../store/errors.js";
import { formString, type FormFields } from "../http.js";
import { CSRF_FIELD, FIELDS } from "../pages/forms.js";
import {
  TIMER_INTENTS,
  TRAINED_VALUE,
  ruleKeyOfSeverityField,
  userIdOfTrainedField,
} from "../pages/pilotfields.js";

/**
 * What the four forms of the pilot measures accept (package W2.6b), read from the fields of a form
 * after the guard has let the request in. Each parser is strict: a field the form does not offer is
 * a refusal and not something to ignore, so a post made by hand cannot set a field the operation
 * does not have. A refusal here is a `ValidationError` with a fixed message (the same code and the
 * same phrase as the store's, where the store has one) or a `ZodError`, which the shell answers with
 * 400 and a fixed message; neither is read for its text, because it would quote the input.
 *
 * There is no JSON twin of these routes (docs/parol/03 lists none), so no schema is shared.
 */

/** The fields of a form other than the CSRF token, as they were posted. */
const fieldsOf = (form: FormFields): Record<string, string | File> =>
  Object.fromEntries(Object.entries(form).filter(([name]) => name !== CSRF_FIELD));

const unknownField = (): ValidationError =>
  new ValidationError("unknown_field", "the request has a field that is not accepted");

/**
 * The calendar form: one date. It must be one the pilot can be counted from, by the definition the
 * store and the pilot module use (`isUsableStartDate`), and a date that is not is refused here with
 * the store's own code, so the person is told in the words of the form before anything is looked up.
 */
export function calendarFromForm(form: FormFields): { startDate: string } {
  for (const name of Object.keys(fieldsOf(form)))
    if (name !== FIELDS.startDate) throw unknownField();
  // A missing or non-text field is the empty date, which is refused with the same code as a date
  // that is not a real one.
  const startDate = (formString(form, FIELDS.startDate) ?? "").trim();
  if (!isUsableStartDate(startDate))
    throw new ValidationError(
      "bad_calendar_date",
      "the pilot start date is not a real date that the pilot can be counted from",
    );
  return { startDate };
}

/**
 * The roster form: one ticked box per person who was trained, named `trained:<userId>` with the
 * value `yes`. An unticked box posts nothing, so the people listed are exactly those ticked. Whether
 * each is a user, and how many there may be, is the store's to say.
 */
export function participantsFromForm(form: FormFields): { userIds: string[] } {
  const userIds: string[] = [];
  for (const [name, value] of Object.entries(fieldsOf(form))) {
    const userId = userIdOfTrainedField(name);
    if (userId === null || value !== TRAINED_VALUE) throw unknownField();
    userIds.push(userId);
  }
  return { userIds };
}

/** The timer form: start or stop, and nothing else. */
export const TimerInput = z.strictObject({
  [FIELDS.intent]: z.enum([TIMER_INTENTS.start, TIMER_INTENTS.stop]),
});
export type TimerInput = z.infer<typeof TimerInput>;

export const timerFromForm = (form: FormFields): TimerInput => TimerInput.parse(fieldsOf(form));

const OUTSIDE_FIELDS = {
  high: FIELDS.outsideHigh,
  medium: FIELDS.outsideMedium,
  low: FIELDS.outsideLow,
} as const;

/** A count of issues no rule covers: blank reads as none, and anything but digits is refused. */
function countFromForm(form: FormFields, name: string): number {
  const text = (formString(form, name) ?? "").trim();
  if (text === "") return 0;
  if (!/^\d{1,3}$/.test(text))
    throw new ValidationError("bad_count", "the count of issues no rule covers is 0 to 9");
  // The range, 0 to 9, is the store's, which applies it to every caller.
  return Number(text);
}

/**
 * The reference list form: a severity for each rule that was an issue (`severity:<ruleKey>`, blank
 * for a rule that was not), and three counts of issues no rule covers. Whether each rule key is a
 * rule of the matter's playbook, and whether a rule is listed twice, is the store's to say.
 */
export function referenceListFromForm(form: FormFields): ReferenceListInput {
  const rules: ReferenceListInput["rules"] = [];
  const counts = new Set<string>(Object.values(OUTSIDE_FIELDS));
  for (const [name, value] of Object.entries(fieldsOf(form))) {
    if (counts.has(name)) continue;
    const ruleKey = ruleKeyOfSeverityField(name);
    if (ruleKey === null) throw unknownField();
    const choice = typeof value === "string" ? value.trim() : null;
    if (choice === "") continue;
    const severity = PILOT_SEVERITIES.find((known) => known === choice);
    if (severity === undefined)
      throw new ValidationError("bad_severity", "the severity is high, medium or low");
    rules.push({ ruleKey, severity });
  }
  return {
    rules,
    outsideHigh: countFromForm(form, OUTSIDE_FIELDS.high),
    outsideMedium: countFromForm(form, OUTSIDE_FIELDS.medium),
    outsideLow: countFromForm(form, OUTSIDE_FIELDS.low),
  };
}
