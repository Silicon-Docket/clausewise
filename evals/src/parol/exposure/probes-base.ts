/**
 * The base tables of the probes: the routes the application had before the packages of part 3
 * added theirs. A route that a later package adds is probed in that package's own fragment
 * (probes-evaluations.ts, probes-retention.ts, probes-feedback.ts, probes-training.ts and
 * probes-pilot.ts), not here; probes.ts composes the base and the fragments into the tables that
 * the exposure suite and the application's tests read.
 *
 * Nothing here sends a request. It is data.
 */
import {
  A,
  M,
  NEW_DOCUMENT,
  NONE,
  TEXT_FILE,
  decisionFields,
  form,
  json,
  onScratch,
  sameIds,
  upload,
  type EffectOf,
  type ForgedBody,
  type OtherProbe,
  type Probe,
} from "./probe-kit.js";

export const MATTER_PROBES_BASE: readonly Probe[] = [
  // Pages and forms
  { method: "GET", template: M, action: "matter.read", body: NONE, reaches: 200 },
  {
    method: "POST",
    template: `${M}/settings`,
    action: "matter.update",
    body: form(),
    reaches: 400,
  },
  { method: "POST", template: `${M}/members`, action: "member.add", body: form(), reaches: 400 },
  { method: "POST", template: `${M}/delete`, action: "matter.delete", body: form(), reaches: 400 },
  {
    method: "POST",
    template: `${M}/documents`,
    action: "document.write",
    body: upload,
    reaches: 400,
  },
  {
    method: "POST",
    template: `${M}/documents/:documentId/versions`,
    action: "document.write",
    body: upload,
    reaches: 400,
  },
  {
    method: "POST",
    template: `${M}/documents/:documentId/operative`,
    action: "document.write",
    body: form(),
    reaches: 400,
  },
  {
    method: "POST",
    template: `${M}/versions/:versionId/stated-date`,
    action: "document.write",
    body: form({ statedDate: "2026-13-45" }),
    reaches: 400,
  },
  {
    method: "POST",
    template: `${M}/documents/:documentId/remove`,
    action: "document.write",
    body: form(),
    reaches: 400,
  },
  {
    method: "POST",
    template: `${M}/runs`,
    action: "run.start",
    body: form({ workflow: "bad label!" }),
    reaches: 400,
  },
  {
    method: "POST",
    template: `${M}/runs/:runId/resume`,
    action: "run.resume",
    body: form(),
    reaches: 409,
  },
  {
    method: "POST",
    template: `${M}/runs/:runId/cancel`,
    action: "run.start",
    body: form(),
    reaches: 409,
  },
  { method: "GET", template: `${M}/runs/:runId`, action: "run.read", body: NONE, reaches: 200 },
  {
    method: "GET",
    template: `${M}/runs/:runId/status`,
    action: "run.read",
    body: NONE,
    reaches: 200,
  },
  {
    method: "GET",
    template: `${M}/findings/:findingId`,
    action: "finding.read",
    body: NONE,
    reaches: 200,
  },
  {
    method: "POST",
    template: `${M}/findings/:findingId/reviews`,
    action: "review.decide",
    body: form(),
    reaches: 400,
  },
  { method: "GET", template: `${M}/memos`, action: "memo.read", body: NONE, reaches: 200 },
  { method: "POST", template: `${M}/memos`, action: "memo.export", body: form(), reaches: 303 },
  {
    method: "GET",
    template: `${M}/memos/:memoId/file`,
    action: "memo.read",
    body: NONE,
    reaches: 200,
  },

  // The JSON API
  { method: "GET", template: A, action: "matter.read", body: NONE, reaches: 200 },
  { method: "PATCH", template: A, action: "matter.update", body: json(), reaches: 400 },
  { method: "DELETE", template: A, action: "matter.delete", body: NONE, reaches: 204, fresh: true },
  { method: "POST", template: `${A}/members`, action: "member.add", body: json(), reaches: 400 },
  {
    method: "POST",
    template: `${A}/documents`,
    action: "document.write",
    body: upload,
    reaches: 400,
  },
  {
    method: "POST",
    template: `${A}/documents/:documentId/versions`,
    action: "document.write",
    body: upload,
    reaches: 400,
  },
  {
    // The NDA is not the last document, so it cannot be removed: nothing changes.
    method: "DELETE",
    template: `${A}/documents/:documentId`,
    action: "document.write",
    body: NONE,
    reaches: 409,
  },
  {
    method: "POST",
    template: `${A}/runs`,
    action: "run.start",
    body: json({ workflow: "bad label!" }),
    reaches: 400,
  },
  { method: "GET", template: `${A}/runs`, action: "run.read", body: NONE, reaches: 200 },
  { method: "GET", template: `${A}/runs/:runId`, action: "run.read", body: NONE, reaches: 200 },
  {
    method: "POST",
    template: `${A}/runs/:runId/resume`,
    action: "run.resume",
    body: NONE,
    reaches: 409,
  },
  {
    method: "POST",
    template: `${A}/runs/:runId/cancel`,
    action: "run.start",
    body: NONE,
    reaches: 409,
  },
  {
    method: "GET",
    template: `${A}/runs/:runId/findings`,
    action: "run.read",
    body: NONE,
    reaches: 200,
  },
  {
    method: "GET",
    template: `${A}/findings/:findingId`,
    action: "finding.read",
    body: NONE,
    reaches: 200,
  },
  {
    method: "POST",
    template: `${A}/findings/:findingId/reviews`,
    action: "review.decide",
    body: json(),
    reaches: 400,
  },
  { method: "POST", template: `${A}/memos`, action: "memo.export", body: NONE, reaches: 201 },
  {
    method: "GET",
    template: `${A}/memos/:memoId/file`,
    action: "memo.read",
    body: NONE,
    reaches: 200,
  },
];

