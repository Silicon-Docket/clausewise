import { refusalOf } from "../../src/server/routes/notices.js";
import { ValidationError } from "../../src/store/index.js";
import { f1Records } from "../pilot/f1.js";
import {
  adminView,
  buildReference,
  buildTimer,
  emptyRecords,
  matterPagePilot,
  pilotPage,
  referencePane,
  timerPane,
  withSeverities,
} from "./pilot-support.js";
import { buildChrome } from "./support.js";
import type { Variant } from "./variants.js";

/**
 * The page fixtures of the pilot measures page, the timer and the reference list (work package
 * W2.6b), in the same shape as the base list in variants.ts, which spreads this list after its own.
 * The package adds an entry for every state of a page that changes what the page shows, and only in
 * this file.
 *
 * The pilot measures page: the pilot scope as every database of this build gives it (no data), the
 * synthetic scope and the pilot scope over fixture F1 (people who are not demonstration identities,
 * which no database of this build can hold, so that the rows with values are laid out too), the
 * page with a calendar and a roster, the page for a person who may not change them, and the page
 * after each of its two forms was refused.
 *
 * The timer and the reference list: the matter page with each panel in each of its states (a timer
 * not running, running, running on another matter and refused; a reference list open, saved,
 * closed by a review, with no playbook and refused; the page of a viewer, who is given neither), and
 * each panel alone as a pane.
 */

const refused = (code: string) => refusalOf(new ValidationError(code, "words"))!.notice;

const SINCE = "2026-11-03T14:05:00.000Z";
const RUNNING = buildTimer({ running: { since: SINCE }, closedSeconds: 4521, sessions: 3 });
const SAVED = buildReference({
  rules: withSeverities({ "dur-1": "high", "pds-1": "medium" }),
  outside: { high: 1, medium: 0, low: 2 },
  issues: 5,
});

export const VARIANTS_PILOT: Variant[] = [
  ["pilot measures, pilot scope, no data, no calendar", () => pilotPage()],
  [
    "pilot measures, pilot scope, no data, calendar and roster",
    () => pilotPage({ admin: adminView() }),
  ],
  [
    "pilot measures, synthetic scope, no data",
    () => pilotPage({ scope: "synthetic", records: emptyRecords() }),
  ],
  [
    "pilot measures, synthetic scope, every row with a value",
    () => pilotPage({ scope: "synthetic", records: f1Records(), admin: adminView() }),
  ],
  [
    "pilot measures, pilot scope, fixture with people who are not demonstration identities",
    () => pilotPage({ scope: "pilot", records: f1Records(), admin: adminView() }),
  ],
  ["pilot measures, administrator", () => pilotPage({ globalRole: "admin", admin: adminView() })],
  ["pilot measures, read only", () => pilotPage({ readOnly: true, admin: adminView() })],
  [
    "pilot measures, date refused, what was typed kept",
    () =>
      pilotPage({
        admin: adminView(),
        draft: { startDate: "2026-02-30" },
        chrome: { notice: refused("bad_calendar_date") },
      }),
  ],
  [
    "pilot measures, the stored start date cannot be used, the form to mend it",
    () =>
      pilotPage({
        unusableStartDate: "0026-01-05",
        admin: adminView({
          calendar: {
            startDate: "0026-01-05",
            endDate: null,
            usable: false,
            setAt: "2026-01-02T09:00:00.000Z",
            timesSet: 1,
          },
        }),
      }),
  ],
  [
    "pilot measures, roster refused, what was ticked kept",
    () =>
      pilotPage({
        admin: adminView(),
        draft: { trained: ["u_okafor"] },
        chrome: { notice: refused("unknown_user") },
      }),
  ],

  // The timer and the reference list on the matter page
  [
    "matter page, timer not running, associate",
    () => matterPagePilot("associate", { timer: buildTimer() }),
  ],
  ["matter page, timer running, associate", () => matterPagePilot("associate", { timer: RUNNING })],
  [
    "matter page, timer running on another matter, associate",
    () => matterPagePilot("associate", { timer: buildTimer({ elsewhere: true }) }),
  ],
  [
    "matter page, training matter, a timer left running by an earlier build, only the Stop",
    () =>
      matterPagePilot("associate", {
        timer: buildTimer({ allowed: true, training: true, running: { since: SINCE } }),
      }),
  ],
  [
    "matter page, timer not running, reviewing attorney, list open",
    () => matterPagePilot("reviewer", { timer: buildTimer(), reference: buildReference() }),
  ],
  [
    "matter page, timer refused, a timer already runs",
    () =>
      matterPagePilot("associate", {
        timer: RUNNING,
        chrome: buildChrome({ notice: refused("timer_open") }),
      }),
  ],
  [
    "matter page, timer refused, none is running, link to the timer",
    () =>
      matterPagePilot("associate", {
        timer: buildTimer(),
        chrome: buildChrome({ notice: refused("no_open_timer") }),
      }),
  ],
  [
    "matter page, reference list saved",
    () => matterPagePilot("reviewer", { timer: buildTimer(), reference: SAVED }),
  ],
  [
    "matter page, reference list closed by a review",
    () =>
      matterPagePilot("reviewer", {
        timer: buildTimer(),
        reference: buildReference({ ...SAVED, state: "locked" }),
      }),
  ],
  [
    "matter page, reference list closed, nothing was recorded",
    () => matterPagePilot("reviewer", { reference: buildReference({ state: "locked" }) }),
  ],
  [
    "matter page, reference list, no playbook chosen",
    () =>
      matterPagePilot("reviewer", {
        reference: buildReference({ state: "no_playbook", rules: [] }),
      }),
  ],
  [
    "matter page, reference list refused, a count out of range, link to the counts",
    () =>
      matterPagePilot("reviewer", {
        reference: SAVED,
        chrome: buildChrome({ notice: refused("bad_count") }),
      }),
  ],
  [
    "matter page, reference list refused, a rule twice, link to the list",
    () =>
      matterPagePilot("reviewer", {
        reference: SAVED,
        chrome: buildChrome({ notice: refused("duplicate_rule") }),
      }),
  ],
  [
    "matter page, viewer: neither the timer nor the reference list",
    () => matterPagePilot("viewer", { timer: buildTimer({ allowed: false }), reference: null }),
  ],
  ["pane, timer not running", () => timerPane(buildTimer()), { fragment: true }],
  ["pane, timer running", () => timerPane(RUNNING), { fragment: true }],
  [
    "pane, timer left running on a training matter",
    () => timerPane(buildTimer({ allowed: true, training: true, running: { since: SINCE } })),
    { fragment: true },
  ],
  [
    "pane, timer running on another matter",
    () => timerPane(buildTimer({ elsewhere: true })),
    { fragment: true },
  ],
  ["pane, reference list open", () => referencePane(buildReference()), { fragment: true }],
  ["pane, reference list saved", () => referencePane(SAVED), { fragment: true }],
  [
    "pane, reference list closed",
    () => referencePane(buildReference({ ...SAVED, state: "locked" })),
    { fragment: true },
  ],
];
