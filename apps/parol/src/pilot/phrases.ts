/**
 * The fixed sentences of the pilot measures page: measure titles, the definitions of
 * docs/parol/08 and what each denominator counts, the three reasons a row has no data, the sentence
 * under each line of the population table, the method lines and the two scope notes.
 *
 * The page cannot import this file (pages may import only what `test/pages/static.test.ts`
 * allows), so the service passes these words to it inside the view (`views.ts`). The CSV never uses
 * them: it carries codes and numbers only.
 *
 * Every sentence that states a number states its denominator beside it. Nothing here describes a
 * figure as adoption, accuracy or time saved, except to say that it is none of them.
 */
import {
  MEASURE_IDS,
  NO_DATA_REASONS,
  PHASES,
  PILOT_SEVERITIES,
  PILOT_WEEKS,
  POPULATION_CODES,
  TIME_SERIES,
  type MeasureId,
  type MeasureRow,
  type NoDataReason,
  type Phase,
  type PilotScope,
  type PilotSeverity,
  type PopulationCode,
  type TimeSeries,
} from "./types.js";

export interface MeasureWords {
  /** The name of the measure. */
  title: string;
  /** The definition of docs/parol/08. */
  definition: string;
  /** A sentence saying what the denominator counts. */
  denominator: string;
}

export interface PilotPhrases {
  measures: Record<MeasureId, MeasureWords>;
  noData: Record<NoDataReason, string>;
  population: Record<PopulationCode, string>;
  phases: Record<Phase, string>;
  series: Record<TimeSeries, string>;
  severities: Record<PilotSeverity, string>;
  /** The link text of each scope, and the name of the scope as a table caption ends with it. */
  scopeLinks: Record<PilotScope, string>;
  scopeNames: Record<PilotScope, string>;
  /** The banner that heads the synthetic scope. */
  syntheticBanner: string;
  /** The fixed method lines, in the order the page lists them. */
  method: readonly string[];
}

const WEEKS = `weeks 1 to ${PILOT_WEEKS}`;

const MEASURES: Record<MeasureId, MeasureWords> = {
  completion: {
    title: "Completion",
    definition: "Matters exported",
    denominator:
      "Matters with a run started: matters on which a review was started, whatever became of it, with the first review inside the pilot weeks.",
  },
  repeat_usage: {
    title: "Repeat usage",
    definition: "Participants who started matters in at least two different pilot weeks",
    denominator: "Participants trained: the people the trainer recorded as trained.",
  },
  correction_rate: {
    title: "Correction rate",
    definition: "Decisions that are edit or reject, overall and by reason code",
    denominator: "Decided findings: findings of finished reviews that have a current decision.",
  },
  accepted_or_minor: {
    title: "Accepted or minor edit",
    definition: "Decisions that are accept, or an edit marked as a minor edit",
    denominator: "Decided findings, as for the correction rate.",
  },
  missed_issue_rate: {
    title: "Missed-issue rate",
    definition: "Missed-issue reports, overall and per rule",
    denominator:
      "Exported matters: matters on which a memo was ever exported. This is a count of reports per matter, not a share.",
  },
  escalation_system: {
    title: "Escalation by the system",
    definition: "Findings escalated by the system",
    denominator: "Findings of reviews that finished.",
  },
  escalation_reviewer: {
    title: "Escalation by reviewers",
    definition: "Findings escalated by reviewers",
    denominator: "Findings of reviews that finished (a second row counts decided findings only).",
  },
  satisfaction_rating: {
    title: "Satisfaction",
    definition: "Median and distribution of the post-matter rating",
    denominator:
      "Ratings given: the latest rating of each associate or reviewer on an exported matter.",
  },
  satisfaction_response: {
    title: "Response to the rating question",
    definition: "People who gave a post-matter rating",
    denominator: "People who could rate: the associates and reviewers of exported matters.",
  },
  active_time: {
    title: "Active time",
    definition: "Median active minutes per NDA, associate and attorney separately and combined",
    denominator:
      "Timed NDAs, per phase: matters with a closed timer in the phase (for the combined figure, matters timed by both an associate and a reviewing attorney).",
  },
  shadow_agreement: {
    title: "Shadow-mode agreement",
    definition: "Reference-list issues that Parol flagged or escalated, by severity",
    denominator:
      "Reference-list issues on matters that have a finished review. An issue no rule covers counts as not flagged.",
  },
};

const NO_DATA: Record<NoDataReason, string> = {
  no_calendar:
    "No pilot calendar is set, so no record can be placed in a pilot week. An administrator sets the start date on this page.",
  all_excluded:
    "Every matter in this database belongs to the other scope, so there is nothing to count in this one.",
  no_denominator:
    "Nothing to count yet: no record meets the definition, so there is no denominator.",
};

