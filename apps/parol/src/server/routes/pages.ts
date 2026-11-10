import type { Context, Hono } from "hono";
import { csrfToken } from "../../auth/csrf.js";
import { readPrincipal } from "../../auth/identity.js";
import type { AppDeps } from "../deps.js";
import { formString, readForm } from "../http.js";
import { defineMatterRoute, defineRoute } from "../matter-route.js";
import { SignInPage, runStatusPayload } from "../pages/index.js";
import { FIELDS } from "../pages/forms.js";
import { WORKFLOW_FIELD } from "../pages/matter.js";
import { urls } from "../urls.js";
import { decisionFromForm, draftFromForm } from "./decision.js";
import { refusalOf, uploadNotice } from "./notices.js";
import { addDocument, addVersion, createMatter, startRun, updateSettings } from "./operations.js";
import {
  AddMemberInput,
  ConfirmInput,
  CreateMatterInput,
  OperativeInput,
  SettingsInput,
  StartRunInput,
  StatedDateInput,
  UploadDocumentFields,
  UploadVersionFields,
} from "./schemas.js";
import { answerRefusal, createPageRenderers } from "./page-renderers.js";
import {
  blankToNull,
  blankToUndefined,
  memoDownloadHeaders,
  readUpload,
  redirectWithNotice,
  sendPage,
} from "./shared.js";

/** A path parameter. A route that has matched always has it; the services refuse an id they do not know. */
const param = (c: Context, name: string): string => c.req.param(name) ?? "";

/**
 * The pages and the forms behind them (docs/parol/02 and 03). Every route that names a matter
 * goes through `defineMatterRoute` with the action it performs; the rest go through `defineRoute`.
 *
 * A form post answers with a redirect to the page that shows its result, carrying a fixed notice
 * code (notices.ts). The target is always built here from the matter and ids the database
 * confirmed; none is taken from the request (no `next` field, no Referer), so no request can send a
 * person anywhere but a page of this application.
 *
 * A form that is refused is not redirected: it is answered with the page it was posted from, the
 * status of the refusal and the reason in words (`answerInPlace`, page-renderers.ts). The words and
 * the status are those of notices.ts and the shell; this file only chooses where they are shown.
 */
