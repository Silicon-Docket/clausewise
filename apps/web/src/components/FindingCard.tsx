import { LIMITS, type Decision, type Finding, type FindingClause } from "@clausewise/api";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { DECISION_LABEL, FINDING_STATUS_LABEL } from "../lib/format.js";
import { effectiveReplacement } from "../lib/findings.js";
import { DiffView } from "./DiffView.js";
import { SeverityBadge } from "./SeverityBadge.js";

/** A clause longer than this is cut, with a button for the rest. */
const CLAUSE_PREVIEW_CHARS = 900;

export interface FindingCardProps {
  finding: Finding;
  /** A request for this finding is in flight, or a bulk change is. */
  busy: boolean;
  /** Why the last change was not saved, in words. */
  error: string | null;
  onDecide: (decision: Decision) => void;
  /** Stores a new wording. Resolves true when it was saved, so that the editor can close. */
  onSaveEdit: (text: string, accept: boolean) => Promise<boolean>;
  onReset: () => void;
}

export function FindingCard(props: FindingCardProps) {
  const { finding, busy, error, onDecide, onSaveEdit, onReset } = props;
  const titleId = useId();
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  // When the editor closes its own buttons go away, so focus goes back to the button that opened it.
  useEffect(() => {
    if (!editing && returnFocus.current) {
      returnFocus.current = false;
      editButton.current?.focus();
    }
  }, [editing]);
  const closeEditor = (): void => {
    returnFocus.current = true;
    setEditing(false);
  };

  const edited = finding.editedReplacement !== null;
  const canReset = finding.decision !== "pending" || edited;

  return (
    <article
      className={`finding finding-${finding.decision}`}
      aria-labelledby={titleId}
      aria-busy={busy}
    >
      <div className="finding-head">
        <SeverityBadge severity={finding.severity} />
        <h3 id={titleId} className="finding-title">
          {finding.title}
        </h3>
        <DecisionChip decision={finding.decision} />
      </div>

      <p className="finding-status">
        {FINDING_STATUS_LABEL[finding.status]}.
        {finding.required ? " The playbook marks this clause as required." : ""}
      </p>
      <p className="finding-explanation">{finding.explanation}</p>

      <Clauses clauses={finding.clauses} missing={finding.status === "missing"} />

      <Change
        finding={finding}
        editing={editing}
        busy={busy}
        onSaveEdit={onSaveEdit}
        onClose={closeEditor}
      />

      {finding.suggestedClause === null ? null : (
        <div className="finding-block">
          <p className="field-label">Suggested clause</p>
          <p className="document-text">{finding.suggestedClause}</p>
        </div>
      )}

      <details className="finding-comment">
        <summary>Comment that goes into the Word file</summary>
        <p>{finding.comment}</p>
      </details>

      {error === null ? null : (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}

      <div className="finding-actions" role="group" aria-label="Decision">
        <button
          type="button"
          className="button button-accept"
          aria-pressed={finding.decision === "accepted"}
          disabled={busy}
          onClick={() => onDecide(finding.decision === "accepted" ? "pending" : "accepted")}
        >
          Accept
        </button>
        <button
          type="button"
          className="button button-reject"
          aria-pressed={finding.decision === "rejected"}
          disabled={busy}
          onClick={() => onDecide(finding.decision === "rejected" ? "pending" : "rejected")}
        >
          Reject
        </button>
        {finding.edit.kind === "applied" && !editing ? (
          <button
            ref={editButton}
            type="button"
            className="button"
            disabled={busy}
            onClick={() => setEditing(true)}
          >
            Edit wording
          </button>
        ) : null}
        {canReset ? (
          <button type="button" className="button button-quiet" disabled={busy} onClick={onReset}>
            Reset
          </button>
        ) : null}
        {busy ? <span className="saving">Saving...</span> : null}
      </div>
    </article>
  );
}

function DecisionChip(props: { decision: Decision }) {
  const { decision } = props;
  return (
    <span className={`decision decision-${decision}`}>
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
        {decision === "accepted" ? <path d="M2 6.5 5 9.5 10.5 3" /> : null}
        {decision === "rejected" ? <path d="M2.5 2.5 9.5 9.5M9.5 2.5 2.5 9.5" /> : null}
        {decision === "pending" ? <circle cx="6" cy="6" r="3.75" /> : null}
      </svg>
      {DECISION_LABEL[decision]}
    </span>
  );
}

function Clauses(props: { clauses: FindingClause[]; missing: boolean }) {
  const { clauses, missing } = props;
  if (clauses.length === 0) {
    return missing ? (
      <div className="finding-block">
        <p className="field-label">What the contract says</p>
        <p className="muted">No clause in the contract covers this.</p>
      </div>
    ) : null;
  }
  return (
    <div className="finding-block">
      <p className="field-label">What the contract says</p>
      {clauses.map((clause) => (
        <ClauseText key={clause.id} clause={clause} />
      ))}
    </div>
  );
}

function clauseName(clause: FindingClause): string {
  const number = clause.number === null ? "Clause" : `Clause ${clause.number}`;
  return clause.heading === null ? number : `${number}, ${clause.heading}`;
}

function ClauseText(props: { clause: FindingClause }) {
  const { clause } = props;
  const [whole, setWhole] = useState(false);
  const long = clause.text.length > CLAUSE_PREVIEW_CHARS;
  const shown =
    long && !whole ? `${clause.text.slice(0, CLAUSE_PREVIEW_CHARS).trimEnd()}...` : clause.text;
  return (
    <figure className="clause">
      <figcaption>{clauseName(clause)}</figcaption>
      <blockquote className="document-text">{shown}</blockquote>
      {long ? (
        <button
          type="button"
          className="link-button"
          aria-expanded={whole}
          onClick={() => setWhole(!whole)}
        >
          {whole ? "Show less" : "Show the whole clause"}
        </button>
      ) : null}
    </figure>
  );
}

function Change(props: {
  finding: Finding;
  editing: boolean;
  busy: boolean;
  onSaveEdit: FindingCardProps["onSaveEdit"];
  onClose: () => void;
}) {
  const { finding, editing, busy, onSaveEdit, onClose } = props;
  const { edit } = finding;

  if (edit.kind === "none") return null;

  if (edit.kind === "comment-only") {
    return (
      <div className="finding-block">
        <p className="field-label">Suggested wording, as a comment only</p>
        <p className="muted">{edit.reason}</p>
        <p className="muted">Instead of:</p>
        <p className="document-text">{edit.proposed.quote}</p>
        <p className="muted">Suggested:</p>
        <p className="document-text">{edit.proposed.replacement}</p>
        <p className="muted">
          Accepting keeps the comment in the Word file. No tracked change is written for this one.
        </p>
      </div>
    );
  }

  const replacement = effectiveReplacement(finding) ?? "";
  return (
    <div className="finding-block">
      <p className="field-label">
        Suggested change{finding.editedReplacement === null ? "" : ", with your wording"}
      </p>
      {editing ? (
        <WordingEditor
          finding={finding}
          busy={busy}
          initial={replacement}
          onSave={onSaveEdit}
          onClose={onClose}
        />
      ) : (
        <DiffView
          paragraphText={edit.paragraphText}
          start={edit.start}
          end={edit.end}
          original={edit.original}
          replacement={replacement}
        />
      )}
    </div>
  );
}

function WordingEditor(props: {
  finding: Finding;
  busy: boolean;
  initial: string;
  onSave: FindingCardProps["onSaveEdit"];
  onClose: () => void;
}) {
  const { finding, busy, initial, onSave, onClose } = props;
  const { edit } = finding;
  const fieldId = useId();
  const hintId = useId();
  const [draft, setDraft] = useState(initial);

  if (edit.kind !== "applied") return null;

  const save = (accept: boolean): void => {
    void onSave(draft, accept).then((saved) => {
      if (saved) onClose();
    });
  };
  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    save(false);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <form className="wording-editor" onSubmit={onSubmit} onKeyDown={onKeyDown}>
      <label htmlFor={fieldId} className="field-label">
        Your wording
      </label>
      <textarea
        id={fieldId}
        className="input textarea"
        rows={4}
        value={draft}
        maxLength={LIMITS.maxReplacementChars}
        aria-describedby={hintId}
        onChange={(event) => setDraft(event.target.value)}
        // The box opens ready to type, because the only reason to open it is to type.
        autoFocus
      />
      <p id={hintId} className="hint">
        This replaces the words shown struck through below. Leave the box empty to remove them
        without a replacement.
      </p>
      <p className="field-label">How it will read</p>
      <DiffView
        paragraphText={edit.paragraphText}
        start={edit.start}
        end={edit.end}
        original={edit.original}
        replacement={draft}
      />
      <div className="finding-actions">
        <button type="submit" className="button button-primary" disabled={busy}>
          Save wording
        </button>
        <button type="button" className="button" disabled={busy} onClick={() => save(true)}>
          Save and accept
        </button>
        <button type="button" className="button button-quiet" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
