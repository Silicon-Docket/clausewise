import type { PilotSeverity } from "../../services/views.js";
import { plural } from "./format.js";

/**
 * The fixed words of the timer and of the reference list on the matter page (package W2.6b). The
 * panels (`pages/timer.tsx`, `pages/reference.tsx`) lay these out and write no sentence of their own,
 * so a test can pin every word in one place and a change of wording is a change of this file. The
 * refusal fragment (`routes/refusals-pilot.ts`) names the buttons by these words in the sentences
 * that tell a person what to press, and a test holds the two together.
 *
 * What the words promise, and what they do not. They describe stored rows: a timer is the seconds
 * between pressing Start and pressing Stop, and a reference list is the issues a reviewing attorney
 * wrote down by hand before Parol read the matter. Neither is described as time saved, accuracy or
 * adoption, and no sentence here states a figure of its own: the only numbers the panels show are
 * the person's own closed sessions and the count of rules marked, each with what it is out of.
 */

// ---------------------------------------------------------------------------------------------
// The timer
// ---------------------------------------------------------------------------------------------

export const TIMER_HEADING = "Time on this matter";
export const TIMER_NOTE =
  "The pilot measures page uses these times. A timer runs from Start to Stop, so press Stop when you pause.";

/** The two buttons. The refusal sentences tell a person to press them by these words. */
export const TIMER_START_LABEL = "Start timer";
export const TIMER_STOP_LABEL = "Stop timer";

export const TIMER_NOT_RUNNING = "No timer is running on this matter.";
/** A timer of this person is running on another matter: no button, and no matter is named. */
export const TIMER_ELSEWHERE =
  "You have a timer running on another matter. Stop it there first, then start one here.";

/** Says what a running timer counts, and when it is added to the total. */
export const TIMER_RUNNING_HINT =
  "It counts every second from Start to Stop, including time away from the screen, and is added to your total when you stop it.";

export const TIMER_OWN_ONLY =
  "These are your own sessions on this matter. The pilot measures page shows medians over NDAs, never a figure for one person.";

/** Before the first stop: nothing to add up. */
export const TIMER_NONE_YET = "You have not stopped a timer on this matter yet.";

/** The sentence that names when the running timer began. The page puts the time after it. */
export const TIMER_RUNNING_SINCE = "A timer is running since";

/**
 * A length of time in words, from whole seconds: seconds under a minute, minutes and seconds under
 * an hour, hours and minutes from an hour. A negative or fractional input reads as the nearest
 * whole number of seconds that is not below zero, so the sentence never shows a sign or a decimal.
 */
export function formatDuration(totalSeconds: number): string {
  const seconds = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  if (seconds < 60) return plural(seconds, "second");
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest === 0
      ? plural(minutes, "minute")
      : `${plural(minutes, "minute")} ${plural(rest, "second")}`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return minutes === 0
    ? plural(hours, "hour")
    : `${plural(hours, "hour")} ${plural(minutes, "minute")}`;
}

/** The closed sessions of the person on this matter, with the number of sessions they add up. */
export function timedSentence(sessions: number, closedSeconds: number): string {
  if (sessions <= 0) return TIMER_NONE_YET;
  return `You have ${plural(sessions, "stopped session")} on this matter, ${formatDuration(closedSeconds)} in all.`;
}

// ---------------------------------------------------------------------------------------------
// The reference list
// ---------------------------------------------------------------------------------------------

export const REFERENCE_HEADING = "Reference list for shadow mode";
export const REFERENCE_NOTE =
  "Record the issues found in the manual review before Parol reads this matter. The list closes when the first review starts, so it cannot be changed after Parol has seen the documents.";

export const REFERENCE_TABLE_CAPTION = "Issues found by hand, rule by rule";
export const REFERENCE_RULE_COLUMN = "Rule";
export const REFERENCE_SEVERITY_COLUMN = "Severity of the issue";

/** The choice that leaves a rule out of the list, and the three severities. */
export const REFERENCE_NOT_AN_ISSUE = "Not an issue";
export const SEVERITY_LABEL: Record<PilotSeverity, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};
/** In the order of the form. The test holds this list equal to the one the store accepts. */
export const SEVERITY_ORDER = ["high", "medium", "low"] as const satisfies readonly PilotSeverity[];

/** The label of the select of one rule. It is read aloud with the choice; the table shows the rule once. */
export const severitySelectLabel = (ruleTitle: string): string =>
  `Severity of the issue for ${ruleTitle}`;

export const REFERENCE_OUTSIDE_LEGEND = "Issues that no rule of the playbook covers";
export const REFERENCE_OUTSIDE_HINT =
  "How many issues the manual review found that none of the rules above covers, by severity. Whole numbers from 0 to 9. Leave a count empty for none.";
export const OUTSIDE_LABEL: Record<PilotSeverity, string> = {
  high: "High-severity issues no rule covers",
  medium: "Medium-severity issues no rule covers",
  low: "Low-severity issues no rule covers",
};

export const REFERENCE_SAVE_LABEL = "Save the reference list";

/** What the saved list holds, each number with what it is out of. */
export function referenceSummary(markedRules: number, rules: number, outside: number): string {
  return `Saved: ${markedRules} of ${plural(rules, "rule")} marked as an issue, and ${plural(outside, "issue")} no rule covers.`;
}

/** No playbook version is chosen: there are no rules to list issues by. */
export const REFERENCE_NO_PLAYBOOK =
  "No playbook version is chosen for this matter yet, so there are no rules to list issues by. An associate of this matter chooses one under Client and playbook. You can still record issues no rule covers.";
export const REFERENCE_NO_PLAYBOOK_LINK = "Go to Client and playbook";

/** A review has started: the list is read only, as it was left. */
export const REFERENCE_LOCKED = "This list is closed because a review has started.";
export const REFERENCE_LOCKED_EMPTY =
  "No reference list was recorded before the review started, so there is nothing to compare the review with.";
export const REFERENCE_LOCKED_CAPTION = "Reference list as it was closed";
export const REFERENCE_LOCKED_SEVERITY = "Severity";
export const REFERENCE_LOCKED_COUNT = "Issues";
/** The row header of the issues that no rule covers, in the closed list. */
export const REFERENCE_LOCKED_OUTSIDE = "No rule covers it";
