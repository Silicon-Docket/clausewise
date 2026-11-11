/**
 * Fixture F1: the records of a pilot that no database of this build can hold (people who are not
 * demonstration identities), written by hand, with the answer worked out by hand in
 * `compute.test.ts`. Nothing in the expected values comes from the code under test.
 *
 * Calendar start 2026-01-05 (a Monday). Day numbers count from it, and the table below is the only
 * place a day number becomes a date:
 *
 *   day -1 = 2026-01-04    day 14 = 2026-01-19    day 22 = 2026-01-27
 *   day  2 = 2026-01-07    day 15 = 2026-01-20    day 23 = 2026-01-28
 *   day  3 = 2026-01-08    day 16 = 2026-01-21    day 24 = 2026-01-29
 *   day  7 = 2026-01-12    day 21 = 2026-01-26    day 40 = 2026-02-14
 *   day  8 = 2026-01-13
 *
 * Weeks: 1 = days 0 to 6, 2 = days 7 to 13, 3 = days 14 to 20, 4 = days 21 to 27, 5 = days 28 to 34.
 * Phases: week 1 baseline, week 2 shadow, weeks 3 to 5 assisted.
 *
 * People: associates `a1` and `a2`, reviewer `r1`, viewer `v1` (all real); `s1` is a demonstration
 * identity. The roster is `a1`, `a2` (real) and `s1` (demo).
 *
 * Matters (playbook `pb-1` of eight rules unless said):
 *   M1  real, creator a1, members a1 r1 v1. First run day 14 by a1. 3 findings escalated by the
 *       system. 8 current decisions by r1: 5 accept, 1 edit (wrong_status, not minor), 1 reject
 *       (wrong_evidence), 1 escalate; 2 stale decisions. Memo. Ratings a1 4, r1 5, v1 3. Reports:
 *       dur-1 and one that no rule covers.
 *   M2  real, a1, members a1 r1. First run day 21 by a1. 1 finding escalated. 8 accepts. No memo.
 *       One report (pds-1).
 *   M3  real, a2, members a2 r1. First run day 7 by a2. dur-1 is a deviation, pds-1 compliant, none
 *       escalated, none decided. Reference list by r1 (day 1): dur-1 high, pds-1 medium, one high
 *       issue that no rule covers.
 *   M4  real, a2. First run day 40 (after the window). 8 findings, none decided.
 *   M5  real, a2, members a2 r1. No run. Reference list by r1: one pds-2 low issue.
 *   M6  synthetic, creator a1, members a1 r1. First run day 14 by a1. 2 findings escalated. 8
 *       accepts by r1; 1 stale decision. Memo. Rating a1 5.
 *   M7  not synthetic, creator s1 (demo). First run day 15 by s1. 8 findings, none decided.
 *   M8  a TRAINING matter that looks real in every other way (not synthetic, creator a1), with a
 *       run in the window, decisions, a memo, a rating, a report, a timer and a reference issue.
 *       It is in neither scope; if the code ignored the flag these records would move the answer.
 *
 * Audit log: M1 to M8 and two matters that were deleted (D1 real, D2 synthetic).
 */
import type {
  DecisionRecord,
  FindingRecord,
  PilotRecords,
  PilotSeverity,
  TimeEntryRecord,
} from "../../src/pilot/types.js";
import type { ReviewDecision, Status } from "../../src/contracts.js";

export const RULES = [
  "pty-1",
  "def-1",
  "exc-1",
  "pds-1",
  "pds-2",
  "dur-1",
  "ret-1",
  "gov-1",
] as const;
type Rule = (typeof RULES)[number];

const SEVERITY: Record<Rule, PilotSeverity> = {
  "pty-1": "high",
  "def-1": "medium",
  "exc-1": "high",
  "pds-1": "medium",
  "pds-2": "low",
  "dur-1": "high",
  "ret-1": "low",
  "gov-1": "medium",
};

