import type { ReferenceView } from "../../services/views.js";
import { urls } from "../urls.js";
import {
  OUTSIDE_LABEL,
  REFERENCE_HEADING,
  REFERENCE_LOCKED,
  REFERENCE_LOCKED_CAPTION,
  REFERENCE_LOCKED_COUNT,
  REFERENCE_LOCKED_EMPTY,
  REFERENCE_LOCKED_OUTSIDE,
  REFERENCE_LOCKED_SEVERITY,
  REFERENCE_NOTE,
  REFERENCE_NOT_AN_ISSUE,
  REFERENCE_NO_PLAYBOOK,
  REFERENCE_NO_PLAYBOOK_LINK,
  REFERENCE_OUTSIDE_HINT,
  REFERENCE_OUTSIDE_LEGEND,
  REFERENCE_RULE_COLUMN,
  REFERENCE_SAVE_LABEL,
  REFERENCE_SEVERITY_COLUMN,
  REFERENCE_TABLE_CAPTION,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  referenceSummary,
  severitySelectLabel,
} from "../views/pilot.js";
import { revealToString } from "../views/reveal.js";
import { RevealedText, ScrollBox, Section, idPart } from "./components.js";
import { FIELDS } from "./forms.js";
import { csrfField, type Chrome } from "./layout.js";
import { PILOT_ANCHORS, referenceSeverityField } from "./pilotfields.js";

/**
 * The reference list of a matter, as a section of the matter page (package W2.6b): the issues a
 * reviewing attorney found by hand, before Parol read the matter, which the pilot measures page
 * compares with what the review found (shadow-mode agreement).
 *
 * The section is for the reviewing attorney only. The service makes the `ReferenceView` for a role
 * that may write the list and gives every other role `null`, so the page shows nothing to them; the
 * route and the store check the role again, and the database refuses a write by anyone else. A
 * view of `null` or no view is no section at all.
 *
 * Three states of the same view. Open: one row for each rule of the matter's playbook with a select
 * (Not an issue, High, Medium, Low), and three counts for the issues no rule covers, in one form
 * with one button. No playbook chosen: the same form without the rules, and a sentence that says
 * who chooses one and where. Locked: a review has started, so the database has closed the list; it
 * is shown as it was left, read only, with the sentence that says why. The playbook's rule titles
 * and keys are shown through `RevealedText`, so an invisible character in one is made visible.
 *
 * Every control is native and labelled, in reading order: the select of a rule has a label that
 * names the rule (visible to a screen reader, not repeated on the screen, where the row header
 * says it), each count has its own visible label, and Tab, arrow keys and typing work as in any
 * form. The page uses no script.
 */
export interface ReferencePanelProps {
  chrome: Chrome;
  matterId: string;
  /** From the pilot service; `null` for a role that may not write the list. */
  reference: ReferenceView | null | undefined;
}

