import type { AuditPageView } from "../../src/services/views.js";
import { AuditPage } from "../../src/server/pages/audit.js";
import { render, type Chrome } from "../../src/server/pages/index.js";
import { all, readable, section, type El } from "./html.js";
import { buildChrome } from "./support.js";

/**
 * Fixtures of the audit log page (package W2.7, slice C): a view the service could have made, in
 * every state that changes what the page shows. Everything here is synthetic: ids, hashes and counts
 * are made up, and no name or text appears in a view.
 */

export const CHECKED_AT = "2026-11-04T09:00:00.000Z";
export const RUN_AT = "2026-11-03T02:00:00.000Z";

/** 64 lower-case hex digits, as the head of a log is. Made up. */
export const HEAD_HASH = "9f2c1d4e7a6b03582fe1c4d9a07b6e35c8d1f2a4b6097e3d5c1a8f40b7e2d963";

export const GHOST_IDS = ["mat_00000000000000a1", "mat_00000000000000a2", "mat_00000000000000a3"];

/** Twenty made-up matter ids, the most a list holds. */
export const TWENTY_IDS = Array.from(
  { length: 20 },
  (_, i) => `mat_${(0x1000 + i).toString(16).padStart(16, "0")}`,
);

const NO_IDS = { count: 0, ids: [] as string[] };

/**
 * A log with 12 events and an intact chain. Six matters were created, five are in the database and
 * two of those are past their date; one was deleted with an event. No retention run is recorded.
 */
export function buildAuditView(overrides: Partial<AuditPageView> = {}): AuditPageView {
  return {
    checkedAt: CHECKED_AT,
    eventsInLog: 12,
    chain: { ok: true, events: 12 },
    head: { seq: 12, hash: HEAD_HASH },
    matters: {
      created: 6,
      present: 5,
      deleted: 1,
      goneWithoutDeleteEvent: NO_IDS,
      presentWithoutCreateEvent: NO_IDS,
      deletedButPresent: NO_IDS,
    },
    retention: { totalMatters: 5, pastDate: 2, lastRun: null, lastRunUnreadable: false },
    ...overrides,
  };
}

/** The same, with the retention part changed. */
export const withRetention = (
  retention: Partial<AuditPageView["retention"]>,
  base: AuditPageView = buildAuditView(),
): AuditPageView => ({ ...base, retention: { ...base.retention, ...retention } });

/** The same, with the matters part changed. */
export const withMatters = (
  matters: Partial<AuditPageView["matters"]>,
  base: AuditPageView = buildAuditView(),
): AuditPageView => ({ ...base, matters: { ...base.matters, ...matters } });

/**
 * Matters the events do not explain: one gone with no deletion event, two present with no creation
 * event, one present although a deletion event names it. Eight matters were created, five are in
 * the database, one was deleted with an event.
 */
export const UNEXPLAINED = {
  created: 8,
  present: 5,
  deleted: 1,
  goneWithoutDeleteEvent: { count: 1, ids: [GHOST_IDS[0] as string] },
  presentWithoutCreateEvent: { count: 2, ids: GHOST_IDS.slice(1) },
  deletedButPresent: { count: 1, ids: [GHOST_IDS[2] as string] },
} satisfies AuditPageView["matters"];

/**
 * Thirty-one matters present with no creation event, of 39 in the database, of which only twenty
 * ids are listed: a list is capped, and the page says how many more there are.
 */
export const MORE_THAN_LISTED = {
  created: 9,
  present: 39,
  deleted: 1,
  goneWithoutDeleteEvent: { count: 0, ids: [] },
  presentWithoutCreateEvent: { count: 31, ids: TWENTY_IDS },
  deletedButPresent: { count: 0, ids: [] },
} satisfies AuditPageView["matters"];

/** A chain that breaks at event 5 of a log of 12. */
export const BROKEN_CHAIN: AuditPageView["chain"] = {
  ok: false,
  events: 4,
  firstBrokenSeq: 5,
  reason: "hash_mismatch",
  reasonText: "this event's content does not match its hash",
};

/** A run of the retention command, as the service reads it from the log. */
export const LAST_RUN: NonNullable<AuditPageView["retention"]["lastRun"]> = {
  seq: 11,
  at: RUN_AT,
  expired: 3,
  deleted: 2,
  skipped: 1,
  failed: 0,
  orphansRemoved: 1,
  orphansFailed: 0,
  compaction: "done",
  refused: false,
};

export const administrator = (): Chrome => buildChrome({ globalRole: "admin" });

/** The page, as the route sends it. */
export const auditPage = (
  view: AuditPageView = buildAuditView(),
  chrome: Chrome = administrator(),
): string => render(AuditPage({ chrome, view }));

/** The terms of the definition list of a section with their descriptions, in order. */
export const factsOf = (root: El, id: string): Record<string, string> => {
  const list = all(section(root, id), (el) => el.name === "dl")[0] as El;
  const out: Record<string, string> = {};
  let term = "";
  for (const child of list.children) {
    if (child.type !== "element") continue;
    if (child.name === "dt") term = readable(child);
    else if (child.name === "dd") out[term] = readable(child);
  }
  return out;
};
