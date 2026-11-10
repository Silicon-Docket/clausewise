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
  buildAllKindsFinding,
  buildChrome,
  buildConflictFinding,
  buildDecidedFinding,
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
        buildChrome({ notice: { kind: "error", text: "The file could not be read." } }),
      ),
  ],
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
