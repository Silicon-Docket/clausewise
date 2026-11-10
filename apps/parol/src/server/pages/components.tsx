import type { Child } from "hono/jsx";
import type { Severity } from "@clausewise/playbook";
import type {
  EvidenceRole,
  QuoteCheck,
  ReviewDecision,
  RunStatus,
  Status,
  SupportCheck,
} from "../../contracts.js";
import type { IssueRow } from "../../services/views.js";
import { UNKNOWN_DATE, formatDateTime } from "../views/format.js";
import { splitByOffsets, type Offsets } from "../views/highlight.js";
import {
  DECISION_LABEL,
  ESCALATION_MEANING,
  QUOTE_CHECK_MEANING,
  ROLE_MEANING,
  RUN_STATUS_MEANING,
  STATUS_MEANING,
  SUPPORT_CHECK_MEANING,
  decisionLabel,
  escalationLabel,
  isActiveRun,
  matterStatusLabel,
  matterStatusMeaning,
  quoteCheckLabel,
  roleLabel,
  runStatusLabel,
  severityLabel,
  statusLabel,
  supportCheckLabel,
} from "../views/labels.js";
import { revealInvisible } from "../views/reveal.js";

/**
 * Small pieces the pages share. Everything that shows a code shows its words next to a shape, so
 * no meaning rests on colour alone, and everything that shows text from a document, a model or a
 * person goes through JSX, which escapes it. Classes are chosen from fixed lists and never built
 * from data.
 */

export type ShapeName = "circle" | "ring" | "triangle" | "square" | "diamond" | "bar" | "flag";
export type Tone = "ok" | "bad" | "warn" | "info" | "neutral";

/** Every shape the stylesheet draws. A test checks that parol.css has a rule for each. */
export const SHAPES: readonly ShapeName[] = [
  "circle",
  "ring",
  "triangle",
  "square",
  "diamond",
  "bar",
  "flag",
];

/** What an id is written as when it is not already plain: this prefix and the code points in hex. */
const ESCAPED_ID = "u-";

/**
 * The id of an element, made safe to use as an attribute value and as a fragment. An id made of
 * letters, digits, underscores and hyphens is used as it is. Any other is written as `u-` and its
 * code points in hex, joined by hyphens, so two different ids never share one DOM id (`a.b` and
 * `a_b` must not label each other's controls). An id that already starts with `u-` is written
 * that way too, so a plain id can never equal an escaped one.
 */
export const idPart = (value: string): string =>
  /^[A-Za-z0-9_-]*$/.test(value) && !value.startsWith(ESCAPED_ID)
    ? value
    : ESCAPED_ID + [...value].map((char) => (char.codePointAt(0) ?? 0).toString(16)).join("-");

/** The member of a fixed list that `value` equals, or `fallback`. Used before data becomes a class. */
function oneOf<T extends string>(list: readonly T[], value: unknown, fallback: T): T {
  return list.find((item) => item === value) ?? fallback;
}

// ---------------------------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------------------------

export function ShapeMark({ shape }: { shape: ShapeName }) {
  return <span class={`shape shape-${shape}`} aria-hidden="true"></span>;
}

export function Chip(props: {
  tone: Tone;
  shape: ShapeName;
  children?: Child;
  title?: string | undefined;
}) {
  return (
    <span class={`chip tone-${props.tone}`} title={props.title}>
      <ShapeMark shape={props.shape} />
      <span class="chip-text">{props.children}</span>
    </span>
  );
}

const STATUS_LOOK: Record<Status, { tone: Tone; shape: ShapeName }> = {
  compliant: { tone: "ok", shape: "circle" },
  deviation: { tone: "bad", shape: "triangle" },
  missing: { tone: "bad", shape: "square" },
  not_applicable: { tone: "neutral", shape: "bar" },
  undetermined: { tone: "warn", shape: "diamond" },
};
const STATUS_KEYS = Object.keys(STATUS_LOOK) as Status[];

export function StatusChip({ status }: { status: Status }) {
  const known = oneOf(STATUS_KEYS, status, "undetermined");
  const look = STATUS_LOOK[known];
  const isKnown = known === status;
  return (
    <Chip
      tone={isKnown ? look.tone : "neutral"}
      shape={isKnown ? look.shape : "ring"}
      title={isKnown ? STATUS_MEANING[known] : undefined}
    >
      {statusLabel(status)}
    </Chip>
  );
}

