import { ValidationError } from "../../store/errors.js";
import { RULE_KEY_PATTERN } from "../../store/schemas.js";
import { formString, type FormFields } from "../http.js";
import { FIELDS, NOT_COVERED_VALUE, normalizeNewlines } from "../pages/forms.js";
import type { MissedIssueDraft, RatingDraft } from "../pages/feedback.js";
import { MAX_FEEDBACK_TEXT, MAX_LOCATION, MissedIssueBody, RatingBody } from "./schemas.js";

/**
 * Reading what the feedback forms and the feedback JSON carry (package W2.6a), parallel to
 * decision.ts: a parser turns a form or a body into the input of the service, or refuses it with a
 * `ValidationError` whose code has a phrase in `refusals-feedback.ts`. The messages name a rule and
 * never what was sent.
 *
 * A form and a body are refused for the same reasons with the same codes, so a page and a script
 * are told the same thing. Who reported it, which review it is about and which matter it is in are
 * not read from either: the person is the signed-in one and the review is the path's.
 */

/** What the report of a missed issue is made of, as the service takes it. */
export interface MissedIssueInput {
  /** A rule key of the review's playbook, or null for "not covered by any rule". */
  ruleKey: string | null;
  /** Where in the documents, or null when the person gave none. */
  location: string | null;
  /** What the review should have flagged. Never empty. */
  note: string;
}

const blank = (value: string | undefined): boolean => value === undefined || value.trim() === "";

/**
 * The rule key that was given. Nothing given is `rule_required` and never "not covered": that is a
 * choice of its own (the form's `NOT_COVERED_VALUE`, which is not a possible rule key, and JSON's
 * `null`). A value that could not be a rule key at all is `unknown_rule`, the answer for a key that
 * is not in the playbook; whether it is in this review's playbook is for the store to say.
 */
function ruleKeyOf(given: string | undefined): string {
  if (given === undefined || blank(given))
    throw new ValidationError("rule_required", "choose the rule the review should have applied");
  if (!RULE_KEY_PATTERN.test(given))
    throw new ValidationError("unknown_rule", "the rule is not in the playbook");
  return given;
}

/** The location, as the store keeps it (trimmed): left empty it is none; too long it is refused. */
function locationOf(posted: string | undefined): string | null {
  if (posted === undefined || blank(posted)) return null;
  const place = posted.trim();
  if (place.length > MAX_LOCATION)
    throw new ValidationError("location_too_long", "the location is too long");
  return place;
}

/** The note: it must say something, and not more than the store keeps. */
function noteOf(posted: string | undefined): string {
  if (posted === undefined || blank(posted))
    throw new ValidationError("note_required", "the note is empty");
  if (posted.length > MAX_FEEDBACK_TEXT)
    throw new ValidationError("note_too_long", "the note is too long");
  return posted;
}

/**
 * The report form. Every text goes through `normalizeNewlines` first (a browser posts a line break
 * as CR LF). The first thing wrong, in the order the form is laid out (rule, location, note), is
 * what the refusal names, so the person mends the form from the top.
 */
export function missedIssueFromForm(form: FormFields): MissedIssueInput {
  const text = (name: string): string | undefined => {
    const value = formString(form, name);
    return value === undefined ? undefined : normalizeNewlines(value);
  };
  const posted = text(FIELDS.ruleKey);
  const ruleKey = posted === NOT_COVERED_VALUE ? null : ruleKeyOf(posted);
  const location = locationOf(text(FIELDS.location));
  const note = noteOf(text(FIELDS.note));
  return { ruleKey, location, note };
}

/**
 * What had been typed in the report form, to show it again when the report was refused, so that a
 * long note is not lost to a rule left unchosen. Only a rule key that could be one is kept, and the
 * texts are cut to twice what the store accepts, so that a note that was too long is shown to be
 * and a crafted post cannot put more on the page than the form could have held. The text is the
 * person's own, returned to the person who typed it, and goes through the same escaping as every
 * other text on the page. It is never logged or stored.
 */
export function missedIssueDraftFromForm(form: FormFields): MissedIssueDraft {
  const text = (name: string, max: number): string | undefined => {
    const value = formString(form, name);
    return value === undefined ? undefined : normalizeNewlines(value).slice(0, max);
  };
  const draft: MissedIssueDraft = {};
  const rule = text(FIELDS.ruleKey, 64);
  if (rule !== undefined && (rule === NOT_COVERED_VALUE || RULE_KEY_PATTERN.test(rule)))
    draft.ruleKey = rule;
  const location = text(FIELDS.location, MAX_LOCATION * 2);
  if (location !== undefined) draft.location = location;
  const note = text(FIELDS.note, MAX_FEEDBACK_TEXT * 2);
  if (note !== undefined) draft.note = note;
  return draft;
}

