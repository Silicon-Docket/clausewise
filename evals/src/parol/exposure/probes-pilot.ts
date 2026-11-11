/**
 * The probes that W2.6b, the pilot measures adds. The package that owns this file is the only one
 * that edits it, and probes.ts composes it after the base tables.
 *
 *  - `MATTER_PROBES_PILOT`: a route that names a matter, with the action it checks and what a
 *    caller who is let in reaches.
 *  - `OTHER_PROBES_PILOT`: a route that names no matter; a page that only some global roles may
 *    open names its `globalAction`.
 *  - `FORGED_BODIES_PILOT` and `EFFECTS_PILOT`: by route key (`METHOD template`), the body of a
 *    forged request and the body that changes the store.
 *
 * A route may be given once in all the probe modules together: composing the tables refuses a
 * route, a forged-id body or an effect body that two owners both give.
 *
 * The two forms of a matter, the timer and the reference list. Neither takes an id besides the
 * matter: the timer is the signed-in person's own on the matter of the path, and the reference list
 * is the matter's. So neither has a forged-id body (there is no id to forge), and each states why
 * here and in the application's tests. Each has an effect body that would change the store if a
 * caller who must be refused got through: a timer started on the scratch matter (a row in
 * `time_entries` and an event in the audit log), and a reference list saved with one issue (a row in
 * `reference_issues` and an event). Both are aimed at the scratch matter at the level `documents`:
 * a timer needs only membership, and the reference list needs a matter with no review started and a
 * pinned playbook, which the scratch matter has (`dur-1` is a rule of the demo playbook). Each
 * probe's own body is refused with 400 whatever the state of the matter (`intent=pause` is not a
 * timer intent; `outsideHigh=x` is not a count), so a caller who is let in changes nothing with it.
 * The let-in proof is sent by the first documented role of the action: the associate for
 * `time.record`, the reviewer for `reference.write`.
 *
 * The four routes that name no matter. `GET /pilot` and `GET /pilot/measures.csv` are the pilot
 * measures page and its CSV, for the legal engineer and the administrator (`pilot.read`): the suite
 * expects 303 to sign in for a visitor, 403 for every signed-in caller whose global role the
 * hand-written table does not list (all five of its member actors), and 200 for the administrator,
 * and it fetches both as the administrator for the canary scan. Both show counts and fixed text
 * only, never a matter title, a text window or the id of a matter, a run, a finding or a memo, which
 * is what lets them sit in the lists group. The two POSTs (`POST /pilot/calendar`,
 * `POST /pilot/participants`, `pilot.manage`) are listed so that the application's tests
 * (`csrf.test.ts` and the generic global block of `authorization.test.ts`) send them; the exposure
 * suite sends no POST that names no matter.
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

export const MATTER_PROBES_PILOT: readonly Probe[] = [
  {
    method: "POST",
    template: `${M}/timer`,
    action: "time.record",
    body: form({ intent: "pause" }),
    reaches: 400,
  },
  {
    method: "POST",
    template: `${M}/reference-list`,
    action: "reference.write",
    body: form({ outsideHigh: "x" }),
    reaches: 400,
  },
];

export const OTHER_PROBES_PILOT: readonly OtherProbe[] = [
  {
    method: "GET",
    template: "/pilot",
    access: "principal",
    body: NONE,
    globalAction: "pilot.read",
  },
  {
    method: "GET",
    template: "/pilot/measures.csv",
    access: "principal",
    body: NONE,
    globalAction: "pilot.read",
  },
  {
    method: "POST",
    template: "/pilot/calendar",
    access: "principal",
    body: form({ startDate: "2026-11-09" }),
    globalAction: "pilot.manage",
  },
  {
    method: "POST",
    template: "/pilot/participants",
    access: "principal",
    body: form({ "trained:usr_demo_associate": "yes" }),
    globalAction: "pilot.manage",
  },
];

export const FORGED_BODIES_PILOT: Readonly<Record<string, ForgedBody>> = {};

export const EFFECTS_PILOT: Readonly<Record<string, EffectOf>> = {
  [`POST ${M}/timer`]: () => ({
    target: "scratch",
    needs: "documents",
    ids: onScratch,
    body: form({ intent: "start" }),
  }),
  [`POST ${M}/reference-list`]: () => ({
    target: "scratch",
    needs: "documents",
    ids: onScratch,
    body: form({ "severity:dur-1": "high" }),
  }),
};
