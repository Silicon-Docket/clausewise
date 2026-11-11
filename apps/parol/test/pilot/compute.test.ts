import { describe, expect, it } from "vitest";
import { REASON_CODES } from "../../src/contracts.js";
import { computePilotMeasures } from "../../src/pilot/compute.js";
import {
  MEASURE_IDS,
  POPULATION_CODES,
  type MeasureRow,
  type NoDataReason,
  type PilotMeasures,
  type PilotRecords,
  type PilotScope,
} from "../../src/pilot/types.js";
import { AS_OF, at, f1Records } from "./f1.js";

/**
 * Every expected value below was worked out by hand from the description of fixture F1 in `f1.ts`
 * and from the definitions of docs/parol/08. None of it was produced by the code under test.
 */

const SIX = [
  "wrong_status",
  "wrong_evidence",
  "missed_context",
  "bad_fallback",
  "unclear",
  "other",
];

const compute = (records: PilotRecords, scope: PilotScope = "pilot"): PilotMeasures =>
  computePilotMeasures(records, { scope, asOf: AS_OF, reasonCodes: SIX });

type Tuple = [
  measure: string,
  breakdown: string,
  key: string,
  numerator: number | null,
  denominator: number,
  value: number | null,
  min: number | null,
  max: number | null,
  reason: NoDataReason | null,
];

const tuple = (row: MeasureRow): Tuple => [
  row.measure,
  row.breakdown,
  row.key,
  row.numerator,
  row.denominator,
  row.value,
  row.min,
  row.max,
  row.reason,
];

// Builders for the expected rows.
const ratio = (m: string, b: string, k: string, num: number, den: number, value: number): Tuple => [
  m,
  b,
  k,
  num,
  den,
  value,
  null,
  null,
  null,
];
/** A ratio row with a zero denominator. */
const none = (m: string, b: string, k: string, reason: NoDataReason = "no_denominator"): Tuple => [
  m,
  b,
  k,
  0,
  0,
  null,
  null,
  null,
  reason,
];
const median = (
  m: string,
  b: string,
  k: string,
  n: number,
  value: number,
  min: number,
  max: number,
): Tuple => [m, b, k, null, n, value, min, max, null];
/** A median row with no values. */
const noMedian = (
  m: string,
  b: string,
  k: string,
  reason: NoDataReason = "no_denominator",
): Tuple => [m, b, k, null, 0, null, null, null, reason];

const RULE_KEYS = ["pty-1", "def-1", "exc-1", "pds-1", "pds-2", "dur-1", "ret-1", "gov-1"];