/** The routes that do not name a matter: a person is enough, or not even that. */
export const OTHER_PROBES_BASE: readonly OtherProbe[] = [
  { method: "GET", template: "/", access: "public", body: NONE },
  { method: "GET", template: "/healthz", access: "public", body: NONE },
  { method: "GET", template: "/assets/:name", access: "public", body: NONE },
  {
    method: "POST",
    template: "/session",
    access: "public",
    body: form({ intent: "sign-in", userId: "usr_demo_associate" }),
  },
  { method: "POST", template: "/session/end", access: "public", body: form() },
  { method: "GET", template: "/api/session", access: "public", body: NONE },
  { method: "GET", template: "/matters", access: "principal", body: NONE },
  {
    method: "POST",
    template: "/matters",
    access: "principal",
    body: form({ name: "A probe", clientLegalName: "Probe, Inc." }),
  },
  { method: "GET", template: "/api/matters", access: "principal", body: NONE },
  {
    method: "POST",
    template: "/api/matters",
    access: "principal",
    body: json({ name: "A probe", clientLegalName: "Probe, Inc." }),
  },
  { method: "GET", template: "/api/playbooks", access: "principal", body: NONE },
];

/**
 * The bodies a forged request carries so that it gets past the checks on the body and reaches the
 * lookup of the id it borrows. Without one, the probe's own body stands (a read has none).
 */
export const FORGED_BODIES_BASE: Readonly<Record<string, ForgedBody>> = {
  [`POST ${M}/documents/:documentId/versions`]: () => ({
    kind: "multipart",
    fields: { statedDate: "2026-09-16" },
    file: TEXT_FILE,
  }),
  [`POST ${A}/documents/:documentId/versions`]: () => ({
    kind: "multipart",
    fields: { statedDate: "2026-09-16" },
    file: TEXT_FILE,
  }),
  [`POST ${M}/documents/:documentId/operative`]: (own) => form({ versionId: own.versionId }),
  [`POST ${M}/versions/:versionId/stated-date`]: () => form({ statedDate: "2026-01-01" }),
  [`POST ${M}/documents/:documentId/remove`]: () => form({ confirm: "yes" }),
  [`POST ${M}/findings/:findingId/reviews`]: (_own, borrowed) =>
    form({ decision: "accept", findingContentSha256: borrowed.findingContentSha256 }),
  [`POST ${A}/findings/:findingId/reviews`]: (_own, borrowed) =>
    json({ decision: "accept", findingContentSha256: borrowed.findingContentSha256 }),
};

