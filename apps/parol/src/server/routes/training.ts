import type { Context, Hono } from "hono";
import { z } from "zod";
import { csrfToken } from "../../auth/csrf.js";
import { readPrincipal } from "../../auth/identity.js";
import type { Principal } from "../../auth/types.js";
import type { AppDeps } from "../deps.js";
import { formString, readForm, type FormFields } from "../http.js";
import { defineRoute } from "../matter-route.js";
import { HelpPage } from "../pages/help.js";
import { QuickstartPage } from "../pages/quickstart.js";
import { TrainerKeyPage } from "../pages/training.js";
import { FIELDS } from "../pages/forms.js";
import type { Chrome } from "../pages/layout.js";
import { urls } from "../urls.js";
import {
  QUICKSTART_STEPS,
  T01,
  TRAINER_NOTES,
  TRAINING_STEPS,
  ownTrainingMatter,
  publicStep,
  startTraining,
} from "../../training/index.js";
import { ConflictError } from "../../store/errors.js";
import { answerRefusal } from "./page-renderers.js";
import type { Refusal } from "./notices.js";
import { blankToNull, pageChrome, redirectWithNotice, sendPage } from "./shared.js";

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
 * The routes of the training matter, the quickstart and the help (work package W2.8). None of them
 * names a matter, so all go through `defineRoute`.
 *
 * `GET /quickstart` and `GET /help` are open to everyone, a visitor included: they hold fixed text
 * and, for a signed-in person, the link to their own training matter and the form that makes it.
 * `GET /training/key` is the trainer's key, for the legal engineer and the administrators only.
 * The page lists the person's matters through the services, which return only matters the person
 * is a member of, so it never names another person's training matter.
 *
 * `POST /training` starts the signed-in person's own T01: the shell checks the person and the CSRF
 * token before the handler runs, the handler reads two named fields, and the matter, its documents
 * and its members are made by the services as a person's own actions, so `matter.create` (with the
 * training key), `document.add` and `member.add` are in the audit log. It is idempotent for a
 * person who has a T01: nothing is made and the redirect says so. A refusal is answered on the
 * quickstart page, which holds the form, with the status and the words of the refusal.
 */
export function registerTrainingRoutes(app: Hono, deps: AppDeps): void {
  const { services, repo, config } = deps;
  const relaxedSegregation = config.relaxedSegregation === true;

  /** The ten steps as the page is given them. */
  const steps = QUICKSTART_STEPS.map((step) => ({
    n: step.n,
    text: step.text,
    built: step.availability === "built",
  }));
  /** The seven steps without the answer key: `publicStep` drops it, and the view keeps five fields. */
  const exercise = TRAINING_STEPS.map(publicStep).map(({ n, title, who, task, teaches }) => ({
    n,
    title,
    who,
    task,
    teaches,
  }));

  /**
   * The quickstart, for a visitor or a signed-in person. A refusal (and what was chosen in the form
   * that was refused) is shown on it with the refusal's status. The jump of a refusal leads to the
   * start form, so it is kept only when the form is on the page.
   */
  const quickstartPage = (
    c: Context,
    principal: Principal | null,
    refusal?: Refusal,
    form?: FormFields,
  ): Response => {
    const base: Chrome =
      principal === null ? { userName: null, csrfToken: csrfToken(c) } : pageChrome(c, principal);
    if (principal === null)
      return sendPage(c, QuickstartPage({ chrome: base, steps, exercise }), refusal?.status);
    const own = ownTrainingMatter(services, repo, principal);
    const playbookAvailable = services.matters
      .playbooks()
      .some((option) => option.slug === T01.playbookSlug);
    const formShown = own === undefined && playbookAvailable;
    let chrome = base;
    if (refusal !== undefined) {
      const { jump: _jump, ...withoutJump } = refusal.notice;
      chrome = { ...base, notice: formShown ? refusal.notice : withoutJump };
    }
    return sendPage(
      c,
      QuickstartPage({
        chrome,
        steps,
        exercise,
        ownTraining: own === undefined ? null : { matterId: own.id },
        start:
          own !== undefined
            ? undefined
            : {
                people: services.matters.users(),
                relaxedSegregation,
                playbookAvailable,
                chosen:
                  form === undefined
                    ? undefined
                    : {
                        reviewerUserId: blankToNull(formString(form, FIELDS.reviewerUserId)),
                        trainerUserId: blankToNull(formString(form, FIELDS.trainerUserId)),
                      },
              },
      }),
      refusal?.status,
    );
  };

  defineRoute(app, {
    method: "GET",
    path: urls.quickstart(),
    access: "public",
    handler: (c) => quickstartPage(c, readPrincipal(c)),
  });

  defineRoute(app, {
    method: "GET",
    path: urls.help(),
    access: "public",
    handler: (c) => {
      const principal = readPrincipal(c);
      const chrome: Chrome =
        principal === null ? { userName: null, csrfToken: csrfToken(c) } : pageChrome(c, principal);
      return sendPage(c, HelpPage({ chrome }));
    },
  });

  /**
   * The trainer's key. The guard answers 403 to a person whose global role is not the legal
   * engineer's or an administrator's (`training.key`) and sends a visitor to sign in, so the
   * handler runs only for a trainer role, and this is the one place the answers are handed to a
   * page. A read: no token, no write, no audit event. The page holds fixed text and no matter id.
   */
  defineRoute(app, {
    method: "GET",
    path: urls.trainerKey(),
    access: "principal",
    globalAction: "training.key",
    handler: (c, principal) =>
      sendPage(
        c,
        TrainerKeyPage({
          chrome: pageChrome(c, principal),
          steps: TRAINING_STEPS.map(({ n, title, who, task, teaches, key }) => ({
            n,
            title,
            who,
            task,
            teaches,
            key,
          })),
          notes: TRAINER_NOTES.map(({ heading, text }) => ({ heading, text })),
        }),
      ),
  });

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
          const started = await startTraining({ services, repo, relaxedSegregation }, principal, {
            playbookVersionId: playbook.versionId,
            ...input,
          });
          return redirectWithNotice(
            c,
            principal,
            urls.matter(started.matterId),
            started.created ? "training-started" : "training-exists",
          );
        },
        // The form is on the quickstart page, which answers its own refusal.
        (refusal) => quickstartPage(c, principal, refusal, form),
      );
    },
  });
}
