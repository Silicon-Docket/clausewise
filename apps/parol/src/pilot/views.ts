/**
 * What the pages are given. A page cannot import this folder (R8 of the part 3 plan: pages and
 * views import only what `test/pages/static.test.ts` allows), so the service builds these values and
 * `services/views.ts` re-exports their types. Everything a page prints that comes from the
 * measures is already a string here: the numbers with their denominators, the sentences, the
 * captions. The page lays them out and adds only its own headings and form labels.
 *
 * `presentMeasures` is pure. It is tested against the hand-computed fixture, so the words a reader
 * sees are pinned in one place and the page tests need to prove only the markup.
 */
import {
  PILOT_PHRASES,
  calendarSentence,
  expiringNote,
  noDataText,
  pilotEmptyNote,
  resultText,
  type PilotPhrases,
} from "./phrases.js";
import {
  MEASURE_IDS,
  NOT_COVERED_KEY,
  NOT_RECORDED_KEY,
  PHASES,
  PILOT_SEVERITIES,
  SCOPES,
  TIME_SERIES,
  type MeasureId,
  type MeasureRow,
  type PilotMeasures,
  type PilotScope,
  type PilotSeverity,
} from "./types.js";

// ---------------------------------------------------------------------------------------------
// The measures page
// ---------------------------------------------------------------------------------------------

export interface PilotCellView {
  text: string;
  /** True for a cell with no value: the page shows a chip with the words and a shape, not colour alone. */
  noData: boolean;
  /** The sentence that says why there is no data; null for a cell that has a value. */
  reason: string | null;
}

export interface PilotTableRowView {
  /** The row header. */
  header: string;
  /** A line under the header (a definition, or a note about the row); null for none. */
  detail: string | null;
  cells: PilotCellView[];
}

export interface PilotTableView {
  /** A stable id, letters and hyphens. */
  id: string;
  /** Names the scope at its end, so a screenshot of one table still says which scope it counts. */
  caption: string;
  /** The column headers; the first is the row header's. */
  columns: string[];
  rows: PilotTableRowView[];
}

export interface PilotPopulationLine {
  code: string;
  count: number;
  sentence: string;
}

export interface PilotMeasuresView {
  scope: PilotScope;
  /** The `<title>` of the page, before ` | Parol`. */
  title: string;
  scopeLinks: { scope: PilotScope; label: string; current: boolean }[];
  /** The banner of the synthetic scope; null in the pilot scope. */
  banner: string | null;
  /** The note that the pilot scope holds no matter; null otherwise. */
  emptyNote: string | null;
  calendar: { startDate: string; endDate: string } | null;
  calendarSentence: string;
  tables: PilotTableView[];
  population: PilotPopulationLine[];
  /** Set when matters will reach their retention date before the pilot ends. */
  expiringNote: string | null;
  method: readonly string[];
  /** The text of the link to the CSV and the scope it carries. */
  download: { label: string; scope: PilotScope };
  /** The numbers as computed, for anything the page needs beyond the strings above. */
  measures: PilotMeasures;
  /** The fixed words, as data, for the same purpose (the page cannot import them). */
  phrases: PilotPhrases;
}

const plainCell = (text: string): PilotCellView => ({ text, noData: false, reason: null });

/** The Result cell of a row: the number with its denominator, or "No data" and why. */
function resultCell(row: MeasureRow | undefined): PilotCellView {
  if (row === undefined) return { text: "No data", noData: true, reason: noDataText(null) };
  if (row.status === "no_data") {
    return { text: "No data", noData: true, reason: noDataText(row.reason) };
  }
  return plainCell(resultText(row));
}

const numberCell = (
  row: MeasureRow | undefined,
  field: "numerator" | "denominator",
): PilotCellView => {
  if (row === undefined) return plainCell("0");
  const value = row[field];
  return plainCell(value === null ? "none (a median)" : String(value));
};

