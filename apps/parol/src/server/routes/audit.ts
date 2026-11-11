import type { Hono } from "hono";
import type { AppDeps } from "../deps.js";
import { defineRoute } from "../matter-route.js";
import { AuditPage } from "../pages/audit.js";
import { urls } from "../urls.js";
import { pageChrome, sendPage } from "./shared.js";

/**
 * Where the routes of the audit log page are registered (work package W2.7, slice C).
 *
 * `GET /audit` names no matter and is for an administrator: the global action `audit.read` (see
 * `GLOBAL_ACTIONS`), checked by the guard and again by the service. A signed-in person who is not
 * an administrator is answered 403 by the shell's page, a visitor is sent to sign in. It is a read:
 * it carries no CSRF token, writes no event and changes nothing, and the check it runs is made
 * each time the page is opened, never stored. Nothing in the request is read: the page takes no
 * query, so an unknown key is ignored and never echoed.
 */
export function registerAuditRoutes(app: Hono, deps: AppDeps): void {
  const { services } = deps;

  defineRoute(app, {
    method: "GET",
    path: urls.audit(),
    access: "principal",
    globalAction: "audit.read",
    handler: (c, principal) =>
      sendPage(
        c,
        AuditPage({ chrome: pageChrome(c, principal), view: services.audit.check(principal) }),
      ),
  });
}
