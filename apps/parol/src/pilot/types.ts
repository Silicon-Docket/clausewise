/**
 * The vocabulary of the pilot measures: constants, the records the store hands to the computation,
 * and the results the computation hands back. Types and constants only; nothing here reads a clock,
 * a file or a database.
 *
 * Why the records are a plain interface. The computation (`compute.ts`) is a pure function from
 * `PilotRecords` to `PilotMeasures`, so that it can be tested with fixtures whose expected values
 * are written by hand, including fixtures that no database of this build can hold (a person who is
 * not a demonstration identity). The store fills `PilotRecords` in (`PilotRecordSource`); this
 * module never imports the store.
 *
 * What a record may hold. Ids, flags, codes, counts and timestamps. No field is free text: no name,
 * title, note, reason, quote or location. `test/pilot/no-text.test.ts` lists the string fields of
 * this file and fails for one that is not on its list, so a text field cannot be added by accident.
 */
import type { ReviewDecision, RunStatus, Status } from "../contracts.js";

// ---------------------------------------------------------------------------------------------
// The calendar and its phases
// ---------------------------------------------------------------------------------------------

/** The pilot lasts five weeks (docs/parol/08, 'Pilot design'). */
export const PILOT_WEEKS = 5;

export const PHASES = ["baseline", "shadow", "assisted"] as const;
export type Phase = (typeof PHASES)[number];

/** Week 1 is the manual baseline, week 2 training and shadow mode, weeks 3 to 5 assisted use. */
export const PHASE_OF_WEEK: readonly Phase[] = [
  "baseline",
  "shadow",
  "assisted",
  "assisted",
  "assisted",
];

// ---------------------------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------------------------

/**
 * `pilot`: records of a matter that is not synthetic and was not made by a demonstration identity,
 * by people who are not demonstration identities. `synthetic`: everything else except training
 * matters. A training matter is in neither scope (it is counted in the population table only).
 */
export const SCOPES = ["pilot", "synthetic"] as const;
export type PilotScope = (typeof SCOPES)[number];

// ---------------------------------------------------------------------------------------------
// The measures
// ---------------------------------------------------------------------------------------------

/**
 * The set of measures is closed. Every id is one of the rows of the table in docs/parol/08
 * ('Measures'), apart from `accepted_or_minor`, which is the number acceptance criterion A3 reads.
 * No id is a difference, a mean, a ratio of phases or a saving, and `test/pilot/compute.test.ts`
 * fails when a row carries any other id.
 *
 * CUT LINE. `accepted_or_minor` is the first row to cut if time runs short: remove its id here, its
 * block in `compute.ts` (`acceptedOrMinorRows`), its words in `phrases.ts` and its rows in the
 * fixture tests. Nothing else reads it.
 */
export const MEASURE_IDS = [
  "completion",
  "repeat_usage",
  "correction_rate",
  "accepted_or_minor",
  "missed_issue_rate",
  "escalation_system",
  "escalation_reviewer",
  "satisfaction_rating",
  "satisfaction_response",
  "active_time",
  "shadow_agreement",
] as const;
export type MeasureId = (typeof MEASURE_IDS)[number];

export type BreakdownId =
  | "overall"
  | "phase"
  | "reason_code"
  | "rule"
  | "of_decided"
  | "distribution"
  | "severity"
  | "series";

/**
 * Why a row has no value. In order of precedence: no calendar is set; the database holds matters and
 * none of them is in this scope; otherwise there is simply nothing to count.
 */
export const NO_DATA_REASONS = ["no_calendar", "all_excluded", "no_denominator"] as const;
export type NoDataReason = (typeof NO_DATA_REASONS)[number];

/** How a row's `value` is to be read. */
export type Unit = "ratio" | "reports_per_matter" | "rating" | "minutes";

export const TIME_SERIES = ["associate", "reviewer", "combined"] as const;
export type TimeSeries = (typeof TIME_SERIES)[number];

export const PILOT_SEVERITIES = ["high", "medium", "low"] as const;
export type PilotSeverity = (typeof PILOT_SEVERITIES)[number];

/** The key of a missed-issue report that names no rule of the playbook. */
export const NOT_COVERED_KEY = "not_covered";
/** The key of a correction whose decision carries no reason code (made before reason codes existed). */
export const NOT_RECORDED_KEY = "not_recorded";

export interface MeasureRow {
  measure: MeasureId;
  breakdown: BreakdownId;
  /**
   * '' for overall; a phase; a reason code or `not_recorded`; a rule key or `not_covered`;
   * `decided`; '1' to '5'; a severity; `<phase>:<series>`.
   */
  key: string;
  unit: Unit;
  /** Null for a median. */
  numerator: number | null;
  /** The denominator; for a median, the number of values it is the median of (its n). */
  denominator: number;
  /** Null when `status` is `no_data`. Never NaN or Infinity. */
  value: number | null;
  /** The smallest and the largest value behind a median; null for every other row. */
  min: number | null;
  max: number | null;
  status: "value" | "no_data";
  reason: NoDataReason | null;
}

/**
 * The denominators and the exclusions, so that no number is without its context. The order is the
 * order the page and the CSV list them in.
 */
