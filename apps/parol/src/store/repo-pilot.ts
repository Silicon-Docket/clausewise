import { newId } from "../ids.js";
import { isUsableStartDate } from "../pilot/calendar.js";
import type {
  AuditMatterRecord,
  DecisionRecord,
  FindingRecord,
  MatterRecord,
  MemberRecord,
  MemoRecord,
  MissedIssueRecord,
  ParticipantRecord,
  PilotRecords,
  PilotSeverity,
  PlaybookRecord,
  RatingRecord,
  ReferenceIssueRecord,
  RunRecord,
  StaleDecisionRecord,
  TimeEntryRecord,
} from "../pilot/types.js";
import type { ReferenceListInput } from "../pilot/views.js";
import { bool, type Ctx } from "./context.js";
import { ConflictError, ValidationError } from "./errors.js";
import { NOT_TRAINING_SQL, type MattersApi } from "./repo-matters.js";
import type { PlaybooksApi } from "./repo-playbooks.js";

/**
 * The pilot measures' own data (package W2.6b): the pilot calendar, the roster of people the trainer
 * says were trained, the timers and the shadow-mode reference list, and the one read across matters
 * that the measures page needs (`loadPilotRecords`).
 *
 * What is written here holds no text. A timer is a role and two timestamps, a reference issue a rule
 * key and a severity, the calendar a date, the roster user ids. Every write runs in one transaction
 * with its audit event, validates before it writes, and uses a fixed message that interpolates
 * nothing (test/store/error-messages.test.ts holds that for the whole store).
 *
 * The refusal codes raised here, for the layer above to give a phrase each (the codes are the whole
 * contract; the words are the route layer's): `PILOT_REFUSAL_CODES`.
 */

/** The codes this module throws, so the layer above can check that every one has a phrase. */
export const PILOT_REFUSAL_CODES = [
  "bad_calendar_date",
  "unknown_user",
  "duplicate_user",
  "too_many_participants",
  "timer_role",
  "timer_training",
  "timer_open",
  "no_open_timer",
  "reference_role",
  "reference_training",
  "reference_locked",
  "unknown_rule",
  "duplicate_rule",
  "bad_severity",
  "bad_count",
] as const;
export type PilotRefusalCode = (typeof PILOT_REFUSAL_CODES)[number];

/** The audit list holds 64 entries at most (`MAX_DETAIL_ENTRIES`), and the roster is written into it. */
export const MAX_PARTICIPANTS = 64;
/** The most issues of one severity that no rule covers, per reference list. */
export const MAX_OUTSIDE_ISSUES = 9;

const SEVERITIES: readonly PilotSeverity[] = ["high", "medium", "low"];

// ---------------------------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------------------------

/** The calendar in force. `timesSet` counts the rows: the table keeps every date ever set. */
export interface PilotCalendarRow {
  startDate: string;
  setBy: string;
  setAt: string;
  timesSet: number;
}

export interface PilotParticipantRow {
  userId: string;
  recordedBy: string;
  recordedAt: string;
}

export interface PilotAdminRow {
  calendar: PilotCalendarRow | null;
  participants: PilotParticipantRow[];
}

export interface TimeEntryRow {
  id: string;
  matterId: string;
  userId: string;
  role: "associate" | "reviewer";
  startedAt: string;
  /** Null while the timer runs. */
  stoppedAt: string | null;
}

/** One person's timers on one matter, and whether they have one running somewhere else. */
export interface TimerState {
  running: TimeEntryRow | null;
  /** A timer of this person runs on another matter. The matter is not named. */
  elsewhere: boolean;
  /** Whole seconds over the closed entries of this person on this matter. */
  closedSeconds: number;
  sessions: number;
}

export interface ReferenceIssueRow {
  id: string;
  matterId: string;
  /** Null: an issue that no rule of the playbook covers. */
  ruleKey: string | null;
  severity: PilotSeverity;
  ordinal: number;
  recordedBy: string;
  recordedAt: string;
}