const SEVERITY_LEVEL: Record<Severity, number> = { high: 3, medium: 2, low: 1 };
const SEVERITY_KEYS = Object.keys(SEVERITY_LEVEL) as Severity[];

export function SeverityChip({ severity }: { severity: Severity }) {
  const known = oneOf(SEVERITY_KEYS, severity, "low");
  const level = known === severity ? SEVERITY_LEVEL[known] : 0;
  return (
    <span class={`chip chip-severity severity-${known === severity ? known : "unknown"}`}>
      <span class="level" aria-hidden="true">
        <i class={level >= 1 ? "on" : "off"}></i>
        <i class={level >= 2 ? "on" : "off"}></i>
        <i class={level >= 3 ? "on" : "off"}></i>
      </span>
      <span class="chip-text">{severityLabel(severity)}</span>
    </span>
  );
}

const ROLE_LOOK: Record<EvidenceRole, { tone: Tone; shape: ShapeName }> = {
  governing: { tone: "info", shape: "square" },
  supporting: { tone: "neutral", shape: "ring" },
  superseded: { tone: "neutral", shape: "bar" },
  conflicting: { tone: "bad", shape: "triangle" },
  definition: { tone: "neutral", shape: "diamond" },
};
const ROLE_KEYS = Object.keys(ROLE_LOOK) as EvidenceRole[];

export function RoleChip({ role }: { role: EvidenceRole }) {
  const known = oneOf(ROLE_KEYS, role, "supporting");
  const isKnown = known === role;
  return (
    <Chip
      tone={isKnown ? ROLE_LOOK[known].tone : "neutral"}
      shape={isKnown ? ROLE_LOOK[known].shape : "ring"}
      title={isKnown ? ROLE_MEANING[known] : undefined}
    >
      {roleLabel(role)}
    </Chip>
  );
}

const QUOTE_LOOK: Record<QuoteCheck, { tone: Tone; shape: ShapeName }> = {
  verified: { tone: "ok", shape: "circle" },
  not_found: { tone: "bad", shape: "triangle" },
  ambiguous: { tone: "warn", shape: "diamond" },
};
const QUOTE_KEYS = Object.keys(QUOTE_LOOK) as QuoteCheck[];

export function QuoteCheckChip({ check }: { check: QuoteCheck }) {
  const known = oneOf(QUOTE_KEYS, check, "not_found");
  const isKnown = known === check;
  return (
    <Chip
      tone={isKnown ? QUOTE_LOOK[known].tone : "neutral"}
      shape={isKnown ? QUOTE_LOOK[known].shape : "ring"}
      title={isKnown ? QUOTE_CHECK_MEANING[known] : undefined}
    >
      {quoteCheckLabel(check)}
    </Chip>
  );
}

const SUPPORT_LOOK: Record<SupportCheck, { tone: Tone; shape: ShapeName }> = {
  supported: { tone: "ok", shape: "circle" },
  not_supported: { tone: "bad", shape: "triangle" },
  insufficient: { tone: "warn", shape: "diamond" },
  not_run: { tone: "neutral", shape: "bar" },
};
const SUPPORT_KEYS = Object.keys(SUPPORT_LOOK) as SupportCheck[];

export function SupportCheckChip({ check }: { check: SupportCheck }) {
  const known = oneOf(SUPPORT_KEYS, check, "not_run");
  const isKnown = known === check;
  return (
    <Chip
      tone={isKnown ? SUPPORT_LOOK[known].tone : "neutral"}
      shape={isKnown ? SUPPORT_LOOK[known].shape : "ring"}
      title={isKnown ? SUPPORT_CHECK_MEANING[known] : undefined}
    >
      {supportCheckLabel(check)}
    </Chip>
  );
}

/** An escalation as a chip. The words say what is wrong, so a reader needs no key. */
export function EscalationChip({ code }: { code: string }) {
  const meaning = (ESCALATION_MEANING as Record<string, string>)[code];
  return (
    <Chip
      tone="warn"
      shape="flag"
      title={Object.hasOwn(ESCALATION_MEANING, code) ? meaning : undefined}
    >
      {escalationLabel(code)}
    </Chip>
  );
}

