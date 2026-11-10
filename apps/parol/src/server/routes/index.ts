import type { Hono } from "hono";
import type { AppDeps } from "../deps.js";
import { registerApiRoutes } from "./api.js";
import { registerAuditRoutes } from "./audit.js";
import { registerEvaluationRoutes } from "./evaluations.js";
import { registerFeedbackRoutes } from "./feedback-routes.js";
import { registerPageRoutes } from "./pages.js";
import { registerPilotRoutes } from "./pilot.js";
import { registerTrainingRoutes } from "./training.js";

/**
 * Adds the page routes and the JSON API to the application `createApp` made. `main.ts` loads this
 * function by name, and the route-coverage tests (test/server/shell-routes.test.ts) call it on a
 * shell of their own.
 *
 * Every route is registered through `defineRoute` or `defineMatterRoute` and nowhere else, so each
 * one states what it needs (nothing, a person, or a role on a matter) at the place it is defined
 * and the shell enforces it the same way for all of them.
 *
 * The routes of the pages and the API that belong to the matter and its review are in `pages.ts`
 * and `api.ts`. Each later package registers its own routes in a module of its own, called below,
 * so that this file does not change when a package arrives.
 */
export function registerRoutes(app: Hono, deps: AppDeps): void {
  registerPageRoutes(app, deps);
  registerApiRoutes(app, deps);
  registerEvaluationRoutes(app, deps);
  registerFeedbackRoutes(app, deps);
  registerPilotRoutes(app, deps);
  registerAuditRoutes(app, deps);
  registerTrainingRoutes(app, deps);
}

export { NOTICE_PARAM, noticeFor, withNotice, type NoticeCode } from "./notices.js";