export interface ReferenceListRow {
  matterId: string;
  /** A review has started on the matter, so the list can no longer change. */
  locked: boolean;
  /** Rule slots first, in the playbook's order, then the issues no rule covers. */
  issues: ReferenceIssueRow[];
}

interface RawTimeEntry {
  id: string;
  matter_id: string;
  user_id: string;
  role: "associate" | "reviewer";
  started_at: string;
  stopped_at: string | null;
}

const toTimeEntry = (r: RawTimeEntry): TimeEntryRow => ({
  id: r.id,
  matterId: r.matter_id,
  userId: r.user_id,
  role: r.role,
  startedAt: r.started_at,
  stoppedAt: r.stopped_at,
});

interface RawReferenceIssue {
  id: string;
  matter_id: string;
  rule_key: string | null;
  severity: PilotSeverity;
  ordinal: number;
  recorded_by: string;
  recorded_at: string;
}

const toReferenceIssue = (r: RawReferenceIssue): ReferenceIssueRow => ({
  id: r.id,
  matterId: r.matter_id,
  ruleKey: r.rule_key,
  severity: r.severity,
  ordinal: r.ordinal,
  recordedBy: r.recorded_by,
  recordedAt: r.recorded_at,
});

/**
 * `YYYY-MM-DD` that the pilot can be counted from. Unlike a stated date, there is no null: a
 * calendar is set. What a usable date is has one definition, `isUsableStartDate` of the pilot
 * module (the one value the store takes from it, so the two cannot disagree): a real calendar day
 * of the years 1000 to 9999 whose five weeks end in those years. A date that only looks like one
 * (year 0026, or the last days of 9999) is refused here and never stored, because the measures page,
 * the file and the end of the pilot are all worked out from the stored date.
 */
function cleanCalendarDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new ValidationError("bad_calendar_date", "the pilot start date must be YYYY-MM-DD");
  if (!isUsableStartDate(value))
    throw new ValidationError(
      "bad_calendar_date",
      "the pilot start date is not a real date that the pilot can be counted from",
    );
  return value;
}

const secondsBetween = (start: string, stop: string): number =>
  Math.floor((Date.parse(stop) - Date.parse(start)) / 1000);

// ---------------------------------------------------------------------------------------------

