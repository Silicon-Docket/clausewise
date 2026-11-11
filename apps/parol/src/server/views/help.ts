import type { FindingView, IssueRow } from "../../services/views.js";
import type { EvidenceRole, ReviewDecision } from "../../contracts.js";
import {
  DECISION_HINT,
  DECISION_LABEL,
  ESCALATION_LABEL,
  ESCALATION_MEANING,
  MATTER_STATUS_LABEL,
  MATTER_STATUS_MEANING,
  QUOTE_CHECK_LABEL,
  QUOTE_CHECK_MEANING,
  ROLE_LABEL,
  ROLE_MEANING,
  ROLE_ORDER,
  RUN_STATUS_LABEL,
  RUN_STATUS_MEANING,
  SEVERITY_LABEL,
  SEVERITY_MEANING,
  SEVERITY_ORDER,
  STATUS_LABEL,
  STATUS_MEANING,
  STATUS_ORDER,
  SUPPORT_CHECK_LABEL,
  SUPPORT_CHECK_MEANING,
  WARNING_LABEL,
  WARNING_MEANING,
} from "./labels.js";

/**
 * The words of the help page and of the help inside the review page (package W2.8). Every meaning
 * here is a sentence the application already shows somewhere (the tables of `labels.ts`, a chip's
 * title, the keyboard list) or a sentence that rests on a named source, and the help page is the
 * one place a person who cannot hover a chip can read them. A table is typed as a complete record
 * of its vocabulary, so a new member of a vocabulary does not compile until it has its words, and
 * the help page lists it from the table with no edit here.
 *
 * Nothing here comes from a document, a model or a person: the words are fixed, and a code that is
 * not in a table is left out and never repeated.
 */

export interface HelpTerm {
  /** The anchor of the term on the help page: lower case letters, digits and hyphens. */
  id: string;
  term: string;
  meaning: string;
}

export interface HelpGroup {
  /** The anchor of the group on the help page. */
  id: string;
  title: string;
  intro?: string | undefined;
  terms: HelpTerm[];
}

/** The id of a term: its group and its code, with hyphens for underscores. Codes are fixed words. */
const termId = (group: string, code: string): string => `${group}-${code.replaceAll("_", "-")}`;

/** Whether `code` is a member of the vocabulary the table is a complete record of. */
function has<T extends string>(table: Readonly<Record<T, string>>, code: unknown): code is T {
  return typeof code === "string" && Object.hasOwn(table, code);
}

/** The terms of one vocabulary, from its table of labels and its table of meanings, in key order. */
function termsOf<T extends string>(
  group: string,
  labels: Readonly<Record<T, string>>,
  meanings: Readonly<Record<T, string>>,
): HelpTerm[] {
  return (Object.keys(labels) as T[]).map((code) => ({
    id: termId(group, code),
    term: labels[code],
    meaning: meanings[code],
  }));
}

// ---------------------------------------------------------------------------------------------
// The sentences this file adds to the tables
// ---------------------------------------------------------------------------------------------

/**
 * Severity belongs to the rule. A finding always has its rule's severity (the `findings_same_matter`
 * trigger of migration 002 refuses any other), and a reviewer's edit has no severity field
 * (`EditsInput`). The playbook gives no wider definition, so none is made up here.
 */
const SEVERITY_INTRO =
  "Severity belongs to the rule. The playbook sets it, and neither the reader nor a reviewer's edit changes it. The playbook gives no wider definition.";

/** What a status is and who decides it: document 8, "What Parol will not do". */
const STATUS_INTRO =
  "A status is a draft answer to one playbook rule. An attorney decides every finding.";

/** The role of a passage is what it does for the finding, shown on the passage in the inspector. */
const SUPERSEDED_LEAD =
  "A passage marked superseded is struck through. A quote that is found in it is still a correct quote; what it says no longer governs.";

/**
 * The first look and the second look. `QUOTE_CHECK_MEANING` and `SUPPORT_CHECK_MEANING` say what
 * each check found; this says how they relate. The support check is off in the two workflow
 * versions the application registers (known gap 3 of document 7), so every passage says "Support
 * not checked".
 */
const CHECKS_INTRO =
  "Quote found means the words are in the paragraph. It does not mean the paragraph supports the finding. The support check is the second look at that; the two workflow versions this application registers leave it off, and then each passage says Support not checked.";

const FLAGS_INTRO =
  "A flag says what the review could not confirm. It is shown as a chip on the row and explained in the inspector.";

const DECISIONS_INTRO =
  "Parol drafts findings and an attorney decides every one. A decision stops counting when the documents or the playbook change.";

/** The form's hint without its pointer to the fields below it, which a page of help does not have. */
const withoutFieldsPointer = (hint: string): string => hint.replace(" Use the fields below.", "");

/**
 * What each decision does: the hint the decision form shows, so that what a decision needs (a
 * reason, and for an edit and a reject a reason code) is said once and the form and the help
 * cannot differ. The form's hint for an edit points at the fields below it, which a page of help
 * does not have, so that pointer is left out. A complete record, so a new decision needs words.
 */
