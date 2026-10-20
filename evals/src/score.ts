import type { Severity } from "@clausewise/playbook";
import type { ReviewReport, RuleStatus } from "@clausewise/review";
import { EXPECTED_STATUSES, type ExpectedStatus, type Fixture } from "./fixtures.js";
import type { IntegrityResult } from "./integrity.js";
import type { UsageTotals } from "./usage.js";

export const GOT_STATUSES: readonly RuleStatus[] = [...EXPECTED_STATUSES, "error"];

/** One review of one fixture, with everything the harness learned about it. */
export interface RunRecord {
  fixture: string;
  /** 1-based. */
  run: number;
  report: ReviewReport;
  integrity: IntegrityResult;
  /** Model calls the pipeline made. */
  calls: number;
  /** Null when the provider does not report usage. */
  usage: UsageTotals | null;
}

export interface RuleScore {
  fixture: string;
  ruleId: string;
  severity: Severity;
  expected: ExpectedStatus;
  /** The status of each run, in run order. */
  got: RuleStatus[];
  matches: number;
  /** The share of runs whose status was the expected one. */
  accuracy: number;
  /** The most common status. A tie goes to the one listed first in GOT_STATUSES. */
  modal: RuleStatus;
  /** The share of runs that gave the modal status. */
  agreement: number;
}

export type Confusion = Record<ExpectedStatus, Record<RuleStatus, number>>;

/**
 * Deviation and missing count as flagged. A rule that errored is not flagged, so an error where a
 * flag was expected is a miss. That is deliberate: a rule that was not checked found nothing.
 */