/**
 * The report as JSON. The body is a strict object (an unknown key or a wrong type is a `ZodError`,
 * which the shell answers with 400), and past that it is refused for the same reasons as the form,
 * with the same codes: a rule left out or empty is `rule_required` (`null` is the choice "not
 * covered"), a key that is not one is `unknown_rule`, a note that is missing or empty is
 * `note_required`, and an empty location is none.
 */
export function missedIssueFromBody(body: unknown): MissedIssueInput {
  const parsed = MissedIssueBody.parse(body);
  const ruleKey = parsed.ruleKey === null ? null : ruleKeyOf(parsed.ruleKey);
  return {
    ruleKey,
    location: locationOf(parsed.location ?? undefined),
    note: noteOf(parsed.note),
  };
}

// ---------------------------------------------------------------------------------------------
// The rating of a matter (slice C)
// ---------------------------------------------------------------------------------------------

/** What the rating of a matter is made of, as the service takes it. */
export interface RatingInput {
  /** A whole number from 1 to 5. */
  rating: number;
  /** The person's words about it, or null when they gave none. */
  comment: string | null;
}

/**
 * The mark. Nothing given is `rating_required`; something given that is not a whole number from 1
 * to 5 is `bad_rating`. `given` is what the form posted (a string) or what the body carried (a
 * number), and a string is a mark only when it is the plain digit of one: "4" is, "4.0", " 4" and
 * "04" are not, so a mark is one thing in one spelling. A blank string is nothing given.
 */
function markOf(given: string | number | null | undefined): number {
  if (given === undefined || given === null || (typeof given === "string" && blank(given)))
    throw new ValidationError("rating_required", "choose a rating from 1 to 5");
  const mark = typeof given === "number" ? given : /^[1-5]$/.test(given) ? Number(given) : NaN;
  if (!Number.isInteger(mark) || mark < 1 || mark > 5)
    throw new ValidationError("bad_rating", "the rating is not a whole number from 1 to 5");
  return mark;
}

/** The comment, as the store keeps it: left empty it is none; too long it is refused. */
function commentOf(posted: string | null | undefined): string | null {
  if (posted === undefined || posted === null || blank(posted)) return null;
  if (posted.length > MAX_FEEDBACK_TEXT)
    throw new ValidationError("comment_too_long", "the comment is too long");
  return posted;
}

/**
 * The rating form. The first thing wrong, in the order the form is laid out (the mark, then the
 * comment), is what the refusal names. The comment goes through `normalizeNewlines` first.
 */
export function ratingFromForm(form: FormFields): RatingInput {
  const comment = formString(form, FIELDS.comment);
  return {
    rating: markOf(formString(form, FIELDS.rating)),
    comment: commentOf(comment === undefined ? undefined : normalizeNewlines(comment)),
  };
}

/**
 * What had been chosen and typed in the rating form, to show it again when it was refused. Only a
 * mark that is one of the five is kept, and the comment is cut to twice what the store accepts, so
 * that a comment that was too long is shown to be and a crafted post cannot put more on the page
 * than the form could have held. The text is the person's own, returned to the person who typed it,
 * and goes through the same escaping as every other text on the page. It is never logged or stored.
 */
export function ratingDraftFromForm(form: FormFields): RatingDraft {
  const draft: RatingDraft = {};
  const mark = formString(form, FIELDS.rating);
  if (mark !== undefined && /^[1-5]$/.test(mark)) draft.rating = Number(mark);
  const comment = formString(form, FIELDS.comment);
  if (comment !== undefined)
    draft.comment = normalizeNewlines(comment).slice(0, MAX_FEEDBACK_TEXT * 2);
  return draft;
}

/**
 * The rating as JSON. The body is a strict object (an unknown key or a wrong type is a `ZodError`,
 * which the shell answers with 400), and past that it is refused for the same reasons as the form,
 * with the same codes: a mark left out is `rating_required`, a number that is not one of the five is
 * `bad_rating`, a comment that is too long is `comment_too_long`, and an empty comment is none.
 */
export function ratingFromBody(body: unknown): RatingInput {
  const parsed = RatingBody.parse(body);
  return { rating: markOf(parsed.rating), comment: commentOf(parsed.comment) };
}
