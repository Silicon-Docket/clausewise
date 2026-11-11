import { REASON_CODES, type ReasonCode } from "../../contracts.js";
import {
  MINOR_EDIT_HINT,
  MINOR_EDIT_LABEL,
  REASON_CODE_LABEL,
  REASON_CODE_MEANING,
} from "../views/feedback.js";
import { Field } from "./components.js";
import { FIELDS, MINOR_EDIT_VALUE } from "./forms.js";

/**
 * The parts of the feedback capture that sit inside other pages (package W2.6a). Each one is a
 * native control with a label, so it takes its place in the tab order with no script: the reason
 * code and the minor-edit box on the decision form, in the order the reviewer uses them.
 *
 * The decision form is `finding.tsx`'s; it calls these and adds nothing else of its own.
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