export function presentMeasures(measures: PilotMeasures): PilotMeasuresView {
  const { scope } = measures;
  const words = PILOT_PHRASES;
  const scopeName = words.scopeNames[scope];

  const find = (
    measure: MeasureId,
    breakdown: MeasureRow["breakdown"],
    key: string,
  ): MeasureRow | undefined =>
    measures.rows.find((r) => r.measure === measure && r.breakdown === breakdown && r.key === key);
  const rowsOf = (measure: MeasureId, breakdown: MeasureRow["breakdown"]): MeasureRow[] =>
    measures.rows.filter((r) => r.measure === measure && r.breakdown === breakdown);
  const count = (code: string): number =>
    measures.population.find((p) => p.code === code)?.count ?? 0;

  const table = (
    id: string,
    caption: string,
    columns: string[],
    rows: PilotTableRowView[],
  ): PilotTableView => ({ id, caption: `${caption}, ${scopeName}`, columns, rows });

  // -- the measures, one row each --------------------------------------------------------------
  const measureRows: PilotTableRowView[] = [];
  for (const id of MEASURE_IDS) {
    const w = words.measures[id];
    if (id === "active_time") {
      measureRows.push({
        header: w.title,
        detail: w.definition,
        cells: [
          plainCell("By phase, in the active time table below"),
          plainCell("none (a median)"),
          plainCell("per phase"),
          plainCell(w.denominator),
          plainCell(""),
        ],
      });
      continue;
    }
    const row = find(id, "overall", "");
    measureRows.push({
      header: w.title,
      detail: w.definition,
      cells: [
        resultCell(row),
        numberCell(row, "numerator"),
        numberCell(row, "denominator"),
        plainCell(w.denominator),
        plainCell(row?.status === "no_data" ? noDataText(row.reason) : ""),
      ],
    });
    if (id === "escalation_reviewer") {
      const decided = find(id, "of_decided", "decided");
      measureRows.push({
        header: `${w.title}, decided findings only`,
        detail: "Findings escalated by reviewers over findings with a current decision",
        cells: [
          resultCell(decided),
          numberCell(decided, "numerator"),
          numberCell(decided, "denominator"),
          plainCell(
            "Decided findings: a finding nobody has decided cannot have been escalated by a reviewer.",
          ),
          plainCell(decided?.status === "no_data" ? noDataText(decided.reason) : ""),
        ],
      });
    }
  }
  const measuresTable = table(
    "measures",
    "Pilot measures",
    ["Measure", "Result", "Numerator", "Denominator", "What the denominator counts", "Note"],
    measureRows,
  );

  // -- by pilot phase ---------------------------------------------------------------------------
  const phaseMeasures: MeasureId[] = MEASURE_IDS.filter(
    (id) => id !== "repeat_usage" && id !== "active_time" && id !== "shadow_agreement",
  );
  const phaseTable = table(
    "phases",
    "Run-based measures by pilot phase",
    ["Measure", ...PHASES.map((p) => words.phases[p])],
    phaseMeasures.map((id) => ({
      header: words.measures[id].title,
      detail: null,
      cells: PHASES.map((p) => resultCell(find(id, "phase", p))),
    })),
  );

  // -- correction rate by reason code -----------------------------------------------------------
  const reasonTable = table(
    "reasons",
    "Correction rate by reason code",
    ["Reason code", "Result", "Numerator", "Denominator"],
    rowsOf("correction_rate", "reason_code").map((row) => ({
      header:
        row.key === NOT_RECORDED_KEY
          ? "Not recorded (decided before reason codes were recorded)"
          : row.key,
      detail: null,
      cells: [resultCell(row), numberCell(row, "numerator"), numberCell(row, "denominator")],
    })),
  );

  // -- missed issues by rule --------------------------------------------------------------------
  const ruleTable = table(
    "rules",
    "Missed-issue reports by rule",
    ["Rule", "Result", "Numerator", "Denominator"],
    rowsOf("missed_issue_rate", "rule").map((row) => ({
      header: row.key === NOT_COVERED_KEY ? "No rule covers it" : row.key,
      detail: null,
      cells: [resultCell(row), numberCell(row, "numerator"), numberCell(row, "denominator")],
    })),
  );

  // -- rating distribution ----------------------------------------------------------------------
  const ratingTable = table(
    "ratings",
    "Distribution of the post-matter rating",
    ["Rating", "Result", "Numerator", "Denominator"],
    rowsOf("satisfaction_rating", "distribution").map((row) => ({
      header: `Rating ${row.key}`,
      detail: null,
      cells: [resultCell(row), numberCell(row, "numerator"), numberCell(row, "denominator")],
    })),
  );

  // -- shadow-mode agreement by severity -------------------------------------------------------
  const shadowTable = table(
    "shadow",
    "Shadow-mode agreement by severity of the reference-list issue",
    ["Severity", "Result", "Numerator", "Denominator"],
    PILOT_SEVERITIES.map((severity: PilotSeverity) => {
      const row = find("shadow_agreement", "severity", severity);
      return {
        header: words.severities[severity],
        detail:
          severity === "high"
            ? "This is the row that acceptance criterion A2 of document 8 reads. This page does not judge it."
            : null,
        cells: [resultCell(row), numberCell(row, "numerator"), numberCell(row, "denominator")],
      };
    }),
  );

  // -- active time ------------------------------------------------------------------------------
  const timeRows: PilotTableRowView[] = [];
  for (const phase of PHASES) {
    for (const series of TIME_SERIES) {
      const row = find("active_time", "series", `${phase}:${series}`);
      const valued = row !== undefined && row.status === "value";
      const minutes = (value: number | null | undefined): PilotCellView =>
        valued && value !== null && value !== undefined
          ? plainCell(value.toFixed(1))
          : resultCell(row);
      timeRows.push({
        header: `${words.phases[phase]}, ${words.series[series]}`,
        detail: null,
        cells: [
          valued ? plainCell(String(row.denominator)) : resultCell(row),
          minutes(row?.value),
          minutes(row?.min),
          minutes(row?.max),
        ],
      });
    }
  }
  const timeTable = table(
    "time",
    "Active time, median minutes per NDA",
    [
      "Phase and series",
      "Timed NDAs (n)",
      "Median (minutes)",
      "Minimum (minutes)",
      "Maximum (minutes)",
    ],
    timeRows,
  );

  return {
    scope,
    title: scope === "pilot" ? "Pilot measures" : "Pilot measures (synthetic scope)",
    scopeLinks: SCOPES.map((s) => ({
      scope: s,
      label: words.scopeLinks[s],
      current: s === scope,
    })),
    banner: scope === "synthetic" ? words.syntheticBanner : null,
    emptyNote:
      scope === "pilot" && count("matters_in_scope") === 0
        ? pilotEmptyNote(count("matters_total"))
        : null,
    calendar: measures.calendar,
    calendarSentence: calendarSentence(measures.calendar),
    tables: [
      measuresTable,
      phaseTable,
      reasonTable,
      ruleTable,
      ratingTable,
      shadowTable,
      timeTable,
    ],
    population: measures.population.map((p) => ({
      code: p.code,
      count: p.count,
      sentence: words.population[p.code],
    })),
    expiringNote: expiringNote(count("matters_expiring_before_pilot_end")),
    method: words.method,
    download: { label: "Download the CSV of this scope", scope },
    measures,
    phrases: words,
  };
}