const DECISION_HELP: Record<ReviewDecision, string> = {
  accept: DECISION_HINT.accept,
  edit: withoutFieldsPointer(DECISION_HINT.edit),
  reject: DECISION_HINT.reject,
  escalate: DECISION_HINT.escalate,
};

/** The two states a finding can be in before or after a decision, as the chips on the row say them. */
const NOT_DECIDED = "No decision has been made on this finding yet.";
const OUT_OF_DATE = "The documents or playbook changed after this was decided.";

const WARNINGS_INTRO =
  "A warning is raised when a file is uploaded. It does not stop the review; it says what to read yourself.";

// ---------------------------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------------------------

const statusTerm = (code: unknown): HelpTerm | null =>
  has(STATUS_LABEL, code)
    ? { id: termId("status", code), term: STATUS_LABEL[code], meaning: STATUS_MEANING[code] }
    : null;

const severityTerm = (code: unknown): HelpTerm | null =>
  has(SEVERITY_LABEL, code)
    ? {
        id: termId("severity", code),
        term: SEVERITY_LABEL[code],
        meaning: SEVERITY_MEANING[code],
      }
    : null;

const flagTerm = (code: unknown): HelpTerm | null =>
  has(ESCALATION_LABEL, code)
    ? {
        id: termId("flag", code),
        term: ESCALATION_LABEL[code],
        meaning: ESCALATION_MEANING[code],
      }
    : null;

const roleTerm = (code: unknown): HelpTerm | null => {
  if (!has(ROLE_LABEL, code)) return null;
  const meaning =
    code === "superseded" ? `${SUPERSEDED_LEAD} ${ROLE_MEANING[code]}` : ROLE_MEANING[code];
  return { id: termId("role", code), term: ROLE_LABEL[code], meaning };
};

const quoteTerm = (code: unknown): HelpTerm | null =>
  has(QUOTE_CHECK_LABEL, code)
    ? {
        id: termId("quote", code),
        term: QUOTE_CHECK_LABEL[code],
        meaning: QUOTE_CHECK_MEANING[code],
      }
    : null;

const supportTerm = (code: unknown): HelpTerm | null =>
  has(SUPPORT_CHECK_LABEL, code)
    ? {
        id: termId("support", code),
        term: SUPPORT_CHECK_LABEL[code],
        meaning: SUPPORT_CHECK_MEANING[code],
      }
    : null;

const decisionTerm = (code: ReviewDecision): HelpTerm => ({
  id: termId("decision", code),
  term: DECISION_LABEL[code],
  meaning: DECISION_HELP[code],
});

const present = (terms: readonly (HelpTerm | null)[]): HelpTerm[] =>
  terms.filter((term): term is HelpTerm => term !== null);

/** The members of a table, in the order of a list, then any the list lacks, each once. */
const inOrder = <T extends string>(
  table: Readonly<Record<T, string>>,
  order: readonly T[],
): T[] => [...order, ...(Object.keys(table) as T[]).filter((code) => !order.includes(code))];

// ---------------------------------------------------------------------------------------------
// The keyboard
// ---------------------------------------------------------------------------------------------

/**
 * The keys of the review page. They are the same as the list on the review page (`KeysHelp` in
 * pages/run.tsx) and as the script handles (`setupKeys` in public/parol.js): a test compares all
 * three. They work while focus is in the issue table.
 */
export const KEYBOARD_SHORTCUTS: readonly { keys: readonly string[]; does: string }[] = [
  { keys: ["j"], does: "Next row" },
  { keys: ["k"], does: "Previous row" },
  { keys: ["Enter"], does: "Open the row you are on" },
  { keys: ["?"], does: "Show this list. Escape hides it." },
];

const KEYBOARD_INTRO =
  "These keys work on the review page while focus is in the issue table. Every other control is a link or a button that Tab reaches and Enter or Space presses.";

// ---------------------------------------------------------------------------------------------
// The help page
// ---------------------------------------------------------------------------------------------

/**
 * Every group of the help page, in order: statuses, severity, flags, passages, checks, decisions,
 * upload warnings, the states of a matter and a review, and the keyboard.
 */