/**
 * What to send, instead of the probe's own body, to a caller who must be refused, so that the
 * request changes the store if the guard lets it through. The key is the route, `METHOD template`.
 */
export const EFFECTS_BASE: Readonly<Record<string, EffectOf>> = {
  [`POST ${M}/settings`]: () => ({
    target: "scratch",
    needs: "documents",
    ids: onScratch,
    body: form({ clientLegalName: "A Changed Client, Inc." }),
  }),
  [`POST ${M}/members`]: (scratch) => ({
    target: "scratch",
    needs: "documents",
    ids: onScratch,
    body: form({ userId: scratch.invitee, role: "viewer" }),
  }),
  [`POST ${M}/delete`]: () => ({
    target: "scratch",
    needs: "documents",
    ids: onScratch,
    body: form({ confirm: "yes" }),
  }),
  [`POST ${M}/documents`]: () => ({
    target: "scratch",
    needs: "documents",
    ids: onScratch,
    body: NEW_DOCUMENT,
  }),
  [`POST ${M}/documents/:documentId/versions`]: () => ({
    target: "scratch",
    needs: "documents",
    ids: onScratch,
    body: { kind: "multipart", fields: { statedDate: "2026-09-16" }, file: TEXT_FILE },
  }),
  [`POST ${M}/documents/:documentId/operative`]: (scratch) => ({
    target: "scratch",
    needs: "documents",
    ids: onScratch,
    body: form({ versionId: scratch.earlierVersionId }),
  }),
  [`POST ${M}/versions/:versionId/stated-date`]: () => ({
    target: "scratch",
    needs: "documents",
    ids: onScratch,
    body: form({ statedDate: "2031-07-04" }),
  }),
  [`POST ${M}/documents/:documentId/remove`]: (scratch) => ({
    target: "scratch",
    needs: "documents",
    ids: (s, own) => ({ ...onScratch(s, own), firstDocumentId: scratch.amendmentId }),
    body: form({ confirm: "yes" }),
  }),
  [`POST ${M}/runs`]: (scratch) => ({
    target: "scratch",
    needs: "documents",
    ids: onScratch,
    body: form({ workflow: scratch.workflow }),
  }),
  [`POST ${M}/findings/:findingId/reviews`]: (scratch) => ({
    target: "scratch",
    needs: "run",
    ids: onScratch,
    body: form(decisionFields(scratch)),
  }),
  [`POST ${M}/memos`]: () => ({
    target: "scratch",
    needs: "decided",
    ids: onScratch,
    body: form(),
  }),
  [`PATCH ${A}`]: () => ({
    target: "scratch",
    needs: "documents",
    ids: onScratch,
    body: json({ clientLegalName: "A Changed Client, Inc." }),
  }),
  [`DELETE ${A}`]: () => ({ target: "fresh", needs: "documents", ids: sameIds, body: NONE }),
  [`POST ${A}/members`]: (scratch) => ({
    target: "scratch",
    needs: "documents",
    ids: onScratch,
    body: json({ userId: scratch.invitee, role: "viewer" }),
  }),
  [`POST ${A}/documents`]: () => ({
    target: "scratch",
    needs: "documents",
    ids: onScratch,
    body: NEW_DOCUMENT,
  }),
  [`POST ${A}/documents/:documentId/versions`]: () => ({
    target: "scratch",
    needs: "documents",
    ids: onScratch,
    body: { kind: "multipart", fields: { statedDate: "2026-09-16" }, file: TEXT_FILE },
  }),
  [`DELETE ${A}/documents/:documentId`]: (scratch) => ({
    target: "scratch",
    needs: "documents",
    ids: (s, own) => ({ ...onScratch(s, own), firstDocumentId: scratch.amendmentId }),
    body: NONE,
  }),
  [`POST ${A}/runs`]: (scratch) => ({
    target: "scratch",
    needs: "documents",
    ids: onScratch,
    body: json({ workflow: scratch.workflow }),
  }),
  [`POST ${A}/findings/:findingId/reviews`]: (scratch) => ({
    target: "scratch",
    needs: "run",
    ids: onScratch,
    body: json(decisionFields(scratch)),
  }),
  [`POST ${A}/memos`]: () => ({
    target: "scratch",
    needs: "decided",
    ids: onScratch,
    body: NONE,
  }),
};
