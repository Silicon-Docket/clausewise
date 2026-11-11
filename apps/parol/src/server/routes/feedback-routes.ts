import type { Context, Hono } from "hono";
import type { AppDeps } from "../deps.js";
import { readForm } from "../http.js";
import { defineMatterRoute } from "../matter-route.js";
import { urls } from "../urls.js";
import {
  missedIssueDraftFromForm,
  missedIssueFromBody,
  missedIssueFromForm,
  noteDraftFromForm,
  noteFromBody,
  noteFromForm,
  ratingDraftFromForm,
  ratingFromBody,
  ratingFromForm,
} from "./feedback.js";
import { answerRefusal, createPageRenderers } from "./page-renderers.js";
import { readJsonBody, redirectWithNotice } from "./shared.js";

/** A path parameter. A route that has matched always has it; the services refuse an id they do not know. */
const param = (c: Context, name: string): string => c.req.param(name) ?? "";

/**
 * Where the routes of the capture of feedback are registered (work package W2.6a): the report of a
 * missed issue (slice B), the rating of a matter (slice C) and the note on a finding (slice D), each
 * as a form and as JSON, and the read of what the caller may see of a matter's feedback. Every route
 * goes through `defineMatterRoute`, so a write needs the CSRF token and a role that holds
 * `feedback.add`, and a person with no part in the matter is answered exactly as for a matter that
 * does not exist. The pages are built by the renderers of page-renderers.ts, so a refused form is
 * answered with the page it was posted from.
 *
 * In each write the order is fixed: the guard, then the id in the path is looked up in the caller's
 * matter (a run or a finding of another matter is a 404 before the body is read), then the body is
 * read and checked (400), then the state is checked (409). Nothing in a body names a person, a
 * matter, a run or a finding: the person is the signed-in one and the run or the finding is the
 * path's. The rating takes no id at all: the matter is the path's and the review it is recorded
 * against is the newest memo's.
 */
export function registerFeedbackRoutes(app: Hono, deps: AppDeps): void {
  const { services } = deps;
  const { runs, feedback, matters } = services;
  const { runPage, findingPage, memosPage } = createPageRenderers(deps);

  defineMatterRoute(app, {
    method: "POST",
    path: "/matters/:matterId/runs/:runId/missed-issues",
    action: "feedback.add",
    handler: async (c, am) => {
      // A run of another matter, or none at all, ends here as a 404, before the form is looked at.
      const run = runs.get(am, param(c, "runId"));
      const form = await readForm(c);
      // A report the person can mend is answered on the review page, with what they typed.
      return answerRefusal(
        () => {
          feedback.reportMissedIssue(am, run.id, missedIssueFromForm(form));
          return redirectWithNotice(
            c,
            am.principal,
            urls.run(am.matterId, run.id),
            "missed-issue-saved",
          );
        },
        (refusal) =>
          runPage(c, am, run.id, refusal, { missedIssueDraft: missedIssueDraftFromForm(form) }),
      );
    },
  });

  defineMatterRoute(app, {
    method: "POST",
    path: "/api/matters/:matterId/runs/:runId/missed-issues",
    action: "feedback.add",
    handler: async (c, am) => {
      const run = runs.get(am, param(c, "runId"));
      const input = missedIssueFromBody(await readJsonBody(c));
      return c.json(feedback.reportMissedIssue(am, run.id, input), 201);
    },
  });

  // --- a note on a finding ------------------------------------------------------------------

  defineMatterRoute(app, {
    method: "POST",
    path: "/matters/:matterId/findings/:findingId/notes",
    action: "feedback.add",
    handler: async (c, am) => {
      const findingId = param(c, "findingId");
      // A finding of another matter, or none at all, ends here as a 404, before the form is looked at.
      runs.finding(am, findingId);
      const form = await readForm(c);
      // A note the person can mend is answered on the finding itself, with what they typed.
      return answerRefusal(
        () => {
          feedback.addNote(am, findingId, noteFromForm(form));
          // Back to the table the person was reading, with this finding selected, as a decision does.
          // A note can be added only to a finding of a review that has not been replaced.
          const current = matters.view(am).currentRun;
          const back =
            current === null
              ? urls.finding(am.matterId, findingId)
              : urls.run(am.matterId, current.id, findingId);
          return redirectWithNotice(c, am.principal, back, "note-saved");
        },
        (refusal) =>
          findingPage(c, am, findingId, refusal, undefined, {
            noteDraft: noteDraftFromForm(form),
          }),
      );
    },
  });

  defineMatterRoute(app, {
    method: "POST",
    path: "/api/matters/:matterId/findings/:findingId/notes",
    action: "feedback.add",
    handler: async (c, am) => {
      const findingId = param(c, "findingId");
      runs.finding(am, findingId);
      const input = noteFromBody(await readJsonBody(c));
      return c.json(feedback.addNote(am, findingId, input), 201);
    },
  });

  // --- the rating of a matter ----------------------------------------------------------------

  defineMatterRoute(app, {
    method: "POST",
    path: "/matters/:matterId/rating",
    action: "feedback.add",
    handler: async (c, am) => {
      const form = await readForm(c);
      // A rating the person can mend is answered on the memos page, with what they chose and typed.
      return answerRefusal(
        () => {
          feedback.rate(am, ratingFromForm(form));
          return redirectWithNotice(c, am.principal, urls.memos(am.matterId), "rating-saved");
        },
        (refusal) => memosPage(c, am, refusal, { ratingDraft: ratingDraftFromForm(form) }),
      );
    },
  });

  defineMatterRoute(app, {
    method: "POST",
    path: "/api/matters/:matterId/rating",
    action: "feedback.add",
    handler: async (c, am) => {
      const input = ratingFromBody(await readJsonBody(c));
      return c.json(feedback.rate(am, input), 201);
    },
  });

  // --- what the caller may read of a matter's feedback ----------------------------------------

  defineMatterRoute(app, {
    method: "GET",
    path: "/api/matters/:matterId/feedback",
    action: "matter.read",
    // The reports and the notes of the matter, and the caller's own rating: another person's rating
    // is not in the answer, because the service does not return it.
    handler: (c, am) => c.json(feedback.list(am)),
  });
}
