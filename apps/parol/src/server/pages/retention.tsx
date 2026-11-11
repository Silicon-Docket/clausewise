import type { RetentionView } from "../../services/views.js";
import { urls } from "../urls.js";
import { formatDate, formatDateTime, plural } from "../views/format.js";
import { Chip, Field, Section } from "./components.js";
import { FIELDS } from "./forms.js";
import { csrfField, type Chrome } from "./layout.js";

/**
 * The retention date of a matter, as a section of the matter page (package W2.7): how long the
 * matter is kept, whether it is past its date, and, for an associate, the form that changes it.
 *
 * The page says what the date means and no more: from that time the operator's retention command
 * deletes the matter, and nothing deletes it by itself. The date is an instant (the day it was set
 * plus whole days, so partway through its calendar day) and the command compares that instant, so
 * the page names the instant in UTC and not the day: a day would be wrong for up to 24 hours. The
 * minute is cut, not rounded, so the time named is never later than the one the command uses.
 * Every number it states is a time or a count of days from today; none is a measurement. The
 * section is a real form with a labelled number field and a submit button, so Tab reaches them in
 * document order and Enter submits; it uses no script.
 *
 * The file name is letters only because a page may import another page only by such a name (the
 * static test).
 */
export interface RetentionSectionProps {
  chrome: Chrome;
  matterId: string;
  /** From `MatterView.retention`. Absent when the service did not fill it: no section. */
  retention: RetentionView | undefined;
  /** Whether the signed-in person's role on the matter allows `matter.update`. */
  canUpdate: boolean;
}

export function RetentionSection(props: RetentionSectionProps) {
  const { retention } = props;
  if (retention === undefined) return null;
  const when = formatDateTime(retention.retainUntil);
  return (
    <Section id="retention" title="How long this matter is kept">
      {retention.pastDate ? (
        <p>
          <Chip tone="warn" shape="triangle">
            Past its date
          </Chip>{" "}
          {`This matter is past its retention date (${formatDate(retention.retainUntil)}). It became deletable at ${when}. It is still here because nothing deletes a matter by itself; it goes when the operator runs the retention command. `}
          {props.canUpdate
            ? "Change the date below if it should be kept."
            : "Ask an associate on the matter to change the date if it should be kept."}
        </p>
      ) : (
        <p>
          {`This matter is kept until ${when}, ${plural(retention.daysLeft, "day")} from today. From that time it is deleted, with its documents, findings, decisions and memos, when the operator runs the retention command. Nothing deletes it by itself.`}
        </p>
      )}
      {props.canUpdate ? (
        <form method="post" action={urls.matterRetention(props.matterId)} class="stack form-panel">
          {csrfField(props.chrome.csrfToken)}
          <Field
            id="retain-days"
            label="Keep for how many more days, counting from today"
            hint={`A whole number from 1 to ${retention.maxDays}. The new date replaces the old one, whether it is earlier or later.`}
          >
            <input
              id="retain-days"
              name={FIELDS.retainDays}
              type="number"
              inputmode="numeric"
              min={1}
              max={retention.maxDays}
              required
              autocomplete="off"
              aria-describedby="retain-days-hint"
            />
          </Field>
          <div class="actions">
            <button type="submit" class="button button-primary">
              Change retention date
            </button>
          </div>
        </form>
      ) : (
        <p class="hint">Only an associate on the matter can change this date.</p>
      )}
    </Section>
  );
}
