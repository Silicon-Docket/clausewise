import type { RefusalFragment } from "./notices.js";

/**
 * The refusal phrases, notices and guidance of package W2.6b (pilot measures, the timer and the
 * reference list). `routes/notices.ts` merges it with the core fragment and the other three, and
 * refuses a code that two fragments define.
 *
 * Each code has its phrase, the sentence inside the phrase that says what to do (`todo`) and, where
 * one control of one form is to blame, a `jump` to the id the page gives that control
 * (`PILOT_ANCHORS` in `pages/pilotfields.ts`). The codes are the ones the store raises
 * (`PILOT_REFUSAL_CODES` in `store/repo-pilot.ts`); a test holds that every one of them has a phrase
 * here or in the feedback fragment, which defines `unknown_rule` once for the report of a missed
 * issue and this package's reference list (plan R10), so it is not written again.
 *
 * The calendar form and the roster of trained people are the pilot page's (`/pilot`): a date that is
 * not a real date is mended at the date, and a person who is not a user, listed twice or too many
 * people at the roster. The timer and the reference list are sections of the matter page. A timer
 * that is already running, or that is not running, is not a control to mend (the page shows which
 * it is), so those have no jump, but `no_open_timer` leads to the timer, where the button to start
 * one is. The reference list's codes about a rule or a severity lead to the section, because the
 * form has one select per rule and a refusal does not say which; `bad_count` leads to the counts.
 * `reference_locked`, `timer_role` and `reference_role` are about the matter and the person, not a
 * control.
 */
export const REFUSALS_PILOT = {
  phrases: {
    bad_calendar_date:
      "The start date is not a real date. Enter the first day of the pilot as year-month-day, for example 2026-11-09.",
    unknown_user:
      "The list names a person who is not a user of Parol. Tick only people from the list.",
    duplicate_user: "A person is listed twice. Tick each person once.",
    too_many_participants:
      "The list holds more than 64 people, which is the most it can record. Untick the people who were not trained.",
    timer_open: "You already have a timer running. Stop it before starting another one.",
    no_open_timer: "No timer is running on this matter. Press Start timer to begin one.",
    timer_role:
      "Only an associate or a reviewing attorney of a matter can time it. Ask an associate of this matter about your role.",
    reference_locked:
      "A review has started on this matter, so its reference list is closed. Report anything the review missed on the review page.",
    reference_role:
      "Only a reviewing attorney of this matter can record its reference list. Ask a reviewing attorney of this matter to record it.",
    duplicate_rule:
      "A rule is listed twice in the reference list. Choose one severity for each rule.",
    bad_severity:
      "That severity is not one of the choices. Choose High, Medium or Low, or leave the rule empty.",
    bad_count: "That is not a count the list can hold. Enter a whole number from 0 to 9.",
  },
  todo: {
    bad_calendar_date:
      "Enter the first day of the pilot as year-month-day, for example 2026-11-09.",
    unknown_user: "Tick only people from the list.",
    duplicate_user: "Tick each person once.",
    too_many_participants: "Untick the people who were not trained.",
    timer_open: "Stop it before starting another one.",
    no_open_timer: "Press Start timer to begin one.",
    timer_role: "Ask an associate of this matter about your role.",
    reference_locked: "Report anything the review missed on the review page.",
    reference_role: "Ask a reviewing attorney of this matter to record it.",
    duplicate_rule: "Choose one severity for each rule.",
    bad_severity: "Choose High, Medium or Low, or leave the rule empty.",
    bad_count: "Enter a whole number from 0 to 9.",
  },
  jump: {
    bad_calendar_date: { href: "#start-date", label: "Go to the start date" },
    unknown_user: { href: "#participants", label: "Go to the list of trained people" },
    duplicate_user: { href: "#participants", label: "Go to the list of trained people" },
    too_many_participants: { href: "#participants", label: "Go to the list of trained people" },
    no_open_timer: { href: "#time", label: "Go to the timer" },
    duplicate_rule: { href: "#reference-list", label: "Go to the reference list" },
    bad_severity: { href: "#reference-list", label: "Go to the reference list" },
    bad_count: { href: "#reference-outside", label: "Go to the counts of issues no rule covers" },
  },
  notices: {
    "calendar-saved": "The start date of the pilot was saved.",
    "participants-saved": "The list of trained people was saved.",
    "timer-started": "The timer is running. Press Stop timer when you pause or finish.",
    "timer-stopped": "The timer was stopped.",
    "reference-saved": "The reference list was saved.",
  },
} as const satisfies RefusalFragment;