describe("fixture F1, pilot scope", () => {
  const result = compute(f1Records());

  it("has the matters, the roster and the window that the hand count says", () => {
    expect(result.scope).toBe("pilot");
    expect(result.asOf).toBe(AS_OF);
    expect(result.calendar).toEqual({ startDate: "2026-01-05", endDate: "2026-02-08" });
    expect(result.population.map((p) => [p.code, p.count])).toEqual([
      ["matters_total", 8],
      ["matters_training", 1],
      ["matters_synthetic", 1],
      ["matters_by_demo_identity", 1],
      ["matters_real", 5],
      ["matters_in_scope", 5],
      ["matters_run_in_window", 3],
      ["matters_run_before_window", 0],
      ["matters_run_after_window", 1],
      ["matters_no_run", 1],
      ["matters_exported", 1],
      ["findings", 24],
      ["findings_decided", 16],
      ["decisions_no_longer_current", 2],
      ["missed_reports_counted", 2],
      ["missed_reports_outside", 1],
      ["ratings_counted", 2],
      ["ratings_by_viewers", 1],
      ["raters_eligible", 2],
      ["time_entries_counted", 8],
      ["time_entries_open", 1],
      ["time_entries_outside_window", 1],
      ["reference_issues_compared", 3],
      ["reference_issues_not_compared", 1],
      ["participants_trained", 2],
      ["starters_not_on_roster", 0],
      ["matters_expiring_before_pilot_end", 2],
      ["audit_matters_created", 6],
      ["audit_matters_deleted", 1],
    ]);
  });

  it("gives every row to the digit, in the order the page and the file list them", () => {
    const expected: Tuple[] = [
      // completion: 1 of 3 (M1 exported; M1, M2 and M3 had a run in the window)
      ratio("completion", "overall", "", 1, 3, 0.3333),
      none("completion", "phase", "baseline"),
      ratio("completion", "phase", "shadow", 0, 1, 0),
      ratio("completion", "phase", "assisted", 1, 2, 0.5),
      // repeat usage: a1 started in weeks 3 and 4, a2 in week 2 only (M4 is outside the window)
      ratio("repeat_usage", "overall", "", 1, 2, 0.5),
      // correction rate: M1 has one edit and one reject among 16 decided findings
      ratio("correction_rate", "overall", "", 2, 16, 0.125),
      none("correction_rate", "phase", "baseline"),
      none("correction_rate", "phase", "shadow"),
      ratio("correction_rate", "phase", "assisted", 2, 16, 0.125),
      ratio("correction_rate", "reason_code", "wrong_status", 1, 16, 0.0625),
      ratio("correction_rate", "reason_code", "wrong_evidence", 1, 16, 0.0625),
      ratio("correction_rate", "reason_code", "missed_context", 0, 16, 0),
      ratio("correction_rate", "reason_code", "bad_fallback", 0, 16, 0),
      ratio("correction_rate", "reason_code", "unclear", 0, 16, 0),
      ratio("correction_rate", "reason_code", "other", 0, 16, 0),
      // accepted or minor: 5 + 8 accepts, and the one edit is not minor
      ratio("accepted_or_minor", "overall", "", 13, 16, 0.8125),
      none("accepted_or_minor", "phase", "baseline"),
      none("accepted_or_minor", "phase", "shadow"),
      ratio("accepted_or_minor", "phase", "assisted", 13, 16, 0.8125),
      // missed issues: 2 reports on the one exported matter; the pds-1 report is on M2, not exported
      ratio("missed_issue_rate", "overall", "", 2, 1, 2),
      none("missed_issue_rate", "phase", "baseline"),
      none("missed_issue_rate", "phase", "shadow"),
      ratio("missed_issue_rate", "phase", "assisted", 2, 1, 2),
      ratio("missed_issue_rate", "rule", "pty-1", 0, 1, 0),
      ratio("missed_issue_rate", "rule", "def-1", 0, 1, 0),
      ratio("missed_issue_rate", "rule", "exc-1", 0, 1, 0),
      ratio("missed_issue_rate", "rule", "pds-1", 0, 1, 0),
      ratio("missed_issue_rate", "rule", "pds-2", 0, 1, 0),
      ratio("missed_issue_rate", "rule", "dur-1", 1, 1, 1),
      ratio("missed_issue_rate", "rule", "ret-1", 0, 1, 0),
      ratio("missed_issue_rate", "rule", "gov-1", 0, 1, 0),
      ratio("missed_issue_rate", "rule", "not_covered", 1, 1, 1),
      // escalation by the system: M1 3 + M2 1 of 24; M3 0 of 8
      ratio("escalation_system", "overall", "", 4, 24, 0.1667),
      none("escalation_system", "phase", "baseline"),
      ratio("escalation_system", "phase", "shadow", 0, 8, 0),
      ratio("escalation_system", "phase", "assisted", 4, 16, 0.25),
      // escalation by reviewers: one escalate decision on M1
      ratio("escalation_reviewer", "overall", "", 1, 24, 0.0417),
      ratio("escalation_reviewer", "of_decided", "decided", 1, 16, 0.0625),
      none("escalation_reviewer", "phase", "baseline"),
      ratio("escalation_reviewer", "phase", "shadow", 0, 8, 0),
      ratio("escalation_reviewer", "phase", "assisted", 1, 16, 0.0625),
      // satisfaction: ratings 4 and 5 (the viewer's 3 is not counted)
      median("satisfaction_rating", "overall", "", 2, 4.5, 4, 5),
      noMedian("satisfaction_rating", "phase", "baseline"),
      noMedian("satisfaction_rating", "phase", "shadow"),
      median("satisfaction_rating", "phase", "assisted", 2, 4.5, 4, 5),
      ratio("satisfaction_rating", "distribution", "1", 0, 2, 0),
      ratio("satisfaction_rating", "distribution", "2", 0, 2, 0),
      ratio("satisfaction_rating", "distribution", "3", 0, 2, 0),
      ratio("satisfaction_rating", "distribution", "4", 1, 2, 0.5),
      ratio("satisfaction_rating", "distribution", "5", 1, 2, 0.5),
      ratio("satisfaction_response", "overall", "", 2, 2, 1),
      none("satisfaction_response", "phase", "baseline"),
      none("satisfaction_response", "phase", "shadow"),
      ratio("satisfaction_response", "phase", "assisted", 2, 2, 1),
      // active time, in minutes
      median("active_time", "series", "baseline:associate", 1, 45, 45, 45),
      median("active_time", "series", "baseline:reviewer", 1, 20, 20, 20),
      median("active_time", "series", "baseline:combined", 1, 65, 65, 65),
      median("active_time", "series", "shadow:associate", 1, 40, 40, 40),
      noMedian("active_time", "series", "shadow:reviewer"),
      noMedian("active_time", "series", "shadow:combined"),
      median("active_time", "series", "assisted:associate", 2, 35, 25, 45),
      median("active_time", "series", "assisted:reviewer", 2, 25, 15, 35),
      median("active_time", "series", "assisted:combined", 2, 60, 60, 60),
      // shadow-mode agreement: of three reference issues compared, dur-1 was flagged
      ratio("shadow_agreement", "overall", "", 1, 3, 0.3333),
      ratio("shadow_agreement", "severity", "high", 1, 2, 0.5),
      ratio("shadow_agreement", "severity", "medium", 0, 1, 0),
      none("shadow_agreement", "severity", "low"),
    ];
    expect(result.rows.map(tuple)).toEqual(expected);
  });

  it("gives each row the unit and the status its kind needs", () => {
    for (const row of result.rows) {
      const unit =
        row.measure === "missed_issue_rate"
          ? "reports_per_matter"
          : row.measure === "active_time"
            ? "minutes"
            : row.measure === "satisfaction_rating" && row.breakdown !== "distribution"
              ? "rating"
              : "ratio";
      expect(row.unit, `${row.measure} ${row.breakdown} ${row.key}`).toBe(unit);
      expect(row.status).toBe(row.reason === null ? "value" : "no_data");
      expect(row.value === null).toBe(row.status === "no_data");
    }
  });

  it("is deterministic and does not change its input", () => {
    const records = f1Records();
    const copy = JSON.stringify(records);
    const first = compute(records);
    expect(JSON.stringify(records)).toBe(copy);
    expect(JSON.stringify(compute(records))).toBe(JSON.stringify(first));
  });
});

