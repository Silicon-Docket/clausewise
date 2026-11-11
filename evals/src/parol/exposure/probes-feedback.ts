/**
 * The probes that W2.6a, feedback capture adds. The package that owns this file is the only one that
 * edits it, and probes.ts composes it after the base tables.
 *
 *  - `MATTER_PROBES_FEEDBACK`: a route that names a matter, with the action it checks and what a
 *    caller who is let in reaches.
 *  - `OTHER_PROBES_FEEDBACK`: a route that names no matter; a page that only some global roles may
 *    open names its `globalAction`. The capture adds none.
 *  - `FORGED_BODIES_FEEDBACK` and `EFFECTS_FEEDBACK`: by route key (`METHOD template`), the body of a
 *    forged request and the body that changes the store.
 *
 * A route may be given once in all the probe modules together: composing the tables refuses a
 * route, a forged-id body or an effect body that two owners both give.
 *
 * Slice B, the report of a missed issue, as a form and as JSON. Both name a run in the path, and a
 * run of another matter must be answered as a run that does not exist, so each has a forged-id body:
 * a body that passes every check on the body, so that the forged request is stopped by the lookup of
 * the run and not by a refusal of the body. Each has an effect body too, which is aimed at a review
 * of a scratch matter (`needs: "run"`): sent by a caller who must be refused, it would add a row to
 * `feedback` and an event to the audit log if the guard let it through, and the fingerprint of the
 * store, which hashes every row, would show it. The probe's own body is empty and reaches the
 * handler, which refuses it with 400 (no rule was chosen), whatever the state of the matter.
 *
 * The action is `feedback.add`, which every role holds, so the refused callers of the matrix are the
 * outsider, the stranger, the administrator and the visitor.
 */
import {
  A,
  M,
  form,
  json,
  onScratch,
  type EffectOf,
  type ForgedBody,
  type OtherProbe,
  type Probe,
} from "./probe-kit.js";

export const MATTER_PROBES_FEEDBACK: readonly Probe[] = [
  {
    method: "POST",
    template: `${M}/runs/:runId/missed-issues`,
    action: "feedback.add",
    body: form(),
    reaches: 400,
  },
  {
    method: "POST",
    template: `${A}/runs/:runId/missed-issues`,
    action: "feedback.add",
    body: json(),
    reaches: 400,
  },
];

export const OTHER_PROBES_FEEDBACK: readonly OtherProbe[] = [];

export const FORGED_BODIES_FEEDBACK: Readonly<Record<string, ForgedBody>> = {
  [`POST ${M}/runs/:runId/missed-issues`]: () =>
    form({ ruleKey: "(none)", note: "A report written by a probe." }),
  [`POST ${A}/runs/:runId/missed-issues`]: () =>
    json({ ruleKey: null, note: "A report written by a probe." }),
};

export const EFFECTS_FEEDBACK: Readonly<Record<string, EffectOf>> = {
  [`POST ${M}/runs/:runId/missed-issues`]: () => ({
    target: "scratch",
    needs: "run",
    ids: onScratch,
    body: form({ ruleKey: "(none)", location: "", note: "A missed issue written by a probe." }),
  }),
  [`POST ${A}/runs/:runId/missed-issues`]: () => ({
    target: "scratch",
    needs: "run",
    ids: onScratch,
    body: json({ ruleKey: null, location: null, note: "A missed issue written by a probe." }),
  }),
};
