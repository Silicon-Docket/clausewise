/**
 * The probes that W2.5, the evaluation comparison page adds. Empty until that package arrives; the package that owns this file
 * is the only one that edits it, and probes.ts composes it after the base tables.
 *
 *  - `MATTER_PROBES_EVALUATIONS`: a route that names a matter, with the action it checks and what a
 *    caller who is let in reaches.
 *  - `OTHER_PROBES_EVALUATIONS`: a route that names no matter; a page that only some global roles may
 *    open names its `globalAction`.
 *  - `FORGED_BODIES_EVALUATIONS` and `EFFECTS_EVALUATIONS`: by route key (`METHOD template`), the body of a
 *    forged request and the body that changes the store.
 *
 * A route may be given once in all the probe modules together: composing the tables refuses a
 * route, a forged-id body or an effect body that two owners both give.
 */
import { NONE, type EffectOf, type ForgedBody, type OtherProbe, type Probe } from "./probe-kit.js";

export const MATTER_PROBES_EVALUATIONS: readonly Probe[] = [];

/**
 * `GET /evaluations`, the evaluation comparison page. It names no matter, so it is a list probe;
 * only the legal engineer and the administrator may open it (`evaluation.read`), so a member is
 * expected to get 403 and a visitor is sent to sign in. The page takes no matter, document,
 * version, run, finding or memo id, so there is no forged id for it, and it is a read, so there is
 * no effect body: the suite's check that no row of the store changed applies to its cells. Its own
 * query values (`comparison`, `case`, `rule`) are checked by the application's route tests.
 */
export const OTHER_PROBES_EVALUATIONS: readonly OtherProbe[] = [
  {
    method: "GET",
    template: "/evaluations",
    access: "principal",
    body: NONE,
    globalAction: "evaluation.read",
  },
];

export const FORGED_BODIES_EVALUATIONS: Readonly<Record<string, ForgedBody>> = {};

export const EFFECTS_EVALUATIONS: Readonly<Record<string, EffectOf>> = {};