export function helpGroups(): HelpGroup[] {
  const decided = (Object.keys(DECISION_LABEL) as ReviewDecision[]).map(decisionTerm);
  return [
    {
      id: "statuses",
      title: "Statuses",
      intro: STATUS_INTRO,
      terms: present(inOrder(STATUS_LABEL, STATUS_ORDER).map(statusTerm)),
    },
    {
      id: "severity",
      title: "Severity",
      intro: SEVERITY_INTRO,
      terms: present(inOrder(SEVERITY_LABEL, SEVERITY_ORDER).map(severityTerm)),
    },
    {
      id: "flags",
      title: "Flags",
      intro: FLAGS_INTRO,
      terms: present(Object.keys(ESCALATION_LABEL).map(flagTerm)),
    },
    {
      id: "passages",
      title: "Passages and their roles",
      terms: present(inOrder(ROLE_LABEL, ROLE_ORDER).map(roleTerm)),
    },
    {
      id: "checks",
      title: "Quote and support checks",
      intro: CHECKS_INTRO,
      terms: present([
        ...Object.keys(QUOTE_CHECK_LABEL).map(quoteTerm),
        ...Object.keys(SUPPORT_CHECK_LABEL).map(supportTerm),
      ]),
    },
    {
      id: "decisions",
      title: "Decisions",
      intro: DECISIONS_INTRO,
      terms: [
        ...decided,
        { id: "decision-not-decided", term: "Not decided", meaning: NOT_DECIDED },
        { id: "decision-out-of-date", term: "Out of date", meaning: OUT_OF_DATE },
      ],
    },
    {
      id: "warnings",
      title: "Upload warnings",
      intro: WARNINGS_INTRO,
      terms: termsOf("warning", WARNING_LABEL, WARNING_MEANING),
    },
    {
      id: "states",
      title: "States of a matter and of a review",
      terms: [
        ...termsOf("matter-status", MATTER_STATUS_LABEL, MATTER_STATUS_MEANING),
        ...termsOf("run-status", RUN_STATUS_LABEL, RUN_STATUS_MEANING),
      ],
    },
    {
      id: "keyboard",
      title: "Keyboard",
      intro: KEYBOARD_INTRO,
      terms: KEYBOARD_SHORTCUTS.map((shortcut) => ({
        id: termId("key", shortcut.keys.join("-").replace("?", "help").toLowerCase()),
        term: shortcut.keys.join(" "),
        meaning: shortcut.does,
      })),
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// The help inside the review page
// ---------------------------------------------------------------------------------------------

/** The distinct values of a list, in the order they first appear. */
const distinct = <T>(values: readonly T[]): T[] => [...new Set(values)];

/**
 * The words a finding shows, and only those: its status and severity, each flag it carries, each
 * role a passage has (superseded first, because it is the one that changes how a passage reads),
 * and the quote check and support check of its passages. A group with nothing to say is left out,
 * so a compliant finding with a verified quote has no flag entry. Every term has the id it has on
 * the help page, which the pane links to.
 */
export function contextHelp(finding: FindingView): HelpGroup[] {
  const { issue } = finding;
  const roles = distinct(finding.evidence.map((e) => e.role));
  const roleOrder: EvidenceRole[] = [
    "superseded",
    ...ROLE_ORDER.filter((role) => role !== "superseded"),
  ];
  const groups: HelpGroup[] = [
    {
      id: "statuses",
      title: "Status and severity",
      terms: present([statusTerm(issue.status), severityTerm(issue.severity)]),
    },
    {
      id: "flags",
      title: "Flags",
      terms: present(distinct(issue.escalations.map((e) => e.code)).map(flagTerm)),
    },
    {
      id: "passages",
      title: "What each passage is for",
      terms: present(roleOrder.filter((role) => roles.includes(role)).map(roleTerm)),
    },
    {
      id: "checks",
      title: "Quote and support checks",
      terms: present([
        ...distinct(finding.evidence.map((e) => e.quoteCheck)).map(quoteTerm),
        ...distinct(finding.evidence.map((e) => e.supportCheck)).map(supportTerm),
      ]),
    },
  ];
  return groups.filter((group) => group.terms.length > 0);
}

/**
 * The flags a run carries, as help terms, in the order of the vocabulary. The run page lists these
 * and no others, so the help there stays short.
 */
export function flagsInRun(rows: readonly Pick<IssueRow, "escalations">[]): HelpTerm[] {
  const seen = new Set<string>(rows.flatMap((row) => row.escalations.map((e) => e.code)));
  return present(
    Object.keys(ESCALATION_LABEL)
      .filter((code) => seen.has(code))
      .map(flagTerm),
  );
}

/**
 * What the run page's help holds: the statuses, severities and roles, and the flags this run has.
 * Compact: one list per group, no introductions.
 */
export function wordsInRun(rows: readonly Pick<IssueRow, "escalations">[]): HelpGroup[] {
  const groups: HelpGroup[] = [
    {
      id: "statuses",
      title: "Statuses",
      terms: present(inOrder(STATUS_LABEL, STATUS_ORDER).map(statusTerm)),
    },
    {
      id: "severity",
      title: "Severity",
      terms: present(inOrder(SEVERITY_LABEL, SEVERITY_ORDER).map(severityTerm)),
    },
    { id: "flags", title: "Flags in this review", terms: flagsInRun(rows) },
    {
      id: "passages",
      title: "What a passage is for",
      terms: present(inOrder(ROLE_LABEL, ROLE_ORDER).map(roleTerm)),
    },
  ];
  return groups.filter((group) => group.terms.length > 0);
}