describe("fixture F1, synthetic scope", () => {
  const result = compute(f1Records(), "synthetic");

  it("counts what the pilot scope leaves out, and only that", () => {
    const get = (code: string): number | undefined =>
      result.population.find((p) => p.code === code)?.count;
    expect(get("matters_total")).toBe(8);
    expect(get("matters_in_scope")).toBe(2);
    expect(get("matters_run_in_window")).toBe(2);
    expect(get("matters_exported")).toBe(1);
    expect(get("findings")).toBe(16);
    expect(get("findings_decided")).toBe(8);
    expect(get("ratings_counted")).toBe(1);
    expect(get("raters_eligible")).toBe(2);
    expect(get("time_entries_counted")).toBe(1);
    expect(get("participants_trained")).toBe(1);
    expect(get("starters_not_on_roster")).toBe(1);
    expect(get("matters_expiring_before_pilot_end")).toBe(1);
    expect(get("decisions_no_longer_current")).toBe(1);
    expect(get("audit_matters_created")).toBe(3);
    expect(get("audit_matters_deleted")).toBe(1);
  });

  it("gives every row to the digit", () => {
    const expected: Tuple[] = [
      ratio("completion", "overall", "", 1, 2, 0.5),
      none("completion", "phase", "baseline"),
      none("completion", "phase", "shadow"),
      ratio("completion", "phase", "assisted", 1, 2, 0.5),
      // the roster of this scope is the demonstration identity s1, who started M7 in week 3 only
      ratio("repeat_usage", "overall", "", 0, 1, 0),
      ratio("correction_rate", "overall", "", 0, 8, 0),
      none("correction_rate", "phase", "baseline"),
      none("correction_rate", "phase", "shadow"),
      ratio("correction_rate", "phase", "assisted", 0, 8, 0),
      ...SIX.map((code) => ratio("correction_rate", "reason_code", code, 0, 8, 0)),
      ratio("accepted_or_minor", "overall", "", 8, 8, 1),
      none("accepted_or_minor", "phase", "baseline"),
      none("accepted_or_minor", "phase", "shadow"),
      ratio("accepted_or_minor", "phase", "assisted", 8, 8, 1),
      ratio("missed_issue_rate", "overall", "", 0, 1, 0),
      none("missed_issue_rate", "phase", "baseline"),
      none("missed_issue_rate", "phase", "shadow"),
      ratio("missed_issue_rate", "phase", "assisted", 0, 1, 0),
      ...[...RULE_KEYS, "not_covered"].map((key) =>
        ratio("missed_issue_rate", "rule", key, 0, 1, 0),
      ),
      ratio("escalation_system", "overall", "", 2, 16, 0.125),
      none("escalation_system", "phase", "baseline"),
      none("escalation_system", "phase", "shadow"),
      ratio("escalation_system", "phase", "assisted", 2, 16, 0.125),
      ratio("escalation_reviewer", "overall", "", 0, 16, 0),
      ratio("escalation_reviewer", "of_decided", "decided", 0, 8, 0),
      none("escalation_reviewer", "phase", "baseline"),
      none("escalation_reviewer", "phase", "shadow"),
      ratio("escalation_reviewer", "phase", "assisted", 0, 16, 0),
      median("satisfaction_rating", "overall", "", 1, 5, 5, 5),
      noMedian("satisfaction_rating", "phase", "baseline"),
      noMedian("satisfaction_rating", "phase", "shadow"),
      median("satisfaction_rating", "phase", "assisted", 1, 5, 5, 5),
      ratio("satisfaction_rating", "distribution", "1", 0, 1, 0),
      ratio("satisfaction_rating", "distribution", "2", 0, 1, 0),
      ratio("satisfaction_rating", "distribution", "3", 0, 1, 0),
      ratio("satisfaction_rating", "distribution", "4", 0, 1, 0),
      ratio("satisfaction_rating", "distribution", "5", 1, 1, 1),
      // a1 rated, r1 did not
      ratio("satisfaction_response", "overall", "", 1, 2, 0.5),
      none("satisfaction_response", "phase", "baseline"),
      none("satisfaction_response", "phase", "shadow"),
      ratio("satisfaction_response", "phase", "assisted", 1, 2, 0.5),
      noMedian("active_time", "series", "baseline:associate"),
      noMedian("active_time", "series", "baseline:reviewer"),
      noMedian("active_time", "series", "baseline:combined"),
      noMedian("active_time", "series", "shadow:associate"),
      noMedian("active_time", "series", "shadow:reviewer"),
      noMedian("active_time", "series", "shadow:combined"),
      median("active_time", "series", "assisted:associate", 1, 10, 10, 10),
      noMedian("active_time", "series", "assisted:reviewer"),
      noMedian("active_time", "series", "assisted:combined"),
      none("shadow_agreement", "overall", ""),
      none("shadow_agreement", "severity", "high"),
      none("shadow_agreement", "severity", "medium"),
      none("shadow_agreement", "severity", "low"),
    ];
    expect(result.rows.map(tuple)).toEqual(expected);
  });
});

describe("the two scopes partition the records", () => {
  const pilot = compute(f1Records(), "pilot");
  const synthetic = compute(f1Records(), "synthetic");
  const of = (m: PilotMeasures, code: string): number =>
    m.population.find((p) => p.code === code)?.count ?? Number.NaN;

  it("pilot plus synthetic plus training equals the matters in the database", () => {
    expect(
      of(pilot, "matters_in_scope") +
        of(synthetic, "matters_in_scope") +
        of(pilot, "matters_training"),
    ).toBe(of(pilot, "matters_total"));
    expect(of(pilot, "matters_total")).toBe(8);
    // the flags that describe the database do not depend on the scope
    for (const code of [
      "matters_total",
      "matters_training",
      "matters_synthetic",
      "matters_by_demo_identity",
      "matters_real",
    ]) {
      expect(of(pilot, code)).toBe(of(synthetic, code));
    }
  });

  it("splits reports, timers, reference issues, stale decisions and audit rows with none left over", () => {
    const sum = (...codes: string[]): number =>
      codes.reduce((total, code) => total + of(pilot, code) + of(synthetic, code), 0);
    // reports on matters that are not training matters: M1 x2, M2 x1
    expect(sum("missed_reports_counted", "missed_reports_outside")).toBe(3);
    // timers on matters that are not training matters: eleven
    expect(sum("time_entries_counted", "time_entries_open", "time_entries_outside_window")).toBe(
      11,
    );
    // reference issues on matters that are not training matters: M3 x3, M5 x1
    expect(sum("reference_issues_compared", "reference_issues_not_compared")).toBe(4);
    expect(sum("decisions_no_longer_current")).toBe(3);
    // the audit log holds ten rows, one of them a training matter
    expect(sum("audit_matters_created")).toBe(9);
    expect(sum("audit_matters_deleted")).toBe(2);
    // matters with a run: M1 to M4, M6 and M7; each is in the window, after it, or in the other scope
    expect(
      sum("matters_run_in_window", "matters_run_before_window", "matters_run_after_window"),
    ).toBe(6);
    expect(sum("matters_no_run")).toBe(1);
  });
});

