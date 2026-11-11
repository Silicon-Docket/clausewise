/**
 * The pilot measures, computed from stored records. A pure function: no clock (the caller injects
 * `asOf`, which moves no row), no file, no database, no randomness.
 *
 * The definitions are the rows of the table in docs/parol/08 ('Measures'), read as the design of
 * W2.6b reads them, and every reading is stated on the page (`phrases.ts`):
 *
 * - A matter "has a run started" when a run of purpose 'matter' exists, whatever became of it.
 * - A matter is "exported" when a memo was ever exported for it.
 * - A finding is "decided" while it has a current decision.
 * - "Started a matter" (repeat usage) is "started its first run".
 * - Weeks are counted in UTC from the start date of the pilot calendar.
 *
 * Scope. A record is real when its matter is real (not synthetic, creator not a demonstration
 * identity) and the person who acted is not a demonstration identity; a record with no actor (a
 * finding) takes its matter. The pilot scope counts the real records, the synthetic scope the
 * rest. A training matter is in neither scope and is counted once, in `matters_training`. Every
 * ratio is anchored on matters, so a numerator can never exceed its denominator's matters: an act
 * by a demonstration identity on a matter of the pilot scope is counted in no ratio of either scope
 * (timers are the exception, they are records of their own and are placed by `recordIsReal`).
 *
 * No data. A row whose denominator is zero has no value, and says why (`NoDataReason`). A ratio is
 * never computed from a zero denominator, so no row can be NaN, Infinity or 0 percent of nothing.
 */
import {
  calendarEnd,
  parseInstant,
  phaseOfWeek,
  pilotWeekOf,
  windowEnd,
  windowPosition,
  type WindowPosition,
} from "./calendar.js";
import {
  NOT_COVERED_KEY,
  NOT_RECORDED_KEY,
  PHASES,
  PILOT_SEVERITIES,
  POPULATION_CODES,
  TIME_SERIES,
  type BreakdownId,
  type DecisionRecord,
  type FindingRecord,
  type MatterRecord,
  type MeasureId,
  type MeasureRow,
  type MemberRecord,
  type MissedIssueRecord,
  type NoDataReason,
  type Phase,
  type PilotMeasures,
  type PilotRecords,
  type PilotScope,
  type PopulationCode,
  type PopulationRow,
  type RatingRecord,
  type RunRecord,
  type TimeSeries,
  type Unit,
} from "./types.js";

export interface ComputeOptions {
  scope: PilotScope;
  /** The injected clock, an ISO time in UTC. It is echoed in the result and moves no row. */
  asOf: string;
  /** The closed list of reason codes, so that a code nobody used still gets a row. */
  reasonCodes?: readonly string[] | undefined;
}

// ---------------------------------------------------------------------------------------------
// Small exact arithmetic
// ---------------------------------------------------------------------------------------------

/** `numerator / denominator` rounded half up to four decimals, in whole-number arithmetic. */
export function ratioValue(numerator: number, denominator: number): number {
  return Math.floor((2 * numerator * 10_000 + denominator) / (2 * denominator)) / 10_000;
}

/** Twice the median of a sorted list, so that it stays a whole number (the mean of two middles is half-integral). */
function doubleMedian(sorted: readonly number[]): number {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? 2 * (sorted[mid] ?? 0) : (sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0);
}

/** Seconds (given doubled) as minutes, rounded half up to one decimal. */
function minutesFromDoubleSeconds(doubleSeconds: number): number {
  return Math.floor((doubleSeconds + 6) / 12) / 10;
}

const groupBy = <T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> => {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = out.get(key);
    if (list === undefined) out.set(key, [item]);
    else list.push(item);
  }
  return out;
};

const FINISHED: ReadonlySet<string> = new Set(["succeeded", "superseded"]);

/** The earliest run of a matter, ties broken by run id. */
function earliest(runs: readonly RunRecord[]): RunRecord | undefined {
  let best: RunRecord | undefined;
  let bestAt = 0;
  for (const run of runs) {
    const at = parseInstant(run.startedAt);
    if (best === undefined || at < bestAt || (at === bestAt && run.runId < best.runId)) {
      best = run;
      bestAt = at;
    }
  }
  return best;
}

