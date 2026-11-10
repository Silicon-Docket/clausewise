import type { Hono } from "hono";
import type { AppDeps } from "../deps.js";
import { defineRoute } from "../matter-route.js";
import { ComparisonPageView, EvaluationsPage } from "../pages/evaluations.js";
import { urls } from "../urls.js";
import { pageChrome, sendPage } from "./shared.js";

/**
 * The evaluation comparison page (package W2.5): one route, `GET /evaluations`. With no query it
 * lists the comparisons published to this application. With `comparison=<id>` it shows one;
 * `split` picks a section of it, and `case` with `rule` pick a changed slot whose evidence trail is
 * shown. Everything is selected by query string on this one URL, as the review page selects a
 * finding with `?finding=`.
 *
 * The page names no matter, so it goes through `defineRoute` and not `defineMatterRoute`; it is for
 * the legal engineer and the administrator (`evaluation.read`), and the guard answers 403 to a
 * member and sends a visitor to sign in. It reads files and shows them: it changes nothing, so it
 * has no form, no CSRF token to check and no audit event, and no other method is registered on
 * the URL (a test fails when one is).
 *
 * Nothing from the query is echoed. An id that is not shaped like a page id, or that names no
 * readable file, is the same 404 as any URL nothing owns, and the disk is not touched for the
 * first kind (the source checks the shape).
 */
export function registerEvaluationRoutes(app: Hono, deps: AppDeps): void {
  const { evaluations } = deps.services;

  defineRoute(app, {
    method: "GET",
    path: urls.evaluations(),
    access: "principal",
    globalAction: "evaluation.read",
    handler: (c, principal) => {
      const chrome = pageChrome(c, principal);
      const ids = c.req.queries("comparison");
      if (ids === undefined)
        return sendPage(c, EvaluationsPage({ chrome, list: evaluations.list(principal) }));
      // A parameter given twice is not one id.
      const id = ids.length === 1 ? (ids[0] ?? "") : "";
      const view = evaluations.comparison(principal, {
        id,
        split: c.req.query("split"),
        caseKey: c.req.query("case"),
        ruleKey: c.req.query("rule"),
      });
      return sendPage(c, ComparisonPageView({ chrome, view }));
    },
  });
}