describe("training matters", () => {
  it("are in neither scope: flipping the flag of M8 moves the pilot figures", () => {
    const records = f1Records();
    const before = compute(records);
    for (const m of records.matters) if (m.matterId === "M8") m.training = false;
    const after = compute(records);
    const row = (
      m: PilotMeasures,
      measure: string,
      breakdown: string,
      key: string,
    ): MeasureRow | undefined =>
      m.rows.find((r) => r.measure === measure && r.breakdown === breakdown && r.key === key);
    // with the flag off M8 is a real matter with a run in the window, and its records count
    expect(row(before, "completion", "overall", "")?.denominator).toBe(3);
    expect(row(after, "completion", "overall", "")?.denominator).toBe(4);
    expect(row(after, "escalation_system", "overall", "")?.denominator).toBe(32);
    expect(row(after, "correction_rate", "overall", "")?.numerator).toBe(6);
    expect(row(after, "active_time", "series", "assisted:associate")?.denominator).toBe(3);
    expect(row(after, "shadow_agreement", "overall", "")?.denominator).toBe(4);
    expect(row(after, "satisfaction_rating", "overall", "")?.denominator).toBe(3);
  });

  it("are counted once, in matters_training, and in no audit count", () => {
    const records = f1Records();
    const result = compute(records);
    expect(result.population.find((p) => p.code === "matters_training")?.count).toBe(1);
    // the audit row of M8 is a training matter too, so it is in neither scope's count
    expect(result.population.find((p) => p.code === "audit_matters_created")?.count).toBe(6);
  });

  it("are set aside even when the database holds nothing else", () => {
    const records = f1Records();
    const only: PilotRecords = {
      ...records,
      matters: records.matters.filter((m) => m.matterId === "M8"),
      members: [],
      runs: [],
      findings: [],
      decisions: [],
      staleDecisions: [],
      memos: [],
      missedIssues: [],
      ratings: [],
      timeEntries: [],
      referenceIssues: [],
      participants: [],
      auditMatters: [],
    };
    const result = compute(only);
    expect(result.population.find((p) => p.code === "matters_total")?.count).toBe(1);
    expect(result.population.find((p) => p.code === "matters_in_scope")?.count).toBe(0);
    // the only matter is a training matter, so it is not "every matter belongs to the other scope"
    expect(new Set(result.rows.map((r) => r.reason))).toEqual(new Set(["no_denominator"]));
  });
});

describe("no data", () => {
  it("says no_calendar on every row when no calendar is set", () => {
    const records = f1Records();
    records.calendar = null;
    for (const scope of ["pilot", "synthetic"] as const) {
      const result = compute(records, scope);
      expect(result.calendar).toBeNull();
      expect(result.rows.length).toBeGreaterThan(0);
      for (const row of result.rows) {
        expect(row.status, `${scope} ${row.measure} ${row.key}`).toBe("no_data");
        expect(row.reason).toBe("no_calendar");
        expect(row.value).toBeNull();
        expect(row.denominator).toBe(0);
      }
    }
    // the roster is still shown in the population table, and nothing is placed in a window
    const pilot = compute(records);
    const get = (code: string): number | undefined =>
      pilot.population.find((p) => p.code === code)?.count;
    expect(get("participants_trained")).toBe(2);
    expect(get("matters_in_scope")).toBe(5);
    expect(get("matters_run_in_window")).toBe(0);
    expect(get("matters_run_before_window")).toBe(0);
    expect(get("matters_run_after_window")).toBe(0);
    expect(get("matters_expiring_before_pilot_end")).toBe(0);
    expect(get("time_entries_open")).toBe(1);
    expect(get("time_entries_counted")).toBe(0);
    expect(get("time_entries_outside_window")).toBe(9);
  });

  it("says all_excluded on every pilot row when the only matter is a synthetic one", () => {
    const records = f1Records();
    const keep = (id: string): boolean => id === "M6";
    const only: PilotRecords = {
      ...records,
      matters: records.matters.filter((m) => keep(m.matterId)),
      members: records.members.filter((m) => keep(m.matterId)),
      runs: records.runs.filter((r) => keep(r.matterId)),
      findings: records.findings.filter((f) => keep(f.matterId)),
      decisions: records.decisions.filter((d) => keep(d.matterId)),
      staleDecisions: records.staleDecisions.filter((d) => keep(d.matterId)),
      memos: records.memos.filter((m) => keep(m.matterId)),
      missedIssues: records.missedIssues.filter((r) => keep(r.matterId)),
      ratings: records.ratings.filter((r) => keep(r.matterId)),
      timeEntries: records.timeEntries.filter((t) => keep(t.matterId)),
      referenceIssues: records.referenceIssues.filter((r) => keep(r.matterId)),
      participants: [],
      auditMatters: records.auditMatters.filter((a) => keep(a.matterId)),
    };
    const pilot = compute(only, "pilot");
    // the 67 rows of F1 less the eight rule rows, which need an exported matter to be listed
    expect(pilot.rows.length).toBe(59);
    for (const row of pilot.rows) {
      expect(row.status, `${row.measure} ${row.breakdown} ${row.key}`).toBe("no_data");
      expect(row.reason).toBe("all_excluded");
    }
    expect(pilot.population.find((p) => p.code === "matters_total")?.count).toBe(1);
    expect(pilot.population.find((p) => p.code === "matters_in_scope")?.count).toBe(0);
    // the same records read in the other scope have values
    const synthetic = compute(only, "synthetic");
    expect(
      synthetic.rows.find((r) => r.measure === "completion" && r.breakdown === "overall"),
    ).toMatchObject({
      numerator: 1,
      denominator: 1,
      status: "value",
    });
  });

  it("says no_denominator on an empty database, and the pilot scope of an empty database has zero matters", () => {
    const empty: PilotRecords = {
      calendar: { startDate: "2026-01-05" },
      matters: [],
      members: [],
      playbooks: [],
      runs: [],
      findings: [],
      decisions: [],
      staleDecisions: [],
      memos: [],
      missedIssues: [],
      ratings: [],
      timeEntries: [],
      referenceIssues: [],
      participants: [],
      auditMatters: [],
    };
    const result = compute(empty);
    expect(new Set(result.rows.map((r) => r.reason))).toEqual(new Set(["no_denominator"]));
    expect(result.population.every((p) => p.count === 0)).toBe(true);
    expect(result.population.length).toBe(POPULATION_CODES.length);
    // with nothing exported, the missed-issue rows are the one "not covered" row and no rule row
    expect(result.rows.filter((r) => r.breakdown === "rule").map((r) => r.key)).toEqual([
      "not_covered",
    ]);
  });

  it("never states NaN, Infinity or a percentage of nothing", () => {
    const variants: PilotRecords[] = [f1Records(), { ...f1Records(), calendar: null }];
    for (const records of variants) {
      for (const scope of ["pilot", "synthetic"] as const) {
        for (const row of compute(records, scope).rows) {
          for (const n of [row.numerator, row.denominator, row.value, row.min, row.max]) {
            if (n !== null) expect(Number.isFinite(n)).toBe(true);
          }
          if (row.denominator === 0) {
            expect(row.value).toBeNull();
            expect(row.status).toBe("no_data");
          }
        }
      }
    }
  });
});