const DECISION_LOOK: Record<ReviewDecision, { tone: Tone; shape: ShapeName }> = {
  accept: { tone: "ok", shape: "circle" },
  edit: { tone: "info", shape: "diamond" },
  reject: { tone: "bad", shape: "square" },
  escalate: { tone: "warn", shape: "triangle" },
};
const DECISION_KEYS = Object.keys(DECISION_LOOK) as ReviewDecision[];

/**
 * "stale" when the finding is out of date or the decision on it is. Either way the decision no
 * longer counts, so the finding is shown as out of date and still needs one.
 */
export const decisionValidity = (
  issue: Pick<IssueRow, "validity"> & { review: { validity: "current" | "stale" } | null },
): "current" | "stale" =>
  issue.validity === "stale" || issue.review?.validity === "stale" ? "stale" : "current";

/** The review state of a finding: the current decision, "Not decided", or out of date. */
export function ReviewChip(props: {
  decision: ReviewDecision | null;
  validity: "current" | "stale";
}) {
  if (props.validity === "stale") {
    return (
      <Chip
        tone="neutral"
        shape="bar"
        title="The documents or playbook changed after this was decided."
      >
        Out of date
      </Chip>
    );
  }
  if (props.decision === null) {
    return (
      <Chip tone="neutral" shape="ring">
        Not decided
      </Chip>
    );
  }
  const known = oneOf(DECISION_KEYS, props.decision, "accept");
  const isKnown = known === props.decision;
  return (
    <Chip
      tone={isKnown ? DECISION_LOOK[known].tone : "neutral"}
      shape={isKnown ? DECISION_LOOK[known].shape : "ring"}
    >
      {decisionLabel(props.decision)}
    </Chip>
  );
}

export function DecisionChip({ decision }: { decision: ReviewDecision }) {
  const known = oneOf(DECISION_KEYS, decision, "accept");
  const isKnown = known === decision;
  return (
    <Chip
      tone={isKnown ? DECISION_LOOK[known].tone : "neutral"}
      shape={isKnown ? DECISION_LOOK[known].shape : "ring"}
    >
      {isKnown ? DECISION_LABEL[known] : decisionLabel(decision)}
    </Chip>
  );
}

export function RunStatusChip({ status }: { status: RunStatus }) {
  const active = isActiveRun(status);
  const look: { tone: Tone; shape: ShapeName } = active
    ? { tone: "info", shape: status === "queued" ? "ring" : "diamond" }
    : status === "succeeded"
      ? { tone: "ok", shape: "circle" }
      : status === "failed"
        ? { tone: "bad", shape: "triangle" }
        : { tone: "neutral", shape: "bar" };
  const meaning = Object.hasOwn(RUN_STATUS_MEANING, status)
    ? RUN_STATUS_MEANING[status]
    : undefined;
  return (
    <Chip tone={look.tone} shape={look.shape} title={meaning}>
      {runStatusLabel(status)}
    </Chip>
  );
}

export function MatterStatusChip({ status }: { status: string }) {
  const look: { tone: Tone; shape: ShapeName } =
    status === "stale"
      ? { tone: "warn", shape: "triangle" }
      : status === "review_complete" || status === "exported"
        ? { tone: "ok", shape: "circle" }
        : status === "running"
          ? { tone: "info", shape: "diamond" }
          : status === "in_review"
            ? { tone: "info", shape: "square" }
            : { tone: "neutral", shape: "ring" };
  const meaning = matterStatusMeaning(status);
  return (
    <Chip tone={look.tone} shape={look.shape} title={meaning}>
      {matterStatusLabel(status)}
    </Chip>
  );
}

// ---------------------------------------------------------------------------------------------
// Text from documents, models and people
// ---------------------------------------------------------------------------------------------

/**
 * Text with its invisible characters printed as visible markers, so a reviewer can see that a
 * zero-width space is splitting a word or that a direction override is reordering what follows.
 */