export function registerPageRoutes(app: Hono, deps: AppDeps): void {
  const { services, config } = deps;
  const { matters, runs, reviews } = services;

  // The pages that more than one route answers with (page-renderers.ts), and the helper that
  // answers a refused matter form on the matter's own page.
  const { matterPage, mattersPage, runPage, findingPage, memosPage, answerInPlace } =
    createPageRenderers(deps);

  // --- the start and the list of matters ------------------------------------------------------

  defineRoute(app, {
    method: "GET",
    path: urls.home(),
    access: "public",
    handler: (c) => {
      const principal = readPrincipal(c);
      if (principal === null)
        return sendPage(
          c,
          SignInPage({
            chrome: { userName: null, csrfToken: csrfToken(c) },
            // With the demo identity off nobody can be anyone, so there is nobody to pick, and the
            // page says that sign-in is off instead of offering an empty list.
            users: config.demoIdentity ? matters.users() : [],
            signInEnabled: config.demoIdentity,
          }),
        );
      return mattersPage(c, principal);
    },
  });

  defineRoute(app, {
    method: "GET",
    path: urls.matters(),
    access: "principal",
    handler: (c, principal) => mattersPage(c, principal),
  });

  defineRoute(app, {
    method: "POST",
    path: urls.matters(),
    access: "principal",
    handler: async (c, principal) => {
      const form = await readForm(c);
      // A form the person can fix is answered on the list of matters, in words.
      return answerRefusal(
        () => {
          const input = CreateMatterInput.parse({
            name: formString(form, FIELDS.name),
            clientLegalName: formString(form, FIELDS.clientLegalName),
            playbookVersionId: blankToNull(formString(form, FIELDS.playbookVersionId)),
            reviewerUserId: blankToNull(formString(form, FIELDS.reviewerUserId)),
          });
          const created = createMatter(services, principal, input);
          return redirectWithNotice(c, principal, urls.matter(created.id), "matter-created");
        },
        (refusal) => mattersPage(c, principal, refusal),
      );
    },
  });

  // --- one matter -----------------------------------------------------------------------------

  defineMatterRoute(app, {
    method: "GET",
    path: "/matters/:matterId",
    action: "matter.read",
    handler: (c, am) => matterPage(c, am),
  });

  defineMatterRoute(app, {
    method: "POST",
    path: "/matters/:matterId/settings",
    action: "matter.update",
    handler: async (c, am) => {
      const form = await readForm(c);
      return answerInPlace(c, am, () => {
        const input = SettingsInput.parse({
          clientLegalName: formString(form, FIELDS.clientLegalName),
          playbookVersionId: blankToUndefined(formString(form, FIELDS.playbookVersionId)),
        });
        updateSettings(services, am, input);
        return redirectWithNotice(c, am.principal, urls.matter(am.matterId), "settings-saved");
      });
    },
  });

  defineMatterRoute(app, {
    method: "POST",
    path: "/matters/:matterId/members",
    action: "member.add",
    handler: async (c, am) => {
      const form = await readForm(c);
      return answerInPlace(c, am, () => {
        const input = AddMemberInput.parse({
          userId: formString(form, FIELDS.memberUserId),
          role: formString(form, FIELDS.memberRole),
        });
        matters.addMember(am, input);
        return redirectWithNotice(c, am.principal, urls.matter(am.matterId), "member-added");
      });
    },
  });

  defineMatterRoute(app, {
    method: "POST",
    path: "/matters/:matterId/delete",
    action: "matter.delete",
    handler: async (c, am) => {
      const form = await readForm(c);
      return answerInPlace(c, am, async () => {
        ConfirmInput.parse({ confirm: formString(form, FIELDS.confirm) });
        await matters.delete(am);
        return redirectWithNotice(c, am.principal, urls.matters(), "matter-deleted");
      });
    },
  });

  // --- documents ------------------------------------------------------------------------------

  defineMatterRoute(app, {
    method: "POST",
    path: "/matters/:matterId/documents",
    action: "document.write",
    handler: async (c, am) => {
      const form = await readForm(c);
      // A file the person can fix is answered on the matter's page, in words.
      return answerInPlace(c, am, async () => {
        const fields = UploadDocumentFields.parse({
          title: formString(form, FIELDS.title),
          kind: formString(form, FIELDS.kind),
          statedDate: blankToNull(formString(form, FIELDS.statedDate)),
        });
        const file = await readUpload(form, config.maxUploadBytes);
        const result = await addDocument(services, am, fields, file);
        return redirectWithNotice(
          c,
          am.principal,
          urls.matter(am.matterId),
          uploadNotice(result.warnings, "document-added"),
        );
      });
    },
  });

  defineMatterRoute(app, {
    method: "POST",
    path: "/matters/:matterId/documents/:documentId/versions",
    action: "document.write",
    handler: async (c, am) => {
      const form = await readForm(c);
      return answerInPlace(c, am, async () => {
        const fields = UploadVersionFields.parse({
          statedDate: blankToNull(formString(form, FIELDS.statedDate)),
        });
        const file = await readUpload(form, config.maxUploadBytes);
        const result = await addVersion(services, am, param(c, "documentId"), fields, file);
        return redirectWithNotice(
          c,
          am.principal,
          urls.matter(am.matterId),
          uploadNotice(result.warnings, "version-added"),
        );
      });
    },
  });

  defineMatterRoute(app, {
    method: "POST",
    path: "/matters/:matterId/documents/:documentId/operative",
    action: "document.write",
    handler: async (c, am) => {
      const form = await readForm(c);
      return answerInPlace(c, am, () => {
        const input = OperativeInput.parse({
          documentId: param(c, "documentId"),
          versionId: formString(form, FIELDS.versionId),
        });
        matters.setOperative(am, input.documentId, input.versionId);
        return redirectWithNotice(c, am.principal, urls.matter(am.matterId), "operative-saved");
      });
    },
  });

  defineMatterRoute(app, {
    method: "POST",
    path: "/matters/:matterId/versions/:versionId/stated-date",
    action: "document.write",
    handler: async (c, am) => {
      const form = await readForm(c);
      return answerInPlace(c, am, () => {
        const input = StatedDateInput.parse({
          versionId: param(c, "versionId"),
          statedDate: blankToNull(formString(form, FIELDS.statedDate)),
        });
        matters.setStatedDate(am, input.versionId, input.statedDate);
        return redirectWithNotice(c, am.principal, urls.matter(am.matterId), "date-saved");
      });
    },
  });

  defineMatterRoute(app, {
    method: "POST",
    path: "/matters/:matterId/documents/:documentId/remove",
    action: "document.write",
    handler: async (c, am) => {
      const form = await readForm(c);
      return answerInPlace(c, am, () => {
        ConfirmInput.parse({ confirm: formString(form, FIELDS.confirm) });
        matters.removeDocument(am, param(c, "documentId"));
        return redirectWithNotice(c, am.principal, urls.matter(am.matterId), "document-removed");
      });
    },
  });

  // --- runs -----------------------------------------------------------------------------------

  defineMatterRoute(app, {
    method: "POST",
    path: "/matters/:matterId/runs",
    action: "run.start",
    handler: async (c, am) => {
      const form = await readForm(c);
      return answerInPlace(c, am, () => {
        const input = StartRunInput.parse({
          workflow: blankToUndefined(formString(form, WORKFLOW_FIELD)),
        });
        startRun(services, am, input);
        return redirectWithNotice(c, am.principal, urls.matter(am.matterId), "review-started");
      });
    },
  });

  defineMatterRoute(app, {
    method: "POST",
    path: "/matters/:matterId/runs/:runId/resume",
    action: "run.resume",
    // A page made before the model was changed offers a button that can only fail, and "reload and
    // try again" cannot help; the matter's page, with the reason in words, can.
    handler: (c, am) =>
      answerInPlace(c, am, () => {
        runs.resume(am, param(c, "runId"));
        return redirectWithNotice(c, am.principal, urls.matter(am.matterId), "review-resumed");
      }),
  });

  defineMatterRoute(app, {
    method: "POST",
    path: "/matters/:matterId/runs/:runId/cancel",
    action: "run.start",
    handler: (c, am) =>
      answerInPlace(c, am, () => {
        runs.cancel(am, param(c, "runId"));
        return redirectWithNotice(c, am.principal, urls.matter(am.matterId), "review-cancelled");
      }),
  });

  defineMatterRoute(app, {
    method: "GET",
    path: "/matters/:matterId/runs/:runId",
    action: "run.read",
    handler: (c, am) => runPage(c, am, param(c, "runId")),
  });

  // What /assets/parol.js polls (the page puts this URL in `data-status-url`).
  defineMatterRoute(app, {
    method: "GET",
    path: "/matters/:matterId/runs/:runId/status",
    action: "run.read",
    handler: (c, am) => c.json(runStatusPayload(runs.get(am, param(c, "runId")))),
  });

  // --- findings and decisions -----------------------------------------------------------------

  defineMatterRoute(app, {
    method: "GET",
    path: "/matters/:matterId/findings/:findingId",
    action: "finding.read",
    handler: (c, am) => findingPage(c, am, param(c, "findingId")),
  });

  defineMatterRoute(app, {
    method: "POST",
    path: "/matters/:matterId/findings/:findingId/reviews",
    action: "review.decide",
    handler: async (c, am) => {
      const findingId = param(c, "findingId");
      const form = await readForm(c);
      // The finding as it is now: the form is read against it, and a finding of another matter
      // ends here as a 404 before the form is looked at.
      const finding = runs.finding(am, findingId);
      try {
        reviews.decide(am, findingId, decisionFromForm(form, finding));
      } catch (error) {
        // A decision the reviewer can mend (no reason, nothing edited, a finding that has moved)
        // is answered on the finding itself, as it now stands, with what is wrong said in words.
        const refusal = refusalOf(error);
        if (refusal === null) throw error;
        // What was typed comes back with the refusal, unless the finding itself moved: edits
        // written against a finding that has changed would sit beside text they were not written
        // for, and the reviewer has to read the finding again before deciding.
        const moved = refusal.code === "content_mismatch" || refusal.code === "stale_finding";
        return findingPage(c, am, findingId, refusal, moved ? undefined : draftFromForm(form));
      }
      // Back to the table the reviewer was working in, with this finding selected. A finding can
      // be decided only in the current run, so that is the run the table belongs to.
      const current = matters.view(am).currentRun;
      const back =
        current === null
          ? urls.finding(am.matterId, findingId)
          : urls.run(am.matterId, current.id, findingId);
      return redirectWithNotice(c, am.principal, back, "decision-saved");
    },
  });

  // --- memos ----------------------------------------------------------------------------------

  defineMatterRoute(app, {
    method: "GET",
    path: "/matters/:matterId/memos",
    action: "memo.read",
    handler: (c, am) => memosPage(c, am),
  });

  defineMatterRoute(app, {
    method: "POST",
    path: "/matters/:matterId/memos",
    action: "memo.export",
    handler: async (c, am) => {
      await reviews.exportMemo(am);
      return redirectWithNotice(c, am.principal, urls.memos(am.matterId), "memo-exported");
    },
  });

  defineMatterRoute(app, {
    method: "GET",
    path: "/matters/:matterId/memos/:memoId/file",
    action: "memo.read",
    handler: async (c, am) => {
      const file = await reviews.memoFile(am, param(c, "memoId"));
      const bytes = new Uint8Array(file.bytes);
      return c.body(bytes, 200, memoDownloadHeaders(file.fileName, bytes.byteLength));
    },
  });
}