function RuleRows({ reference }: { reference: ReferenceView }) {
  return (
    <ScrollBox label={REFERENCE_TABLE_CAPTION}>
      <table class="data-table">
        <caption>{REFERENCE_TABLE_CAPTION}</caption>
        <thead>
          <tr>
            <th scope="col">{REFERENCE_RULE_COLUMN}</th>
            <th scope="col">{REFERENCE_SEVERITY_COLUMN}</th>
          </tr>
        </thead>
        <tbody>
          {reference.rules.map((rule) => {
            const id = idPart(`reference-severity-${rule.ruleKey}`);
            return (
              <tr>
                <th scope="row">
                  <RevealedText value={rule.title} />
                  <p class="hint">
                    <RevealedText value={rule.ruleKey} />
                  </p>
                </th>
                <td>
                  <label class="sr-only" for={id}>
                    {revealToString(severitySelectLabel(rule.title))}
                  </label>
                  <select id={id} name={referenceSeverityField(rule.ruleKey)}>
                    <option value="" selected={rule.severity === null}>
                      {REFERENCE_NOT_AN_ISSUE}
                    </option>
                    {SEVERITY_ORDER.map((severity) => (
                      <option value={severity} selected={rule.severity === severity}>
                        {SEVERITY_LABEL[severity]}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ScrollBox>
  );
}

function OutsideCounts({ reference }: { reference: ReferenceView }) {
  return (
    <fieldset id={PILOT_ANCHORS.referenceOutside}>
      <legend>{REFERENCE_OUTSIDE_LEGEND}</legend>
      <p class="hint" id="reference-outside-hint">
        {REFERENCE_OUTSIDE_HINT}
      </p>
      {SEVERITY_ORDER.map((severity) => {
        const id = `reference-outside-${severity}`;
        const name = {
          high: FIELDS.outsideHigh,
          medium: FIELDS.outsideMedium,
          low: FIELDS.outsideLow,
        }[severity];
        return (
          <div class="field">
            <label for={id}>{OUTSIDE_LABEL[severity]}</label>
            <input
              id={id}
              name={name}
              type="number"
              inputmode="numeric"
              min={0}
              max={9}
              value={String(reference.outside[severity])}
              autocomplete="off"
              aria-describedby="reference-outside-hint"
            />
          </div>
        );
      })}
    </fieldset>
  );
}

function OpenList(props: { chrome: Chrome; matterId: string; reference: ReferenceView }) {
  const { reference } = props;
  const marked = reference.rules.filter((rule) => rule.severity !== null).length;
  const outside = SEVERITY_ORDER.reduce((sum, severity) => sum + reference.outside[severity], 0);
  return (
    <>
      {reference.state === "no_playbook" ? (
        <p>
          {REFERENCE_NO_PLAYBOOK} <a href="#settings">{REFERENCE_NO_PLAYBOOK_LINK}</a>
        </p>
      ) : null}
      <form
        method="post"
        action={urls.matterReferenceList(props.matterId)}
        class="stack form-panel"
      >
        {csrfField(props.chrome.csrfToken)}
        {reference.state === "no_playbook" ? null : <RuleRows reference={reference} />}
        <OutsideCounts reference={reference} />
        <p class="hint">{referenceSummary(marked, reference.rules.length, outside)}</p>
        <div class="actions">
          <button type="submit" class="button button-primary">
            {REFERENCE_SAVE_LABEL}
          </button>
        </div>
      </form>
    </>
  );
}

function LockedList({ reference }: { reference: ReferenceView }) {
  const marked = reference.rules.filter((rule) => rule.severity !== null);
  const outside = SEVERITY_ORDER.filter((severity) => reference.outside[severity] > 0);
  const outsideTotal = SEVERITY_ORDER.reduce(
    (sum, severity) => sum + reference.outside[severity],
    0,
  );
  return (
    <>
      <p>{REFERENCE_LOCKED}</p>
      {marked.length === 0 && outside.length === 0 ? (
        <p class="empty">{REFERENCE_LOCKED_EMPTY}</p>
      ) : (
        <ScrollBox label={REFERENCE_LOCKED_CAPTION}>
          <table class="data-table">
            <caption>{REFERENCE_LOCKED_CAPTION}</caption>
            <thead>
              <tr>
                <th scope="col">{REFERENCE_RULE_COLUMN}</th>
                <th scope="col">{REFERENCE_LOCKED_SEVERITY}</th>
                <th scope="col">{REFERENCE_LOCKED_COUNT}</th>
              </tr>
            </thead>
            <tbody>
              {marked.map((rule) => (
                <tr>
                  <th scope="row">
                    <RevealedText value={rule.title} />
                  </th>
                  <td>{rule.severity === null ? "" : SEVERITY_LABEL[rule.severity]}</td>
                  <td>1</td>
                </tr>
              ))}
              {outside.map((severity) => (
                <tr>
                  <th scope="row">{REFERENCE_LOCKED_OUTSIDE}</th>
                  <td>{SEVERITY_LABEL[severity]}</td>
                  <td>{String(reference.outside[severity])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollBox>
      )}
      <p class="hint">{referenceSummary(marked.length, reference.rules.length, outsideTotal)}</p>
    </>
  );
}

export function ReferencePanel(props: ReferencePanelProps) {
  const { reference } = props;
  if (reference === undefined || reference === null) return null;
  return (
    <Section id={PILOT_ANCHORS.referenceList} title={REFERENCE_HEADING} note={REFERENCE_NOTE}>
      {reference.state === "locked" ? (
        <LockedList reference={reference} />
      ) : (
        <OpenList chrome={props.chrome} matterId={props.matterId} reference={reference} />
      )}
    </Section>
  );
}