// ---------------------------------------------------------------------------------------------
// The administration form, the timer and the reference list (filled by the store and the service)
// ---------------------------------------------------------------------------------------------

export interface PilotParticipantView {
  userId: string;
  /** A display name; the page shows it through `RevealedText`. */
  name: string;
  /** On the roster the trainer recorded. */
  trained: boolean;
  /** A hint, never an input to a measure: the person completed the training matter. Null when unknown. */
  completedTraining: boolean | null;
}

export interface PilotAdminView {
  /** The start date in force, with when it was set and how many times it has been set. */
  calendar: { startDate: string; endDate: string; setAt: string; timesSet: number } | null;
  participants: PilotParticipantView[];
}

export interface TimerView {
  /** The person's role on the matter may time it (an associate or a reviewing attorney). */
  allowed: boolean;
  /** Set when this person has a timer running on this matter. */
  running: { since: string } | null;
  /** True when this person has a timer running on another matter. The page names no matter. */
  elsewhere: boolean;
  /** The closed time on this matter, in whole seconds, over `sessions` closed entries. */
  closedSeconds: number;
  sessions: number;
}

export interface ReferenceRuleView {
  ruleKey: string;
  title: string;
  /** The saved choice; null for "not an issue". */
  severity: PilotSeverity | null;
}

export interface ReferenceView {
  /** `open`: it can be recorded; `locked`: a review has started; `no_playbook`: no version is pinned. */
  state: "open" | "locked" | "no_playbook";
  rules: ReferenceRuleView[];
  /** Issues no rule covers, by severity. */
  outside: Record<PilotSeverity, number>;
  /** The number of issues saved in all. */
  issues: number;
}

/** The set a reviewer saves. Only the rules with a severity are listed. */
export interface ReferenceListInput {
  rules: { ruleKey: string; severity: PilotSeverity }[];
  outsideHigh: number;
  outsideMedium: number;
  outsideLow: number;
}
