import { roleAllows } from "../auth/actions.js";
import type { AuthorizedMatter, Principal } from "../auth/types.js";
import { REASON_CODES } from "../contracts.js";
import {
  calendarEnd,
  computePilotMeasures,
  csvFileName,
  presentMeasures,
  toCsv,
  type PilotAdminView,
  type PilotMeasuresView,
  type PilotScope,
  type PilotSeverity,
  type ReferenceListInput,
  type ReferenceView,
  type TimerView,
} from "../pilot/index.js";
import { NotFoundError } from "../store/index.js";
import { trainedUserIds } from "../training/progress.js";
import { requireGlobalRole, requireRole, type ServiceDeps } from "./deps.js";

/**
 * The pilot measures, the timer and the reference list, as data (package W2.6b).
 *
 * Two kinds of function, with two kinds of check. The ones that name no matter (the measures, the
 * CSV, the administration form) take the `Principal` and call `requireGlobalRole` first, against the
 * table the route guard uses (`GLOBAL_ACTIONS`), so the service is never more permissive than the
 * route. The ones that are about one matter take an `AuthorizedMatter`, call `requireRole` first and
 * work on `am.matterId` only; no id from a request stands in for it. The timer is always the
 * signed-in person's own: nothing here takes a user id to time for.
 *
 * What is returned. The measures come back as the view the page lays out (`presentMeasures`): the
 * numbers with their denominators and the fixed words, as strings and data, because a page cannot
 * import the pilot module. Nothing returned or thrown holds document text, a name from an upload, a
 * note, a reason or a quote; the store read it all by id, flag, code and time, and the CSV is made
 * from the same measures.
 */
export interface PilotService {
  /**
   * The measures of a scope as the page shows them. Needs `pilot.read`. Writes nothing: it reads the
   * rows once and computes. The pilot scope is empty on every database this build can make (every
   * person is a demonstration identity), and the view says so.
   */
  measures(principal: Principal, scope: PilotScope): PilotMeasuresView;
  /** The same measures as the file a download carries. Needs `pilot.read`. */
  csv(principal: Principal, scope: PilotScope): { fileName: string; body: string };
  /** The calendar in force and the roster, for the administration form. Needs `pilot.read`. */
  admin(principal: Principal): PilotAdminView;
  /** Sets the first day of the pilot. Needs `pilot.manage`. 400 `bad_calendar_date`. */
  setCalendar(principal: Principal, input: { startDate: string }): void;
  /** Replaces the roster of trained people. Needs `pilot.manage`. 400 `unknown_user`, `too_many_participants`. */
  setParticipants(principal: Principal, input: { userIds: readonly string[] }): void;
  /** The caller's own timer on this matter. Any member may ask; `allowed` says whether they may time it. */
  timer(am: AuthorizedMatter): TimerView;
  /** Starts the caller's timer. `time.record`. 409 `timer_open` when one runs, here or on another matter. */
  startTimer(am: AuthorizedMatter): TimerView;
  /** Stops the caller's timer on this matter. `time.record`. 409 `no_open_timer`. */
  stopTimer(am: AuthorizedMatter): TimerView;
  /** The reference list, for the reviewer who may record it; null for any other role. */
  referenceList(am: AuthorizedMatter): ReferenceView | null;
  /** Replaces the reference list. `reference.write`. 400 for a bad rule, severity or count; 409 `reference_locked`. */
  saveReferenceList(am: AuthorizedMatter, input: ReferenceListInput): ReferenceView;
}

const SEVERITIES: readonly PilotSeverity[] = ["high", "medium", "low"];

/**
 * Builds the service. It must not throw here: `createServices` calls it for every process and every
 * test.
 */
