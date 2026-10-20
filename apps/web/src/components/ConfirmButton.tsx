import { useEffect, useRef, useState } from "react";
import { Button } from "./Button.js";

/**
 * A button that asks once before it does something that cannot be undone. The question appears in
 * its place, with the safe answer focused first; no browser dialog, which cannot be styled,
 * labelled or tested the same way.
 */
export function ConfirmButton(props: {
  label: string;
  question: string;
  confirmLabel: string;
  keepLabel: string;
  onConfirm: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  const {
    label,
    question,
    confirmLabel,
    keepLabel,
    onConfirm,
    busy = false,
    disabled = false,
  } = props;
  const [asking, setAsking] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);

  useEffect(() => {
    if (asking) keep.current?.focus();
    else if (wasAsking.current) opener.current?.focus();
    wasAsking.current = asking;
  }, [asking]);

  if (!asking) {
    // Busy is "unavailable", not disabled: the focus returns to this button after the answer, and
    // a disabled button would not take it.
    return (
      <Button
        ref={opener}
        className="button button-danger"
        disabled={disabled}
        unavailable={busy}
        aria-busy={busy}
        onClick={() => setAsking(true)}
      >
        {label}
      </Button>
    );
  }
  return (
    <div className="confirm" role="group" aria-label={question}>
      <p className="confirm-question">{question}</p>
      <button ref={keep} type="button" className="button" onClick={() => setAsking(false)}>
        {keepLabel}
      </button>
      <button
        type="button"
        className="button button-danger"
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </button>
    </div>
  );
}