export function createPilotApi(ctx: Ctx, matters: MattersApi, playbooks: PlaybooksApi) {
  const { get, all, run, tx } = ctx;
  const { requireMatter, requireUser } = matters.internal;

  // --- the calendar -------------------------------------------------------------------------

  const getPilotCalendar = (): PilotCalendarRow | null => {
    const row = get<{ start_date: string; set_by: string; set_at: string }>(
      "SELECT start_date, set_by, set_at FROM pilot_calendar ORDER BY seq DESC LIMIT 1",
    );
    if (row === undefined) return null;
    const times = get<{ n: number }>("SELECT count(*) AS n FROM pilot_calendar");
    return {
      startDate: row.start_date,
      setBy: row.set_by,
      setAt: row.set_at,
      timesSet: times?.n ?? 0,
    };
  };

  /**
   * Sets the start date of the pilot. The table is append-only, so every date ever set stays and the
   * newest is in force; the event holds the new date and the one it replaced.
   */
  function setPilotCalendar(input: { startDate: string; actorId: string }): { startDate: string } {
    const startDate = cleanCalendarDate(input.startDate);
    return tx(() => {
      requireUser(input.actorId);
      const previous = getPilotCalendar();
      run(
        "INSERT INTO pilot_calendar (start_date, set_by, set_at) VALUES (?, ?, ?)",
        startDate,
        input.actorId,
        ctx.now(),
      );
      ctx.audit({
        actorId: input.actorId,
        matterId: null,
        action: "pilot.calendar",
        targetType: "pilot_calendar",
        targetId: startDate,
        detail: { startDate, previousStartDate: previous?.startDate ?? null },
      });
      return { startDate };
    });
  }

  // --- the roster ---------------------------------------------------------------------------

  const listPilotParticipants = (): PilotParticipantRow[] =>
    all<{ user_id: string; recorded_by: string; recorded_at: string }>(
      "SELECT user_id, recorded_by, recorded_at FROM pilot_participants ORDER BY user_id",
    ).map((r) => ({ userId: r.user_id, recordedBy: r.recorded_by, recordedAt: r.recorded_at }));

  /**
   * Replaces the roster of people the trainer says were trained with exactly these users. Every id
   * is an existing user, none twice, at most 64. The event lists the ids added and removed and the
   * new total.
   */
  function setPilotParticipants(
    userIds: readonly string[],
    opts: { actorId: string },
  ): { added: string[]; removed: string[]; total: number } {
    if (!Array.isArray(userIds))
      throw new ValidationError("unknown_user", "the roster must be a list of people");
    if (userIds.length > MAX_PARTICIPANTS)
      throw new ValidationError("too_many_participants", "the roster holds at most 64 people");
    if (new Set(userIds).size !== userIds.length)
      throw new ValidationError("duplicate_user", "a person is listed twice");
    return tx(() => {
      requireUser(opts.actorId);
      for (const userId of userIds)
        if (typeof userId !== "string" || matters.getUser(userId) === undefined)
          throw new ValidationError("unknown_user", "the roster names a person who is not a user");
      const before = listPilotParticipants().map((p) => p.userId);
      const wanted = new Set(userIds);
      const removed = before.filter((id) => !wanted.has(id)).sort();
      const added = [...wanted].filter((id) => !before.includes(id)).sort();
      for (const userId of removed) run("DELETE FROM pilot_participants WHERE user_id = ?", userId);
      const at = ctx.now();
      for (const userId of added)
        run(
          "INSERT INTO pilot_participants (user_id, recorded_by, recorded_at) VALUES (?, ?, ?)",
          userId,
          opts.actorId,
          at,
        );
      ctx.audit({
        actorId: opts.actorId,
        matterId: null,
        action: "pilot.participants",
        targetType: "pilot_participants",
        targetId: "roster",
        detail: { added, removed, total: wanted.size },
      });
      return { added, removed, total: wanted.size };
    });
  }

  /** What the administration form shows: the calendar in force and the roster. */
  const getPilotAdmin = (): PilotAdminRow => ({
    calendar: getPilotCalendar(),
    participants: listPilotParticipants(),
  });

  // --- timers -------------------------------------------------------------------------------

  const getTimeEntry = (entryId: string): TimeEntryRow | undefined => {
    const row = get<RawTimeEntry>(
      "SELECT id, matter_id, user_id, role, started_at, stopped_at FROM time_entries WHERE id = ?",
      entryId,
    );
    return row === undefined ? undefined : toTimeEntry(row);
  };

  /**
   * Starts a timer for a person on a matter, in the role they hold there (an associate or a
   * reviewer; a viewer cannot time a matter). A person times one thing at a time, so a timer
   * running anywhere, here or on another matter, refuses a second (`timer_open`). The server's
   * clock writes the start.
   */
  function startTimer(matterId: string, opts: { userId: string }): TimeEntryRow {
    return tx(() => {
      const matter = requireMatter(matterId);
      const member = matters.getMember(matterId, opts.userId);
      if (member === undefined || (member.role !== "associate" && member.role !== "reviewer"))
        throw new ValidationError(
          "timer_role",
          "only an associate or a reviewer of the matter can time it",
        );
      // The measures leave a training matter out and its page offers no timer, so a time on it would
      // be counted by nothing and would take the one timer slot of the person with no way to stop it.
      if (matter.trainingKey !== null)
        throw new ConflictError("timer_training", "a training matter is not timed");
      const open = get<{ n: number }>(
        "SELECT 1 AS n FROM time_entries WHERE user_id = ? AND stopped_at IS NULL LIMIT 1",
        opts.userId,
      );
      if (open !== undefined)
        throw new ConflictError("timer_open", "this person already has a timer running");
      const id = newId("tim");
      run(
        "INSERT INTO time_entries (id, matter_id, user_id, role, started_at) VALUES (?, ?, ?, ?, ?)",
        id,
        matterId,
        opts.userId,
        member.role,
        ctx.now(),
      );
      ctx.audit({
        actorId: opts.userId,
        matterId,
        action: "time.start",
        targetType: "time_entry",
        targetId: id,
        detail: { entryId: id, role: member.role },
      });
      return getTimeEntry(id) as TimeEntryRow;
    });
  }

  /**
   * Stops the person's running timer on this matter. The stop is the server's clock, and never
   * earlier than the start, so a clock that stepped back cannot write a negative time. An entry is
   * final once stopped. A training matter is no exception: a timer that a database made earlier holds
   * there (a start is refused now) must always be stoppable.
   */
  function stopTimer(
    matterId: string,
    opts: { userId: string },
  ): TimeEntryRow & { seconds: number } {
    return tx(() => {
      requireMatter(matterId);
      const open = get<RawTimeEntry>(
        `SELECT id, matter_id, user_id, role, started_at, stopped_at FROM time_entries
         WHERE matter_id = ? AND user_id = ? AND stopped_at IS NULL`,
        matterId,
        opts.userId,
      );
      if (open === undefined)
        throw new ConflictError("no_open_timer", "this person has no timer running on the matter");
      const now = ctx.now();
      const stoppedAt = Date.parse(now) >= Date.parse(open.started_at) ? now : open.started_at;
      const changed = run(
        "UPDATE time_entries SET stopped_at = ? WHERE id = ? AND stopped_at IS NULL",
        stoppedAt,
        open.id,
      );
      if (changed !== 1)
        throw new ConflictError("no_open_timer", "this person has no timer running on the matter");
      const seconds = secondsBetween(open.started_at, stoppedAt);
      ctx.audit({
        actorId: opts.userId,
        matterId,
        action: "time.stop",
        targetType: "time_entry",
        targetId: open.id,
        detail: { entryId: open.id, role: open.role, seconds },
      });
      return { ...(getTimeEntry(open.id) as TimeEntryRow), seconds };
    });
  }

  /** One person's timers on one matter. Filters on the matter and the person, whatever the ids are. */
  function listTimerState(matterId: string, userId: string): TimerState {
    const entries = all<RawTimeEntry>(
      `SELECT id, matter_id, user_id, role, started_at, stopped_at FROM time_entries
       WHERE matter_id = ? AND user_id = ? ORDER BY started_at, rowid`,
      matterId,
      userId,
    ).map(toTimeEntry);
    let running: TimeEntryRow | null = null;
    let closedSeconds = 0;
    let sessions = 0;
    for (const entry of entries) {
      if (entry.stoppedAt === null) running = entry;
      else {
        closedSeconds += secondsBetween(entry.startedAt, entry.stoppedAt);
        sessions += 1;
      }
    }
    const elsewhere =
      get<{ n: number }>(
        `SELECT 1 AS n FROM time_entries
         WHERE user_id = ? AND stopped_at IS NULL AND matter_id <> ? LIMIT 1`,
        userId,
        matterId,
      ) !== undefined;
    return { running, elsewhere, closedSeconds, sessions };
  }

  // --- the reference list -------------------------------------------------------------------

  /** A review has started on the matter: a run for a matter, whatever became of it. */
  const reviewStarted = (matterId: string): boolean =>
    get<{ n: number }>(
      "SELECT 1 AS n FROM runs WHERE matter_id = ? AND purpose = 'matter' LIMIT 1",
      matterId,
    ) !== undefined;

  function getReferenceList(matterId: string): ReferenceListRow {
    return {
      matterId,
      locked: reviewStarted(matterId),
      issues: all<RawReferenceIssue>(
        `SELECT id, matter_id, rule_key, severity, ordinal, recorded_by, recorded_at
         FROM reference_issues WHERE matter_id = ? ORDER BY ordinal`,
        matterId,
      ).map(toReferenceIssue),
    };
  }

  /**
   * Records the issues a reviewing attorney found by hand, before Parol has read the matter: a
   * severity for each rule of the matter's pinned playbook that was an issue, and how many issues of
   * each severity no rule covers. The set replaces the list. Only a reviewer of the matter records
   * it (`reference_role`), and not once a review has started (`reference_locked`), which the
   * database holds as well (migration 008): the list cannot be fitted to Parol's answer.
   */
  function saveReferenceList(
    matterId: string,
    input: ReferenceListInput,
    opts: { userId: string },
  ): ReferenceListRow {
    // The shape of the input first: nothing is looked up for a request that cannot be right.
    if (!Array.isArray(input.rules))
      throw new ValidationError("bad_severity", "the rules of a reference list are a list");
    const slots = input.rules;
    for (const slot of slots) {
      if (typeof slot?.ruleKey !== "string")
        throw new ValidationError("unknown_rule", "a reference issue names a rule of the playbook");
      if (!SEVERITIES.includes(slot.severity))
        throw new ValidationError("bad_severity", "the severity is high, medium or low");
    }
    if (new Set(slots.map((slot) => slot.ruleKey)).size !== slots.length)
      throw new ValidationError("duplicate_rule", "a rule is listed twice in a reference list");
    const outside = {
      high: input.outsideHigh,
      medium: input.outsideMedium,
      low: input.outsideLow,
    } satisfies Record<PilotSeverity, number>;
    for (const severity of SEVERITIES) {
      const count = outside[severity];
      if (!Number.isInteger(count) || count < 0 || count > MAX_OUTSIDE_ISSUES)
        throw new ValidationError("bad_count", "the count of issues no rule covers is 0 to 9");
    }

    return tx(() => {
      const matter = requireMatter(matterId);
      const member = matters.getMember(matterId, opts.userId);
      if (member?.role !== "reviewer")
        throw new ValidationError(
          "reference_role",
          "only a reviewer of the matter records its reference list",
        );
      // A training matter is in no measure and its page offers no list, so a list on it is counted by nothing.
      if (matter.trainingKey !== null)
        throw new ConflictError("reference_training", "a training matter has no reference list");
      if (reviewStarted(matterId))
        throw new ConflictError(
          "reference_locked",
          "a review has started, so the reference list is closed",
        );
      const playbookKeys =
        matter.playbookVersionId === null
          ? []
          : playbooks.listRules(matter.playbookVersionId).map((rule) => rule.key);
      for (const slot of slots)
        if (!playbookKeys.includes(slot.ruleKey))
          throw new ValidationError(
            "unknown_rule",
            "a reference issue names a rule of the playbook",
          );

      // Rule slots in the playbook's own order, then the issues no rule covers, so that the same
      // choices always give the same list whatever order the form listed them in.
      const ordered: { ruleKey: string | null; severity: PilotSeverity }[] = [
        ...playbookKeys.flatMap((key) => {
          const slot = slots.find((s) => s.ruleKey === key);
          return slot === undefined ? [] : [{ ruleKey: key, severity: slot.severity }];
        }),
        ...SEVERITIES.flatMap((severity) =>
          Array.from({ length: outside[severity] }, () => ({ ruleKey: null, severity })),
        ),
      ];

      run("DELETE FROM reference_issues WHERE matter_id = ?", matterId);
      const at = ctx.now();
      ordered.forEach((issue, ordinal) => {
        run(
          `INSERT INTO reference_issues (id, matter_id, rule_key, severity, ordinal, recorded_by, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          newId("ref"),
          matterId,
          issue.ruleKey,
          issue.severity,
          ordinal,
          opts.userId,
          at,
        );
      });
      ctx.audit({
        actorId: opts.userId,
        matterId,
        action: "reference.save",
        targetType: "matter",
        targetId: matterId,
        detail: {
          issues: ordered.length,
          ruleKeys: ordered.flatMap((issue) => (issue.ruleKey === null ? [] : [issue.ruleKey])),
          outsideHigh: outside.high,
          outsideMedium: outside.medium,
          outsideLow: outside.low,
        },
      });
      return getReferenceList(matterId);
    });
  }

  // --- the one read across matters ----------------------------------------------------------

  /**
   * Every record the pilot measures are computed from, across all matters: ids, flags, codes and
   * timestamps and nothing else. This is the first repository method that is not scoped to one
   * matter, on purpose and by construction: the statements below select no column that can hold
   * text (test/store/pilot.test.ts scans this file for the names of the ones that can, and plants
   * a marker in each and shows that none reaches the records). It writes nothing, reads every row
   * once, and has one caller, the pilot service.
   *
   * A training matter is set aside. It is listed (with its flag) so that the population table can
   * count it, and every other statement adds `NOT_TRAINING_SQL`, so none of its runs, findings,
   * decisions, memos, reports, ratings, timers or reference issues leave the store.
   *
   * The reads are made in one snapshot, so that a row written between two statements by another
   * process cannot leave a finding whose run is not in the list.
   */
  function loadPilotRecords(): PilotRecords {
    const snapshot = <T>(fn: () => T): T => {
      if (ctx.db.isTransaction) return fn();
      ctx.db.exec("BEGIN");
      try {
        return fn();
      } finally {
        ctx.db.exec("ROLLBACK");
      }
    };
    return snapshot(() => {
      const calendarRow = get<{ start_date: string }>(
        "SELECT start_date FROM pilot_calendar ORDER BY seq DESC LIMIT 1",
      );

      const mattersList: MatterRecord[] = all<{
        id: string;
        synthetic: number;
        creator_demo: number;
        training: number;
        playbook_version_id: string | null;
        retain_until: string;
      }>(
        `SELECT matters.id, matters.synthetic, u.demo AS creator_demo,
                matters.training_key IS NOT NULL AS training,
                matters.playbook_version_id, matters.retain_until
         FROM matters JOIN users u ON u.id = matters.created_by
         WHERE matters.status <> 'deleted' AND matters.deleted_at IS NULL
         ORDER BY matters.id`,
      ).map((r) => ({
        matterId: r.id,
        synthetic: bool(r.synthetic),
        creatorDemo: bool(r.creator_demo),
        training: bool(r.training),
        playbookVersionId: r.playbook_version_id,
        retainUntil: r.retain_until,
      }));

      const members: MemberRecord[] = all<{
        matter_id: string;
        user_id: string;
        demo: number;
        role: MemberRecord["role"];
      }>(
        `SELECT mm.matter_id, mm.user_id, u.demo, mm.role
         FROM matter_members mm
         JOIN matters ON matters.id = mm.matter_id
         JOIN users u ON u.id = mm.user_id
         WHERE ${NOT_TRAINING_SQL}
         ORDER BY mm.matter_id, mm.user_id`,
      ).map((r) => ({
        matterId: r.matter_id,
        userId: r.user_id,
        userDemo: bool(r.demo),
        role: r.role,
      }));

      const ruleRows = all<{ playbook_version_id: string; rule_key: string }>(
        `SELECT pr.playbook_version_id, pr.rule_key
         FROM playbook_rules pr
         WHERE pr.playbook_version_id IN (
           SELECT matters.playbook_version_id FROM matters
           WHERE matters.playbook_version_id IS NOT NULL AND ${NOT_TRAINING_SQL})
         ORDER BY pr.playbook_version_id, pr.ordinal, pr.rowid`,
      );
      const playbookList: PlaybookRecord[] = [];
      for (const row of ruleRows) {
        const last = playbookList[playbookList.length - 1];
        if (last !== undefined && last.versionId === row.playbook_version_id)
          last.ruleKeys.push(row.rule_key);
        else playbookList.push({ versionId: row.playbook_version_id, ruleKeys: [row.rule_key] });
      }

      const runs: RunRecord[] = all<{
        id: string;
        matter_id: string;
        started_by: string;
        demo: number;
        started_at: string;
        status: RunRecord["status"];
      }>(
        `SELECT r.id, r.matter_id, r.started_by, u.demo, r.started_at, r.status
         FROM runs r
         JOIN matters ON matters.id = r.matter_id
         JOIN users u ON u.id = r.started_by
         WHERE r.purpose = 'matter' AND ${NOT_TRAINING_SQL}
         ORDER BY r.started_at, r.id`,
      ).map((r) => ({
        runId: r.id,
        matterId: r.matter_id,
        startedBy: r.started_by,
        startedByDemo: bool(r.demo),
        startedAt: r.started_at,
        status: r.status,
      }));

      const findings: FindingRecord[] = all<{
        id: string;
        run_id: string;
        matter_id: string;
        rule_key: string;
        severity: PilotSeverity;
        status: FindingRecord["status"];
        verification_state: string;
      }>(
        `SELECT f.id, f.run_id, f.matter_id, f.rule_key, f.severity, f.status, f.verification_state
         FROM findings f
         JOIN runs r ON r.id = f.run_id
         JOIN matters ON matters.id = f.matter_id
         WHERE r.purpose = 'matter' AND ${NOT_TRAINING_SQL}
         ORDER BY f.run_id, f.id`,
      ).map((r) => ({
        findingId: r.id,
        runId: r.run_id,
        matterId: r.matter_id,
        ruleKey: r.rule_key,
        severity: r.severity,
        status: r.status,
        escalatedBySystem: r.verification_state === "escalated_by_system",
      }));

      const decisions: DecisionRecord[] = all<{
        finding_id: string;
        matter_id: string;
        demo: number;
        decision: DecisionRecord["decision"];
        reason_code: string | null;
        minor_edit: number | null;
      }>(
        `SELECT rv.finding_id, rv.matter_id, u.demo, rv.decision, rv.reason_code, rv.minor_edit
         FROM reviews rv
         JOIN matters ON matters.id = rv.matter_id
         JOIN users u ON u.id = rv.reviewer_id
         WHERE rv.validity = 'current' AND ${NOT_TRAINING_SQL}
         ORDER BY rv.matter_id, rv.finding_id`,
      ).map((r) => ({
        findingId: r.finding_id,
        matterId: r.matter_id,
        reviewerDemo: bool(r.demo),
        decision: r.decision,
        reasonCode: r.reason_code,
        minorEdit: r.minor_edit === null ? null : bool(r.minor_edit),
      }));

      const staleDecisions: StaleDecisionRecord[] = all<{ matter_id: string; demo: number }>(
        `SELECT rv.matter_id, u.demo
         FROM reviews rv
         JOIN matters ON matters.id = rv.matter_id
         JOIN users u ON u.id = rv.reviewer_id
         WHERE rv.validity = 'stale' AND ${NOT_TRAINING_SQL}
         ORDER BY rv.matter_id, rv.rowid`,
      ).map((r) => ({ matterId: r.matter_id, reviewerDemo: bool(r.demo) }));

      const memos: MemoRecord[] = all<{ matter_id: string; demo: number }>(
        `SELECT mo.matter_id, u.demo
         FROM memos mo
         JOIN matters ON matters.id = mo.matter_id
         JOIN users u ON u.id = mo.exported_by
         WHERE ${NOT_TRAINING_SQL}
         ORDER BY mo.matter_id, mo.rowid`,
      ).map((r) => ({ matterId: r.matter_id, exportedByDemo: bool(r.demo) }));

      // The text and the place of a report and the words of a rating are never selected.
      const missedIssues: MissedIssueRecord[] = all<{
        matter_id: string;
        demo: number;
        rule_key: string | null;
      }>(
        `SELECT fb.matter_id, u.demo, fb.rule_key
         FROM feedback fb
         JOIN matters ON matters.id = fb.matter_id
         JOIN users u ON u.id = fb.user_id
         WHERE fb.kind = 'missed_issue' AND ${NOT_TRAINING_SQL}
         ORDER BY fb.matter_id, fb.rowid`,
      ).map((r) => ({ matterId: r.matter_id, userDemo: bool(r.demo), ruleKey: r.rule_key }));

      // Oldest first: when one person has rated twice the later rating is the one in force.
      const ratings: RatingRecord[] = all<{
        matter_id: string;
        user_id: string;
        demo: number;
        rating: number;
      }>(
        `SELECT fb.matter_id, fb.user_id, u.demo, fb.rating
         FROM feedback fb
         JOIN matters ON matters.id = fb.matter_id
         JOIN users u ON u.id = fb.user_id
         WHERE fb.kind = 'rating' AND ${NOT_TRAINING_SQL}
         ORDER BY fb.rowid`,
      ).map((r) => ({
        matterId: r.matter_id,
        userId: r.user_id,
        userDemo: bool(r.demo),
        rating: r.rating,
      }));

      const timeEntries: TimeEntryRecord[] = all<{
        matter_id: string;
        user_id: string;
        demo: number;
        role: TimeEntryRecord["role"];
        started_at: string;
        stopped_at: string | null;
      }>(
        `SELECT te.matter_id, te.user_id, u.demo, te.role, te.started_at, te.stopped_at
         FROM time_entries te
         JOIN matters ON matters.id = te.matter_id
         JOIN users u ON u.id = te.user_id
         WHERE ${NOT_TRAINING_SQL}
         ORDER BY te.started_at, te.id`,
      ).map((r) => ({
        matterId: r.matter_id,
        userId: r.user_id,
        userDemo: bool(r.demo),
        role: r.role,
        startedAt: r.started_at,
        stoppedAt: r.stopped_at,
      }));

      const referenceIssues: ReferenceIssueRecord[] = all<{
        matter_id: string;
        rule_key: string | null;
        severity: PilotSeverity;
        demo: number;
      }>(
        `SELECT ri.matter_id, ri.rule_key, ri.severity, u.demo
         FROM reference_issues ri
         JOIN matters ON matters.id = ri.matter_id
         JOIN users u ON u.id = ri.recorded_by
         WHERE ${NOT_TRAINING_SQL}
         ORDER BY ri.matter_id, ri.ordinal`,
      ).map((r) => ({
        matterId: r.matter_id,
        ruleKey: r.rule_key,
        severity: r.severity,
        recordedByDemo: bool(r.demo),
      }));

      const participants: ParticipantRecord[] = all<{ user_id: string; demo: number }>(
        `SELECT p.user_id, u.demo
         FROM pilot_participants p JOIN users u ON u.id = p.user_id
         ORDER BY p.user_id`,
      ).map((r) => ({ userId: r.user_id, demo: bool(r.demo) }));

      // The audit log keeps the matters that were deleted: created, with the flags the matter had
      // (a missing flag reads as the safe side, synthetic), and deleted or not.
      const auditMatters: AuditMatterRecord[] = all<{
        matter_id: string;
        synthetic: number;
        creator_demo: number;
        training: number;
        deleted: number;
      }>(
        `SELECT a.matter_id,
                COALESCE(json_extract(a.detail_json, '$.synthetic'), 1) AS synthetic,
                COALESCE(u.demo, 1) AS creator_demo,
                json_extract(a.detail_json, '$.training') IS NOT NULL AS training,
                EXISTS (SELECT 1 FROM audit_events d
                        WHERE d.action = 'matter.delete' AND d.matter_id = a.matter_id) AS deleted
         FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
         WHERE a.action = 'matter.create' AND a.matter_id IS NOT NULL
         ORDER BY a.seq`,
      ).map((r) => ({
        matterId: r.matter_id,
        synthetic: bool(r.synthetic),
        creatorDemo: bool(r.creator_demo),
        training: bool(r.training),
        deleted: bool(r.deleted),
      }));

      return {
        calendar: calendarRow === undefined ? null : { startDate: calendarRow.start_date },
        matters: mattersList,
        members,
        playbooks: playbookList,
        runs,
        findings,
        decisions,
        staleDecisions,
        memos,
        missedIssues,
        ratings,
        timeEntries,
        referenceIssues,
        participants,
        auditMatters,
      };
    });
  }

  return {
    // calendar and roster
    getPilotCalendar,
    setPilotCalendar,
    listPilotParticipants,
    setPilotParticipants,
    getPilotAdmin,
    // timers
    startTimer,
    stopTimer,
    listTimerState,
    // reference list
    getReferenceList,
    saveReferenceList,
    // the one read across matters
    loadPilotRecords,
  };
}

export type PilotApi = ReturnType<typeof createPilotApi>;