describe("the set of measures is closed", () => {
  it("never carries an id outside MEASURE_IDS, and none is a difference, a mean or a saving", () => {
    expect([...MEASURE_IDS]).toEqual([
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
    ]);
    for (const scope of ["pilot", "synthetic"] as const) {
      const ids = new Set(compute(f1Records(), scope).rows.map((r) => r.measure));
      expect([...ids].sort()).toEqual([...MEASURE_IDS].sort());
    }
    for (const id of MEASURE_IDS) {
      expect(id).not.toMatch(/difference|saving|mean|average|delta|ratio_of|annual/);
    }
  });

  it("is the reason codes of the contract that the fixture lists", () => {
    expect([...REASON_CODES]).toEqual(SIX);
  });
});

describe("mixed records: an act of a demonstration identity on a real matter", () => {
  it("leaves the pilot scope and is counted in the other scope where a record of its own exists", () => {
    const records = f1Records();
    // Five acts become acts of a demonstration identity: the last decision of M2, a1's timer on M1,
    // one of M1's reports, a stale decision of M1, and the pds-1 reference issue of M3.
    const lastOfM2 = records.decisions.find(
      (d) => d.matterId === "M2" && d.findingId === "M2-gov-1",
    );
    if (lastOfM2 === undefined) throw new Error("fixture changed");
    lastOfM2.reviewerDemo = true;
    const timer = records.timeEntries.find(
      (t) => t.matterId === "M1" && t.userId === "a1" && t.role === "associate",
    );
    if (timer === undefined) throw new Error("fixture changed");
    timer.userDemo = true;
    const report = records.missedIssues.find((r) => r.matterId === "M1" && r.ruleKey === null);
    if (report === undefined) throw new Error("fixture changed");
    report.userDemo = true;
    const stale = records.staleDecisions[0];
    if (stale === undefined) throw new Error("fixture changed");
    stale.reviewerDemo = true;
    const reference = records.referenceIssues.find(
      (r) => r.ruleKey === "pds-1" && r.matterId === "M3",
    );
    if (reference === undefined) throw new Error("fixture changed");
    reference.recordedByDemo = true;

    const pilot = compute(records, "pilot");
    const synthetic = compute(records, "synthetic");
    const row = (
      m: PilotMeasures,
      measure: string,
      breakdown: string,
      key: string,
    ): MeasureRow | undefined =>
      m.rows.find((r) => r.measure === measure && r.breakdown === breakdown && r.key === key);
    const count = (m: PilotMeasures, code: string): number | undefined =>
      m.population.find((p) => p.code === code)?.count;

    // the decision by the demonstration identity is not a decided finding of the pilot scope
    expect(count(pilot, "findings_decided")).toBe(15);
    expect(row(pilot, "accepted_or_minor", "overall", "")).toMatchObject({
      numerator: 12,
      denominator: 15,
    });
    // the matter-anchored ratios of the synthetic scope are over its own matters, so it is not there
    expect(count(synthetic, "findings_decided")).toBe(8);

    // the timer: five minutes fewer in the pilot medians, one more in the synthetic ones
    expect(count(pilot, "time_entries_counted")).toBe(7);
    expect(count(synthetic, "time_entries_counted")).toBe(2);
    expect(row(pilot, "active_time", "series", "assisted:associate")).toMatchObject({
      denominator: 1,
      value: 45,
      min: 45,
      max: 45,
    });
    // timers are records of their own, so the synthetic medians now hold M6's 10 minutes and M1's 25
    expect(row(synthetic, "active_time", "series", "assisted:associate")).toMatchObject({
      denominator: 2,
      value: 17.5,
      min: 10,
      max: 25,
    });

    // the report: one of M1's two reports leaves the rate and shows in the other scope's outside count
    expect(row(pilot, "missed_issue_rate", "overall", "")).toMatchObject({
      numerator: 1,
      denominator: 1,
    });
    expect(count(pilot, "missed_reports_counted")).toBe(1);
    expect(count(synthetic, "missed_reports_outside")).toBe(1);

    // the stale decision moves the other way in the population table
    expect(count(pilot, "decisions_no_longer_current")).toBe(1);
    expect(count(synthetic, "decisions_no_longer_current")).toBe(2);

    // the reference issue recorded by a demonstration identity is not compared in either scope's ratio
    expect(count(pilot, "reference_issues_compared")).toBe(2);
    expect(count(synthetic, "reference_issues_not_compared")).toBe(1);
    expect(row(pilot, "shadow_agreement", "overall", "")).toMatchObject({
      numerator: 1,
      denominator: 2,
    });
  });

  it("puts a matter whose first run a demonstration identity started in the synthetic scope", () => {
    const records = f1Records();
    const run = records.runs.find((r) => r.runId === "run-3");
    if (run === undefined) throw new Error("fixture changed");
    run.startedByDemo = true;
    const pilot = compute(records, "pilot");
    const synthetic = compute(records, "synthetic");
    const count = (m: PilotMeasures, code: string): number | undefined =>
      m.population.find((p) => p.code === code)?.count;
    expect(count(pilot, "matters_in_scope")).toBe(4);
    expect(count(synthetic, "matters_in_scope")).toBe(3);
    expect(count(pilot, "matters_in_scope")! + count(synthetic, "matters_in_scope")! + 1).toBe(8);
    expect(count(pilot, "matters_run_in_window")).toBe(2);
    expect(count(synthetic, "matters_run_in_window")).toBe(3);
  });
});

