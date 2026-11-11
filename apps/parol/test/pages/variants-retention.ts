import {
  BROKEN_CHAIN,
  HEAD_HASH,
  LAST_RUN,
  MORE_THAN_LISTED,
  UNEXPLAINED,
  auditPage,
  buildAuditView,
  withMatters,
  withRetention,
} from "./audit-support.js";
import {
  PAST,
  buildRetention,
  newMatterPane,
  retentionListPage,
  retentionMatterPage,
  retentionPane,
} from "./retention-support.js";
import type { Variant } from "./variants.js";

/**
 * The page fixtures of the retention section and the audit log page (work package W2.7), in the
 * same shape as the base list in variants.ts, which spreads this list after its own. The package
 * adds an entry for every state of a page that changes what the page shows, and only in this file.
 *
 * The retention section of the matter page and the chip of the list of matters (slice B): the date
 * kept and the date passed, for the associate who may change it and for those who may not, and one
 * day left.
 *
 * The audit log page (slice C): an intact log, an empty one, a broken chain, matters the events do
 * not explain, every state of the last retention run, and a head that is not a hash.
 */
export const VARIANTS_RETENTION: Variant[] = [
  ["matter, retention kept, associate", () => retentionMatterPage("associate")],
  ["matter, retention past, associate", () => retentionMatterPage("associate", PAST)],
  [
    "matter, retention one day left, associate",
    () => retentionMatterPage("associate", buildRetention({ daysLeft: 1 })),
  ],
  ["matter, retention kept, reviewer", () => retentionMatterPage("reviewer")],
  ["matter, retention past, reviewer", () => retentionMatterPage("reviewer", PAST)],
  ["matter, retention kept, viewer", () => retentionMatterPage("viewer")],
  ["matters, one past its date", () => retentionListPage()],
  ["pane, retention kept, associate", () => retentionPane("associate"), { fragment: true }],
  ["pane, retention past, associate", () => retentionPane("associate", PAST), { fragment: true }],
  ["pane, retention kept, viewer", () => retentionPane("viewer"), { fragment: true }],
  ["pane, retention past, reviewer", () => retentionPane("reviewer", PAST), { fragment: true }],
  ["pane, new-matter form", () => newMatterPane(), { fragment: true }],
  ["audit log, intact, nothing recorded", () => auditPage()],
  [
    "audit log, empty",
    () =>
      auditPage(
        buildAuditView({
          eventsInLog: 0,
          chain: { ok: true, events: 0 },
          head: null,
          matters: {
            created: 0,
            present: 0,
            deleted: 0,
            goneWithoutDeleteEvent: { count: 0, ids: [] },
            presentWithoutCreateEvent: { count: 0, ids: [] },
            deletedButPresent: { count: 0, ids: [] },
          },
          retention: { totalMatters: 0, pastDate: 0, lastRun: null, lastRunUnreadable: false },
        }),
      ),
  ],
  ["audit log, broken chain", () => auditPage(buildAuditView({ chain: BROKEN_CHAIN }))],
  [
    "audit log, broken chain, log cut back",
    () =>
      auditPage(
        buildAuditView({
          chain: {
            ok: false,
            events: 12,
            firstBrokenSeq: 13,
            reason: "truncated",
            reasonText: "the newest events are missing",
          },
        }),
      ),
  ],
  ["audit log, matters the events do not explain", () => auditPage(withMatters(UNEXPLAINED))],
  [
    "audit log, more unexplained matters than are listed",
    () => auditPage(withMatters(MORE_THAN_LISTED)),
  ],
  ["audit log, last retention run", () => auditPage(withRetention({ lastRun: LAST_RUN }))],
  [
    "audit log, last retention run refused",
    () =>
      auditPage(
        withRetention({
          lastRun: {
            ...LAST_RUN,
            expired: 30,
            deleted: 0,
            skipped: 0,
            failed: 0,
            orphansRemoved: 0,
            compaction: "not_run",
            refused: true,
          },
        }),
      ),
  ],
  [
    "audit log, last retention run with failures",
    () =>
      auditPage(
        withRetention({
          lastRun: {
            ...LAST_RUN,
            failed: 1,
            orphansRemoved: 1,
            orphansFailed: 2,
            compaction: "failed",
          },
        }),
      ),
  ],
  [
    "audit log, last retention run unreadable",
    () => auditPage(withRetention({ lastRunUnreadable: true })),
  ],
  [
    "audit log, head is not a hash",
    () => auditPage(buildAuditView({ head: { seq: 12, hash: null } })),
  ],
  [
    "audit log, one event",
    () =>
      auditPage(
        buildAuditView({
          eventsInLog: 1,
          chain: { ok: true, events: 1 },
          head: { seq: 1, hash: HEAD_HASH },
        }),
      ),
  ],
];
