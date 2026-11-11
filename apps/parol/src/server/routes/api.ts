import type { Context, Hono } from "hono";
import { csrfToken } from "../../auth/csrf.js";
import { readPrincipal } from "../../auth/identity.js";
import type { AppDeps } from "../deps.js";
import { readForm } from "../http.js";
import { defineMatterRoute, defineRoute } from "../matter-route.js";
import { FIELDS } from "../pages/forms.js";
import { decisionFromBody } from "./decision.js";
import { uploadStatus } from "./notices.js";
import {
  addDocument,
  addVersion,
  createMatter,
  setRetention,
  startRun,
  updateSettings,
} from "./operations.js";
import {
  AddMemberInput,
  CreateMatterInput,
  PatchMatterBody,
  StartRunInput,
  UploadDocumentFields,
  UploadVersionFields,
} from "./schemas.js";
import {
  blankToNull,
  memoDownloadHeaders,
  onlyFields,
  readJsonBody,
  readUpload,
  textField,
} from "./shared.js";

const param = (c: Context, name: string): string => c.req.param(name) ?? "";

/**
 * The JSON API under /api (docs/parol/03). It performs the same operations as the pages, through
 * the same functions (operations.ts) and the same services, and reads its input from a JSON body
 * or from a multipart form for uploads.
 *
 * A write carries the CSRF token in the `x-csrf-token` header; `GET /api/session` tells a script
 * its token. Every body is checked with a strict schema: a key the operation does not offer is a
 * 400. Errors are the shell's: a fixed kind and message, never what the request said.
 */
