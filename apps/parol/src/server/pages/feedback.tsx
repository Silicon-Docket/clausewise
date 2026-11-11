import { REASON_CODES, type ReasonCode } from "../../contracts.js";
import type { FindingView, MissedIssueView, RatingView, RuleChoice } from "../../services/views.js";
import { urls } from "../urls.js";
import {
  MINOR_EDIT_HINT,
  MINOR_EDIT_LABEL,
  MISSED_ISSUE_BUTTON,
  MISSED_ISSUE_EMPTY,
  MISSED_ISSUE_HEADING,
  MISSED_ISSUE_INTRO,
  MISSED_ISSUE_LIST_HEADING,
  MISSED_ISSUE_LOCATION_HINT,
  MISSED_ISSUE_LOCATION_LABEL,
  MISSED_ISSUE_NO_FINDINGS,
  MISSED_ISSUE_NO_LOCATION,
  MISSED_ISSUE_NOTE_HINT,
  MISSED_ISSUE_NOTE_LABEL,
  MISSED_ISSUE_RULE_HINT,
  MISSED_ISSUE_RULE_LABEL,
  MISSED_ISSUE_RULE_PLACEHOLDER,
  NOTE_BUTTON,
  NOTE_CANNOT_ADD,
  NOTE_HINT,
  NOTE_LABEL,
  NOT_COVERED_LABEL,
  NOTES_EMPTY,
  NOTES_HEADING,
  NOTES_INTRO,
  RATING_BUTTON,
  RATING_COMMENT_HINT,
  RATING_COMMENT_LABEL,
  RATING_FORM_HINT,
  RATING_HEADING,
  RATING_MARKS,
  RATING_MISSED_ISSUE_LINK,
  RATING_NO_MEMO,
  RATING_QUESTION,
  RATING_SCALE_HINT,
  REASON_CODE_LABEL,
  REASON_CODE_MEANING,
  ratingChoiceLabel,
  ratingLabel,
  ruleChoiceLabel,
} from "../views/feedback.js";
import {
  Field,
  Heading,
  RevealedText,
  ScrollBox,
  Section,
  Time,
  textareaValue,
} from "./components.js";
import { FIELDS, MINOR_EDIT_VALUE, NOT_COVERED_VALUE } from "./forms.js";
import { csrfField, type Chrome } from "./layout.js";

/**
 * The parts of the feedback capture that sit inside other pages (package W2.6a). Each one is a
 * native control with a label, so it takes its place in the tab order with no script: the reason
 * code and the minor-edit box on the decision form, in the order the reviewer uses them.
 *
 * The decision form is `finding.tsx`'s; it calls these and adds nothing else of its own. The
 * report of a missed issue is a section of the review page (`run.tsx`), which calls
 * `MissedIssueSection` and adds nothing else of its own. The rating is a section of the memos page
 * (`memos.tsx`), which calls `RatingSection` and adds nothing else of its own.
 */

export interface ReasonCodeDraft {
  /** The code the reviewer had chosen when the decision was refused. */
  reasonCode?: ReasonCode | undefined;
}

/**
 * The reason code of an edit or a reject, as a list to choose from. The first option is the
 * placeholder and is the choice when nothing was chosen. It is not `required`, because accept and
 * escalate carry no code; the server says that an edit or a reject needs one, and the form comes
 * back with what was typed.
 */
export function ReasonCodeField({ draft }: { draft?: ReasonCodeDraft | undefined }) {
  const chosen = draft?.reasonCode;
  return (
    <>
      <Field
        id="decision-reason-code"
        label="Reason code"
        hint="Required for edit and reject. Leave it unchosen for accept and escalate."
      >
        <select
          id="decision-reason-code"
          name={FIELDS.reasonCode}
          aria-describedby="decision-reason-code-hint"
        >
          <option value="" selected={chosen === undefined}>
            Choose a reason code
          </option>
          {REASON_CODES.map((code) => (
            <option value={code} selected={code === chosen}>
              {REASON_CODE_LABEL[code]}
            </option>
          ))}
        </select>
      </Field>
      <details class="disclosure">
        <summary>What the reason codes mean</summary>
        <dl class="facts">
          {REASON_CODES.map((code) => (
            <>
              <dt>{REASON_CODE_LABEL[code]}</dt>
              <dd>{REASON_CODE_MEANING[code]}</dd>
            </>
          ))}
        </dl>
      </details>
    </>
  );
}

