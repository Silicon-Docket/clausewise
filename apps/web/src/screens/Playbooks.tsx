import {
  LIMITS,
  type PlaybookDetail,
  type PlaybookSummary,
  type PlaybookValidateResponse,
} from "@clausewise/api";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { errorMessage, isAbortError } from "../api/client.js";
import { Button } from "../components/Button.js";
import { ConfirmButton } from "../components/ConfirmButton.js";
import { Notice } from "../components/Notice.js";
import { useAnnounce } from "../hooks/useAnnounce.js";
import { useDocumentTitle } from "../hooks/useDocumentTitle.js";
import { useLoad } from "../hooks/useLoad.js";
import { plural } from "../lib/format.js";
import { useServices } from "../services.js";

/** How long typing must pause before the playbook is checked again. */
export const VALIDATE_DEBOUNCE_MS = 400;

type Selection = { kind: "saved"; id: string } | { kind: "draft"; yaml: string; from: string };

export function PlaybooksScreen() {
  useDocumentTitle("Playbooks");
  const { api } = useServices();
  const announce = useAnnounce();
  const list = useLoad((signal) => api.listPlaybooks(signal), [api]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [switchTo, setSwitchTo] = useState<Selection | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Set when the editor on screen is about to be replaced by another that the person asked for,
  // so that the new one takes the focus: the control they used is gone with the old editor.
  const [focusEditor, setFocusEditor] = useState(false);
  const unsaved = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);

  const open = (next: Selection, takeFocus = false): void => {
    if (unsaved.current) {
      setSwitchTo(next);
      return;
    }
    setSwitchTo(null);
    setMessage(null);
    setFocusEditor(takeFocus);
    setSelection(next);
  };

  // The question about unsaved changes appears next to the list the person clicked in. It gets the
  // focus on its safe answer, as a confirmation does, and is told to a screen reader.
  useEffect(() => {
    if (switchTo === null) return;
    keepEditing.current?.focus();
    announce("You have changes that are not saved. Opening another playbook throws them away.");
  }, [switchTo, announce]);
  const setUnsaved = useCallback((value: boolean) => {
    unsaved.current = value;
  }, []);

  const playbooks = list.state.status === "ready" ? list.state.data : [];
  const selectedId = selection?.kind === "saved" ? selection.id : null;

  return (
    <div>
      <h1 ref={heading} tabIndex={-1}>
        Playbooks
      </h1>
      <p className="lead">
        A playbook is the list of positions a contract is checked against. The built-in ones are
        read-only: open one and choose Copy to edit to make your own.
      </p>
      <div className="playbooks-layout">
        <nav className="playbook-list" aria-label="Playbooks">
          {list.state.status === "loading" ? <p className="muted">Loading...</p> : null}
          {list.state.status === "error" ? (
            <Notice kind="error">
              <p>The playbooks could not be loaded. {list.state.message}</p>
              <button type="button" className="button" onClick={list.reload}>
                Try again
              </button>
            </Notice>
          ) : null}
          <ul>
            {playbooks.map((playbook) => (
              <li key={playbook.id}>
                <PlaybookItem
                  playbook={playbook}
                  selected={playbook.id === selectedId}
                  onOpen={() => open({ kind: "saved", id: playbook.id })}
                />
              </li>
            ))}
          </ul>
          {list.state.status === "ready" && playbooks.length === 0 ? (
            <p className="empty">There are no playbooks yet.</p>
          ) : null}
        </nav>

        <div className="playbook-pane" ref={pane}>
          {switchTo === null ? null : (
            <Notice kind="warning" title="You have changes that are not saved">
              <p>Opening another playbook throws them away.</p>
              <div className="row">
                <button
                  type="button"
                  className="button button-danger"
                  onClick={() => {
                    unsaved.current = false;
                    setMessage(null);
                    setFocusEditor(true);
                    setSelection(switchTo);
                    setSwitchTo(null);
                  }}
                >
                  Discard and open
                </button>
                <button
                  ref={keepEditing}
                  type="button"
                  className="button"
                  onClick={() => {
                    setSwitchTo(null);
                    // The question goes away; the person goes back to what they were typing.
                    pane.current?.querySelector("textarea")?.focus();
                  }}
                >
                  Keep editing
                </button>
              </div>
            </Notice>
          )}
          {/* Said once through the announcer; this is the visible copy. */}
          {message === null ? null : <p className="saved-note">{message}</p>}
          {selection === null ? (
            <p className="empty">Choose a playbook to read it.</p>
          ) : selection.kind === "draft" ? (
            <PlaybookEditor
              key={`draft:${selection.from}`}
              mode={selection}
              takeFocus={focusEditor}
              onUnsavedChange={setUnsaved}
              onCopy={(yaml, from) => open({ kind: "draft", yaml, from }, true)}
              onSaved={(detail, created) => {
                list.reload();
                setMessage(`Saved "${detail.name}".`);
                announce(`Saved ${detail.name}.`);
                if (created) {
                  unsaved.current = false;
                  // The draft's Save button goes with the draft; the saved playbook takes over.
                  setFocusEditor(true);
                  setSelection({ kind: "saved", id: detail.id });
                }
              }}
              onDeleted={() => undefined}
            />
          ) : (
            <SavedPlaybook
              key={selection.id}
              id={selection.id}
              takeFocus={focusEditor}
              onUnsavedChange={setUnsaved}
              onCopy={(yaml, from) => open({ kind: "draft", yaml, from }, true)}
              onSaved={(detail) => {
                list.reload();
                setMessage(`Saved "${detail.name}".`);
                announce(`Saved ${detail.name}.`);
              }}
              onDeleted={(name) => {
                unsaved.current = false;
                list.reload();
                setSelection(null);
                setMessage(`Deleted "${name}".`);
                announce(`Deleted ${name}.`);
                // The editor, with the button that was just pressed, is gone: back to the top.
                heading.current?.focus();
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function PlaybookItem(props: { playbook: PlaybookSummary; selected: boolean; onOpen: () => void }) {
  const { playbook, selected, onOpen } = props;
  return (
    <button
      type="button"
      className={`playbook-item${selected ? " playbook-item-selected" : ""}`}
      aria-current={selected ? "true" : undefined}
      onClick={onOpen}
    >
      <span className="playbook-name">{playbook.name}</span>
      <span className="playbook-meta">
        {playbook.source === "builtin" ? "Built in, read-only" : "Yours"}.{" "}
        {plural(playbook.ruleCount, "rule")}
        {playbook.contractTypes.length === 0 ? "" : `. For ${playbook.contractTypes.join(", ")}`}
      </span>
    </button>
  );
}

type EditorProps = {
  /** Take the focus when the editor opens, for an editor that replaces the one that had it. */
  takeFocus: boolean;
  onUnsavedChange: (unsaved: boolean) => void;
  onCopy: (yaml: string, from: string) => void;
  onSaved: (detail: PlaybookDetail, created: boolean) => void;
  onDeleted: (name: string) => void;
};

function SavedPlaybook(props: EditorProps & { id: string }) {
  const { id, ...rest } = props;
  const { api } = useServices();
  const detail = useLoad((signal) => api.getPlaybook(id, signal), [api, id]);

  if (detail.state.status === "loading") return <p className="muted">Opening the playbook...</p>;
  if (detail.state.status === "error") {
    return (
      <Notice kind="error">
        <p>This playbook could not be opened. {detail.state.message}</p>
        <button type="button" className="button" onClick={detail.reload}>
          Try again
        </button>
      </Notice>
    );
  }
  return <PlaybookEditor mode={{ kind: "saved", detail: detail.state.data }} {...rest} />;
}

type Validation =
  | { status: "checking" }
  | { status: "done"; text: string; result: PlaybookValidateResponse }
  | { status: "failed"; text: string; message: string };

const encoder = new TextEncoder();

function PlaybookEditor(
  props: EditorProps & {
    mode: { kind: "saved"; detail: PlaybookDetail } | { kind: "draft"; yaml: string; from: string };
  },
) {
  const { mode, takeFocus, onUnsavedChange, onCopy, onSaved, onDeleted } = props;
  const { api } = useServices();
  const fieldId = useId();
  const validationId = useId();
  const saveHintId = useId();
  const heading = useRef<HTMLHeadingElement>(null);

  const initial = mode.kind === "saved" ? mode.detail.yaml : mode.yaml;
  const editable = mode.kind === "draft" || mode.detail.editable;
  const [title, setTitle] = useState(mode.kind === "saved" ? mode.detail.name : "New playbook");
  const name = title;

  const [baseline, setBaseline] = useState(initial);
  const [text, setText] = useState(initial);
  const [validation, setValidation] = useState<Validation>({ status: "checking" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const first = useRef(true);

  const changed = text !== baseline;
  useEffect(() => {
    onUnsavedChange(editable && changed);
    return () => onUnsavedChange(false);
  }, [editable, changed, onUnsavedChange]);

  // An editor that was opened by a press on a control in the editor it replaced, such as Copy to
  // edit, starts with its heading focused: a screen reader says which playbook this is, and the
  // next press of Tab is the text.
  useEffect(() => {
    if (takeFocus) heading.current?.focus();
    // Once, when the editor opens: later changes of the flag are for editors yet to open.
  }, []);

  // Checks the text a short while after typing stops. An answer for text that has since changed is
  // dropped, so a slow answer can not overwrite a newer one.
  useEffect(() => {
    if (!editable) return undefined;
    const controller = new AbortController();
    setValidation({ status: "checking" });
    const delay = first.current ? 0 : VALIDATE_DEBOUNCE_MS;
    first.current = false;
    const timer = setTimeout(() => {
      if (text.trim() === "") {
        setValidation({
          status: "done",
          text,
          result: { ok: false, problems: ["The playbook is empty. Type or paste its YAML."] },
        });
        return;
      }
      if (encoder.encode(text).length > LIMITS.maxPlaybookBytes) {
        setValidation({
          status: "done",
          text,
          result: {
            ok: false,
            problems: [
              `The playbook is larger than ${Math.round(LIMITS.maxPlaybookBytes / 1024)} KB, which is the most the server accepts.`,
            ],
          },
        });
        return;
      }
      api
        .validatePlaybook(text, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) setValidation({ status: "done", text, result });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || isAbortError(error)) return;
          setValidation({ status: "failed", text, message: errorMessage(error) });
        });
    }, delay);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, editable, text]);

  // The newest answer, if it is for the text that is in the box now.
  const settled = validation.status !== "checking" && validation.text === text ? validation : null;
  const valid = settled !== null && settled.status === "done" && settled.result.ok;
  const canSave = editable && valid && (mode.kind === "draft" || changed) && !saving;

  // What is read out about the check, once the person has typed: a short sentence, and only when
  // it changes, not the list of problems and not on every pause. The first check, when the editor
  // opens, is on the screen already.
  const spoken = !changed || settled === null ? "" : spokenCheck(settled);

  const saveHint = !editable
    ? null
    : settled === null
      ? "Checking the playbook..."
      : settled.status === "failed"
        ? "The playbook could not be checked, so it can not be saved yet."
        : !settled.result.ok
          ? "Fix the problems above to save."
          : mode.kind === "saved" && !changed
            ? "There are no changes to save."
            : null;

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaveError(null);
    try {
      const detail =
        mode.kind === "draft"
          ? await api.createPlaybook(text)
          : await api.updatePlaybook(mode.detail.id, text);
      setBaseline(text);
      setTitle(detail.name);
      onSaved(detail, mode.kind === "draft");
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (mode.kind !== "saved") return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deletePlaybook(mode.detail.id);
      onDeleted(mode.detail.name);
    } catch (error) {
      setDeleteError(errorMessage(error));
      setDeleting(false);
    }
  };

  return (
    <section className="editor" aria-label={name}>
      <h2 ref={heading} tabIndex={-1}>
        {name}
      </h2>
      {mode.kind === "draft" ? (
        <p className="hint">
          This is a copy of &quot;{mode.from}&quot;. Change the name in it so that you can tell your
          copy from the original. Nothing is saved until you press Save.
        </p>
      ) : mode.detail.editable ? (
        <p className="hint">Your playbook. Changes are saved when you press Save.</p>
      ) : (
        <p className="hint">Built in and read-only. To change it, make a copy and edit that.</p>
      )}

      <label className="field-label" htmlFor={fieldId}>
        Playbook (YAML)
      </label>
      <textarea
        id={fieldId}
        className="input textarea code"
        rows={24}
        spellCheck={false}
        value={text}
        readOnly={!editable}
        aria-describedby={editable ? validationId : undefined}
        aria-invalid={settled?.status === "done" && !settled.result.ok ? true : undefined}
        onChange={(event) => setText(event.target.value)}
      />

      {editable ? (
        <>
          <div id={validationId} className="validation">
            <ValidationView validation={validation} text={text} />
          </div>
          <p className="visually-hidden" aria-live="polite">
            {spoken}
          </p>
        </>
      ) : null}

      {saveError === null ? null : (
        <Notice kind="error" title="The playbook was not saved">
          <p className="message-text">{saveError}</p>
        </Notice>
      )}
      {deleteError === null ? null : (
        <Notice kind="error" title="The playbook was not deleted">
          <p className="message-text">{deleteError}</p>
        </Notice>
      )}

      <div className="row">
        {editable ? (
          // Unavailable, not disabled: after a save the button has nothing left to do and is
          // still where the focus is.
          <Button
            className="button button-primary"
            unavailable={!canSave}
            aria-busy={saving}
            aria-describedby={saveHint === null ? undefined : saveHintId}
            onClick={() => void save()}
          >
            {saving
              ? "Saving..."
              : mode.kind === "draft"
                ? "Save as a new playbook"
                : "Save changes"}
          </Button>
        ) : (
          <button
            type="button"
            className="button button-primary"
            onClick={() => onCopy(mode.kind === "saved" ? mode.detail.yaml : "", name)}
          >
            Copy to edit
          </button>
        )}
        {mode.kind === "saved" && mode.detail.editable ? (
          <ConfirmButton
            label="Delete playbook"
            question={`Delete "${mode.detail.name}"? Reviews that already used it keep their own copy.`}
            confirmLabel="Delete it"
            keepLabel="Keep it"
            busy={deleting}
            onConfirm={() => void remove()}
          />
        ) : null}
      </div>
      {saveHint === null ? null : (
        <p id={saveHintId} className="hint">
          {saveHint}
        </p>
      )}
    </section>
  );
}

function spokenCheck(settled: Exclude<Validation, { status: "checking" }>): string {
  if (settled.status === "failed") return "Playbook check: it could not be done.";
  if (settled.result.ok) return "Playbook check: no problems.";
  return `Playbook check: ${plural(settled.result.problems.length, "problem")}.`;
}

function ValidationView(props: { validation: Validation; text: string }) {
  const { validation, text } = props;
  if (validation.status === "checking" || validation.text !== text) {
    return <p className="muted">Checking the playbook...</p>;
  }
  if (validation.status === "failed") {
    return (
      <Notice kind="warning">
        <p className="message-text">The playbook could not be checked. {validation.message}</p>
      </Notice>
    );
  }
  const { result } = validation;
  if (result.ok) {
    return (
      <p className="validation-ok">
        <span className="validation-mark" aria-hidden="true" />
        The playbook is valid: {result.name}, {plural(result.ruleCount, "rule")}
        {result.contractTypes.length === 0 ? "" : `, for ${result.contractTypes.join(", ")}`}.
      </p>
    );
  }
  return (
    <div className="validation-problems">
      <p>
        <span className="validation-mark validation-mark-bad" aria-hidden="true" />
        <strong>{plural(result.problems.length, "problem")} to fix</strong>
      </p>
      <ul>
        {result.problems.map((problem, index) => (
          <li key={index} className="message-text">
            {problem}
          </li>
        ))}
      </ul>
    </div>
  );
}
