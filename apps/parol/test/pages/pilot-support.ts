import { computePilotMeasures, presentMeasures } from "../../src/pilot/index.js";
import type {
  PilotAdminView,
  PilotMeasuresView,
  PilotRecords,
  PilotScope,
  ReferenceView,
  TimerView,
} from "../../src/pilot/index.js";
import type { GlobalRole, MatterRole } from "../../src/contracts.js";
import { MatterPage, render, type Chrome } from "../../src/server/pages/index.js";
import { PilotPage, type PilotDraft } from "../../src/server/pages/pilot.js";
import { ReferencePanel } from "../../src/server/pages/reference.js";
import { TimerPanel } from "../../src/server/pages/timer.js";
import type { MatterView } from "../../src/services/views.js";
import { auditPage, type Violation } from "../a11y/rules.js";
import { AS_OF, f1Records } from "../pilot/f1.js";
import { parseHtml } from "./html.js";
import { IDS, buildChrome, buildMatterViewFor, buildUsers } from "./support.js";

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

// ---------------------------------------------------------------------------------------------
// The timer and the reference list on the matter page
// ---------------------------------------------------------------------------------------------

/** A timer view for a person who may time the matter, with none running and nothing timed yet. */
export function buildTimer(overrides: Partial<TimerView> = {}): TimerView {
  return {
    allowed: true,
    running: null,
    elsewhere: false,
    closedSeconds: 0,
    sessions: 0,
    ...overrides,
  };
}

/** The rules of a synthetic playbook of eight rules, in the order of the playbook. */
export const REFERENCE_RULES: ReferenceView["rules"] = [
  { ruleKey: "pty-1", title: "The parties are named", severity: null },
  { ruleKey: "def-1", title: "Confidential information is defined", severity: null },
  { ruleKey: "exc-1", title: "The usual exclusions are present", severity: null },
  { ruleKey: "pds-1", title: "Disclosure to advisers is allowed", severity: null },
  { ruleKey: "pds-2", title: "Disclosure when the law requires it", severity: null },
  { ruleKey: "dur-1", title: "The obligations end after a fixed term", severity: null },
  { ruleKey: "ret-1", title: "Material is returned or destroyed", severity: null },
  { ruleKey: "gov-1", title: "The governing law is acceptable", severity: null },
];

/** A reference list that is open, with the rules of the synthetic playbook and nothing recorded. */
export function buildReference(overrides: Partial<ReferenceView> = {}): ReferenceView {
  return {
    state: "open",
    rules: REFERENCE_RULES,
    outside: { high: 0, medium: 0, low: 0 },
    issues: 0,
    ...overrides,
  };
}

/** The same list with a severity set on some rules, as a saved list reads. */
export function withSeverities(
  severities: Record<string, "high" | "medium" | "low">,
): ReferenceView["rules"] {
  return REFERENCE_RULES.map((rule) => ({ ...rule, severity: severities[rule.ruleKey] ?? null }));
}

/** The timer panel alone, as a pane (no frame). Empty when it renders nothing. */
export function timerPane(timer: TimerView | undefined, chrome: Chrome = buildChrome()): string {
  const pane = TimerPanel({ chrome, matterId: IDS.matter, timer });
  return pane === null ? "" : render(pane);
}

/** The reference list alone, as a pane (no frame). Empty when it renders nothing. */
export function referencePane(
  reference: ReferenceView | null | undefined,
  chrome: Chrome = buildChrome(),
): string {
  const pane = ReferencePanel({ chrome, matterId: IDS.matter, reference });
  return pane === null ? "" : render(pane);
}

export interface MatterPilotFixture {
  timer?: TimerView | undefined;
  reference?: ReferenceView | null | undefined;
  view?: Partial<MatterView>;
  chrome?: Chrome;
}

/** The whole matter page for a role, with the two optional panels as the service would fill them. */
export function matterPagePilot(role: MatterRole, fixture: MatterPilotFixture = {}): string {
  return render(
    MatterPage({
      chrome: fixture.chrome ?? buildChrome(),
      view: buildMatterViewFor(role, fixture.view ?? {}),
      users: buildUsers(),
      canDelete: role === "associate",
      timer: fixture.timer,
      reference: fixture.reference,
    }),
  );
}

/**
 * What the accessibility rules find on a whole matter page that they do not find on the same page
 * without the two pilot panels. The rest of the matter page is the sweep of a later package
 * (W2.9-fix), so the panels are held to the rules by what they add, and the panes are audited
 * alone as well, where nothing else is on the page.
 */
export function violationsAddedByPanels(
  role: MatterRole,
  fixture: MatterPilotFixture,
): Violation[] {
  const key = (v: Violation): string => `${v.rule}|${v.where}|${v.detail}`;
  const before = new Map<string, number>();
  const without = { ...fixture, timer: undefined, reference: undefined };
  for (const v of auditPage(parseHtml(matterPagePilot(role, without))))
    before.set(key(v), (before.get(key(v)) ?? 0) + 1);
  const added: Violation[] = [];
  for (const v of auditPage(parseHtml(matterPagePilot(role, fixture)))) {
    const left = before.get(key(v)) ?? 0;
    if (left > 0) before.set(key(v), left - 1);
    else added.push(v);
  }
  return added;
}