describe("the first run of a matter", () => {
  it("is the earliest one, with ties broken by run id, whatever the order of the list", () => {
    const records = f1Records();
    // M1 gets a second run at the same instant as its first, started by a demonstration identity
    records.runs.push({
      runId: "run-0",
      matterId: "M1",
      startedBy: "s1",
      startedByDemo: true,
      startedAt: at(14, "09:00:00"),
      status: "failed",
    });
    // "run-0" sorts before "run-1", so the first run is now the demonstration identity's: M1 leaves
    // the pilot scope and its failed run still counts as "a run started"
    const result = compute(records, "pilot");
    expect(result.population.find((p) => p.code === "matters_in_scope")?.count).toBe(4);
    const synthetic = compute(records, "synthetic");
    expect(synthetic.population.find((p) => p.code === "matters_in_scope")?.count).toBe(3);
    // and the same list in the other order gives the same answer
    records.runs.reverse();
    expect(JSON.stringify(compute(records, "pilot"))).toBe(JSON.stringify(result));
  });

  it("counts a failed run as a run started, but takes the findings of finished runs only", () => {
    const records = f1Records();
    for (const run of records.runs) if (run.runId === "run-2") run.status = "failed";
    const result = compute(records);
    const get = (code: string): number | undefined =>
      result.population.find((p) => p.code === code)?.count;
    expect(get("matters_run_in_window")).toBe(3);
    expect(get("findings")).toBe(16);
    expect(get("findings_decided")).toBe(8);
  });

  it("counts the findings of a run that a later run superseded", () => {
    const records = f1Records();
    for (const run of records.runs) if (run.runId === "run-1") run.status = "superseded";
    expect(compute(records).population.find((p) => p.code === "findings")?.count).toBe(24);
  });
});

describe("the window", () => {
  it("places a matter by the week of its first run, to the millisecond", () => {
    const records = f1Records();
    const run = records.runs.find((r) => r.runId === "run-1");
    if (run === undefined) throw new Error("fixture changed");
    const phaseRow = (m: PilotMeasures): string =>
      m.rows
        .filter((r) => r.measure === "completion" && r.breakdown === "phase" && r.denominator > 0)
        .map((r) => `${r.key}:${r.denominator}`)
        .join(",");
    // the last millisecond of day 34 is week 5, assisted; the first of day 35 is after the window
    run.startedAt = "2026-02-08T23:59:59.999Z";
    expect(phaseRow(compute(records))).toBe("shadow:1,assisted:2");
    run.startedAt = "2026-02-09T00:00:00.000Z";
    expect(phaseRow(compute(records))).toBe("shadow:1,assisted:1");
    // the first instant of day 7 is week 2, the instant before it week 1
    run.startedAt = "2026-01-12T00:00:00.000Z";
    expect(phaseRow(compute(records))).toBe("shadow:2,assisted:1");
    run.startedAt = "2026-01-11T23:59:59.999Z";
    expect(phaseRow(compute(records))).toBe("baseline:1,shadow:1,assisted:1");
    // before the start date the matter is outside the window
    run.startedAt = "2026-01-04T23:59:59.999Z";
    const before = compute(records);
    expect(before.population.find((p) => p.code === "matters_run_before_window")?.count).toBe(1);
    expect(before.population.find((p) => p.code === "matters_run_in_window")?.count).toBe(2);
  });
});

describe("reason codes", () => {
  it("rows add up to the overall numerator, with not_recorded only when positive", () => {
    const records = f1Records();
    const base = compute(records);
    expect(base.rows.some((r) => r.key === "not_recorded")).toBe(false);

    // a reject made before reason codes existed carries none; a code nobody listed is also seen
    const reject = records.decisions.find((d) => d.findingId === "M1-dur-1");
    const edit = records.decisions.find((d) => d.findingId === "M1-exc-1");
    if (reject === undefined || edit === undefined) throw new Error("fixture changed");
    reject.reasonCode = null;
    edit.reasonCode = "unlisted_code";
    const result = compute(records);
    const byCode = result.rows.filter(
      (r) => r.measure === "correction_rate" && r.breakdown === "reason_code",
    );
    expect(byCode.map((r) => r.key)).toEqual([...SIX, "unlisted_code", "not_recorded"]);
    const overall = result.rows.find(
      (r) => r.measure === "correction_rate" && r.breakdown === "overall",
    );
    expect(byCode.reduce((total, r) => total + (r.numerator ?? 0), 0)).toBe(overall?.numerator);
    expect(byCode.find((r) => r.key === "not_recorded")).toMatchObject({
      numerator: 1,
      denominator: 16,
    });
    expect(byCode.find((r) => r.key === "unlisted_code")).toMatchObject({
      numerator: 1,
      denominator: 16,
    });
  });

  it("has one row per code seen when no list is given, and none when nothing was corrected", () => {
    const records = f1Records();
    const result = computePilotMeasures(records, { scope: "pilot", asOf: AS_OF });
    expect(result.rows.filter((r) => r.breakdown === "reason_code").map((r) => r.key)).toEqual([
      "wrong_evidence",
      "wrong_status",
    ]);
    records.decisions = records.decisions.filter((d) => d.decision === "accept");
    const quiet = computePilotMeasures(records, { scope: "pilot", asOf: AS_OF });
    expect(quiet.rows.filter((r) => r.breakdown === "reason_code")).toEqual([]);
  });
});