/** The only place a day number becomes a date (see the table above). */
const DATE: Record<number, string> = {
  [-1]: "2026-01-04",
  1: "2026-01-06",
  2: "2026-01-07",
  3: "2026-01-08",
  7: "2026-01-12",
  8: "2026-01-13",
  14: "2026-01-19",
  15: "2026-01-20",
  16: "2026-01-21",
  21: "2026-01-26",
  22: "2026-01-27",
  23: "2026-01-28",
  24: "2026-01-29",
  40: "2026-02-14",
};
export const at = (day: number, time: string): string => {
  const date = DATE[day];
  if (date === undefined) throw new Error(`fixture F1 has no date for day ${day}`);
  return `${date}T${time}.000Z`;
};

const finding = (
  matterId: string,
  runId: string,
  rule: Rule,
  status: Status,
  escalatedBySystem = false,
): FindingRecord => ({
  findingId: `${matterId}-${rule}`,
  runId,
  matterId,
  ruleKey: rule,
  severity: SEVERITY[rule],
  status,
  escalatedBySystem,
});

/** Eight findings, one per rule, all `compliant` except the overrides. */
const eight = (
  matterId: string,
  runId: string,
  overrides: Partial<Record<Rule, [Status, boolean]>> = {},
): FindingRecord[] =>
  RULES.map((rule) => {
    const [status, escalated] = overrides[rule] ?? ["compliant", false];
    return finding(matterId, runId, rule, status, escalated);
  });

const decision = (
  matterId: string,
  rule: Rule,
  kind: ReviewDecision,
  reasonCode: string | null = null,
  minorEdit: boolean | null = null,
  reviewerDemo = false,
): DecisionRecord => ({
  findingId: `${matterId}-${rule}`,
  matterId,
  reviewerDemo,
  decision: kind,
  reasonCode,
  minorEdit,
});

const accepts = (matterId: string): DecisionRecord[] =>
  RULES.map((rule) => decision(matterId, rule, "accept"));

const entry = (
  matterId: string,
  userId: string,
  role: "associate" | "reviewer",
  day: number,
  startTime: string,
  stopTime: string | null,
  userDemo = false,
): TimeEntryRecord => ({
  matterId,
  userId,
  userDemo,
  role,
  startedAt: at(day, startTime),
  stoppedAt: stopTime === null ? null : at(day, stopTime),
});