export function registerApiRoutes(app: Hono, deps: AppDeps): void {
  const { services, config } = deps;
  const { matters, runs, reviews } = services;

  // --- the session and what is not about one matter -------------------------------------------

  // The person and the token a script sends with its writes. Anonymous callers get a token too:
  // it is what the sign-in post (POST /session) has to carry.
  defineRoute(app, {
    method: "GET",
    path: "/api/session",
    access: "public",
    handler: (c) => {
      const principal = readPrincipal(c);
      return c.json({
        user:
          principal === null
            ? null
            : {
                userId: principal.userId,
                displayName: principal.displayName,
                globalRole: principal.globalRole,
              },
        csrfToken: csrfToken(c),
      });
    },
  });

  defineRoute(app, {
    method: "GET",
    path: "/api/playbooks",
    access: "principal",
    handler: (c) => c.json({ playbooks: matters.playbooks() }),
  });

  defineRoute(app, {
    method: "GET",
    path: "/api/matters",
    access: "principal",
    handler: (c, principal) => c.json({ matters: matters.list(principal) }),
  });

  defineRoute(app, {
    method: "POST",
    path: "/api/matters",
    access: "principal",
    handler: async (c, principal) => {
      const input = CreateMatterInput.parse(await readJsonBody(c));
      return c.json(createMatter(services, principal, input), 201);
    },
  });

  // --- one matter -----------------------------------------------------------------------------

  defineMatterRoute(app, {
    method: "GET",
    path: "/api/matters/:matterId",
    action: "matter.read",
    handler: (c, am) => c.json(matters.view(am)),
  });

  defineMatterRoute(app, {
    method: "PATCH",
    path: "/api/matters/:matterId",
    action: "matter.update",
    handler: async (c, am) => {
      const body = PatchMatterBody.parse(await readJsonBody(c));
      if ("operative" in body) {
        matters.setOperative(am, body.operative.documentId, body.operative.versionId);
      } else if ("statedDate" in body) {
        matters.setStatedDate(am, body.statedDate.versionId, body.statedDate.statedDate);
      } else if ("retention" in body) {
        setRetention(services, am, body.retention.days);
      } else {
        updateSettings(services, am, body);
      }
      return c.json(matters.view(am));
    },
  });

  defineMatterRoute(app, {
    method: "DELETE",
    path: "/api/matters/:matterId",
    action: "matter.delete",
    handler: async (c, am) => {
      await matters.delete(am);
      return c.body(null, 204);
    },
  });

  defineMatterRoute(app, {
    method: "POST",
    path: "/api/matters/:matterId/members",
    action: "member.add",
    handler: async (c, am) => {
      const input = AddMemberInput.parse(await readJsonBody(c));
      matters.addMember(am, input);
      return c.json({ members: matters.view(am).members }, 201);
    },
  });

  // --- documents ------------------------------------------------------------------------------

  defineMatterRoute(app, {
    method: "POST",
    path: "/api/matters/:matterId/documents",
    action: "document.write",
    handler: async (c, am) => {
      const form = await readForm(c);
      onlyFields(form, [FIELDS.title, FIELDS.kind, FIELDS.statedDate, FIELDS.file]);
      const fields = UploadDocumentFields.parse({
        title: textField(form, FIELDS.title),
        kind: textField(form, FIELDS.kind),
        statedDate: blankToNull(textField(form, FIELDS.statedDate)),
      });
      const file = await readUpload(form, config.maxUploadBytes);
      const result = await addDocument(services, am, fields, file);
      return c.json(result, uploadStatus(result.warnings));
    },
  });

  defineMatterRoute(app, {
    method: "POST",
    path: "/api/matters/:matterId/documents/:documentId/versions",
    action: "document.write",
    handler: async (c, am) => {
      const form = await readForm(c);
      onlyFields(form, [FIELDS.statedDate, FIELDS.file]);
      const fields = UploadVersionFields.parse({
        statedDate: blankToNull(textField(form, FIELDS.statedDate)),
      });
      const file = await readUpload(form, config.maxUploadBytes);
      const result = await addVersion(services, am, param(c, "documentId"), fields, file);
      return c.json(result, uploadStatus(result.warnings));
    },
  });

  defineMatterRoute(app, {
    method: "DELETE",
    path: "/api/matters/:matterId/documents/:documentId",
    action: "document.write",
    handler: (c, am) => {
      matters.removeDocument(am, param(c, "documentId"));
      return c.body(null, 204);
    },
  });

  // --- runs -----------------------------------------------------------------------------------

  defineMatterRoute(app, {
    method: "POST",
    path: "/api/matters/:matterId/runs",
    action: "run.start",
    handler: async (c, am) => {
      const input = StartRunInput.parse(await readJsonBody(c));
      return c.json(startRun(services, am, input), 202);
    },
  });

  defineMatterRoute(app, {
    method: "GET",
    path: "/api/matters/:matterId/runs",
    action: "run.read",
    handler: (c, am) => c.json({ runs: runs.list(am) }),
  });

  defineMatterRoute(app, {
    method: "GET",
    path: "/api/matters/:matterId/runs/:runId",
    action: "run.read",
    handler: (c, am) => c.json(runs.get(am, param(c, "runId"))),
  });

  defineMatterRoute(app, {
    method: "POST",
    path: "/api/matters/:matterId/runs/:runId/resume",
    action: "run.resume",
    handler: (c, am) => c.json(runs.resume(am, param(c, "runId")), 202),
  });

  defineMatterRoute(app, {
    method: "POST",
    path: "/api/matters/:matterId/runs/:runId/cancel",
    action: "run.start",
    handler: (c, am) => c.json(runs.cancel(am, param(c, "runId"))),
  });

  defineMatterRoute(app, {
    method: "GET",
    path: "/api/matters/:matterId/runs/:runId/findings",
    action: "run.read",
    handler: (c, am) => {
      // `issues` answers an empty table for a run it does not know; a missing run is a 404.
      const run = runs.get(am, param(c, "runId"));
      return c.json({ runId: run.id, findings: runs.issues(am, run.id) });
    },
  });

  // --- findings and decisions -----------------------------------------------------------------

  defineMatterRoute(app, {
    method: "GET",
    path: "/api/matters/:matterId/findings/:findingId",
    action: "finding.read",
    handler: (c, am) => c.json(runs.finding(am, param(c, "findingId"))),
  });

  defineMatterRoute(app, {
    method: "POST",
    path: "/api/matters/:matterId/findings/:findingId/reviews",
    action: "review.decide",
    handler: async (c, am) => {
      const request = decisionFromBody(await readJsonBody(c));
      return c.json(reviews.decide(am, param(c, "findingId"), request), 201);
    },
  });

  // --- memos ----------------------------------------------------------------------------------

  defineMatterRoute(app, {
    method: "POST",
    path: "/api/matters/:matterId/memos",
    action: "memo.export",
    handler: async (c, am) => c.json(await reviews.exportMemo(am), 201),
  });

  defineMatterRoute(app, {
    method: "GET",
    path: "/api/matters/:matterId/memos/:memoId/file",
    action: "memo.read",
    handler: async (c, am) => {
      const file = await reviews.memoFile(am, param(c, "memoId"));
      const bytes = new Uint8Array(file.bytes);
      return c.body(bytes, 200, memoDownloadHeaders(file.fileName, bytes.byteLength));
    },
  });
}
