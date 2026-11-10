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
import type { EffectOf, ForgedBody, OtherProbe, Probe } from "./probe-kit.js";

export const MATTER_PROBES_EVALUATIONS: readonly Probe[] = [];

export const OTHER_PROBES_EVALUATIONS: readonly OtherProbe[] = [];

export const FORGED_BODIES_EVALUATIONS: Readonly<Record<string, ForgedBody>> = {};

export const EFFECTS_EVALUATIONS: Readonly<Record<string, EffectOf>> = {};
