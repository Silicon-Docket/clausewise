import { GUIDANCE_BY_STATUS, GUIDANCE_KEYS, type GuidanceKey } from "../../src/server/guidance.js";
import { titleFor } from "../../src/server/middleware/errors.js";
import {
  FindingPage,
  MemosPage,
  RunPage,
  render,
  renderErrorPage,
} from "../../src/server/pages/index.js";
import {
  errorPage,
  findingPage,
  matterPage,
  mattersPage,
  memosPage,
  paneOnly,
  runPage,
  signInPage,
} from "./render.js";
import {
  IDS,
  buildAllKindsFinding,
  buildChrome,
  buildConflictFinding,
  buildDecidedFinding,
  buildEvidence,
  buildFindingView,
  buildIssueRows,
  buildMatterSummary,
  buildMatterViewFor,
  buildNotReadyMatterView,
  buildRunSummary,
  buildRunningMatterView,
  buildStaleFinding,
  buildStaleMatterView,
  buildUndecidableFinding,
  buildUnverifiedFinding,
  buildMatterView,
  buildMemo,
} from "./support.js";
import { VARIANTS_EVALUATIONS } from "./variants-evaluations.js";
import { VARIANTS_FEEDBACK } from "./variants-feedback.js";
import { VARIANTS_PILOT } from "./variants-pilot.js";
import { VARIANTS_RETENTION } from "./variants-retention.js";
import { VARIANTS_TRAINING } from "./variants-training.js";
import { VARIANTS_USAGE } from "./variants-usage.js";

/**
 * One page fixture: a name, the page as HTML, and `fragment: true` for a pane that is a piece of a
 * page and not a whole document.
 */
export type Variant = [string, () => string, { fragment?: boolean }?];

/** The id a server fault carries (`req_` and sixteen hex digits), so that the 500 page prints one. */
const REQUEST_ID = "req_0123456789abcdef";

/**
 * The status each guidance key is answered with: its own where the table gives one, 403 for the
 * causes of a 403 that the shell names from the kind of error, and a status the table does not know
 * for `other`, which is what the key is for.
 */
const statusOfKey = (key: GuidanceKey): number => {
  const own = Object.entries(GUIDANCE_BY_STATUS).find(([, k]) => k === key)?.[0];
  if (own !== undefined) return Number(own);
  return key === "csrf" || key === "host" || key === "global_role" ? 403 : 418;
};

/**
 * One error page for every key of `server/guidance.ts`, made by the renderer the shell uses. A key
 * added there is a page in the sweep of every page, without anyone adding it here.
 */
const ERROR_PAGE_VARIANTS: Variant[] = GUIDANCE_KEYS.map((key) => {
  const status = statusOfKey(key);
  return [
    `error page, ${key}`,
    () => renderErrorPage(status, titleFor(status), status === 500 ? REQUEST_ID : undefined, key),
  ];
});

/** A long paragraph, cited twice by one finding: two scroll boxes with one location to tell apart. */
const buildTwiceCitedLongFinding = () => {
  const long = `${"The Receiving Party shall keep the information confidential. ".repeat(40)}Final sentence.`;
  const cite = (id: string, quote: string) =>
    buildEvidence({
      id,
      spanId: "dv_d1v1:p4",
      location: "Mutual NDA (v1), Section 4, paragraph 4",
      quote,
      role: "supporting",
      spanText: long,
    });
  return buildFindingView({
    evidence: [
      cite("ev_long_a", "shall keep the information confidential"),
      cite("ev_long_b", "Final sentence"),
    ],
  });
};

/** The finding page as a route makes it, with the review the matter shows now to go back to. */
const findingPageWithReview = (
  finding = buildFindingView(),
  currentRunId: string | null = IDS.run,
) =>
  render(
    FindingPage({
      chrome: buildChrome(),
      matterId: IDS.matter,
      matterName: "Lanternfish / Corvane NDA",
      finding,
      currentRunId,
    }),
  );

/** The review page for a given role, for the empty states whose words depend on it. */
const runPageFor = (role: "associate" | "reviewer" | "viewer", issuesOnly: boolean) =>
  render(
    RunPage({
      chrome: buildChrome(),
      matter: buildMatterSummary({ role }),
      run: buildRunSummary(),
      issues: issuesOnly ? buildIssueRows() : [],
      selected: null,
      filter: issuesOnly ? "stale" : "all",
    }),
  );

/** The memos page with no memo yet, for a person who may export and for one who may not. */
const memosPageWithoutMemos = (canExport: boolean) =>
  render(
    MemosPage({
      chrome: buildChrome(),
      matter: buildMatterSummary(),
      memos: [],
      canExport,
      exportBlockedReason: canExport ? "Decide every finding first." : null,
    }),
  );

/**
 * The pages that exist before the packages of week two part 3, in every state that changes what
 * they show. A package that adds a page does not edit this list: it adds its fixtures to its own
 * `variants-<name>.ts`, which is spread after this list below.
 */
