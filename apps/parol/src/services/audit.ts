import type { Principal } from "../auth/types.js";
import {
  AUDIT_BREAK_TEXT,
  MATTER_ID_PATTERN,
  type AuditEvent,
  type MatterReconciliation,
} from "../store/index.js";
import { requireGlobalRole, type ServiceDeps } from "./deps.js";

/**
 * The audit log check, as data (package W2.7, slice C). `check` calls
 * `requireGlobalRole(principal, "audit.read")` first, then reads the chain, the head, the matters
 * against their events and the last retention run from the repository. It never receives a value
 * from a request and never returns a name.
 *
 * What the view may hold. The page behind it renders only what is here, and the log it describes is
 * the very thing that may have been tampered with, so nothing in the view is a string that came out
 * of a row unless it was checked against a closed list or a fixed shape first:
 *
 * - the words for a break come from `AUDIT_BREAK_TEXT`, chosen by a code the chain check made;
 * - the head hash is shown only if it is 64 lower-case hex digits;
 * - an id of a matter is listed only if it has the form of one (`mat_` and 16 hex digits);
 * - the last retention run is read from the event's detail field by field, and an event whose
 *   detail is not exactly what the job writes is reported as unreadable and is not shown;
 * - every other value is a count, and a count is a whole number of at least 0.
 *
 * A count always travels with the number it is a part of (`eventsInLog`, `retention.totalMatters`,
 * the `created` and `present` of the matters), so the page can state each as "x of y".
 */

/** How the job's compaction step ended, in the words the job writes. */
export type RetentionCompaction = "done" | "not_needed" | "failed" | "not_run";

const COMPACTIONS: readonly RetentionCompaction[] = ["done", "not_needed", "failed", "not_run"];

/** A matter id that is listed on the page. The count is exact; the ids are at most 20. */
export interface MatterIdList {
  count: number;
  /** Only ids of the form the application issues, so that nothing else a row holds is shown. */
  ids: string[];
}

/** The matters against the events that account for them (docs/parol/06). */
export interface MatterAccountView {
  /** Distinct matters with a creation event. */
  created: number;
  /** Matters in the database. */
  present: number;
  /** Created, no longer present, with a deletion event. */
  deleted: number;
  /** Created and gone, with no deletion event: something other than the application removed them. */
  goneWithoutDeleteEvent: MatterIdList;
  /** Present with no creation event. */
  presentWithoutCreateEvent: MatterIdList;
  /** Present although a deletion event names them. */
  deletedButPresent: MatterIdList;
}

/** The last `retention.run` event, as the job wrote it. */
export interface RetentionRunView {
  /** The number of the event in the log. */
  seq: number;
  /** When the event was written (ISO time). */
  at: string;
  /** Matters past their date when the run judged. The denominator of the next three. */
  expired: number;
  deleted: number;
  skipped: number;
  failed: number;
  /** Folders no matter named that were removed, and that could not be. Their sum is the denominator. */
  orphansRemoved: number;
  orphansFailed: number;
  compaction: RetentionCompaction;
  /** The run found more matters past their date than its limit and deleted none. */
  refused: boolean;
}

export interface AuditPageView {
  /** When the check ran (ISO time). The page does not store a result: this is the moment it read. */
  checkedAt: string;
  /** Rows in the log, whether or not its chain holds. The denominator of every count of events. */
  eventsInLog: number;
  chain:
    | { ok: true; events: number }
    | {
        ok: false;
        /** Events that checked out before the break. */
        events: number;
        firstBrokenSeq: number;
        reason: string;
        reasonText: string;
      };
  /** The newest event: what an operator keeps elsewhere to anchor the log. Null for an empty log. */
  head: { seq: number; hash: string | null } | null;
  matters: MatterAccountView;
  retention: {
    /** Matters in the database. The denominator of `pastDate`. */
    totalMatters: number;
    pastDate: number;
    /** The last run of the job, or null if the log holds none (or only one the page cannot read). */
    lastRun: RetentionRunView | null;
    /** The log holds a retention run event whose detail is not in the form the job writes. */
    lastRunUnreadable: boolean;
  };
}

