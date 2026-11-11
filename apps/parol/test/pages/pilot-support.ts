import { computePilotMeasures, presentMeasures } from "../../src/pilot/index.js";
import type {
  PilotAdminView,
  PilotMeasuresView,
  PilotRecords,
  PilotScope,
} from "../../src/pilot/index.js";
import type { GlobalRole } from "../../src/contracts.js";
import { render, type Chrome } from "../../src/server/pages/index.js";
import { PilotPage, type PilotDraft } from "../../src/server/pages/pilot.js";
import { AS_OF, f1Records } from "../pilot/f1.js";
import { buildChrome } from "./support.js";

/**
 * Fixtures of the pilot measures page (package W2.6b): the view the service would make from a set
 * of records, in the states that change what the page shows. The records are synthetic: either none
 * at all (what every database this build can make gives for the pilot scope), or fixture F1 of the
 * pure module (`test/pilot/f1.ts`, with people who are not demonstration identities, which no
 * database of this build can hold), which fills every row of the page.
 */

/** No matter, no person, no event, and no calendar. */
export function emptyRecords(): PilotRecords {
  return {
    calendar: null,
    matters: [],
    members: [],
    playbooks: [],
    runs: [],
    findings: [],
    decisions: [],
    staleDecisions: [],
    memos: [],
    missedIssues: [],
    ratings: [],
    timeEntries: [],
    referenceIssues: [],
    participants: [],
    auditMatters: [],
  };
}

const REASON_CODES = [
  "wrong_status",
  "wrong_evidence",
  "missed_context",
  "bad_fallback",
  "unclear",
  "other",
];

/** The page's view of a set of records in a scope, made by the code the service uses. */
export function measuresView(records: PilotRecords, scope: PilotScope): PilotMeasuresView {
  return presentMeasures(
    computePilotMeasures(records, { scope, asOf: AS_OF, reasonCodes: REASON_CODES }),
  );
}

export const PEOPLE: PilotAdminView["participants"] = [
  { userId: "u_ruiz", name: "A. Ruiz", trained: true, completedTraining: true },
  { userId: "u_whitfield", name: "D. Whitfield", trained: true, completedTraining: false },
  { userId: "u_okafor", name: "P. Okafor", trained: false, completedTraining: false },
  { userId: "u_lindqvist", name: "S. Lindqvist", trained: false, completedTraining: false },
];

export function adminView(overrides: Partial<PilotAdminView> = {}): PilotAdminView {
  return {
    calendar: {
      startDate: "2026-01-05",
      endDate: "2026-02-08",
      setAt: "2026-01-02T09:00:00.000Z",
      timesSet: 1,
    },
    participants: PEOPLE,
    ...overrides,
  };
}

export interface PilotPageFixture {
  scope?: PilotScope;
  records?: PilotRecords;
  admin?: PilotAdminView;
  draft?: PilotDraft;
  /** Default: the legal engineer, who may change the calendar and the roster. */
  globalRole?: GlobalRole;
  /** A chrome that carries no global role, so the page offers no form. */
  readOnly?: boolean;
  chrome?: Partial<Chrome>;
}

/** The pilot page as a person of a global role is sent it. */
export function pilotPage(fixture: PilotPageFixture = {}): string {
  const scope = fixture.scope ?? "pilot";
  return render(
    PilotPage({
      chrome: buildChrome({
        ...(fixture.readOnly === true
          ? {}
          : { globalRole: fixture.globalRole ?? "legal_engineer" }),
        ...fixture.chrome,
      }),
      view: measuresView(fixture.records ?? emptyRecords(), scope),
      admin: fixture.admin ?? adminView({ calendar: null }),
      draft: fixture.draft,
    }),
  );
}