describe("minor edits", () => {
  it("count with the accepts only when the edit is marked minor", () => {
    const records = f1Records();
    const row = (m: PilotMeasures): MeasureRow | undefined =>
      m.rows.find((r) => r.measure === "accepted_or_minor" && r.breakdown === "overall");
    expect(row(compute(records))?.numerator).toBe(13);
    const edit = records.decisions.find((d) => d.findingId === "M1-exc-1");
    if (edit === undefined) throw new Error("fixture changed");
    edit.minorEdit = true;
    expect(row(compute(records))?.numerator).toBe(14);
    edit.minorEdit = null;
    expect(row(compute(records))?.numerator).toBe(13);
  });
});

describe("ratings", () => {
  const ratingRow = (m: PilotMeasures): MeasureRow | undefined =>
    m.rows.find((r) => r.measure === "satisfaction_rating" && r.breakdown === "overall");

  it("count once per person and matter, the later one, whatever the database allows", () => {
    const records = f1Records();
    // a1 rated twice on M1: the list is oldest first, so the second is the one in force
    records.ratings.push({ matterId: "M1", userId: "a1", userDemo: false, rating: 2 });
    const result = compute(records);
    expect(ratingRow(result)).toMatchObject({ denominator: 2, value: 3.5, min: 2, max: 5 });
    expect(result.population.find((p) => p.code === "ratings_counted")?.count).toBe(2);
  });

  it("take the middle value of an odd count and the mean of the two middle values of an even one", () => {
    const records = f1Records();
    records.ratings = [
      { matterId: "M1", userId: "a1", userDemo: false, rating: 5 },
      { matterId: "M1", userId: "r1", userDemo: false, rating: 1 },
    ];
    expect(ratingRow(compute(records))).toMatchObject({ denominator: 2, value: 3, min: 1, max: 5 });
    // add a third eligible rater: the viewer is not one, so give the matter another reviewer
    records.members.push({ matterId: "M1", userId: "r2", userDemo: false, role: "reviewer" });
    records.ratings.push({ matterId: "M1", userId: "r2", userDemo: false, rating: 4 });
    expect(ratingRow(compute(records))).toMatchObject({ denominator: 3, value: 4, min: 1, max: 5 });
    // four ratings, 1, 2, 3 and 5: the median is the mean of 2 and 3
    records.members.push({ matterId: "M1", userId: "r3", userDemo: false, role: "reviewer" });
    records.ratings = [
      { matterId: "M1", userId: "a1", userDemo: false, rating: 1 },
      { matterId: "M1", userId: "r1", userDemo: false, rating: 2 },
      { matterId: "M1", userId: "r2", userDemo: false, rating: 3 },
      { matterId: "M1", userId: "r3", userDemo: false, rating: 5 },
    ];
    expect(ratingRow(compute(records))).toMatchObject({ denominator: 4, value: 2.5 });
  });

  it("leave a viewer's rating out of every figure and report it in the population table", () => {
    const result = compute(f1Records());
    expect(ratingRow(result)).toMatchObject({ denominator: 2, value: 4.5 });
    expect(result.population.find((p) => p.code === "ratings_by_viewers")?.count).toBe(1);
    expect(result.population.find((p) => p.code === "raters_eligible")?.count).toBe(2);
  });

  it("refuse a rating outside 1 to 5 loudly", () => {
    const records = f1Records();
    records.ratings.push({ matterId: "M1", userId: "a1", userDemo: false, rating: 6 });
    expect(() => compute(records)).toThrow(RangeError);
    records.ratings.pop();
    records.ratings.push({ matterId: "M1", userId: "a1", userDemo: false, rating: 2.5 });
    expect(() => compute(records)).toThrow(RangeError);
  });
});

describe("repeat usage", () => {
  const repeat = (m: PilotMeasures): MeasureRow | undefined =>
    m.rows.find((r) => r.measure === "repeat_usage");

  it("counts people of the roster who started in two different weeks, not two matters in one week", () => {
    const records = f1Records();
    // a2 starts a second matter in week 2: still one week
    records.matters.push({
      matterId: "M9",
      synthetic: false,
      creatorDemo: false,
      training: false,
      playbookVersionId: "pb-1",
      retainUntil: "2026-03-20T09:00:00.000Z",
    });
    records.runs.push({
      runId: "run-9",
      matterId: "M9",
      startedBy: "a2",
      startedByDemo: false,
      startedAt: at(8, "10:00:00"),
      status: "failed",
    });
    expect(repeat(compute(records))).toMatchObject({ numerator: 1, denominator: 2 });
    // in week 3 instead: two weeks
    for (const run of records.runs) if (run.runId === "run-9") run.startedAt = at(15, "10:00:00");
    expect(repeat(compute(records))).toMatchObject({ numerator: 2, denominator: 2 });
  });

  it("reports starters who are not on the roster, and gives no figure with an empty roster", () => {
    const records = f1Records();
    records.participants = [{ userId: "a1", demo: false }];
    const result = compute(records);
    expect(repeat(result)).toMatchObject({ numerator: 1, denominator: 1 });
    expect(result.population.find((p) => p.code === "starters_not_on_roster")?.count).toBe(1);
    records.participants = [];
    expect(repeat(compute(records))).toMatchObject({ status: "no_data", reason: "no_denominator" });
  });
});

