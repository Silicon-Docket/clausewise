import type { Context, Hono } from "hono";
import type { Principal } from "../../auth/types.js";
import type { PilotScope } from "../../pilot/index.js";
import type { AppDeps } from "../deps.js";
import { formString, readForm } from "../http.js";
import { defineMatterRoute, defineRoute } from "../matter-route.js";
import { PilotPage, type PilotDraft } from "../pages/pilot.js";
import { FIELDS } from "../pages/forms.js";
import { userIdOfTrainedField } from "../pages/pilotfields.js";
import { urls } from "../urls.js";
import { answerRefusal, createPageRenderers } from "./page-renderers.js";
import type { Refusal } from "./notices.js";
import {
  calendarFromForm,
  participantsFromForm,
  referenceListFromForm,
  timerFromForm,
} from "./pilot-input.js";
import { csvDownloadHeaders, pageChrome, redirectWithNotice, sendPage } from "./shared.js";

/**
 * Where the routes of the pilot measures, the timer and the reference list are registered (work
 * package W2.6b). Six routes, none with a JSON twin (docs/parol/03 lists none).
 *
 * Four name no matter and go through `defineRoute` with the global action they need
 * (`GLOBAL_ACTIONS`): `GET /pilot` and `GET /pilot/measures.csv` need `pilot.read`, the two forms
 * that change the pilot (`POST /pilot/calendar`, `POST /pilot/participants`) need `pilot.manage`. A
 * signed-in person whose global role is not listed gets the shell's 403, a visitor is sent to sign
 * in, and a write needs the CSRF token before the role is looked at. The service checks the same
 * action again.
 *
 * Two name a matter and go through `defineMatterRoute`: `POST /matters/:matterId/timer`
 * (`time.record`: an associate or a reviewer) and `POST /matters/:matterId/reference-list`
 * (`reference.write`: a reviewer). The person is the signed-in one in both; no field names a person
 * or a matter. A form that was refused is answered with the matter page and the status of the
 * refusal.
 *
 * In every write the order is fixed: the guard, then the body is read and checked (400), then the
 * state is checked (409). Every write is audited in the transaction of the change.
 */

/** Anything but `synthetic` reads as the pilot scope, so a query string cannot ask for a third. */
export const scopeOf = (c: Context): PilotScope =>
  c.req.query("scope") === "synthetic" ? "synthetic" : "pilot";

export function registerPilotRoutes(app: Hono, deps: AppDeps): void {
  const { services } = deps;
  const { pilot } = services;
  const { answerInPlace } = createPageRenderers(deps);

  /**
   * The pilot page, for a GET or for a form that was refused. A refusal brings its notice and its
   * status, and what was typed or ticked is shown again.
   */
  const pilotPage = (
    c: Context,
    principal: Principal,
    scope: PilotScope,
    refusal?: Refusal,
    draft?: PilotDraft,
  ): Response => {
    const chrome = pageChrome(c, principal);
    return sendPage(
      c,
      PilotPage({
        chrome: refusal === undefined ? chrome : { ...chrome, notice: refusal.notice },
        view: pilot.measures(principal, scope),
        admin: pilot.admin(principal),
        draft,
      }),
      refusal?.status,
    );
  };

  defineRoute(app, {
    method: "GET",
    path: urls.pilot(),
    access: "principal",
    globalAction: "pilot.read",
    handler: (c, principal) => pilotPage(c, principal, scopeOf(c)),
  });

  defineRoute(app, {
    method: "GET",
    path: urls.pilotCsv(),
    access: "principal",
    globalAction: "pilot.read",
    handler: (c, principal) => {
      const file = pilot.csv(principal, scopeOf(c));
      const bytes = new TextEncoder().encode(file.body);
      return c.body(bytes, 200, csvDownloadHeaders(file.fileName, bytes.byteLength));
    },
  });

  defineRoute(app, {
    method: "POST",
    path: urls.pilotCalendar(),
    access: "principal",
    globalAction: "pilot.manage",
    handler: async (c, principal) => {
      const form = await readForm(c);
      // A date the person can mend is answered on the pilot page, with what they typed.
      return answerRefusal(
        () => {
          pilot.setCalendar(principal, calendarFromForm(form));
          return redirectWithNotice(c, principal, urls.pilot(), "calendar-saved");
        },
        (refusal) =>
          pilotPage(c, principal, "pilot", refusal, {
            startDate: formString(form, FIELDS.startDate),
          }),
      );
    },
  });

  defineRoute(app, {
    method: "POST",
    path: urls.pilotParticipants(),
    access: "principal",
    globalAction: "pilot.manage",
    handler: async (c, principal) => {
      const form = await readForm(c);
      return answerRefusal(
        () => {
          pilot.setParticipants(principal, participantsFromForm(form));
          return redirectWithNotice(c, principal, urls.pilot(), "participants-saved");
        },
        (refusal) =>
          pilotPage(c, principal, "pilot", refusal, {
            // What was ticked, for the names that are ids; the page shows the ones it knows.
            trained: Object.keys(form).flatMap((name) => userIdOfTrainedField(name) ?? []),
          }),
      );
    },
  });

  defineMatterRoute(app, {
    method: "POST",
    path: "/matters/:matterId/timer",
    action: "time.record",
    handler: async (c, am) => {
      const form = await readForm(c);
      return answerInPlace(c, am, () => {
        const { intent } = timerFromForm(form);
        if (intent === "start") {
          pilot.startTimer(am);
          return redirectWithNotice(c, am.principal, urls.matter(am.matterId), "timer-started");
        }
        pilot.stopTimer(am);
        return redirectWithNotice(c, am.principal, urls.matter(am.matterId), "timer-stopped");
      });
    },
  });

  defineMatterRoute(app, {
    method: "POST",
    path: "/matters/:matterId/reference-list",
    action: "reference.write",
    handler: async (c, am) => {
      const form = await readForm(c);
      return answerInPlace(c, am, () => {
        pilot.saveReferenceList(am, referenceListFromForm(form));
        return redirectWithNotice(c, am.principal, urls.matter(am.matterId), "reference-saved");
      });
    },
  });
}
