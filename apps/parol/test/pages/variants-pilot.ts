import { refusalOf } from "../../src/server/routes/notices.js";
import { ValidationError } from "../../src/store/index.js";
import { f1Records } from "../pilot/f1.js";
import { adminView, emptyRecords, pilotPage } from "./pilot-support.js";
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
 */

const refused = (code: string) => refusalOf(new ValidationError(code, "words"))!.notice;

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
    "pilot measures, roster refused, what was ticked kept",
    () =>
      pilotPage({
        admin: adminView(),
        draft: { trained: ["u_okafor"] },
        chrome: { notice: refused("unknown_user") },
      }),
  ],
];
