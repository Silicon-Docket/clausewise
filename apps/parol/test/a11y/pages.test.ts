import { describe, expect, it } from "vitest";
import { GLOBAL_ACTIONS, globalRoleAllows, type GlobalAction } from "../../src/auth/actions.js";
import {
  GLOBAL_ROLES,
  MATTER_ROLES,
  type GlobalRole,
  type MatterRole,
} from "../../src/contracts.js";
import {
  FindingPage,
  FindingPane,
  MemosPage,
  RunPage,
  render,
  type Chrome,
} from "../../src/server/pages/index.js";
import { CANNOT_DECIDE } from "../../src/services/phrases.js";
import type { FindingView, MatterView, RunSummary } from "../../src/services/views.js";
import { comparisonPage } from "../evaluations/fixtures.js";
import { comparisonHtml, listHtml, memorySource } from "../evaluations/render.js";
import { all, attr, byId, byTag, parseHtml, readable, type El } from "../pages/html.js";
import { errorPage, mattersPage, matterPage, signInPage } from "../pages/render.js";
import {
  IDS,
  buildAllKindsFinding,
  buildChrome,
  buildConflictFinding,
  buildDecidedFinding,
  buildDocuments,
  buildFindingView,
  buildIssueRows,
  buildMatterSummary,
  buildMatterView,
  buildMemo,
  buildNotReadyMatterView,
  buildRunSummary,
  buildRunningMatterView,
  buildStaleFinding,
  buildStaleMatterView,
  buildUnverifiedFinding,
  buildWarnings,
} from "../pages/support.js";
import { feedbackProps, ratingProps } from "../pages/feedback-support.js";
import { auditPage as auditView, buildAuditView } from "../pages/audit-support.js";
import { helpHtml, quickstartHtml, trainerKeyHtml } from "../pages/training-support.js";
import { pilotPage } from "../pages/pilot-support.js";
import { variants } from "../pages/variants.js";
import { PAGE_GETS, type PageGet } from "./inventory.js";
import { auditPage, formatViolations } from "./rules.js";

/**
 * The page fixtures, swept. Every fixture of the list (`variants.ts` and the fragment of each
 * package) is held to the rules of `rules.ts`, and so is every page in every role it is shown to:
 * the three roles on a matter, and the three global roles in the frame around every page. A fixture
 * is a page the application can build and a route cannot easily produce (an out-of-date review, a
 * failed one, an unverified quote, a refusal of each kind), so the sweep covers what
 * `routes.test.ts` cannot reach, and `routes.test.ts` covers what the fixtures cannot: the HTML the
 * routes really send. The rules read the HTML and nothing else: no browser, no stylesheet, no
 * screen reader. The data is synthetic.
 */

const problemsOf = (label: string, html: string, fragment = false): string[] => {
  const violations = auditPage(parseHtml(html), { fragment });
  return violations.length === 0 ? [] : [`${label}:\n${formatViolations(violations)}`];
};

/** Renders each case and returns what the rules found, one entry per page that has problems. */
const sweep = (cases: readonly (readonly [string, () => string])[], fragment = false): string[] =>
  cases.flatMap(([label, make]) => problemsOf(label, make(), fragment));

