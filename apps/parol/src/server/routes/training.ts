import type { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../deps.js";
import { formString, readForm } from "../http.js";
import { defineRoute } from "../matter-route.js";
import { FIELDS } from "../pages/forms.js";
import { urls } from "../urls.js";
import { T01, startTraining } from "../../training/index.js";
import { ConflictError } from "../../store/errors.js";
import { createPageRenderers, answerRefusal } from "./page-renderers.js";
import { blankToNull, redirectWithNotice } from "./shared.js";

/**
 * What the start form of the training matter accepts: the reviewing attorney and the trainer, both
 * optional at this layer (the start refuses a missing reviewer unless the server is set for one
 * person). Strict, so no other key can reach the function: there is no field that could set the
 * training key, the playbook, the name or the retention of the matter. It lives here and not in
 * `schemas.ts`, which belongs to the routes of the matter.
 */
const id = z.string().min(1).max(200);
export const StartTrainingInput = z.strictObject({
  reviewerUserId: id.nullable(),
  trainerUserId: id.nullable(),
});
export type StartTrainingInput = z.infer<typeof StartTrainingInput>;

/**
 * The routes of the training matter (work package W2.8). None of them names a matter, so all go
 * through `defineRoute`. `POST /training` starts the signed-in person's own T01: the shell checks
 * the person and the CSRF token before the handler runs, the handler reads two named fields, and
 * the matter, its documents and its members are made by the services as a person's own actions, so
 * `matter.create` (with the training key), `document.add` and `member.add` are in the audit log.
 * It is idempotent for a person who has a T01: nothing is made and the redirect says so.
 */
export function registerTrainingRoutes(app: Hono, deps: AppDeps): void {
  const { services, repo, config } = deps;
  const { mattersPage } = createPageRenderers(deps);

  defineRoute(app, {
    method: "POST",
    path: urls.training(),
    access: "principal",
    handler: async (c, principal) => {
      const form = await readForm(c);
      return answerRefusal(
        async () => {
          const input = StartTrainingInput.parse({
            reviewerUserId: blankToNull(formString(form, FIELDS.reviewerUserId)),
            trainerUserId: blankToNull(formString(form, FIELDS.trainerUserId)),
          });
          // The newest approved version of the playbook the matter is made for.
          const playbook = services.matters
            .playbooks()
            .filter((option) => option.slug === T01.playbookSlug)
            .sort((a, b) => a.approvedAt.localeCompare(b.approvedAt))
            .at(-1);
          if (playbook === undefined)
            throw new ConflictError("no_playbook", "no approved playbook version is available");
          const started = await startTraining(
            { services, repo, relaxedSegregation: config.relaxedSegregation === true },
            principal,
            { playbookVersionId: playbook.versionId, ...input },
          );
          return redirectWithNotice(
            c,
            principal,
            urls.matter(started.matterId),
            started.created ? "training-started" : "training-exists",
          );
        },
        // The form is on the quickstart page, and that page answers its own refusal. Until it is
        // built the refusal is shown on the list of matters, with its status and its words. That
        // page has no field to go to, so the notice is shown without its jump (a link to a place
        // the page does not have would be a broken link); the sentence to follow stays.
        (refusal) => {
          const { jump: _jump, ...notice } = refusal.notice;
          return mattersPage(c, principal, { ...refusal, notice });
        },
      );
    },
  });
}