export interface MinorEditDraft {
  /** Whether the box was ticked when the decision was refused. */
  minorEdit?: boolean | undefined;
}

/**
 * The minor-edit box, the last control of the Edits fieldset. It is read only for an edit; for any
 * other decision the route drops it, as it drops the edits.
 */
export function MinorEditField({ draft }: { draft?: MinorEditDraft | undefined }) {
  return (
    <div class="field">
      <div class="check">
        <input
          type="checkbox"
          id="edit-minor"
          name={FIELDS.minorEdit}
          value={MINOR_EDIT_VALUE}
          checked={draft?.minorEdit === true}
          aria-describedby="edit-minor-hint"
        />
        <label for="edit-minor">{MINOR_EDIT_LABEL}</label>
      </div>
      <p class="hint" id="edit-minor-hint">
        {MINOR_EDIT_HINT}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Report a missed issue (slice B)
// ---------------------------------------------------------------------------------------------

/** What the person had typed in the report form when it was refused. */
export interface MissedIssueDraft {
  /** The rule key that was chosen, or `NOT_COVERED_VALUE`. Kept as posted, cut to a key's length. */
  ruleKey?: string | undefined;
  location?: string | undefined;
  note?: string | undefined;
}

export interface MissedIssueSectionProps {
  chrome: Chrome;
  matterId: string;
  runId: string;
  /** The rules of the playbook the review was made with, in the playbook's order. */
  rules: readonly RuleChoice[];
  /** The reports already made against the review, oldest first. */
  items: readonly MissedIssueView[];
  /** Whether the review produced any finding. With none there is nothing to report a miss against. */
  hasFindings: boolean;
  draft?: MissedIssueDraft | undefined;
}

/**
 * The form that reports a missed issue against one review, and the reports already made. The rule
 * is chosen from the review's playbook, with "Not covered by any rule" last, and is required: the
 * list starts at a placeholder, so leaving it is a refusal and never a report of "not covered". A
 * review with no findings gets the sentence that says why in place of the form.
 *
 * Every control is a native one with a label, in the order of use: rule, location, note, button.
 * The text of a report is shown through `RevealedText` and nowhere as markup.
 */
export function MissedIssueSection(props: MissedIssueSectionProps) {
  const { chrome, matterId, runId, draft } = props;
  // A choice the list does not hold (a rule key typed by hand) is not offered back: the list starts
  // again at its placeholder, as it does when nothing was chosen.
  const chosen =
    draft?.ruleKey === NOT_COVERED_VALUE || props.rules.some((r) => r.ruleKey === draft?.ruleKey)
      ? draft?.ruleKey
      : undefined;
  return (
    <Section id="missed-issue" title={MISSED_ISSUE_HEADING}>
      {props.hasFindings ? (
        <form method="post" action={urls.missedIssues(matterId, runId)} class="stack">
          {csrfField(chrome.csrfToken)}
          <p>{MISSED_ISSUE_INTRO}</p>
          <Field
            id="missed-issue-rule"
            label={MISSED_ISSUE_RULE_LABEL}
            hint={MISSED_ISSUE_RULE_HINT}
          >
            <select
              id="missed-issue-rule"
              name={FIELDS.ruleKey}
              required
              aria-describedby="missed-issue-rule-hint"
            >
              <option value="" selected={chosen === undefined}>
                {MISSED_ISSUE_RULE_PLACEHOLDER}
              </option>
              {props.rules.map((rule) => (
                <option value={rule.ruleKey} selected={rule.ruleKey === chosen}>
                  {ruleChoiceLabel(rule.ruleKey, rule.title)}
                </option>
              ))}
              <option value={NOT_COVERED_VALUE} selected={chosen === NOT_COVERED_VALUE}>
                {NOT_COVERED_LABEL}
              </option>
            </select>
          </Field>
          <Field
            id="missed-issue-location"
            label={MISSED_ISSUE_LOCATION_LABEL}
            hint={MISSED_ISSUE_LOCATION_HINT}
          >
            <input
              type="text"
              id="missed-issue-location"
              name={FIELDS.location}
              maxlength={200}
              value={draft?.location ?? ""}
              aria-describedby="missed-issue-location-hint"
            />
          </Field>
          <Field
            id="missed-issue-note"
            label={MISSED_ISSUE_NOTE_LABEL}
            hint={MISSED_ISSUE_NOTE_HINT}
          >
            <textarea
              id="missed-issue-note"
              name={FIELDS.note}
              rows={4}
              maxlength={4000}
              required
              aria-describedby="missed-issue-note-hint"
            >
              {textareaValue(draft?.note ?? "")}
            </textarea>
          </Field>
          <div class="actions">
            <button type="submit" class="button button-primary">
              {MISSED_ISSUE_BUTTON}
            </button>
          </div>
        </form>
      ) : (
        <p class="empty">{MISSED_ISSUE_NO_FINDINGS}</p>
      )}
      <h3>{MISSED_ISSUE_LIST_HEADING}</h3>
      {props.items.length === 0 ? (
        <p class="empty">{MISSED_ISSUE_EMPTY}</p>
      ) : (
        <ScrollBox label={MISSED_ISSUE_LIST_HEADING}>
          <table class="data-table">
            <caption class="sr-only">{MISSED_ISSUE_LIST_HEADING}</caption>
            <thead>
              <tr>
                <th scope="col">Rule</th>
                <th scope="col">Location</th>
                <th scope="col">Note</th>
                <th scope="col">Reported by</th>
                <th scope="col">Time</th>
              </tr>
            </thead>
            <tbody>
              {props.items.map((item) => (
                <tr>
                  <td>
                    {item.ruleKey === null ? (
                      NOT_COVERED_LABEL
                    ) : (
                      <>
                        <code>
                          <RevealedText value={item.ruleKey} />
                        </code>
                        {item.ruleTitle === null ? null : (
                          <>
                            {" "}
                            <RevealedText value={item.ruleTitle} />
                          </>
                        )}
                      </>
                    )}
                  </td>
                  <td>
                    {item.location === null ? (
                      <span class="muted">{MISSED_ISSUE_NO_LOCATION}</span>
                    ) : (
                      <RevealedText value={item.location} />
                    )}
                  </td>
                  <td>
                    <div class="doc-text">
                      <RevealedText value={item.note} />
                    </div>
                  </td>
                  <td>
                    <RevealedText value={item.reporterName} />
                  </td>
                  <td>
                    <Time value={item.at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollBox>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Rate this matter (slice C)
// ---------------------------------------------------------------------------------------------

/** What the person had chosen and typed in the rating form when it was refused. */
export interface RatingDraft {
  /** The mark that was chosen, when it was one of the five. */
  rating?: number | undefined;
  comment?: string | undefined;
}

export interface RatingSectionProps {
  chrome: Chrome;
  matterId: string;
  /** Whether the matter has a memo. Until it has one there is nothing to rate. */
  hasMemo: boolean;
  /** The signed-in person's own rating, or null. Nobody else's is ever given to this page. */
  given: RatingView | null;
  /** The review the newest memo was made from, for the link to report a missed issue, or null. */
  runId: string | null;
  draft?: RatingDraft | undefined;
}

/**
 * The rating of the matter by the signed-in person, in the four states it can be in: no memo yet
 * (a sentence says why there is no form), a memo and no rating (the form), a rating given (what
 * the person gave, with its denominator, and no form, because a rating is final), and, under the
 * last two, the link that leads to the report of a missed issue.
 *
 * The question is the legend of one group of five radios, so the group is one tab stop and the
 * arrow keys move between the marks; the comment and the button follow in the order of use. The
 * comment is shown through `RevealedText`, and nowhere as markup.
 */
export function RatingSection(props: RatingSectionProps) {
  const { chrome, matterId, draft, given } = props;
  return (
    <Section id="rating" title={RATING_HEADING}>
      {!props.hasMemo ? (
        <p class="empty">{RATING_NO_MEMO}</p>
      ) : given !== null ? (
        <>
          <p>
            You rated this matter{" "}
            <strong>
              {given.rating} of {RATING_MARKS.length}
            </strong>{" "}
            ({ratingLabel(given.rating)}) on <Time value={given.at} />.
          </p>
          {given.comment === null ? null : (
            <div class="doc-text">
              <RevealedText value={given.comment} />
            </div>
          )}
        </>
      ) : (
        <form method="post" action={urls.rating(matterId)} class="stack">
          {csrfField(chrome.csrfToken)}
          <fieldset class="choices" id="rating-choice" aria-describedby="rating-scale-hint">
            <legend>{RATING_QUESTION}</legend>
            <p class="hint" id="rating-scale-hint">
              {RATING_SCALE_HINT}
            </p>
            <div class="rating-scale">
              {RATING_MARKS.map((mark) => (
                <div class="check">
                  <input
                    type="radio"
                    id={`rating-${mark}`}
                    name={FIELDS.rating}
                    value={String(mark)}
                    checked={draft?.rating === mark}
                    required
                  />
                  <label for={`rating-${mark}`}>{ratingChoiceLabel(mark)}</label>
                </div>
              ))}
            </div>
          </fieldset>
          <Field id="rating-comment" label={RATING_COMMENT_LABEL} hint={RATING_COMMENT_HINT}>
            <textarea
              id="rating-comment"
              name={FIELDS.comment}
              rows={3}
              maxlength={4000}
              aria-describedby="rating-comment-hint"
            >
              {textareaValue(draft?.comment ?? "")}
            </textarea>
          </Field>
          <div class="actions">
            <button type="submit" class="button button-primary">
              {RATING_BUTTON}
            </button>
          </div>
          <p class="hint">{RATING_FORM_HINT}</p>
        </form>
      )}
      {props.hasMemo && props.runId !== null ? (
        <p>
          <a href={`${urls.run(matterId, props.runId)}#missed-issue`}>{RATING_MISSED_ISSUE_LINK}</a>
        </p>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Notes on a finding (slice D)
// ---------------------------------------------------------------------------------------------

/** What the person had typed in the note form when it was refused. */
export interface NoteDraft {
  note?: string | undefined;
}

export interface NotesSectionProps {
  chrome: Chrome;
  matterId: string;
  finding: FindingView;
  /** The level of the section's title: the pane's sections all sit one level under the pane's title. */
  level: 1 | 2 | 3 | 4 | 5 | 6;
  draft?: NoteDraft | undefined;
}

/**
 * The notes on one finding and the form that adds one. Every member of the matter reads every note.
 * The form is offered when the service says a note can be added now; otherwise its reason is said in
 * words, in place of the form, and the notes already made are still listed. A finding made before
 * notes existed (a view with neither the notes nor the answer) has no such section: the page then
 * says nothing it does not know.
 *
 * Every control is a native one with a label: the note, then the button. The text of a note is shown
 * through `RevealedText` and nowhere as markup.
 */
export function NotesSection(props: NotesSectionProps) {
  const { chrome, matterId, finding, draft } = props;
  const { notes, canAddNote } = finding;
  if (notes === undefined && canAddNote === undefined) return null;
  const given = canAddNote?.reason;
  return (
    <section class="pane-section" id="notes" aria-labelledby="notes-heading">
      <Heading level={props.level} id="notes-heading">
        {NOTES_HEADING}
      </Heading>
      <p>{NOTES_INTRO}</p>
      {notes === undefined || notes.length === 0 ? (
        <p class="empty">{NOTES_EMPTY}</p>
      ) : (
        <ol class="feedback-list">
          {notes.map((note) => (
            <li>
              <p class="muted">
                <RevealedText value={note.authorName} />, <Time value={note.at} />
              </p>
              <div class="doc-text">
                <RevealedText value={note.note} />
              </div>
            </li>
          ))}
        </ol>
      )}
      {canAddNote?.allowed === true ? (
        <form method="post" action={urls.notes(matterId, finding.issue.findingId)} class="stack">
          {csrfField(chrome.csrfToken)}
          <Field id="note-text" label={NOTE_LABEL} hint={NOTE_HINT}>
            <textarea
              id="note-text"
              name={FIELDS.note}
              rows={4}
              maxlength={4000}
              required
              aria-describedby="note-text-hint"
            >
              {textareaValue(draft?.note ?? "")}
            </textarea>
          </Field>
          <div class="actions">
            <button type="submit" class="button">
              {NOTE_BUTTON}
            </button>
          </div>
        </form>
      ) : (
        // The box the decision uses to say "not here, and why"; the page has no other class for it.
        <p class="decision-blocked" role="note">
          <RevealedText
            value={
              given !== null && given !== undefined && given.trim() !== "" ? given : NOTE_CANNOT_ADD
            }
          />
        </p>
      )}
    </section>
  );
}