describe("the list of page fixtures", () => {
  it("holds every fixture to every accessibility rule, whole pages and panes alike", () => {
    expect(variants.length).toBeGreaterThan(100);
    const problems = variants.flatMap(([name, make, options]) =>
      problemsOf(name, make(), options?.fragment === true),
    );
    expect(problems).toEqual([]);
  });

  it("holds a whole page for every page the application serves", () => {
    // What marks a page of each route, in a fixture. Typed by the list of page routes, so a page
    // route added there has to be given its mark here, and so a fixture, before the tests pass.
    const IS_PAGE: Record<PageGet, (root: El) => boolean> = {
      "/": (root) => hasHeading(root, "Choose a demo identity"),
      "/matters": (root) => hasHeading(root, "Matters"),
      "/matters/:matterId": (root) => byId(root, "documents") !== undefined,
      "/matters/:matterId/runs/:runId": (root) => byId(root, "inspector") !== undefined,
      "/matters/:matterId/findings/:findingId": (root) =>
        byId(root, "inspector") === undefined &&
        all(root, (el) => attr(el, "data-finding") !== undefined).length > 0,
      "/matters/:matterId/memos": (root) => titleStartsWith(root, "Memos for "),
      "/quickstart": (root) => hasHeading(root, "Quickstart"),
      "/help": (root) => hasHeading(root, "Help"),
      "/evaluations": (root) =>
        hasHeading(root, "Evaluations") || hasHeading(root, "Compare workflow versions"),
      "/pilot": (root) => hasHeading(root, "Pilot measures"),
      "/audit": (root) => hasHeading(root, "Audit log check"),
      "/training/key": (root) => hasHeading(root, "Trainer's key"),
    };
    const whole = variants
      .filter(([, , options]) => options?.fragment !== true)
      .map(([name, make]) => ({ name, root: parseHtml(make()) }));
    for (const route of PAGE_GETS) {
      const found = whole.filter((page) => IS_PAGE[route](page.root));
      expect(found.length, `no whole-page fixture for ${route}`).toBeGreaterThan(0);
    }
    // The two pages of the evaluation route are both held, and the frame of a visitor.
    expect(whole.some((page) => hasHeading(page.root, "Evaluations"))).toBe(true);
    expect(whole.some((page) => hasHeading(page.root, "Compare workflow versions"))).toBe(true);
  });
});

const hasHeading = (root: El, text: string): boolean =>
  byTag(root, "h1").some((h1) => readable(h1) === text);
const titleStartsWith = (root: El, text: string): boolean =>
  byTag(root, "title").some((title) => readable(title).startsWith(text));

// ---------------------------------------------------------------------------------------------
// The roles on a matter
// ---------------------------------------------------------------------------------------------

const asRole = (view: MatterView, role: MatterRole): MatterView => ({
  ...view,
  matter: { ...view.matter, role },
});

const failedRun: RunSummary = buildRunSummary({
  status: "failed",
  errorKind: "provider_auth",
  resumable: true,
  findingCount: 0,
});

/** The matter page in each state a matter can be in, as the view model of the associate. */
const MATTER_STATES: readonly (readonly [string, () => MatterView])[] = [
  ["reviewed", () => buildMatterView()],
  ["out of date", () => buildStaleMatterView()],
  ["review under way", () => buildRunningMatterView()],
  ["not ready to start", () => buildNotReadyMatterView()],
  [
    "nothing in it",
    () =>
      buildMatterView({
        matter: buildMatterSummary({ status: "draft" }),
        documents: [],
        warnings: [],
        currentRun: null,
        runs: [],
        start: { ready: false, reasons: ["Add the NDA"] },
      }),
  ],
  [
    "review failed",
    () => buildMatterView({ currentRun: failedRun, runs: [failedRun], staleReason: null }),
  ],
  [
    "exported",
    () =>
      buildMatterView({
        matter: buildMatterSummary({ status: "exported" }),
        memos: [buildMemo(), buildMemo({ memoId: "memo_0002", status: "superseded" })],
      }),
  ],
  ["a server for one person", () => buildMatterView({ segregationRelaxed: true })],
];

describe("the matter page, in every state, as every role on the matter", () => {
  it("is held to the rules in each combination", () => {
    const cases: [string, () => string][] = [];
    for (const role of MATTER_ROLES) {
      for (const [state, view] of MATTER_STATES) {
        // The person who made the matter may delete it, whatever the role; the others never.
        for (const canDelete of role === "associate" ? [true, false] : [false])
          cases.push([
            `matter, ${state}, ${role}${canDelete ? ", may delete" : ""}`,
            () => matterPage(asRole(view(), role), { canDelete }),
          ]);
      }
    }
    expect(cases.length).toBe(MATTER_STATES.length * (MATTER_ROLES.length + 1));
    expect(sweep(cases)).toEqual([]);
  });

  it("covers every role there is: a role added to the tables is swept without anyone adding it here", () => {
    expect([...MATTER_ROLES]).toEqual(["associate", "reviewer", "viewer"]);
  });
});