const POPULATION: Record<PopulationCode, string> = {
  matters_total: "Matters in the database, of every kind, before any scope is applied.",
  matters_training: "Training matters, made by the training exercise. They are in neither scope.",
  matters_synthetic: "Matters marked synthetic, training matters not counted.",
  matters_by_demo_identity:
    "Matters not marked synthetic whose creator is a demonstration identity.",
  matters_real: "Matters not marked synthetic whose creator is not a demonstration identity.",
  matters_in_scope:
    "Matters in this scope. A matter is in the pilot scope when it is real and, if a review was started on it, the person who started the first one is not a demonstration identity.",
  matters_run_in_window: `Matters in this scope whose first review started inside the pilot weeks (${WEEKS}). Every ratio on this page that counts matters starts from these.`,
  matters_run_before_window:
    "Matters in this scope whose first review started before the pilot start date. In no measure.",
  matters_run_after_window: `Matters in this scope whose first review started after the end of week ${PILOT_WEEKS}. In no measure.`,
  matters_no_run: "Matters in this scope on which no review was started. In no measure.",
  matters_exported:
    "Matters in the measures on which a memo was ever exported. The denominator of the missed-issue rate and of the rating questions.",
  findings:
    "Findings of finished reviews of the matters in the measures. The denominator of the escalation rate.",
  findings_decided: "Findings with a current decision. The denominator of the correction rate.",
  decisions_no_longer_current:
    "Decisions that a change to the documents made out of date. They are not counted.",
  missed_reports_counted: "Missed-issue reports counted in the missed-issue rate.",
  missed_reports_outside:
    "Missed-issue reports in this scope on matters that are not in the rate (no memo exported, or the first review outside the pilot weeks). Not counted.",
  ratings_counted:
    "Ratings counted in the satisfaction figures: the latest rating of each associate or reviewer on an exported matter.",
  ratings_by_viewers:
    "Ratings given on an exported matter by a viewer, or by a person who is no longer a member. Not counted.",
  raters_eligible:
    "People who could rate: the associates and reviewers of exported matters. The denominator of the response.",
  time_entries_counted:
    "Closed timers that started inside the pilot weeks, counted in the active time medians.",
  time_entries_open: "Timers still running. A timer left running is not counted.",
  time_entries_outside_window: `Closed timers that started outside the pilot weeks (${WEEKS}), or at any time while no calendar is set. Not counted.`,
  reference_issues_compared:
    "Reference-list issues on matters with a finished review. The denominator of shadow-mode agreement.",
  reference_issues_not_compared:
    "Reference-list issues in this scope on matters that cannot be compared (no finished review, or the first review outside the pilot weeks). Never counted as a miss.",
  participants_trained:
    "People the trainer recorded as trained, of the same kind as this scope. The denominator of repeat usage.",
  starters_not_on_roster:
    "People who started the first review of a matter in the measures and are not on the trained list. Not counted in repeat usage.",
  matters_expiring_before_pilot_end: `Matters in this scope that reach their retention date before the end of week ${PILOT_WEEKS}. They will then disappear from these figures.`,
  audit_matters_created:
    "Matters made in this scope according to the audit log, deleted ones included.",
  audit_matters_deleted:
    "Of those, the matters since deleted. They have no rows and are in no denominator.",
};

const PHASE_WORDS: Record<Phase, string> = {
  baseline: "Baseline (week 1)",
  shadow: "Shadow mode (week 2)",
  assisted: `Assisted use (weeks 3 to ${PILOT_WEEKS})`,
};

const SERIES_WORDS: Record<TimeSeries, string> = {
  associate: "Associate",
  reviewer: "Reviewing attorney",
  combined: "Associate and attorney combined",
};

const SEVERITY_WORDS: Record<PilotSeverity, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const SYNTHETIC_BANNER =
  "SYNTHETIC SCOPE: these figures count what demonstration identities did to synthetic matters. They are not pilot data, not adoption, not accuracy and not time saved.";

