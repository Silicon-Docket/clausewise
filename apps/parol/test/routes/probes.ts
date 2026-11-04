import type { MatterAction } from "../../src/auth/actions.js";
import { multipart, type Prepared } from "./support.js";

/**
 * One request for every route of the application that names a matter, shaped so that a member who
 * is let in reaches the handler and gets a known answer without changing anything: a form with
 * nothing in it (400), a run that has finished (409), a read (200). That is what lets a test send
 * the same request as every kind of caller and know from the answer whether the guard let it in.
 *
 * The authorization matrix, the CSRF test and the forged-id tests all read this table, and a test
 * fails when the application holds a route that is not in it.
 */

export type ProbeBody =
  | { kind: "none" }
  | { kind: "form"; fields: Record<string, string> }
  | { kind: "multipart"; fields: Record<string, string> }
  | { kind: "json"; json: unknown };

export interface Probe {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  template: string;
  action: MatterAction;
  body: ProbeBody;
  /** What a caller who is let in gets. The guard's own refusals are 401, 403 and 404. */
  reaches: number;
  /** Runs on a matter made for the request, because the request changes it for good. */
  fresh?: boolean;
}

const NONE: ProbeBody = { kind: "none" };
const form = (fields: Record<string, string> = {}): ProbeBody => ({ kind: "form", fields });
const upload: ProbeBody = { kind: "multipart", fields: {} };
const json = (value: unknown = {}): ProbeBody => ({ kind: "json", json: value });

const M = "/matters/:matterId";
const A = "/api/matters/:matterId";

export const MATTER_PROBES: readonly Probe[] = [
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
export interface OtherProbe {
  method: "GET" | "POST";
  template: string;
  access: "public" | "principal";
  body: ProbeBody;
}

export const OTHER_PROBES: readonly OtherProbe[] = [
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

export const isApi = (template: string): boolean => template.startsWith("/api/");
export const isUnsafe = (method: string): boolean => method !== "GET";

/** The ids that fill a template's parameters. */
export function pathFor(template: string, ids: Prepared, matterId = ids.matterId): string {
  return template
    .replace(":matterId", matterId)
    .replace(":documentId", ids.firstDocumentId)
    .replace(":versionId", ids.versionId)
    .replace(":runId", ids.runId)
    .replace(":findingId", ids.findingId)
    .replace(":memoId", ids.memoId ?? "no-memo")
    .replace(":name", "parol.css");
}

/**
 * The request for a probe. `token` is what the caller sends as its CSRF token: a string, or null
 * for none. A page form carries it in the `_csrf` field and the JSON API in the header, as the
 * pages and a script do; a read carries none.
 */
export interface Init {
  method: string;
  headers: Record<string, string>;
  body?: BodyInit;
}

export function initFor(
  probe: { method: string; template: string; body: ProbeBody },
  token: string | null,
): Init {
  const headers: Record<string, string> = {};
  const api = isApi(probe.template);
  if (api && token !== null && isUnsafe(probe.method)) headers["x-csrf-token"] = token;
  const withToken = (fields: Record<string, string>): [string, string][] => [
    ...Object.entries(fields),
    ...(!api && token !== null ? ([["_csrf", token]] as [string, string][]) : []),
  ];
  switch (probe.body.kind) {
    case "none":
      return { method: probe.method, headers };
    case "json":
      headers["content-type"] = "application/json";
      return { method: probe.method, headers, body: JSON.stringify(probe.body.json) };
    case "form":
      headers["content-type"] = "application/x-www-form-urlencoded";
      return {
        method: probe.method,
        headers,
        body: new URLSearchParams(withToken(probe.body.fields)).toString(),
      };
    case "multipart":
      return { method: probe.method, headers, body: multipart(withToken(probe.body.fields)) };
  }
}