const review = (
  role: MatterRole,
  chrome: Chrome,
  options: {
    run?: RunSummary;
    issues?: ReturnType<typeof buildIssueRows>;
    selected?: FindingView | null;
    selectionMissing?: boolean;
    filter?: "all" | "open" | "escalated" | "stale";
  } = {},
): string =>
  render(
    RunPage({
      chrome,
      matter: buildMatterSummary({ role }),
      run: options.run ?? buildRunSummary(),
      issues: options.issues ?? buildIssueRows(),
      selected: options.selected === undefined ? buildFindingView() : options.selected,
      selectionMissing: options.selectionMissing,
      filter: options.filter,
      warnings: buildWarnings(),
      documents: buildDocuments(),
      feedback: feedbackProps(),
    }),
  );

const RUN_STATES: readonly (readonly [string, Parameters<typeof review>[2]])[] = [
  ["a finding chosen", {}],
  ["nothing chosen", { selected: null }],
  ["a finding that is not in it", { selected: null, selectionMissing: true }],
  ["filtered to the open", { filter: "open" }],
  ["filtered to the escalated", { filter: "escalated", selected: null }],
  ["filtered to what is out of date", { filter: "stale", selected: null }],
  ["no findings", { issues: [], selected: null }],
  ["out of date", { run: buildRunSummary({ current: false }), selected: buildStaleFinding() }],
  [
    "under way",
    {
      run: buildRunSummary({
        status: "analyzing",
        finishedAt: null,
        progress: { stage: "analyze", done: 3, total: 8 },
      }),
      issues: [],
      selected: null,
    },
  ],
  ["failed", { run: failedRun, issues: [], selected: null }],
  ["a finding nobody may decide", { selected: buildDecidedFinding() }],
];

describe("the review page, in every state, as every role on the matter", () => {
  it("is held to the rules in each combination", () => {
    const cases: [string, () => string][] = [];
    for (const role of MATTER_ROLES)
      for (const [state, options] of RUN_STATES)
        cases.push([`review, ${state}, ${role}`, () => review(role, buildChrome(), options)]);
    expect(sweep(cases)).toEqual([]);
  });
});

const REASONS: readonly (readonly [string, FindingView["canDecide"]])[] = [
  ["a person who may decide", { allowed: true, reason: null }],
  ...Object.entries(CANNOT_DECIDE).map(
    ([key, reason]) => [`the reason "${key}"`, { allowed: false, reason }] as const,
  ),
];

const FINDINGS: readonly (readonly [string, () => FindingView])[] = [
  ["open", () => buildFindingView()],
  ["decided", () => buildDecidedFinding()],
  ["out of date", () => buildStaleFinding()],
  ["in conflict", () => buildConflictFinding()],
  ["with a quote that did not verify", () => buildUnverifiedFinding()],
  ["with every kind of passage", () => buildAllKindsFinding()],
];

describe("a finding, as a person who may decide it and as each person who may not", () => {
  it("is held to the rules on the page and in the pane, for every reason the gate gives", () => {
    const page = (finding: FindingView): string =>
      render(
        FindingPage({
          chrome: buildChrome(),
          matterId: IDS.matter,
          matterName: "Lanternfish / Corvane NDA",
          finding,
          currentRunId: IDS.run,
        }),
      );
    const pane = (finding: FindingView): string =>
      render(FindingPane({ chrome: buildChrome(), matterId: IDS.matter, finding }));
    const cases: [string, () => string][] = [];
    const panes: [string, () => string][] = [];
    for (const [who, canDecide] of REASONS) {
      for (const [state, make] of FINDINGS) {
        const finding = (): FindingView => ({ ...make(), canDecide: { ...canDecide } });
        cases.push([`finding page, ${state}, ${who}`, () => page(finding())]);
        panes.push([`finding pane, ${state}, ${who}`, () => pane(finding())]);
      }
    }
    expect(cases.length).toBe(REASONS.length * FINDINGS.length);
    expect([...sweep(cases), ...sweep(panes, true)]).toEqual([]);
  });

  it("is given every reason the application can give (the gate and this list are the same)", () => {
    expect(REASONS.length).toBe(Object.keys(CANNOT_DECIDE).length + 1);
  });
});