describe("active time", () => {
  const series = (m: PilotMeasures, key: string): MeasureRow | undefined =>
    m.rows.find((r) => r.measure === "active_time" && r.key === key);

  it("sums the entries of a role on a matter in a phase before it takes the median", () => {
    const result = compute(f1Records());
    // M5 baseline associate: 1800 + 900 seconds is one NDA of 45 minutes, not two of 30 and 15
    expect(series(result, "baseline:associate")).toMatchObject({ denominator: 1, value: 45 });
  });

  it("rounds a median half up to one decimal and keeps seconds below a minute", () => {
    const records = f1Records();
    // 1830 s is 30.5 minutes, 1833 s is 30.55 (up to 30.6), 1827 s is 30.45 (up to 30.5), 1826 s is 30.43 (down)
    const entryOf = records.timeEntries.find((t) => t.matterId === "M3" && t.userId === "a2");
    if (entryOf === undefined) throw new Error("fixture changed");
    const set = (seconds: number): number | null | undefined => {
      entryOf.stoppedAt = new Date(Date.parse(entryOf.startedAt) + seconds * 1000).toISOString();
      return series(compute(records), "shadow:associate")?.value;
    };
    expect(set(1830)).toBe(30.5);
    expect(set(1833)).toBe(30.6);
    expect(set(1827)).toBe(30.5); // 30.45 minutes exactly rounds up
    expect(set(1826)).toBe(30.4); // 30.433.. rounds down
  });

  it("takes the median of two NDAs as the mean of the two sums", () => {
    const records = f1Records();
    // assisted associate sums are 1500 s and 2700 s: median 2100 s = 35 minutes
    expect(series(compute(records), "assisted:associate")).toMatchObject({
      value: 35,
      min: 25,
      max: 45,
    });
    // add an odd number of NDAs: a third matter with 600 s
    records.timeEntries.push({
      matterId: "M4",
      userId: "a2",
      userDemo: false,
      role: "associate",
      startedAt: at(16, "13:00:00"),
      stoppedAt: at(16, "13:10:00"),
    });
    expect(series(compute(records), "assisted:associate")).toMatchObject({
      denominator: 3,
      value: 25,
      min: 10,
      max: 45,
    });
  });

  it("does not count a timer that is still running, nor one stopped before it started", () => {
    const records = f1Records();
    const result = compute(records);
    expect(result.population.find((p) => p.code === "time_entries_open")?.count).toBe(1);
    const entryOf = records.timeEntries.find((t) => t.matterId === "M3" && t.userId === "a2");
    if (entryOf === undefined) throw new Error("fixture changed");
    entryOf.stoppedAt = at(8, "08:00:00");
    expect(() => compute(records)).toThrow(RangeError);
  });

  it("places a timer by the week it started, not the week it stopped", () => {
    const records = f1Records();
    const entryOf = records.timeEntries.find((t) => t.matterId === "M3" && t.userId === "a2");
    if (entryOf === undefined) throw new Error("fixture changed");
    // started on the last millisecond of week 2 and stopped in week 3
    entryOf.startedAt = "2026-01-18T23:59:59.000Z";
    entryOf.stoppedAt = "2026-01-19T00:39:59.000Z";
    const result = compute(records);
    expect(series(result, "shadow:associate")).toMatchObject({ denominator: 1, value: 40 });
    expect(series(result, "assisted:associate")).toMatchObject({ denominator: 2 });
  });
});

describe("shadow-mode agreement", () => {
  const overall = (m: PilotMeasures): MeasureRow | undefined =>
    m.rows.find((r) => r.measure === "shadow_agreement" && r.breakdown === "overall");

  it("counts an issue as agreed when the finding is a deviation, missing or escalated", () => {
    const records = f1Records();
    const finding = (id: string) => {
      const f = records.findings.find((x) => x.findingId === id);
      if (f === undefined) throw new Error("fixture changed");
      return f;
    };
    expect(overall(compute(records))).toMatchObject({ numerator: 1, denominator: 3 });
    finding("M3-pds-1").status = "missing";
    expect(overall(compute(records))).toMatchObject({ numerator: 2, denominator: 3 });
    finding("M3-pds-1").status = "compliant";
    finding("M3-pds-1").escalatedBySystem = true;
    expect(overall(compute(records))).toMatchObject({ numerator: 2, denominator: 3 });
    // an issue that no rule covers is never agreed
    finding("M3-pds-1").escalatedBySystem = false;
    finding("M3-dur-1").status = "not_applicable";
    expect(overall(compute(records))).toMatchObject({ numerator: 0, denominator: 3 });
  });

  it("counts an issue as not agreed when the run has no finding for its rule", () => {
    const records = f1Records();
    records.findings = records.findings.filter((f) => f.findingId !== "M3-dur-1");
    expect(overall(compute(records))).toMatchObject({ numerator: 0, denominator: 3 });
  });

  it("compares with the latest finished run of the matter", () => {
    const records = f1Records();
    // a later finished run of M3 in which dur-1 is compliant
    records.runs.push({
      runId: "run-3b",
      matterId: "M3",
      startedBy: "a2",
      startedByDemo: false,
      startedAt: at(8, "10:00:00"),
      status: "succeeded",
    });
    for (const rule of ["pty-1", "dur-1"] as const) {
      records.findings.push({
        findingId: `M3b-${rule}`,
        runId: "run-3b",
        matterId: "M3",
        ruleKey: rule,
        severity: "high",
        status: "compliant",
        escalatedBySystem: false,
      });
    }
    expect(overall(compute(records))).toMatchObject({ numerator: 0, denominator: 3 });
    // a later run that failed does not replace it
    for (const run of records.runs) if (run.runId === "run-3b") run.status = "failed";
    expect(overall(compute(records))).toMatchObject({ numerator: 1, denominator: 3 });
  });

  it("does not compare a matter without a finished run, and never counts it as a miss", () => {
    const records = f1Records();
    for (const run of records.runs) if (run.runId === "run-3") run.status = "failed";
    const result = compute(records);
    expect(overall(result)).toMatchObject({ status: "no_data", reason: "no_denominator" });
    expect(result.population.find((p) => p.code === "reference_issues_compared")?.count).toBe(0);
    expect(result.population.find((p) => p.code === "reference_issues_not_compared")?.count).toBe(
      4,
    );
  });
});

describe("the calendar in the records", () => {
  it("is refused loudly when it is not a real date", () => {
    const records = f1Records();
    records.calendar = { startDate: "2026-02-30" };
    expect(() => compute(records)).toThrow(RangeError);
  });

  it("is refused loudly when the clock is not an ISO time", () => {
    expect(() => computePilotMeasures(f1Records(), { scope: "pilot", asOf: "yesterday" })).toThrow(
      RangeError,
    );
  });
});
