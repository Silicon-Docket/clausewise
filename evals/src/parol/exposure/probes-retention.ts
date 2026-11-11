/**
 * The probes that W2.7, retention and the audit log adds. The package that owns this file is the
 * only one that edits it, and probes.ts composes it after the base tables.
 *
 * What it holds:
 *
 * - `POST /matters/:matterId/retention` (slice B), the form that changes how long a matter is kept.
 *   It takes no id besides the matter, so it has no forged-id body. Its probe sends an empty form,
 *   which reaches the handler and fails there with 400 (the number of days is missing). Its effect
 *   body sets 60 days, which moves `retain_until` of the scratch matter if a caller who should have
 *   been refused gets through (the fingerprint hashes every row). The action is `matter.update`,
 *   the associate's, so no matter action was added for it.
 * - `GET /audit` (slice C), the audit log check, a page that names no matter and only an
 *   administrator may open (`audit.read`). The exposure suite expects 303 to sign in for a visitor,
 *   403 for every signed-in caller whose global role the hand-written table does not list (all five
 *   of its member actors), and 200 for the administrator, and it fetches the page as the
 *   administrator for the canary scan. The page shows counts and fixed text; it lists the ids of at
 *   most 20 matters, and only when the events do not account for a matter, which the suite's own
 *   database never has (the application's tests cover the page with such a database).
 *
 *  - `MATTER_PROBES_RETENTION`: a route that names a matter, with the action it checks and what a
 *    caller who is let in reaches.
 *  - `OTHER_PROBES_RETENTION`: a route that names no matter; a page that only some global roles may
 *    open names its `globalAction`.
 *  - `FORGED_BODIES_RETENTION` and `EFFECTS_RETENTION`: by route key (`METHOD template`), the body of a
 *    forged request and the body that changes the store.
 *
 * A route may be given once in all the probe modules together: composing the tables refuses a
 * route, a forged-id body or an effect body that two owners both give.
 */
import {
  M,
  NONE,
  form,
  onScratch,
  type EffectOf,
  type ForgedBody,
  type OtherProbe,
  type Probe,
} from "./probe-kit.js";

export const MATTER_PROBES_RETENTION: readonly Probe[] = [
  {
    method: "POST",
    template: `${M}/retention`,
    action: "matter.update",
    body: form(),
    reaches: 400,
  },
];

export const OTHER_PROBES_RETENTION: readonly OtherProbe[] = [
  {
    method: "GET",
    template: "/audit",
    access: "principal",
    body: NONE,
    globalAction: "audit.read",
  },
];

export const FORGED_BODIES_RETENTION: Readonly<Record<string, ForgedBody>> = {};

export const EFFECTS_RETENTION: Readonly<Record<string, EffectOf>> = {
  [`POST ${M}/retention`]: () => ({
    target: "scratch",
    needs: "documents",
    ids: onScratch,
    body: form({ retainDays: "60" }),
  }),
};