/** A fresh copy every call, so a test may change it. */
export function f1Records(): PilotRecords {
  return {
    calendar: { startDate: "2026-01-05" },
    matters: [
      {
        matterId: "M1",
        synthetic: false,
        creatorDemo: false,
        training: false,
        playbookVersionId: "pb-1",
        retainUntil: "2026-02-03T09:00:00.000Z",
      },
      {
        matterId: "M2",
        synthetic: false,
        creatorDemo: false,
        training: false,
        playbookVersionId: "pb-1",
        retainUntil: "2026-02-08T23:59:59.999Z",
      },
      {
        matterId: "M3",
        synthetic: false,
        creatorDemo: false,
        training: false,
        playbookVersionId: "pb-1",
        retainUntil: "2026-02-09T00:00:00.000Z",
      },
      {
        matterId: "M4",
        synthetic: false,
        creatorDemo: false,
        training: false,
        playbookVersionId: "pb-1",
        retainUntil: "2026-03-20T09:00:00.000Z",
      },
      {
        matterId: "M5",
        synthetic: false,
        creatorDemo: false,
        training: false,
        playbookVersionId: "pb-1",
        retainUntil: "2026-03-20T09:00:00.000Z",
      },
      {
        matterId: "M6",
        synthetic: true,
        creatorDemo: false,
        training: false,
        playbookVersionId: "pb-1",
        retainUntil: "2026-01-31T09:00:00.000Z",
      },
      {
        matterId: "M7",
        synthetic: false,
        creatorDemo: true,
        training: false,
        playbookVersionId: "pb-1",
        retainUntil: "2026-03-20T09:00:00.000Z",
      },
      {
        matterId: "M8",
        synthetic: false,
        creatorDemo: false,
        training: true,
        playbookVersionId: "pb-1",
        retainUntil: "2026-01-31T09:00:00.000Z",
      },
    ],
    members: [
      { matterId: "M1", userId: "a1", userDemo: false, role: "associate" },
      { matterId: "M1", userId: "r1", userDemo: false, role: "reviewer" },
      { matterId: "M1", userId: "v1", userDemo: false, role: "viewer" },
      { matterId: "M2", userId: "a1", userDemo: false, role: "associate" },
      { matterId: "M2", userId: "r1", userDemo: false, role: "reviewer" },
      { matterId: "M3", userId: "a2", userDemo: false, role: "associate" },
      { matterId: "M3", userId: "r1", userDemo: false, role: "reviewer" },
      { matterId: "M4", userId: "a2", userDemo: false, role: "associate" },
      { matterId: "M5", userId: "a2", userDemo: false, role: "associate" },
      { matterId: "M5", userId: "r1", userDemo: false, role: "reviewer" },
      { matterId: "M6", userId: "a1", userDemo: false, role: "associate" },
      { matterId: "M6", userId: "r1", userDemo: false, role: "reviewer" },
      { matterId: "M7", userId: "s1", userDemo: true, role: "associate" },
      { matterId: "M8", userId: "a1", userDemo: false, role: "associate" },
      { matterId: "M8", userId: "r1", userDemo: false, role: "reviewer" },
    ],
    playbooks: [{ versionId: "pb-1", ruleKeys: [...RULES] }],
    runs: [
      {
        runId: "run-1",
        matterId: "M1",
        startedBy: "a1",
        startedByDemo: false,
        startedAt: at(14, "09:00:00"),
        status: "succeeded",
      },
      {
        runId: "run-2",
        matterId: "M2",
        startedBy: "a1",
        startedByDemo: false,
        startedAt: at(21, "09:00:00"),
        status: "succeeded",
      },
      {
        runId: "run-3",
        matterId: "M3",
        startedBy: "a2",
        startedByDemo: false,
        startedAt: at(7, "09:00:00"),
        status: "succeeded",
      },
      {
        runId: "run-4",
        matterId: "M4",
        startedBy: "a2",
        startedByDemo: false,
        startedAt: at(40, "09:00:00"),
        status: "succeeded",
      },
      {
        runId: "run-6",
        matterId: "M6",
        startedBy: "a1",
        startedByDemo: false,
        startedAt: at(14, "10:00:00"),
        status: "succeeded",
      },
      {
        runId: "run-7",
        matterId: "M7",
        startedBy: "s1",
        startedByDemo: true,
        startedAt: at(15, "09:00:00"),
        status: "succeeded",
      },
      {
        runId: "run-8",
        matterId: "M8",
        startedBy: "a1",
        startedByDemo: false,
        startedAt: at(14, "11:00:00"),
        status: "succeeded",
      },
    ],
    findings: [
      ...eight("M1", "run-1", {
        "def-1": ["undetermined", true],
        "exc-1": ["deviation", false],
        "pds-2": ["undetermined", true],
        "dur-1": ["deviation", false],
        "gov-1": ["undetermined", true],
      }),
      ...eight("M2", "run-2", { "ret-1": ["undetermined", true] }),
      ...eight("M3", "run-3", {
        "dur-1": ["deviation", false],
        "gov-1": ["not_applicable", false],
      }),
      ...eight("M4", "run-4"),
      ...eight("M6", "run-6", { "def-1": ["undetermined", true], "gov-1": ["undetermined", true] }),
      ...eight("M7", "run-7"),
      ...eight("M8", "run-8", { "def-1": ["undetermined", true], "gov-1": ["undetermined", true] }),
    ],
    decisions: [
      decision("M1", "pty-1", "accept"),
      decision("M1", "def-1", "escalate"),
      decision("M1", "exc-1", "edit", "wrong_status", false),
      decision("M1", "pds-1", "accept"),
      decision("M1", "pds-2", "accept"),
      decision("M1", "dur-1", "reject", "wrong_evidence"),
      decision("M1", "ret-1", "accept"),
      decision("M1", "gov-1", "accept"),
      ...accepts("M2"),
      ...accepts("M6"),
      decision("M8", "pty-1", "edit", "other", false),
      decision("M8", "def-1", "edit", "other", false),
      decision("M8", "exc-1", "reject", "other"),
      decision("M8", "pds-1", "reject", "other"),
    ],
    staleDecisions: [
      { matterId: "M1", reviewerDemo: false },
      { matterId: "M1", reviewerDemo: false },
      { matterId: "M6", reviewerDemo: false },
    ],
    memos: [
      { matterId: "M1", exportedByDemo: false },
      { matterId: "M6", exportedByDemo: false },
      { matterId: "M8", exportedByDemo: false },
    ],
    missedIssues: [
      { matterId: "M1", userDemo: false, ruleKey: "dur-1" },
      { matterId: "M1", userDemo: false, ruleKey: null },
      { matterId: "M2", userDemo: false, ruleKey: "pds-1" },
      { matterId: "M8", userDemo: false, ruleKey: "gov-1" },
    ],
    ratings: [
      { matterId: "M1", userId: "a1", userDemo: false, rating: 4 },
      { matterId: "M1", userId: "r1", userDemo: false, rating: 5 },
      { matterId: "M1", userId: "v1", userDemo: false, rating: 3 },
      { matterId: "M6", userId: "a1", userDemo: false, rating: 5 },
      { matterId: "M8", userId: "a1", userDemo: false, rating: 1 },
    ],
    timeEntries: [
      entry("M5", "a2", "associate", 2, "09:00:00", "09:30:00"), // 1800 s
      entry("M5", "a2", "associate", 2, "10:00:00", "10:15:00"), // 900 s
      entry("M5", "r1", "reviewer", 3, "09:00:00", "09:20:00"), // 1200 s
      entry("M3", "a2", "associate", 8, "09:00:00", "09:40:00"), // 2400 s
      entry("M1", "a1", "associate", 15, "09:00:00", "09:25:00"), // 1500 s
      entry("M1", "r1", "reviewer", 16, "09:00:00", "09:35:00"), // 2100 s
      entry("M2", "a1", "associate", 22, "09:00:00", "09:45:00"), // 2700 s
      entry("M2", "r1", "reviewer", 23, "09:00:00", "09:15:00"), // 900 s
      entry("M2", "a1", "associate", 24, "09:00:00", null), // still running
      entry("M6", "a1", "associate", 15, "11:00:00", "11:10:00"), // 600 s, synthetic matter
      entry("M5", "a2", "associate", -1, "09:00:00", "09:10:00"), // 600 s, before the window
      entry("M8", "a1", "associate", 15, "12:00:00", "12:50:00"), // 3000 s, training matter
    ],
    referenceIssues: [
      { matterId: "M3", ruleKey: "dur-1", severity: "high", recordedByDemo: false },
      { matterId: "M3", ruleKey: "pds-1", severity: "medium", recordedByDemo: false },
      { matterId: "M3", ruleKey: null, severity: "high", recordedByDemo: false },
      { matterId: "M5", ruleKey: "pds-2", severity: "low", recordedByDemo: false },
      { matterId: "M8", ruleKey: "dur-1", severity: "high", recordedByDemo: false },
    ],
    participants: [
      { userId: "a1", demo: false },
      { userId: "a2", demo: false },
      { userId: "s1", demo: true },
    ],
    auditMatters: [
      { matterId: "M1", synthetic: false, creatorDemo: false, training: false, deleted: false },
      { matterId: "M2", synthetic: false, creatorDemo: false, training: false, deleted: false },
      { matterId: "M3", synthetic: false, creatorDemo: false, training: false, deleted: false },
      { matterId: "M4", synthetic: false, creatorDemo: false, training: false, deleted: false },
      { matterId: "M5", synthetic: false, creatorDemo: false, training: false, deleted: false },
      { matterId: "M6", synthetic: true, creatorDemo: false, training: false, deleted: false },
      { matterId: "M7", synthetic: false, creatorDemo: true, training: false, deleted: false },
      { matterId: "M8", synthetic: false, creatorDemo: false, training: true, deleted: false },
      { matterId: "D1", synthetic: false, creatorDemo: false, training: false, deleted: true },
      { matterId: "D2", synthetic: true, creatorDemo: false, training: false, deleted: true },
    ],
  };
}

export const AS_OF = "2026-02-10T12:00:00.000Z";