export interface AuditService {
  check(principal: Principal): AuditPageView;
}

const HASH = /^[0-9a-f]{64}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const idList = (list: { count: number; ids: string[] }): MatterIdList => ({
  count: list.count,
  ids: list.ids.filter((id) => MATTER_ID_PATTERN.test(id)),
});

function accountOf(matters: MatterReconciliation): MatterAccountView {
  return {
    created: matters.created,
    present: matters.present,
    deleted: matters.deleted,
    goneWithoutDeleteEvent: idList(matters.goneWithoutDeleteEvent),
    presentWithoutCreateEvent: idList(matters.presentWithoutCreateEvent),
    deletedButPresent: idList(matters.deletedButPresent),
  };
}

/**
 * The run an event records, or null if the event is not exactly what the job writes. The detail is
 * read key by key: a value of the wrong kind, a time that is not an ISO time, a word that is not
 * one of the four the job writes, makes the whole event unreadable, and none of it is shown.
 * `orphansFailed` is optional because a run written before the job counted it has none.
 */
export function readRetentionRun(event: AuditEvent): RetentionRunView | null {
  const d = event.detail;
  const orphansFailed = d.orphansFailed === undefined ? 0 : d.orphansFailed;
  if (
    d.mode !== "apply" ||
    !isCount(d.expired) ||
    !isCount(d.deleted) ||
    !isCount(d.skipped) ||
    !isCount(d.failed) ||
    !isCount(d.orphansRemoved) ||
    !isCount(orphansFailed) ||
    typeof d.compaction !== "string" ||
    !COMPACTIONS.includes(d.compaction as RetentionCompaction) ||
    typeof d.refused !== "boolean" ||
    !isCount(event.seq) ||
    !ISO_TIME.test(event.at)
  )
    return null;
  return {
    seq: event.seq,
    at: event.at,
    expired: d.expired,
    deleted: d.deleted,
    skipped: d.skipped,
    failed: d.failed,
    orphansRemoved: d.orphansRemoved,
    orphansFailed,
    compaction: d.compaction as RetentionCompaction,
    refused: d.refused,
  };
}

/**
 * Builds the service. It must not throw here: `createServices` calls it for every process and every
 * test.
 */
export function createAuditService(deps: ServiceDeps): AuditService {
  const { repo } = deps;

  return {
    check(principal) {
      requireGlobalRole(principal, "audit.read");
      const now = deps.now();
      const result = repo.checkAudit();
      const head = result.head;

      let lastRun: RetentionRunView | null = null;
      let lastRunUnreadable = false;
      try {
        const event = repo.latestAuditEvent("retention.run");
        if (event !== null) {
          lastRun = readRetentionRun(event);
          lastRunUnreadable = lastRun === null;
        }
      } catch {
        // An event whose detail is not even JSON: the log is broken, and the chain check says so.
        lastRunUnreadable = true;
      }

      return {
        checkedAt: now.toISOString(),
        eventsInLog: repo.countAuditEvents(),
        chain: result.chain.ok
          ? { ok: true, events: result.chain.events }
          : {
              ok: false,
              events: result.chain.events,
              firstBrokenSeq: result.chain.firstBrokenSeq,
              reason: result.chain.reason,
              reasonText: AUDIT_BREAK_TEXT[result.chain.reason],
            },
        head:
          head === null ? null : { seq: head.seq, hash: HASH.test(head.hash) ? head.hash : null },
        matters: accountOf(result.matters),
        retention: {
          totalMatters: repo.listMatterIds().length,
          pastDate: repo.listExpiredMatters(now).length,
          lastRun,
          lastRunUnreadable,
        },
      };
    },
  };
}
