import type {
  MatterView,
  FindingView,
  IssueRow,
  RunSummary,
  MatterSummary,
} from "../../src/services/views.js";
import {
  ErrorPage,
  FindingPage,
  FindingPane,
  MatterPage,
  MattersPage,
  MemosPage,
  RunPage,
  SignInPage,
  render,
  type Chrome,
  type IssueFilter,
} from "../../src/server/pages/index.js";
import {
  IDS,
  buildChrome,
  buildDocuments,
  buildFindingView,
  buildIssueRows,
  buildMatterSummary,
  buildMatterView,
  buildMemo,
  buildPlaybooks,
  buildRunSummary,
  buildUsers,
  buildWarnings,
} from "./support.js";

/** Short helpers that render a page with realistic defaults, for tests that change one thing. */

export const chrome = buildChrome();

export const mattersPage = (
  matters: MatterSummary[] = [buildMatterSummary()],
  c: Chrome = chrome,
): string =>
  render(MattersPage({ chrome: c, matters, playbooks: buildPlaybooks(), users: buildUsers() }));

export const matterPage = (
  view: MatterView = buildMatterView(),
  options: { canDelete?: boolean; users?: boolean; chrome?: Chrome } = {},
): string =>
  render(
    MatterPage({
      chrome: options.chrome ?? chrome,
      view,
      users: options.users === false ? undefined : buildUsers(),
      canDelete: options.canDelete ?? true,
    }),
  );

export const runPage = (
  options: {
    run?: RunSummary;
    issues?: IssueRow[];
    selected?: FindingView | null;
    selectionMissing?: boolean;
    filter?: IssueFilter;
    withWarnings?: boolean;
  } = {},
): string =>
  render(
    RunPage({
      chrome,
      matter: buildMatterSummary(),
      run: options.run ?? buildRunSummary(),
      issues: options.issues ?? buildIssueRows(),
      selected: options.selected === undefined ? buildFindingView() : options.selected,
      selectionMissing: options.selectionMissing,
      filter: options.filter,
      warnings: options.withWarnings === false ? undefined : buildWarnings(),
      documents: buildDocuments(),
    }),
  );

export const paneOnly = (finding: FindingView = buildFindingView(), c: Chrome = chrome): string =>
  render(FindingPane({ chrome: c, matterId: IDS.matter, finding }));

export const findingPage = (finding: FindingView = buildFindingView()): string =>
  render(
    FindingPage({ chrome, matterId: IDS.matter, matterName: "Lanternfish / Corvane NDA", finding }),
  );

export const memosPage = (canExport = true, blocked: string | null = null): string =>
  render(
    MemosPage({
      chrome,
      matter: buildMatterSummary(),
      memos: [
        buildMemo(),
        buildMemo({ memoId: "memo_0002", status: "superseded", fileName: "older-memo.docx" }),
      ],
      canExport,
      exportBlockedReason: blocked,
    }),
  );

export const errorPage = (c: Chrome = chrome): string =>
  render(
    ErrorPage({
      chrome: c,
      status: 404,
      title: "Page not found",
      message: "There is no such page, or you cannot see it.",
    }),
  );

export const signInPage = (users = buildUsers()): string =>
  render(SignInPage({ chrome: buildChrome({ userName: null }), users }));