export function RevealedText({ value }: { value: string }) {
  const pieces = revealInvisible(value);
  return (
    <>
      {pieces.map((piece) =>
        piece.kind === "text" ? (
          piece.text
        ) : (
          <span
            class="invisible"
            title={`${piece.count === undefined ? "Invisible character" : "Invisible characters"}: ${piece.name}${piece.count === undefined ? "" : ` (${piece.count})`}`}
          >
            {piece.marker}
          </span>
        ),
      )}
    </>
  );
}

/** A paragraph with the verified quote wrapped in `<mark>`, from offsets that are never trusted. */
export function HighlightedText(props: { text: string; offsets: Offsets | null }) {
  const segments = splitByOffsets(props.text, props.offsets);
  return (
    <>
      {segments.map((segment) =>
        segment.highlighted ? (
          <mark class="quote" data-quote="">
            <RevealedText value={segment.text} />
          </mark>
        ) : (
          <RevealedText value={segment.text} />
        ),
      )}
    </>
  );
}

/**
 * The content of a `<textarea>`. A browser drops one newline straight after the opening tag, so a
 * value that begins with a newline would lose it; adding one keeps the text exactly as stored.
 */
export const textareaValue = (value: string): string => `\n${value}`;

/**
 * A sentence with the part that says what to do set in bold (`.todo`). `todo` is a sentence that
 * occurs inside `text`, and its first occurrence is wrapped; the visible words are `text` itself.
 * If it does not occur it is added after the text, so that the advice is never lost; the tables
 * that feed this are tested so that no entry relies on that. An empty `todo` marks nothing.
 */
export function TodoText({ text, todo }: { text: string; todo: string }) {
  if (todo === "") return <>{text}</>;
  const at = text.indexOf(todo);
  if (at === -1)
    return (
      <>
        {text} <span class="todo">{todo}</span>
      </>
    );
  return (
    <>
      {text.slice(0, at)}
      <span class="todo">{todo}</span>
      {text.slice(at + todo.length)}
    </>
  );
}

export function Time({ value }: { value: string }) {
  const text = formatDateTime(value);
  return text === UNKNOWN_DATE ? <span>{text}</span> : <time datetime={value}>{text}</time>;
}

// ---------------------------------------------------------------------------------------------
// Page furniture
// ---------------------------------------------------------------------------------------------

export function Crumbs({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" class="crumbs">
      <ol>
        {items.map((item, index) => (
          <li aria-current={index === items.length - 1 ? "page" : undefined}>
            {item.href === undefined ? (
              <RevealedText value={item.label} />
            ) : (
              <a href={item.href}>
                <RevealedText value={item.label} />
              </a>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

type Level = 1 | 2 | 3 | 4 | 5 | 6;

/** A heading whose level a caller chooses, so a pane can be a section of a page or a page. */
export function Heading(props: {
  level: Level;
  id?: string | undefined;
  class?: string | undefined;
  children?: Child;
}) {
  const Tag = `h${props.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
  return (
    <Tag id={props.id} class={props.class}>
      {props.children}
    </Tag>
  );
}

export function Section(props: { id: string; title: string; children?: Child; note?: Child }) {
  const headingId = `${idPart(props.id)}-heading`;
  return (
    <section class="section" id={idPart(props.id)} aria-labelledby={headingId}>
      <h2 id={headingId}>{props.title}</h2>
      {props.note === undefined ? null : <p class="section-note">{props.note}</p>}
      {props.children}
    </section>
  );
}

/**
 * A table that scrolls inside its own box on a narrow screen and can be scrolled by keyboard.
 * `id` lets a link lead to the box. `zone` names the box for the script, which acts on keys only
 * while focus is inside one.
 */
export function ScrollBox(props: {
  label: string;
  id?: string | undefined;
  zone?: string | undefined;
  children?: Child;
}) {
  return (
    <div
      class="table-scroll"
      id={props.id}
      data-zone={props.zone}
      role="region"
      aria-label={props.label}
      tabindex={0}
    >
      {props.children}
    </div>
  );
}

export function Field(props: {
  id: string;
  label: string;
  hint?: string | undefined;
  children?: Child;
}) {
  const hintId = props.hint === undefined ? undefined : `${props.id}-hint`;
  return (
    <div class="field">
      <label for={props.id}>{props.label}</label>
      {props.children}
      {props.hint === undefined ? null : (
        <p class="hint" id={hintId}>
          {props.hint}
        </p>
      )}
    </div>
  );
}
