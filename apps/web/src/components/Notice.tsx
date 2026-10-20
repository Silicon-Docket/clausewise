import type { ReactNode } from "react";

/**
 * A boxed message. An error is announced at once (`role="alert"`) and says what happened and what
 * to do next. Other kinds are plain content, so that a page of notes does not shout.
 */
export function Notice(props: {
  kind: "error" | "warning" | "info";
  title?: string;
  children: ReactNode;
  /** Extra class for placement, such as a margin. */
  className?: string;
}) {
  const { kind, title, children, className } = props;
  return (
    <div
      className={`notice notice-${kind}${className === undefined ? "" : ` ${className}`}`}
      {...(kind === "error" ? { role: "alert" } : {})}
    >
      <span className={`notice-icon notice-icon-${kind}`} aria-hidden="true" />
      <div className="notice-body">
        {title === undefined ? null : <p className="notice-title">{title}</p>}
        {children}
      </div>
    </div>
  );
}