const BASE_VARIANTS: Variant[] = [
  ["matters, none", () => mattersPage([])],
  [
    "matters, several",
    () =>
      mattersPage([
        buildMatterSummary(),
        buildMatterSummary({
          id: "m_two",
          name: "Second",
          status: "draft",
          synthetic: false,
          playbook: null,
        }),
      ]),
  ],
  ["matter, associate", () => matterPage(buildMatterViewFor("associate"))],
  ["matter, reviewer", () => matterPage(buildMatterViewFor("reviewer"), { canDelete: false })],
  ["matter, viewer", () => matterPage(buildMatterViewFor("viewer"), { canDelete: false })],
  ["matter, stale", () => matterPage(buildStaleMatterView())],
  ["matter, running", () => matterPage(buildRunningMatterView())],
  ["matter, not ready", () => matterPage(buildNotReadyMatterView())],
  [
    "matter, exported",
    () =>
      matterPage(
        buildMatterViewFor("reviewer", {
          memos: [buildMemo(), buildMemo({ memoId: "m2", status: "superseded" })],
          matter: buildMatterSummary({ status: "exported", role: "reviewer" }),
        }),
        { canDelete: false },
      ),
  ],
  ["matter, no users", () => matterPage(buildMatterView(), { users: false })],
  ["run, selected", () => runPage()],
  ["run, nothing selected", () => runPage({ selected: null })],
  ["run, selection missing", () => runPage({ selected: null, selectionMissing: true })],
  [
    "run, running",
    () =>
      runPage({
        run: buildRunSummary({
          status: "extracting",
          progress: { stage: "extract", done: 1, total: 2 },
          finishedAt: null,
        }),
        issues: [],
        selected: null,
      }),
  ],
  [
    "run, queued",
    () =>
      runPage({
        run: buildRunSummary({ status: "queued", progress: null, finishedAt: null }),
        issues: [],
        selected: null,
      }),
  ],
  [
    "run, failed",
    () =>
      runPage({
        run: buildRunSummary({ status: "failed", errorKind: "provider_auth" }),
        issues: [],
        selected: null,
      }),
  ],
  ["run, out of date", () => runPage({ run: buildRunSummary({ current: false }) })],
  ["run, no findings", () => runPage({ issues: [], selected: null })],
  ["run, filtered", () => runPage({ filter: "escalated" })],
  ["run, stale finding", () => runPage({ selected: buildStaleFinding() })],
  ["finding page", () => findingPage()],
  ["finding page, conflict", () => findingPage(buildConflictFinding())],
  ["pane, decided", () => paneOnly(buildDecidedFinding()), { fragment: true }],
  ["pane, stale", () => paneOnly(buildStaleFinding()), { fragment: true }],
  ["pane, undecidable", () => paneOnly(buildUndecidableFinding()), { fragment: true }],
  ["pane, unverified quote", () => paneOnly(buildUnverifiedFinding()), { fragment: true }],
  ["pane, conflict", () => paneOnly(buildConflictFinding()), { fragment: true }],
  ["pane, every kind of passage", () => paneOnly(buildAllKindsFinding()), { fragment: true }],
  ["memos, reviewer", () => memosPage(true)],
  [
    "memos, blocked",
    () => memosPage(true, "The results are out of date. Run the review again first."),
  ],
  ["memos, viewer", () => memosPage(false)],
  ["error", () => errorPage()],
  ["error, signed out", () => errorPage(buildChrome({ userName: null }))],
  ["sign in", () => signInPage()],
  ["sign in, no users", () => signInPage([])],
  [
    "notice",
    () =>
      mattersPage(
        [],
        buildChrome({ notice: { kind: "success", text: "The decision was saved." } }),
      ),
  ],
  [
    "error notice",
    () =>
      mattersPage(
        [],
        buildChrome({
          notice: {
            kind: "error",
            text: "The file could not be read. Choose another file.",
            todo: "Choose another file.",
          },
        }),
      ),
  ],
  [
    "error notice, with a link to the field",
    () =>
      render(
        FindingPage({
          chrome: buildChrome({
            notice: {
              kind: "error",
              text: "A reason is needed to reject a finding. Give a reason.",
              todo: "Give a reason.",
              jump: { href: "#decision-reason", label: "Go to the reason" },
            },
          }),
          matterId: IDS.matter,
          matterName: "Lanternfish / Corvane NDA",
          finding: buildFindingView(),
        }),
      ),
  ],
  ["finding page, with the way back to the review", () => findingPageWithReview()],
  [
    "finding page, out of date, with the way back to the review",
    () => findingPageWithReview(buildStaleFinding()),
  ],
  ["finding page, no current review", () => findingPageWithReview(buildFindingView(), null)],
  [
    "finding page, one long paragraph cited twice",
    () => findingPageWithReview(buildTwiceCitedLongFinding()),
  ],
  [
    "pane, nothing cited, no checks, no suggestion, no history",
    () =>
      paneOnly(
        buildFindingView({
          evidence: [],
          checks: [],
          fallbackLanguage: null,
          reviews: [],
        }),
      ),
    { fragment: true },
  ],
  // The empty states, with the words of each role that can reach them.
  [
    "matter, empty, reviewer",
    () =>
      matterPage(
        buildMatterViewFor("reviewer", {
          matter: buildMatterSummary({ status: "draft", role: "reviewer" }),
          documents: [],
          warnings: [],
          currentRun: null,
          runs: [],
          start: { ready: false, reasons: ["Add the NDA"] },
        }),
        { canDelete: false },
      ),
  ],
  ["memos, none, reviewer", () => memosPageWithoutMemos(true)],
  ["memos, none, viewer", () => memosPageWithoutMemos(false)],
  ["run, no findings, viewer", () => runPageFor("viewer", false)],
  ["run, no finding matches the filter", () => runPageFor("associate", true)],
  ...ERROR_PAGE_VARIANTS,
];

/** Every page, in every state that changes what it shows. Shared by the tests that sweep them all. */
export const variants: Variant[] = [
  ...BASE_VARIANTS,
  ...VARIANTS_USAGE,
  ...VARIANTS_EVALUATIONS,
  ...VARIANTS_RETENTION,
  ...VARIANTS_FEEDBACK,
  ...VARIANTS_TRAINING,
  ...VARIANTS_PILOT,
];