export const POPULATION_CODES = [
  "matters_total",
  "matters_training",
  "matters_synthetic",
  "matters_by_demo_identity",
  "matters_real",
  "matters_in_scope",
  "matters_run_in_window",
  "matters_run_before_window",
  "matters_run_after_window",
  "matters_no_run",
  "matters_exported",
  "findings",
  "findings_decided",
  "decisions_no_longer_current",
  "missed_reports_counted",
  "missed_reports_outside",
  "ratings_counted",
  "ratings_by_viewers",
  "raters_eligible",
  "time_entries_counted",
  "time_entries_open",
  "time_entries_outside_window",
  "reference_issues_compared",
  "reference_issues_not_compared",
  "participants_trained",
  "starters_not_on_roster",
  "matters_expiring_before_pilot_end",
  "audit_matters_created",
  "audit_matters_deleted",
] as const;
export type PopulationCode = (typeof POPULATION_CODES)[number];

export interface PopulationRow {
  code: PopulationCode;
  count: number;
}

export interface PilotMeasures {
  scope: PilotScope;
  /** The injected clock the figures were computed at; it moves no row. */
  asOf: string;
  /** The start date in force and the last day (inclusive) of week 5, both YYYY-MM-DD; null with no calendar. */
  calendar: { startDate: string; endDate: string } | null;
  population: PopulationRow[];
  rows: MeasureRow[];
}

// ---------------------------------------------------------------------------------------------
// The records the store hands over
// ---------------------------------------------------------------------------------------------

export interface MatterRecord {
  matterId: string;
  synthetic: boolean;
  /** True when the matter's creator is a demonstration identity. */
  creatorDemo: boolean;
  /**
   * True for a training matter (`matters.training_key` is set). A training matter is in neither
   * scope, whatever its other flags say; it is counted in `matters_training` only.
   */
  training: boolean;
  playbookVersionId: string | null;
  /** ISO timestamp. */
  retainUntil: string;
}

export interface MemberRecord {
  matterId: string;
  userId: string;
  userDemo: boolean;
  role: "associate" | "reviewer" | "viewer";
}

export interface PlaybookRecord {
  versionId: string;
  /** The rule keys of the version, in playbook order. */
  ruleKeys: string[];
}

/** A run with purpose 'matter'. Any status counts as "a run started". */
export interface RunRecord {
  runId: string;
  matterId: string;
  startedBy: string;
  startedByDemo: boolean;
  /** ISO timestamp. */
  startedAt: string;
  status: RunStatus;
}

export interface FindingRecord {
  findingId: string;
  runId: string;
  matterId: string;
  ruleKey: string;
  severity: PilotSeverity;
  status: Status;
  escalatedBySystem: boolean;
}

/** A decision whose validity is 'current' (one per finding). */
export interface DecisionRecord {
  findingId: string;
  matterId: string;
  reviewerDemo: boolean;
  decision: ReviewDecision;
  /** Null for an accept or an escalate, and for a decision made before reason codes existed. */
  reasonCode: string | null;
  /** Null unless the decision is an edit. */
  minorEdit: boolean | null;
}

/** A decision whose validity is 'stale': counted for the population table, never listed further. */
export interface StaleDecisionRecord {
  matterId: string;
  reviewerDemo: boolean;
}

export interface MemoRecord {
  matterId: string;
  exportedByDemo: boolean;
}

export interface MissedIssueRecord {
  matterId: string;
  userDemo: boolean;
  /** Null: the report says no rule of the playbook covers the issue. */
  ruleKey: string | null;
}

export interface RatingRecord {
  matterId: string;
  userId: string;
  userDemo: boolean;
  /** 1 to 5. */
  rating: number;
}

export interface TimeEntryRecord {
  matterId: string;
  userId: string;
  userDemo: boolean;
  role: "associate" | "reviewer";
  /** ISO timestamps. A null `stoppedAt` is a timer that is still running. */
  startedAt: string;
  stoppedAt: string | null;
}

export interface ReferenceIssueRecord {
  matterId: string;
  /** Null: an issue that no rule of the playbook covers. */
  ruleKey: string | null;
  severity: PilotSeverity;
  recordedByDemo: boolean;
}

export interface ParticipantRecord {
  userId: string;
  demo: boolean;
}

/** A `matter.create` event of the audit log, joined to the `matter.delete` event of the same matter. */
export interface AuditMatterRecord {
  matterId: string;
  synthetic: boolean;
  creatorDemo: boolean;
  training: boolean;
  deleted: boolean;
}

export interface PilotRecords {
  /** The latest pilot calendar row; null when none was ever set. */
  calendar: { startDate: string } | null;
  /** Existing matters, deleted ones excluded. Training matters may be listed; they are set aside. */
  matters: MatterRecord[];
  /** Every member row of those matters. */
  members: MemberRecord[];
  playbooks: PlaybookRecord[];
  /** Runs with purpose 'matter' only. */
  runs: RunRecord[];
  /** Findings of those runs. */
  findings: FindingRecord[];
  decisions: DecisionRecord[];
  staleDecisions: StaleDecisionRecord[];
  /** Every memo row, any status. */
  memos: MemoRecord[];
  missedIssues: MissedIssueRecord[];
  /** Oldest first, so that when one person rated twice the later one is the one in force. */
  ratings: RatingRecord[];
  timeEntries: TimeEntryRecord[];
  referenceIssues: ReferenceIssueRecord[];
  participants: ParticipantRecord[];
  auditMatters: AuditMatterRecord[];
}

/**
 * What the store implements (slice B). `loadPilotRecords` reads every row once, selects ids, flags,
 * codes and timestamps and never a text column, and writes nothing.
 */
export interface PilotRecordSource {
  loadPilotRecords(): PilotRecords;
}
