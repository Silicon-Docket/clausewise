import type { Context } from "hono";
import { roleAllows } from "../../auth/actions.js";
import type { AuthorizedMatter, Principal } from "../../auth/types.js";
import type { AppDeps } from "../deps.js";
import {
  FindingPage,
  ISSUE_FILTERS,
  MatterPage,
  MattersPage,
  MemosPage,
  RunPage,
} from "../pages/index.js";
import type { Chrome, Notice } from "../pages/layout.js";
import type { MissedIssueDraft, NoteDraft, RatingDraft } from "../pages/feedback.js";
import type { DecisionDraft } from "../pages/finding.js";
import { refusalOf, type Refusal } from "./notices.js";
import { exportBlockedReason, mayDeleteMatter, pageChrome, sendPage } from "./shared.js";

/**
 * The pages that more than one route answers with, made once from the application's dependencies.
 *
 * A page is built here and nowhere else: the route that shows it by a GET, and the route that has to
 * show it again because a form was refused, both call the function below, so the two answers are the
 * same page. Each function takes the request, the person or the matter the guard let in, the ids it
 * needs, and (when a form was refused) the `Refusal` to show. With a refusal the page carries an
 * error notice and is sent with the refusal's status; without one it is the page a GET shows.
 *
 * Nothing here decides who may see a page. The caller has been through the guard; the services
 * behind each function check the role again.
 */

/** The chrome of a page, with the notice of a refusal in place of the signed one, if there is one. */
function chromeFor(c: Context, principal: Principal, refusal: Refusal | undefined): Chrome {
  const chrome = pageChrome(c, principal);
  return refusal === undefined ? chrome : { ...chrome, notice: refusal.notice };
}

/** The place on the finding page that a refused note links to: its textarea. */
const NOTE_CONTROL = "#note-text";

/** The notice as it is, without its link to a place on the page. */
function withoutJump(notice: Notice): Notice {
  const { jump: _jump, ...rest } = notice;
  return rest;
}

/**
 * Runs `run`, and answers a refusal the person can act on (`refusalOf` recognises it) with
 * `render(refusal)`. Anything else, a failure of the server or a refusal that is not a form's to
 * explain, is thrown again for the shell to answer, as it would have been without this. So is a
 * refusal that `render` declines to answer, by returning null.
 */
export async function answerRefusal(
  run: () => Response | Promise<Response>,
  render: (refusal: Refusal) => Response | null,
): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal === null) throw error;
    const answer = render(refusal);
    if (answer === null) throw error;
    return answer;
  }
}

export interface PageRenderers {
  /** The matter's own page, which is also what a refused matter form shows again. */
  matterPage(c: Context, am: AuthorizedMatter, refusal?: Refusal): Response;
  /** The list of matters, with the form that makes one. */
  mattersPage(c: Context, principal: Principal, refusal?: Refusal): Response;
  /**
   * One run: its table of findings, and the finding the query string asks for. With the options of
   * a refused report of a missed issue, it holds what was typed in that form (package W2.6a).
   */
  runPage(
    c: Context,
    am: AuthorizedMatter,
    runId: string,
    refusal?: Refusal,
    options?: { missedIssueDraft?: MissedIssueDraft },
  ): Response;
  /**
   * One finding and the decision form, with what was typed when a decision was refused. With the
   * options of a refused note, it holds what was typed in the note form (package W2.6a).
   */
  findingPage(
    c: Context,
    am: AuthorizedMatter,
    findingId: string,
    refusal?: Refusal,
    draft?: DecisionDraft,
    options?: { noteDraft?: NoteDraft },
  ): Response;
  /**
   * The memos of a matter, the form that exports one and the section that rates the matter. With
   * the options of a refused rating, it holds what was chosen and typed in that form (package
   * W2.6a).
   */
  memosPage(
    c: Context,
    am: AuthorizedMatter,
    refusal?: Refusal,
    options?: { ratingDraft?: RatingDraft },
  ): Response;
  /**
   * Runs `run`, the body of a matter form's POST. A refusal the person can fix is answered on the
   * matter's own page, with the status and the words of the refusal; anything else is thrown again,
   * for the shell. The page is shown only to a person who holds a role on the matter (the check is
   * in the function).
   */
  answerInPlace(
    c: Context,
    am: AuthorizedMatter,
    run: () => Response | Promise<Response>,
  ): Promise<Response>;
}