describe("the memos page, as a person who may export and as one who may not", () => {
  it("is held to the rules whether there are memos or none, and whether the export is blocked", () => {
    const cases: [string, () => string][] = [];
    for (const role of MATTER_ROLES) {
      const canExport = role === "reviewer";
      for (const memos of [
        [],
        [buildMemo(), buildMemo({ memoId: "memo_0002", status: "superseded" })],
      ])
        for (const blocked of canExport ? [null, "Decide every finding first."] : [null])
          cases.push([
            `memos, ${role}, ${memos.length === 0 ? "none" : "two"}${blocked === null ? "" : ", export blocked"}`,
            () =>
              render(
                MemosPage({
                  chrome: buildChrome(),
                  matter: buildMatterSummary({ role }),
                  memos,
                  canExport,
                  exportBlockedReason: blocked,
                  currentRunId: IDS.run,
                  rating: ratingProps(),
                }),
              ),
          ]);
    }
    expect(cases.length).toBe(2 * (2 + 1 + 1));
    expect(sweep(cases)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The global roles, in the frame of every page
// ---------------------------------------------------------------------------------------------

/** The global roles that may open a page that names a global action, from the table the routes read. */
const rolesFor = (action: GlobalAction): GlobalRole[] =>
  GLOBAL_ROLES.filter((role) => globalRoleAllows(role, action));

describe("the frame around every page, as each global role sees it", () => {
  it("is held to the rules on every page that a person of that role is shown", () => {
    const cases: [string, () => string][] = [];
    for (const role of GLOBAL_ROLES) {
      const chrome = buildChrome({ globalRole: role });
      cases.push(
        [`matters, ${role}`, () => mattersPage([buildMatterSummary()], chrome)],
        [`matters, none, ${role}`, () => mattersPage([], chrome)],
        [`matter, ${role}`, () => matterPage(buildMatterView(), { chrome })],
        [`review, ${role}`, () => review("reviewer", chrome)],
        [
          `finding, ${role}`,
          () =>
            render(
              FindingPage({
                chrome,
                matterId: IDS.matter,
                matterName: "Lanternfish / Corvane NDA",
                finding: buildFindingView(),
                currentRunId: IDS.run,
              }),
            ),
        ],
        [
          `memos, ${role}`,
          () =>
            render(
              MemosPage({
                chrome,
                matter: buildMatterSummary(),
                memos: [buildMemo()],
                canExport: true,
                exportBlockedReason: null,
              }),
            ),
        ],
        [`a refusal, ${role}`, () => errorPage(chrome)],
        [`quickstart, ${role}`, () => quickstartHtml({ chrome })],
        [`help, ${role}`, () => helpHtml(chrome)],
      );
      if (rolesFor("evaluation.read").includes(role)) {
        const published = comparisonPage();
        cases.push(
          [`evaluations, ${role}`, () => listHtml(memorySource([published]), chrome)],
          [`comparison, ${role}`, () => comparisonHtml(published, {}, chrome)],
        );
      }
      if (rolesFor("pilot.read").includes(role))
        cases.push([`pilot measures, ${role}`, () => pilotPage({ globalRole: role })]);
      if (rolesFor("audit.read").includes(role))
        cases.push([`audit log, ${role}`, () => auditView(buildAuditView(), chrome)]);
      if (rolesFor("training.key").includes(role))
        cases.push([`trainer key, ${role}`, () => trainerKeyHtml(chrome)]);
    }
    expect(cases.length).toBeGreaterThan(30);
    expect(sweep(cases)).toEqual([]);
  });

  it("holds the pages of a visitor, who has no global role", () => {
    const visitor = buildChrome({ userName: null });
    expect(
      sweep([
        ["sign in", () => signInPage()],
        ["sign in, no one to sign in as", () => signInPage([])],
        ["quickstart, visitor", () => quickstartHtml({ chrome: visitor })],
        ["help, visitor", () => helpHtml(visitor)],
        ["a refusal, visitor", () => errorPage(visitor)],
      ]),
    ).toEqual([]);
  });

  it("is made for every global role there is and every global action: a new one is swept without being added here", () => {
    expect([...GLOBAL_ROLES]).toEqual(["member", "legal_engineer", "admin"]);
    // The pages named above are the pages that name an action: if one is added, this list is stale.
    expect(Object.keys(GLOBAL_ACTIONS).sort()).toEqual([
      "audit.read",
      "evaluation.read",
      "pilot.manage",
      "pilot.read",
      "training.key",
    ]);
  });
});
