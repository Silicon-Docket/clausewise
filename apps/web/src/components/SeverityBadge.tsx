import type { Severity } from "@clausewise/api";
import { SEVERITY_LABEL } from "../lib/format.js";

/** The shape alone, for a place where the word is already written next to it. */
export function SeverityIcon(props: { severity: Severity }) {
  const { severity } = props;
  return (
    <svg
      className="severity-icon"
      viewBox="0 0 12 12"
      width="12"
      height="12"
      aria-hidden="true"
      focusable="false"
    >
      {severity === "high" ? <path d="M6 1 11 11H1Z" /> : null}
      {severity === "medium" ? <path d="M6 1 11 6 6 11 1 6Z" /> : null}
      {severity === "low" ? <circle cx="6" cy="6" r="4.5" /> : null}
    </svg>
  );
}

/**
 * Severity is told three ways: the word, a shape, and a colour. The shapes differ in outline
 * (triangle, diamond, circle), so the badge reads the same in greyscale or with colour blindness.
 */
export function SeverityBadge(props: { severity: Severity }) {
  const { severity } = props;
  return (
    <span className={`severity severity-${severity}`}>
      <SeverityIcon severity={severity} />
      <span>{SEVERITY_LABEL[severity]}</span>
      <span className="visually-hidden"> severity</span>
    </span>
  );
}
