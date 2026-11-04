import type { Hono } from "hono";
import type { AppDeps } from "../deps.js";
import { registerApiRoutes } from "./api.js";
import { registerPageRoutes } from "./pages.js";

/**
 * Adds the page routes and the JSON API to the application `createApp` made. `main.ts` loads this
 * function by name, and the route-coverage tests (test/server/shell-routes.test.ts) call it on a
 * shell of their own.
 *
 * Every route is registered through `defineRoute` or `defineMatterRoute` and nowhere else, so each
 * one states what it needs (nothing, a person, or a role on a matter) at the place it is defined
 * and the shell enforces it the same way for all of them.
 */
export function registerRoutes(app: Hono, deps: AppDeps): void {
  registerPageRoutes(app, deps);
  registerApiRoutes(app, deps);
}

export { NOTICE_PARAM, noticeFor, withNotice, type NoticeCode } from "./notices.js";