export interface FlagScore {
  truePositives: number;
  /** Flagged where compliant or not applicable was expected. */
  falseAlarms: number;
  /** Not flagged where a deviation or a missing clause was expected. */
  misses: number;
  /** Checked and not flagged where compliant or not applicable was expected. */
  trueNegatives: number;
  /** Not flagged where nothing was expected to be, because the rule errored and was not checked. */
  unchecked: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface EditScore {
  /** Results with status deviation, the only ones that can carry an edit. */
  deviations: number;
  proposed: number;
  applied: number;
  commentOnly: number;
  /** Why proposed edits became comments, with the digits blurred so equal causes group. */
  fallbackReasons: { reason: string; count: number }[];
}

export interface Stability {
  /** The most runs any fixture got. */
  runs: number;
  meanAgreement: number | null;
  /** Rules whose runs did not all give the same status, least stable first. */
  unstable: RuleScore[];
}

export interface Score {
  total: number;
  correct: number;
  accuracy: number | null;
  errored: number;
  /** Why rules errored, as the pipeline words it, most common first. */
  errorReasons: { reason: string; count: number }[];
  rules: RuleScore[];
  confusion: Confusion;
  flag: FlagScore;
  edits: EditScore;
  /** Runs whose integrity check failed. */
  integrityFailures: { fixture: string; run: number; problems: string[] }[];
  stability: Stability | null;
}

const ratio = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

function emptyConfusion(): Confusion {
  const row = (): Record<RuleStatus, number> => ({
    compliant: 0,
    deviation: 0,
    missing: 0,
    not_applicable: 0,
    error: 0,
  });
  return {
    compliant: row(),
    deviation: row(),
    missing: row(),
    not_applicable: row(),
  };
}

const isFlag = (status: RuleStatus): boolean => status === "deviation" || status === "missing";

function modalOf(statuses: readonly RuleStatus[]): { status: RuleStatus; count: number } {
  let best: { status: RuleStatus; count: number } = { status: "error", count: 0 };
  for (const status of GOT_STATUSES) {
    const count = statuses.filter((got) => got === status).length;
    if (count > best.count) best = { status, count };
  }
  return best;
}

// Reasons are written by the pipeline and never quote the document. Blurring the numbers makes
// "occurs 2 times" and "occurs 3 times" one cause.
const blur = (reason: string): string => reason.replace(/\d+/g, "N").replace(/\s+/g, " ").trim();

function byCount(counts: ReadonlyMap<string, number>): { reason: string; count: number }[] {
  return [...counts]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

export function computeScore(fixtures: readonly Fixture[], records: readonly RunRecord[]): Score {
  const confusion = emptyConfusion();
  const rules: RuleScore[] = [];
  let errored = 0;

  for (const fixture of fixtures) {
    const own = records.filter((record) => record.fixture === fixture.name);
    if (own.length === 0) continue;
    for (const rule of fixture.playbook.rules) {
      const expected = fixture.expected[rule.id];
      if (expected === undefined) continue;
      const got: RuleStatus[] = own.map(
        (record) =>
          record.report.results.find((result) => result.ruleId === rule.id)?.status ?? "error",
      );
      for (const status of got) {
        confusion[expected][status] += 1;
        if (status === "error") errored += 1;
      }
      const matches = got.filter((status) => status === expected).length;
      const modal = modalOf(got);
      rules.push({
        fixture: fixture.name,
        ruleId: rule.id,
        severity: rule.severity,
        expected,
        got,
        matches,
        accuracy: matches / got.length,
        modal: modal.status,
        agreement: modal.count / got.length,
      });
    }
  }

  const total = rules.reduce((sum, rule) => sum + rule.got.length, 0);
  const correct = rules.reduce((sum, rule) => sum + rule.matches, 0);

  let truePositives = 0;
  let falseAlarms = 0;
  let misses = 0;
  let trueNegatives = 0;
  let unchecked = 0;
  for (const expected of EXPECTED_STATUSES) {
    for (const got of GOT_STATUSES) {
      const count = confusion[expected][got];
      if (isFlag(expected) && isFlag(got)) truePositives += count;
      else if (isFlag(expected)) misses += count;
      else if (isFlag(got)) falseAlarms += count;
      else if (got === "error") unchecked += count;
      else trueNegatives += count;
    }
  }
  const precision = ratio(truePositives, truePositives + falseAlarms);
  const recall = ratio(truePositives, truePositives + misses);
  const f1 = ratio(2 * truePositives, 2 * truePositives + falseAlarms + misses);

  const reasons = new Map<string, number>();
  const errors = new Map<string, number>();
  let deviations = 0;
  let applied = 0;
  let commentOnly = 0;
  for (const record of records) {
    for (const result of record.report.results) {
      if (result.status === "error") {
        const reason = result.error ?? "The rule was not checked.";
        errors.set(reason, (errors.get(reason) ?? 0) + 1);
      }
      if (result.status !== "deviation") continue;
      deviations += 1;
      if (result.edit.kind === "applied") applied += 1;
      if (result.edit.kind === "comment-only") {
        commentOnly += 1;
        const reason = blur(result.edit.reason);
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
    }
  }

  const unstable = rules
    .filter((rule) => rule.agreement < 1)
    .sort((a, b) => a.agreement - b.agreement);
  const longest = Math.max(0, ...rules.map((rule) => rule.got.length));

  return {
    total,
    correct,
    accuracy: ratio(correct, total),
    errored,
    errorReasons: byCount(errors),
    rules,
    confusion,
    flag: { truePositives, falseAlarms, misses, trueNegatives, unchecked, precision, recall, f1 },
    edits: {
      deviations,
      proposed: applied + commentOnly,
      applied,
      commentOnly,
      fallbackReasons: byCount(reasons),
    },
    integrityFailures: records
      .filter((record) => !record.integrity.ok)
      .map((record) => ({
        fixture: record.fixture,
        run: record.run,
        problems: record.integrity.problems,
      })),
    stability:
      longest < 2
        ? null
        : {
            runs: longest,
            meanAgreement: ratio(
              rules.reduce((sum, rule) => sum + rule.agreement, 0),
              rules.length,
            ),
            unstable,
          },
  };
}
