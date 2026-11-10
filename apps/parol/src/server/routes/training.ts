import type { Hono } from "hono";
import type { AppDeps } from "../deps.js";

/**
 * Where the routes of the training matter and its key are registered (work package W2.8). Nothing is registered
 * yet. The package that owns this file adds its routes here, through `defineRoute` or
 * `defineMatterRoute` and nowhere else, and builds its pages with the renderers of
 * page-renderers.ts. `index.ts` already calls this function, so no package edits `index.ts`.
 */
export function registerTrainingRoutes(app: Hono, deps: AppDeps): void {}