/** Fixed, pinned by `test/pilot/phrases.test.ts`. The page lists them under 'How to read this page'. */
export const METHOD_LINES: readonly string[] = [
  "These figures count rows the application stored: reviews started, findings, decisions, exports, reports, ratings, timers and reference lists. Nothing is estimated.",
  "Pilot scope: matters not marked synthetic whose creator is not a demonstration identity, and people who are not demonstration identities. Synthetic scope: everything else. This build has demonstration identities only, so the pilot scope is empty here.",
  "Weeks are counted in UTC from the start date. A matter's week is the week its first review started; a timer's week is the week it started. Week 1 is the baseline, week 2 training and shadow mode, weeks 3 to 5 assisted use (document 8).",
  "A matter counts as started when a review was started on it, whatever became of the review, and as exported when a memo was ever exported for it. Repeat usage reads 'started a matter' as 'started a review on it'.",
  "A decision counts while it counts for the memo. A decision that a change to the documents made out of date is not counted, and the population table says how many there are.",
  "Matters deleted by their creator, an administrator or retention have no rows and are in no denominator. The population table counts them from the audit log.",
  "A time is the seconds between pressing Start and pressing Stop. It is not measured attention. A timer left running is not counted. A stopped timer cannot be edited.",
  "Times are medians with the number of NDAs behind them. This page computes no mean, no difference between phases and no saving: documents differ between phases and the group is small.",
  "No figure is given for a person. With a few participants a total can still be recognised: share the file only with the sponsor and the legal engineer.",
  "This page does not judge the acceptance criteria A1 to A7 or recommend go or no-go. The sponsor does, from the numbers and their denominators.",
];

export const PILOT_PHRASES: PilotPhrases = {
  measures: MEASURES,
  noData: NO_DATA,
  population: POPULATION,
  phases: PHASE_WORDS,
  series: SERIES_WORDS,
  severities: SEVERITY_WORDS,
  scopeLinks: {
    pilot: "Pilot scope",
    synthetic: "Synthetic scope, a demonstration",
  },
  scopeNames: { pilot: "pilot scope", synthetic: "synthetic scope" },
  syntheticBanner: SYNTHETIC_BANNER,
  method: METHOD_LINES,
};

// ---------------------------------------------------------------------------------------------
// Sentences built from numbers. Each states the denominator beside the number.
// ---------------------------------------------------------------------------------------------

const plural = (count: number, one: string, many: string = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/** `numerator / denominator` as a percentage with one decimal, rounded half up, in whole numbers. */
export function percentText(numerator: number, denominator: number): string {
  return (Math.floor((2 * numerator * 1000 + denominator) / (2 * denominator)) / 10).toFixed(1);
}

/** What a row says in its Result cell: the number with its denominator, or "No data". */
export function resultText(row: MeasureRow): string {
  if (row.status === "no_data" || row.value === null) return "No data";
  switch (row.unit) {
    case "ratio":
      return `${row.numerator ?? 0} of ${row.denominator} (${percentText(row.numerator ?? 0, row.denominator)}%)`;
    case "reports_per_matter":
      return `${plural(row.numerator ?? 0, "report")} for ${plural(row.denominator, "exported matter")}`;
    case "rating":
      return `${row.value.toFixed(1)} (n = ${row.denominator}, minimum ${row.min ?? 0}, maximum ${row.max ?? 0})`;
    case "minutes":
      return `${row.value.toFixed(1)} minutes (n = ${row.denominator}, minimum ${(row.min ?? 0).toFixed(1)}, maximum ${(row.max ?? 0).toFixed(1)})`;
  }
}

/** The sentence under a row that has no data. */
export function noDataText(reason: NoDataReason | null): string {
  return NO_DATA[reason ?? "no_denominator"];
}

/** The first thing a reader of the pilot scope sees when the scope holds no matter. */
export function pilotEmptyNote(mattersTotal: number): string {
  if (mattersTotal === 0) {
    return "No pilot data. This database holds no matters, so the pilot scope is empty and every measure below reads no data.";
  }
  const holds =
    mattersTotal === 1
      ? "This database holds 1 matter and it is synthetic or was made by a demonstration identity"
      : `This database holds ${mattersTotal} matters and every one is synthetic or was made by a demonstration identity`;
  return `No pilot data. ${holds}, so the pilot scope is empty and every measure below reads no data.`;
}

export function calendarSentence(calendar: { startDate: string; endDate: string } | null): string {
  return calendar === null
    ? "No pilot calendar is set. Every measure that depends on a pilot week reads no data until one is. An administrator sets the start date on this page."
    : `The pilot starts on ${calendar.startDate} and week ${PILOT_WEEKS} ends on ${calendar.endDate}, counted in UTC.`;
}

export function expiringNote(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "1 matter will reach its retention date before the end of the pilot and then disappear from these measures. Download the CSV before then."
    : `${count} matters will reach their retention date before the end of the pilot and then disappear from these measures. Download the CSV before then.`;
}

/** The ids the words cover, so a test can prove that no measure, reason or code was left without one. */
export const PHRASE_KEYS = {
  measures: MEASURE_IDS,
  noData: NO_DATA_REASONS,
  population: POPULATION_CODES,
  phases: PHASES,
  series: TIME_SERIES,
  severities: PILOT_SEVERITIES,
} as const;