/** The latest run, ties broken by run id. */
function latest(runs: readonly RunRecord[]): RunRecord | undefined {
  let best: RunRecord | undefined;
  let bestAt = 0;
  for (const run of runs) {
    const at = parseInstant(run.startedAt);
    if (best === undefined || at > bestAt || (at === bestAt && run.runId > best.runId)) {
      best = run;
      bestAt = at;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// The computation
// ---------------------------------------------------------------------------------------------

/** Everything about the runs of one set of matters that the run-based measures read. */
interface RunSet {
  /** The matters of the set (the denominator of completion). */
  matters: number;
  /** The matters of the set with a memo by a person in scope (X). */
  exported: ReadonlySet<string>;
  /** Findings of the finished runs of the set (F). */
  findings: readonly FindingRecord[];
  /** Current decisions by people in scope on those findings, one per finding (D). */
  decisions: ReadonlyMap<string, DecisionRecord>;
  /** Missed-issue reports by people in scope on the matters of X. */
  reports: readonly MissedIssueRecord[];
  /** The ratings in force (R) and how many ratings viewers gave. */
  ratings: readonly RatingRecord[];
  viewerRatings: number;
  /** People who could rate: associates and reviewers of the matters of X. */
  eligible: number;
}

export function computePilotMeasures(
  records: PilotRecords,
  options: ComputeOptions,
): PilotMeasures {
  const { scope } = options;
  parseInstant(options.asOf);
  const calendar = records.calendar;
  if (calendar !== null) windowEnd(calendar.startDate); // throws RangeError for a bad start date

  // -- scope -------------------------------------------------------------------------------
  const matterIsReal = (m: MatterRecord): boolean => !m.synthetic && !m.creatorDemo;
  const recordIsReal = (m: MatterRecord, actorDemo: boolean): boolean =>
    matterIsReal(m) && !actorDemo;
  const inScope = (real: boolean): boolean => (scope === "pilot") === real;

  const training = records.matters.filter((m) => m.training);
  const matters = new Map<string, MatterRecord>();
  for (const m of records.matters) if (!m.training) matters.set(m.matterId, m);
  const known = (matterId: string): MatterRecord | undefined => matters.get(matterId);

  const runsByMatter = groupBy(
    records.runs.filter((r) => matters.has(r.matterId)),
    (r) => r.matterId,
  );
  const runById = new Map<string, RunRecord>();
  for (const run of records.runs) if (matters.has(run.matterId)) runById.set(run.runId, run);
  const firstRun = new Map<string, RunRecord>();
  for (const [matterId, runs] of runsByMatter) {
    const first = earliest(runs);
    if (first !== undefined) firstRun.set(matterId, first);
  }

  /** A matter is in this scope by its first run's starter when it has a run, else by its creator. */
  const matterInScope = (m: MatterRecord): boolean => {
    const first = firstRun.get(m.matterId);
    return inScope(first === undefined ? matterIsReal(m) : recordIsReal(m, first.startedByDemo));
  };
  const scopeMatters = [...matters.values()].filter(matterInScope);

  // -- the matters measured (M), by position against the window ---------------------------------
  const position = (m: MatterRecord): WindowPosition | "no_run" => {
    const first = firstRun.get(m.matterId);
    return first === undefined ? "no_run" : windowPosition(calendar, first.startedAt);
  };
  const measured = scopeMatters.filter((m) => position(m) === "within");
  const phaseOfMatter = (m: MatterRecord): Phase => {
    const first = firstRun.get(m.matterId);
    const week = first === undefined ? null : pilotWeekOf(calendar, first.startedAt);
    if (week === null) throw new RangeError("a measured matter has a first run inside the window");
    return phaseOfWeek(week);
  };
  const measuredByPhase = new Map<Phase, MatterRecord[]>(PHASES.map((p) => [p, []]));
  for (const m of measured) measuredByPhase.get(phaseOfMatter(m))?.push(m);

  // -- why a row can have no data -----------------------------------------------------------------
  const noDataReason = (): NoDataReason => {
    if (calendar === null) return "no_calendar";
    if (matters.size > 0 && scopeMatters.length === 0) return "all_excluded";
    return "no_denominator";
  };

  const ratioRow = (
    measure: MeasureId,
    breakdown: BreakdownId,
    key: string,
    unit: Unit,
    numerator: number,
    denominator: number,
  ): MeasureRow =>
    denominator === 0
      ? {
          measure,
          breakdown,
          key,
          unit,
          numerator: 0,
          denominator: 0,
          value: null,
          min: null,
          max: null,
          status: "no_data",
          reason: noDataReason(),
        }
      : {
          measure,
          breakdown,
          key,
          unit,
          numerator,
          denominator,
          value: ratioValue(numerator, denominator),
          min: null,
          max: null,
          status: "value",
          reason: null,
        };

  /**
   * A median row over the sorted values. `toValue` receives twice the median (so that it stays a
   * whole number) and `toBound` a minimum or a maximum; both return the unit of the row. With no
   * values the row has no data.
   */
  const medianRow = (
    measure: MeasureId,
    breakdown: BreakdownId,
    key: string,
    unit: Unit,
    sorted: readonly number[],
    toValue: (doubled: number) => number,
    toBound: (raw: number) => number,
  ): MeasureRow => {
    if (sorted.length === 0) {
      return {
        measure,
        breakdown,
        key,
        unit,
        numerator: null,
        denominator: 0,
        value: null,
        min: null,
        max: null,
        status: "no_data",
        reason: noDataReason(),
      };
    }
    return {
      measure,
      breakdown,
      key,
      unit,
      numerator: null,
      denominator: sorted.length,
      value: toValue(doubleMedian(sorted)),
      min: toBound(sorted[0] ?? 0),
      max: toBound(sorted[sorted.length - 1] ?? 0),
      status: "value",
      reason: null,
    };
  };

  // -- lookups for the run-based measures ------------------------------------------------------
  const memberRole = new Map<string, MemberRecord["role"]>();
  for (const member of records.members) {
    memberRole.set(`${member.matterId}\u0000${member.userId}`, member.role);
  }
  const membersByMatter = groupBy(records.members, (m) => m.matterId);
  const memosByMatter = groupBy(records.memos, (m) => m.matterId);
  const reportsByMatter = groupBy(records.missedIssues, (r) => r.matterId);
  const findingsByRun = groupBy(records.findings, (f) => f.runId);

  for (const rating of records.ratings) {
    if (!Number.isInteger(rating.rating) || rating.rating < 1 || rating.rating > 5) {
      throw new RangeError("a rating is a whole number from 1 to 5");
    }
  }
  // The rating in force of each (matter, person): the later one in the list, which is oldest first.
  const ratingInForce = new Map<string, RatingRecord>();
  for (const rating of records.ratings) {
    ratingInForce.set(`${rating.matterId}\u0000${rating.userId}`, rating);
  }

  // Current decisions, one per finding (a second one for a finding replaces the first).
  const decisionOf = new Map<string, DecisionRecord>();
  for (const decision of records.decisions) decisionOf.set(decision.findingId, decision);

  const runSet = (set: readonly MatterRecord[]): RunSet => {
    const exported = new Set<string>();
    for (const m of set) {
      const memos = memosByMatter.get(m.matterId) ?? [];
      if (memos.some((memo) => inScope(recordIsReal(m, memo.exportedByDemo)))) {
        exported.add(m.matterId);
      }
    }

    const findings: FindingRecord[] = [];
    for (const m of set) {
      for (const run of runsByMatter.get(m.matterId) ?? []) {
        if (!FINISHED.has(run.status)) continue;
        for (const finding of findingsByRun.get(run.runId) ?? []) findings.push(finding);
      }
    }
    const decisions = new Map<string, DecisionRecord>();
    for (const finding of findings) {
      const decision = decisionOf.get(finding.findingId);
      const m = known(runById.get(finding.runId)?.matterId ?? "");
      if (
        decision !== undefined &&
        m !== undefined &&
        inScope(recordIsReal(m, decision.reviewerDemo))
      ) {
        decisions.set(finding.findingId, decision);
      }
    }

    const reports: MissedIssueRecord[] = [];
    for (const matterId of exported) {
      const m = known(matterId);
      if (m === undefined) continue;
      for (const report of reportsByMatter.get(matterId) ?? []) {
        if (inScope(recordIsReal(m, report.userDemo))) reports.push(report);
      }
    }

    const ratings: RatingRecord[] = [];
    let viewerRatings = 0;
    for (const rating of ratingInForce.values()) {
      const m = known(rating.matterId);
      if (m === undefined || !exported.has(rating.matterId)) continue;
      if (!inScope(recordIsReal(m, rating.userDemo))) continue;
      const role = memberRole.get(`${rating.matterId}\u0000${rating.userId}`);
      if (role === "associate" || role === "reviewer") ratings.push(rating);
      else viewerRatings += 1;
    }

    const raters = new Set<string>();
    for (const matterId of exported) {
      const m = known(matterId);
      if (m === undefined) continue;
      for (const member of membersByMatter.get(matterId) ?? []) {
        if (
          (member.role === "associate" || member.role === "reviewer") &&
          inScope(recordIsReal(m, member.userDemo))
        ) {
          raters.add(`${member.matterId}\u0000${member.userId}`);
        }
      }
    }

    return {
      matters: set.length,
      exported,
      findings,
      decisions,
      reports,
      ratings,
      viewerRatings,
      eligible: raters.size,
    };
  };

  const overall = runSet(measured);
  const phaseSets = new Map<Phase, RunSet>(
    PHASES.map((p) => [p, runSet(measuredByPhase.get(p) ?? [])]),
  );
  const slices: readonly [BreakdownId, string, RunSet][] = [
    ["overall", "", overall],
    ...PHASES.map((p): [BreakdownId, string, RunSet] => ["phase", p, phaseSets.get(p) ?? overall]),
  ];

  const rows: MeasureRow[] = [];
  const eachSlice = (
    make: (set: RunSet, breakdown: BreakdownId, key: string) => MeasureRow,
  ): void => {
    for (const [breakdown, key, set] of slices) rows.push(make(set, breakdown, key));
  };

  const corrections = (set: RunSet): DecisionRecord[] =>
    [...set.decisions.values()].filter((d) => d.decision === "edit" || d.decision === "reject");

  // completion: matters exported over matters with a run started
  eachSlice((set, b, k) => ratioRow("completion", b, k, "ratio", set.exported.size, set.matters));

  // repeat usage: not split by phase, it is defined across weeks
  const rosterIds = new Set<string>();
  for (const participant of records.participants) {
    if (inScope(!participant.demo)) rosterIds.add(participant.userId);
  }
  const weeksOf = new Map<string, Set<number>>();
  for (const m of measured) {
    const first = firstRun.get(m.matterId);
    const week = first === undefined ? null : pilotWeekOf(calendar, first.startedAt);
    if (first === undefined || week === null) continue;
    const weeks = weeksOf.get(first.startedBy) ?? new Set<number>();
    weeks.add(week);
    weeksOf.set(first.startedBy, weeks);
  }
  let repeaters = 0;
  for (const userId of rosterIds) if ((weeksOf.get(userId)?.size ?? 0) >= 2) repeaters += 1;
  let startersNotOnRoster = 0;
  for (const userId of weeksOf.keys()) if (!rosterIds.has(userId)) startersNotOnRoster += 1;
  // With no calendar no week can be told from another, so there is no denominator to give.
  rows.push(
    ratioRow(
      "repeat_usage",
      "overall",
      "",
      "ratio",
      repeaters,
      calendar === null ? 0 : rosterIds.size,
    ),
  );

  // correction rate: edits and rejects over decided findings
  eachSlice((set, b, k) =>
    ratioRow("correction_rate", b, k, "ratio", corrections(set).length, set.decisions.size),
  );
  {
    const codeCount = new Map<string, number>();
    for (const decision of corrections(overall)) {
      const code = decision.reasonCode ?? NOT_RECORDED_KEY;
      codeCount.set(code, (codeCount.get(code) ?? 0) + 1);
    }
    const listed = [...new Set(options.reasonCodes ?? [])];
    const seen = [...codeCount.keys()]
      .filter((code) => code !== NOT_RECORDED_KEY && !listed.includes(code))
      .sort();
    for (const code of [...listed, ...seen]) {
      rows.push(
        ratioRow(
          "correction_rate",
          "reason_code",
          code,
          "ratio",
          codeCount.get(code) ?? 0,
          overall.decisions.size,
        ),
      );
    }
    // Only when positive: a decision made before reason codes existed.
    const unrecorded = codeCount.get(NOT_RECORDED_KEY) ?? 0;
    if (unrecorded > 0) {
      rows.push(
        ratioRow(
          "correction_rate",
          "reason_code",
          NOT_RECORDED_KEY,
          "ratio",
          unrecorded,
          overall.decisions.size,
        ),
      );
    }
  }

  // accepted or minor (CUT LINE: the one measure beyond docs/parol/08's table; criterion A3 reads it)
  const acceptedOrMinor = (set: RunSet): number =>
    [...set.decisions.values()].filter(
      (d) => d.decision === "accept" || (d.decision === "edit" && d.minorEdit === true),
    ).length;
  eachSlice((set, b, k) =>
    ratioRow("accepted_or_minor", b, k, "ratio", acceptedOrMinor(set), set.decisions.size),
  );

  // missed-issue rate: reports per exported matter (a count per matter, so it can exceed 1)
  eachSlice((set, b, k) =>
    ratioRow(
      "missed_issue_rate",
      b,
      k,
      "reports_per_matter",
      set.reports.length,
      set.exported.size,
    ),
  );
  {
    const versions = new Set<string>();
    for (const matterId of overall.exported) {
      const version = known(matterId)?.playbookVersionId;
      if (version !== null && version !== undefined) versions.add(version);
    }
    const keys: string[] = [];
    for (const version of [...versions].sort()) {
      for (const playbook of records.playbooks) {
        if (playbook.versionId !== version) continue;
        for (const key of playbook.ruleKeys) if (!keys.includes(key)) keys.push(key);
      }
    }
    const reportCount = new Map<string, number>();
    for (const report of overall.reports) {
      const key = report.ruleKey ?? NOT_COVERED_KEY;
      reportCount.set(key, (reportCount.get(key) ?? 0) + 1);
    }
    const extra = [...reportCount.keys()]
      .filter((key) => key !== NOT_COVERED_KEY && !keys.includes(key))
      .sort();
    for (const key of [...keys, ...extra, NOT_COVERED_KEY]) {
      rows.push(
        ratioRow(
          "missed_issue_rate",
          "rule",
          key,
          "reports_per_matter",
          reportCount.get(key) ?? 0,
          overall.exported.size,
        ),
      );
    }
  }

  // escalation by the system, and by reviewers, separately
  eachSlice((set, b, k) =>
    ratioRow(
      "escalation_system",
      b,
      k,
      "ratio",
      set.findings.filter((f) => f.escalatedBySystem).length,
      set.findings.length,
    ),
  );
  const escalatedByReviewers = (set: RunSet): number =>
    set.findings.filter((f) => set.decisions.get(f.findingId)?.decision === "escalate").length;
  rows.push(
    ratioRow(
      "escalation_reviewer",
      "overall",
      "",
      "ratio",
      escalatedByReviewers(overall),
      overall.findings.length,
    ),
    // A finding nobody has decided cannot have been escalated by a reviewer.
    ratioRow(
      "escalation_reviewer",
      "of_decided",
      "decided",
      "ratio",
      escalatedByReviewers(overall),
      overall.decisions.size,
    ),
  );
  for (const p of PHASES) {
    const set = phaseSets.get(p) ?? overall;
    rows.push(
      ratioRow(
        "escalation_reviewer",
        "phase",
        p,
        "ratio",
        escalatedByReviewers(set),
        set.findings.length,
      ),
    );
  }

  // satisfaction: the median rating with its n, minimum and maximum, then the distribution
  const ratingMedian = (set: RunSet, b: BreakdownId, k: string): MeasureRow =>
    medianRow(
      "satisfaction_rating",
      b,
      k,
      "rating",
      set.ratings.map((r) => r.rating).sort((x, y) => x - y),
      (doubled) => doubled / 2,
      (raw) => raw,
    );
  eachSlice(ratingMedian);
  for (let level = 1; level <= 5; level += 1) {
    rows.push(
      ratioRow(
        "satisfaction_rating",
        "distribution",
        String(level),
        "ratio",
        overall.ratings.filter((r) => r.rating === level).length,
        overall.ratings.length,
      ),
    );
  }
  eachSlice((set, b, k) =>
    ratioRow("satisfaction_response", b, k, "ratio", set.ratings.length, set.eligible),
  );

  // active time: medians of minutes per phase and series, with n, minimum and maximum
  const timeEntries = { counted: 0, open: 0, outside: 0 };
  const timed = new Map<
    string,
    { phase: Phase; associate: number | null; reviewer: number | null }
  >();
  for (const entry of records.timeEntries) {
    const m = known(entry.matterId);
    if (m === undefined || !inScope(recordIsReal(m, entry.userDemo))) continue;
    if (entry.stoppedAt === null) {
      timeEntries.open += 1;
      continue;
    }
    const week = pilotWeekOf(calendar, entry.startedAt);
    if (week === null) {
      timeEntries.outside += 1;
      continue;
    }
    const milliseconds = parseInstant(entry.stoppedAt) - parseInstant(entry.startedAt);
    if (milliseconds < 0) throw new RangeError("a timer stops no earlier than it starts");
    const seconds = Math.floor(milliseconds / 1000);
    timeEntries.counted += 1;
    const phase = phaseOfWeek(week);
    const slot = `${entry.matterId}\u0000${phase}`;
    const sums = timed.get(slot) ?? { phase, associate: null, reviewer: null };
    sums[entry.role] = (sums[entry.role] ?? 0) + seconds;
    timed.set(slot, sums);
  }
  for (const phase of PHASES) {
    const inPhase = [...timed.values()].filter((t) => t.phase === phase);
    const series: Record<TimeSeries, number[]> = { associate: [], reviewer: [], combined: [] };
    for (const t of inPhase) {
      if (t.associate !== null) series.associate.push(t.associate);
      if (t.reviewer !== null) series.reviewer.push(t.reviewer);
      if (t.associate !== null && t.reviewer !== null)
        series.combined.push(t.associate + t.reviewer);
    }
    for (const name of TIME_SERIES) {
      rows.push(
        medianRow(
          "active_time",
          "series",
          `${phase}:${name}`,
          "minutes",
          series[name].sort((x, y) => x - y),
          minutesFromDoubleSeconds,
          (seconds) => minutesFromDoubleSeconds(2 * seconds),
        ),
      );
    }
  }

  // shadow-mode agreement: reference-list issues that Parol flagged or escalated
  const measuredIds = new Set(measured.map((m) => m.matterId));
  const latestFinished = new Map<string, Map<string, FindingRecord>>();
  for (const m of measured) {
    const run = latest((runsByMatter.get(m.matterId) ?? []).filter((r) => FINISHED.has(r.status)));
    if (run === undefined) continue;
    latestFinished.set(
      m.matterId,
      new Map((findingsByRun.get(run.runId) ?? []).map((f) => [f.ruleKey, f])),
    );
  }
  let compared = 0;
  let notCompared = 0;
  const agreement = new Map<string, { agreed: number; total: number }>(
    PILOT_SEVERITIES.map((s) => [s, { agreed: 0, total: 0 }]),
  );
  for (const issue of records.referenceIssues) {
    const m = known(issue.matterId);
    if (m === undefined || !inScope(recordIsReal(m, issue.recordedByDemo))) continue;
    const findings = measuredIds.has(issue.matterId)
      ? latestFinished.get(issue.matterId)
      : undefined;
    if (findings === undefined) {
      notCompared += 1;
      continue;
    }
    compared += 1;
    const finding = issue.ruleKey === null ? undefined : findings.get(issue.ruleKey);
    const agreed =
      finding !== undefined &&
      (finding.status === "deviation" || finding.status === "missing" || finding.escalatedBySystem);
    const bucket = agreement.get(issue.severity);
    if (bucket !== undefined) {
      bucket.total += 1;
      if (agreed) bucket.agreed += 1;
    }
  }
  const allAgreed = [...agreement.values()].reduce((sum, b) => sum + b.agreed, 0);
  rows.push(ratioRow("shadow_agreement", "overall", "", "ratio", allAgreed, compared));
  for (const severity of PILOT_SEVERITIES) {
    const bucket = agreement.get(severity) ?? { agreed: 0, total: 0 };
    rows.push(
      ratioRow("shadow_agreement", "severity", severity, "ratio", bucket.agreed, bucket.total),
    );
  }

  // -- the population table -------------------------------------------------------------------
  const all = [...matters.values()];
  let reportsInScope = 0;
  for (const report of records.missedIssues) {
    const m = known(report.matterId);
    if (m !== undefined && inScope(recordIsReal(m, report.userDemo))) reportsInScope += 1;
  }
  let staleInScope = 0;
  for (const stale of records.staleDecisions) {
    const m = known(stale.matterId);
    if (m !== undefined && inScope(recordIsReal(m, stale.reviewerDemo))) staleInScope += 1;
  }
  const pilotEnd = calendar === null ? null : parseInstant(windowEnd(calendar.startDate));
  const auditInScope = records.auditMatters.filter(
    (a) => !a.training && inScope(!a.synthetic && !a.creatorDemo),
  );
  const count: Record<PopulationCode, number> = {
    matters_total: records.matters.length,
    matters_training: training.length,
    matters_synthetic: all.filter((m) => m.synthetic).length,
    matters_by_demo_identity: all.filter((m) => !m.synthetic && m.creatorDemo).length,
    matters_real: all.filter(matterIsReal).length,
    matters_in_scope: scopeMatters.length,
    matters_run_in_window: measured.length,
    matters_run_before_window: scopeMatters.filter((m) => position(m) === "before").length,
    matters_run_after_window: scopeMatters.filter((m) => position(m) === "after").length,
    matters_no_run: scopeMatters.filter((m) => position(m) === "no_run").length,
    matters_exported: overall.exported.size,
    findings: overall.findings.length,
    findings_decided: overall.decisions.size,
    decisions_no_longer_current: staleInScope,
    missed_reports_counted: overall.reports.length,
    missed_reports_outside: reportsInScope - overall.reports.length,
    ratings_counted: overall.ratings.length,
    ratings_by_viewers: overall.viewerRatings,
    raters_eligible: overall.eligible,
    time_entries_counted: timeEntries.counted,
    time_entries_open: timeEntries.open,
    time_entries_outside_window: timeEntries.outside,
    reference_issues_compared: compared,
    reference_issues_not_compared: notCompared,
    participants_trained: rosterIds.size,
    starters_not_on_roster: startersNotOnRoster,
    matters_expiring_before_pilot_end:
      pilotEnd === null
        ? 0
        : scopeMatters.filter((m) => parseInstant(m.retainUntil) < pilotEnd).length,
    audit_matters_created: auditInScope.length,
    audit_matters_deleted: auditInScope.filter((a) => a.deleted).length,
  };
  const population: PopulationRow[] = POPULATION_CODES.map((code) => ({
    code,
    count: count[code],
  }));

  return {
    scope,
    asOf: options.asOf,
    calendar:
      calendar === null
        ? null
        : { startDate: calendar.startDate, endDate: calendarEnd(calendar.startDate) },
    population,
    rows,
  };
}