export function createPageRenderers(deps: AppDeps): PageRenderers {
  const { services, repo } = deps;
  const { matters, runs, reviews, feedback } = services;

  const matterPage: PageRenderers["matterPage"] = (c, am, refusal) =>
    sendPage(
      c,
      MatterPage({
        chrome: chromeFor(c, am.principal, refusal),
        view: matters.view(am),
        // Only the person who can add someone is shown the list of people to add.
        users: roleAllows(am.role, "member.add") ? matters.users() : undefined,
        canDelete: mayDeleteMatter(repo, am.principal, am.matterId),
      }),
      refusal?.status,
    );

  const mattersPage: PageRenderers["mattersPage"] = (c, principal, refusal) =>
    sendPage(
      c,
      MattersPage({
        chrome: chromeFor(c, principal, refusal),
        matters: matters.list(principal),
        playbooks: matters.playbooks(),
        users: matters.users(),
      }),
      refusal?.status,
    );

  const runPage: PageRenderers["runPage"] = (c, am, runId, refusal, options) => {
    // A run of another matter, or none at all, is a 404 here, before anything is listed.
    const run = runs.get(am, runId);
    const view = matters.view(am);
    const issues = runs.issues(am, run.id);
    const wanted = c.req.query("finding");
    const asked = wanted !== undefined && wanted !== "";
    const chosen = asked ? issues.find((issue) => issue.findingId === wanted) : undefined;
    return sendPage(
      c,
      RunPage({
        chrome: chromeFor(c, am.principal, refusal),
        matter: view.matter,
        run,
        issues,
        selected: chosen === undefined ? null : runs.finding(am, chosen.findingId),
        selectionMissing: asked && chosen === undefined,
        filter: ISSUE_FILTERS.find((name) => name === c.req.query("filter")) ?? "all",
        warnings: view.warnings,
        documents: view.documents,
        feedback: {
          rules: feedback.ruleChoices(am, run.id),
          items: feedback.list(am).missedIssues.filter((item) => item.runId === run.id),
          draft: options?.missedIssueDraft,
        },
      }),
      refusal?.status,
    );
  };

  const findingPage: PageRenderers["findingPage"] = (c, am, findingId, refusal, draft, options) => {
    const finding = runs.finding(am, findingId);
    // A refusal of the note form links to the note's control. A note posted by hand to a finding
    // that has gone out of date is refused for its text before its state, and that page offers no
    // form, so the link is dropped there: it would lead nowhere.
    const shown =
      refusal === undefined ||
      refusal.notice.jump?.href !== NOTE_CONTROL ||
      finding.canAddNote?.allowed === true
        ? refusal
        : { ...refusal, notice: withoutJump(refusal.notice) };
    return sendPage(
      c,
      FindingPage({
        chrome: chromeFor(c, am.principal, shown),
        matterId: am.matterId,
        finding,
        matterName: matters.view(am).matter.name,
        draft,
        noteDraft: options?.noteDraft,
      }),
      refusal?.status,
    );
  };

  const memosPage: PageRenderers["memosPage"] = (c, am, refusal, options) => {
    const view = matters.view(am);
    const memos = reviews.listMemos(am);
    // The caller's own rating, and no other: the service reads it by the caller's id.
    const given = feedback.myRating(am);
    // The refusals of this page are the rating form's, and each leads to a control of that form. The
    // form is on the page while the matter has a memo and the person has not rated; a refusal
    // that reaches the page otherwise (a post made by hand, or from a page opened earlier) is told
    // in words with no link, because a link to a control that is not there leads nowhere.
    const formShown = memos.length > 0 && given === null;
    const shown =
      refusal === undefined || formShown || refusal.notice.jump === undefined
        ? refusal
        : { ...refusal, notice: withoutJump(refusal.notice) };
    return sendPage(
      c,
      MemosPage({
        chrome: chromeFor(c, am.principal, shown),
        matter: view.matter,
        memos,
        canExport: roleAllows(am.role, "memo.export", {
          relaxedSegregation: view.segregationRelaxed,
        }),
        exportBlockedReason: exportBlockedReason(view),
        currentRunId: view.currentRun?.id ?? null,
        rating: {
          hasMemo: memos.length > 0,
          given,
          // The newest memo is first. It names the review the matter was last exported from.
          runId: memos[0]?.runId ?? null,
          draft: options?.ratingDraft,
        },
      }),
      refusal?.status,
    );
  };

  const answerInPlace: PageRenderers["answerInPlace"] = (c, am, run) =>
    answerRefusal(run, (refusal) => {
      // The matter's page is for the people on the matter. The one route that lets in someone who
      // holds no role on it is the deletion (an administrator who is not a member), and the
      // `AuthorizedMatter` it makes gives such a person the role of a viewer only so that the
      // value cannot be used for more than the deletion. Showing the page would be a read, so that
      // person is left with the shell's answer, which is what they had before this existed.
      if (repo.getMember(am.matterId, am.principal.userId) === undefined) return null;
      return matterPage(c, am, refusal);
    });

  return { matterPage, mattersPage, runPage, findingPage, memosPage, answerInPlace };
}
