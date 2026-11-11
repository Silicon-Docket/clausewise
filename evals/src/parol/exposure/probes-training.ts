/**
 * The probes that W2.8, the training matter, the quickstart and the help adds. The package that
 * owns this file is the only one that edits it, and probes.ts composes it after the base tables.
 *
 * What it holds so far:
 *
 * - `POST /training`, the form that starts the signed-in person's own training matter. It names no
 *   matter and takes no id from the request: the reviewer is a user id looked up in the store, so it
 *   has no forged-id body, and it writes to no existing matter, so it has no effect body (it makes a
 *   matter of the caller's own). The suite does not send it; `csrf.test.ts` and
 *   `authorization.test.ts` cover it. The body names the demo reviewing attorney, which is a user
 *   the suite's database has.
 *
 *  - `MATTER_PROBES_TRAINING`: a route that names a matter, with the action it checks and what a
 *    caller who is let in reaches.
 *  - `OTHER_PROBES_TRAINING`: a route that names no matter; a page that only some global roles may
 *    open names its `globalAction`.
 *  - `FORGED_BODIES_TRAINING` and `EFFECTS_TRAINING`: by route key (`METHOD template`), the body of a
 *    forged request and the body that changes the store.
 *
 * A route may be given once in all the probe modules together: composing the tables refuses a
 * route, a forged-id body or an effect body that two owners both give.
 */
import { form, type EffectOf, type ForgedBody, type OtherProbe, type Probe } from "./probe-kit.js";

export const MATTER_PROBES_TRAINING: readonly Probe[] = [];

export const OTHER_PROBES_TRAINING: readonly OtherProbe[] = [
  {
    method: "POST",
    template: "/training",
    access: "principal",
    body: form({ reviewerUserId: "usr_demo_reviewer" }),
  },
];

export const FORGED_BODIES_TRAINING: Readonly<Record<string, ForgedBody>> = {};

export const EFFECTS_TRAINING: Readonly<Record<string, EffectOf>> = {};