export function createPilotService(deps: ServiceDeps): PilotService {
  const { repo, config } = deps;

  /** The measures of a scope, computed from the records of the store, as of the injected clock. */
  const compute = (scope: PilotScope) =>
    computePilotMeasures(repo.loadPilotRecords(), {
      scope,
      asOf: deps.now().toISOString(),
      reasonCodes: REASON_CODES,
    });

  const timerView = (am: AuthorizedMatter): TimerView => {
    if (!roleAllows(am.role, "time.record"))
      return { allowed: false, running: null, elsewhere: false, closedSeconds: 0, sessions: 0 };
    // The caller's own entries only: the store filters on the matter and on the person.
    const state = repo.listTimerState(am.matterId, am.principal.userId);
    return {
      allowed: true,
      running: state.running === null ? null : { since: state.running.startedAt },
      elsewhere: state.elsewhere,
      closedSeconds: state.closedSeconds,
      sessions: state.sessions,
    };
  };

  const referenceView = (am: AuthorizedMatter): ReferenceView => {
    const matter = repo.getMatter(am.matterId);
    if (matter === undefined) throw new NotFoundError("matter");
    const list = repo.getReferenceList(am.matterId);
    const rules = matter.playbookVersionId === null ? [] : repo.listRules(matter.playbookVersionId);
    const saved = new Map<string, PilotSeverity>();
    const outside: Record<PilotSeverity, number> = { high: 0, medium: 0, low: 0 };
    for (const issue of list.issues) {
      if (issue.ruleKey === null) outside[issue.severity] += 1;
      else saved.set(issue.ruleKey, issue.severity);
    }
    const shown = rules.map((rule) => ({
      ruleKey: rule.key,
      title: rule.title,
      severity: saved.get(rule.key) ?? null,
    }));
    return {
      // A list that a review has closed is shown as it was left, whatever else is true of the matter.
      state: list.locked ? "locked" : matter.playbookVersionId === null ? "no_playbook" : "open",
      rules: shown,
      outside,
      // What the page can show: the rules with a severity, and the issues no rule covers.
      issues:
        shown.filter((rule) => rule.severity !== null).length +
        SEVERITIES.reduce((sum, severity) => sum + outside[severity], 0),
    };
  };

  return {
    measures(principal, scope) {
      requireGlobalRole(principal, "pilot.read");
      return presentMeasures(compute(scope));
    },

    csv(principal, scope) {
      requireGlobalRole(principal, "pilot.read");
      const measures = compute(scope);
      return { fileName: csvFileName(scope, measures.asOf), body: toCsv(measures) };
    },

    admin(principal) {
      requireGlobalRole(principal, "pilot.read");
      const stored = repo.getPilotAdmin();
      const roster = new Set(stored.participants.map((participant) => participant.userId));
      // A hint beside each name and an input to no measure (plan R4): the roster is what the trainer
      // recorded.
      const completed = new Set(trainedUserIds(repo));
      return {
        calendar:
          stored.calendar === null
            ? null
            : {
                startDate: stored.calendar.startDate,
                endDate: calendarEnd(stored.calendar.startDate),
                setAt: stored.calendar.setAt,
                timesSet: stored.calendar.timesSet,
              },
        participants: repo.listUsers().map((user) => ({
          userId: user.id,
          name: user.displayName,
          trained: roster.has(user.id),
          completedTraining: completed.has(user.id),
        })),
      };
    },

    setCalendar(principal, input) {
      requireGlobalRole(principal, "pilot.manage");
      repo.setPilotCalendar({ startDate: input.startDate, actorId: principal.userId });
    },

    setParticipants(principal, input) {
      requireGlobalRole(principal, "pilot.manage");
      repo.setPilotParticipants(input.userIds, { actorId: principal.userId });
    },

    timer: timerView,

    startTimer(am) {
      requireRole(am, "time.record", config);
      repo.startTimer(am.matterId, { userId: am.principal.userId });
      return timerView(am);
    },

    stopTimer(am) {
      requireRole(am, "time.record", config);
      repo.stopTimer(am.matterId, { userId: am.principal.userId });
      return timerView(am);
    },

    referenceList(am) {
      return roleAllows(am.role, "reference.write") ? referenceView(am) : null;
    },

    saveReferenceList(am, input) {
      requireRole(am, "reference.write", config);
      repo.saveReferenceList(am.matterId, input, { userId: am.principal.userId });
      return referenceView(am);
    },
  };
}
