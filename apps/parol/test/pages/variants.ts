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

/** Every page, in every state that changes what it shows. Shared by the tests that sweep them all. */
export const variants: [string, () => string, { fragment?: boolean }?][] = [
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
