/**
 * The authorization probes of Parol: one request for every route of the application that names a
 * matter, shaped so that a member who is let in reaches the handler and gets a known answer
 * without changing anything (a form with nothing in it is a 400, a run that has finished is a 409,
 * a read is a 200). That is what lets the same request be sent as every kind of caller, and the
 * guard's decision be read from the answer.
 *
 * This is the single source of truth for the table and for the request builder. Two things read
 * it: the application's own tests (apps/parol/test/routes, which re-export this module) and the
 * exposure suite of the evaluation (authorization.ts next to this file). It must therefore import
 * nothing that imports vitest.
 *
 * Besides the table of the routes that name a matter, it holds three more things the authorization
 * suite sends:
 *  - the forged-id requests: for every route that takes the id of a document, a version, a run, a
 *    finding or a memo, the same request with the id of another matter's record in its place, and
 *    the places outside the path where an id goes (a body, a query string);
 *  - the bodies that would change the store if a caller who must be refused got through, for the
 *    write routes whose probe body is built to change nothing;
 *  - the routes that name no matter, read as every caller.
 *
 * Nothing here sends a request. It is data and small pure functions.
 */
import type { MatterAction } from "../../../../apps/parol/src/auth/actions.js";

export type ProbeBody =
  | { kind: "none" }
  | { kind: "form"; fields: Record<string, string> }
  | {
      kind: "multipart";
      fields: Record<string, string>;
      /** A text file in the form, for a request that has to get past the check that a file is there. */
      file?: { name: string; text: string };
    }
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

/** The ids that fill a template's parameters. A test's `Prepared` fits. */
export interface ProbeIds {
  matterId: string;
  firstDocumentId: string;
  versionId: string;
  runId: string;
  findingId: string;
  memoId: string | null;
}

export function pathFor(template: string, ids: ProbeIds, matterId = ids.matterId): string {
  return template
    .replace(":matterId", matterId)
    .replace(":documentId", ids.firstDocumentId)
    .replace(":versionId", ids.versionId)
    .replace(":runId", ids.runId)
    .replace(":findingId", ids.findingId)
    .replace(":memoId", ids.memoId ?? "no-memo")
    .replace(":name", "parol.css");
}

export interface UploadFile {
  /** The name the browser sends. Only its extension is read. */
  name: string;
  bytes: Uint8Array;
  /** The field the file is in. Default `file`. */
  field?: string;
}

/** The pairs as multipart, with a file. */
export function multipart(pairs: [string, string][], file?: UploadFile): FormData {
  const body = new FormData();
  for (const [name, value] of pairs) body.append(name, value);
  if (file !== undefined)
    body.set(file.field ?? "file", new File([new Uint8Array(file.bytes)], file.name));
  return body;
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
    case "multipart": {
      const file = probe.body.file;
      return {
        method: probe.method,
        headers,
        body: multipart(
          withToken(probe.body.fields),
          file === undefined
            ? undefined
            : { name: file.name, bytes: new TextEncoder().encode(file.text) },
        ),
      };
    }
  }
}

/** `GET /api/matters/:matterId`, for a name in a message. Route templates hold no matter data. */
export const probeName = (probe: Pick<Probe, "method" | "template">): string =>
  `${probe.method} ${probe.template}`;

// ---------------------------------------------------------------------------------------------
// The routes that name no matter
// ---------------------------------------------------------------------------------------------

/**
 * The routes that name no matter and only read, which are the ones that can show a person data of
 * a matter (the lists). The posts of `OTHER_PROBES` are left out: they sign a client in or out or
 * make a matter, which a client shared by all the probes of a caller cannot take.
 */
export const LIST_PROBES: readonly OtherProbe[] = OTHER_PROBES.filter(
  (probe) => probe.method === "GET",
);

// ---------------------------------------------------------------------------------------------
// Ids that belong to another matter, or to nothing
// ---------------------------------------------------------------------------------------------

export type SubResource = "document" | "version" | "run" | "finding" | "memo";

/** The ids a forged request borrows: those of another matter, or well formed ids of no record. */
export interface BorrowedIds {
  documentId: string;
  versionId: string;
  runId: string;
  findingId: string;
  memoId: string;
  /** What a decision on the borrowed finding carries as the content it was made on. */
  findingContentSha256: string;
}

/** Well formed ids (a prefix and 16 hex digits) of records that exist nowhere. */
export const NO_RECORD: BorrowedIds = {
  documentId: "doc_0000000000000000",
  versionId: "ver_0000000000000000",
  runId: "run_0000000000000000",
  findingId: "fnd_0000000000000000",
  memoId: "memo_0000000000000000",
  findingContentSha256: "0".repeat(64),
};

/** The id of a matter that does not exist, well formed. */
export const NO_MATTER = "mat_0000000000000000";

/** Ids of no record in every segment of the path, for the answer a request for nothing gets. */
export function noRecordIds(matterId = NO_MATTER): ProbeIds {
  return {
    matterId,
    firstDocumentId: NO_RECORD.documentId,
    versionId: NO_RECORD.versionId,
    runId: NO_RECORD.runId,
    findingId: NO_RECORD.findingId,
    memoId: NO_RECORD.memoId,
  };
}

const PLACEHOLDERS: readonly {
  token: string;
  position: SubResource;
  field: "firstDocumentId" | "versionId" | "runId" | "findingId" | "memoId";
  borrowed: "documentId" | "versionId" | "runId" | "findingId" | "memoId";
}[] = [
  { token: ":documentId", position: "document", field: "firstDocumentId", borrowed: "documentId" },
  { token: ":versionId", position: "version", field: "versionId", borrowed: "versionId" },
  { token: ":runId", position: "run", field: "runId", borrowed: "runId" },
  { token: ":findingId", position: "finding", field: "findingId", borrowed: "findingId" },
  { token: ":memoId", position: "memo", field: "memoId", borrowed: "memoId" },
];

/** The sub-resource ids a template names, as the kinds of record they are. */
export function subResourcesOf(template: string): SubResource[] {
  return PLACEHOLDERS.filter((entry) => template.includes(entry.token)).map(
    (entry) => entry.position,
  );
}

const probeKey = (probe: Pick<Probe, "method" | "template">): string =>
  `${probe.method} ${probe.template}`;

const AMENDMENT_TEXT =
  "AMENDMENT NO. 2 TO MUTUAL NONDISCLOSURE AGREEMENT\n\n" +
  "1. A paragraph of synthetic text that is long enough to be reviewed.\n";
const TEXT_FILE = { name: "amendment-2.txt", text: AMENDMENT_TEXT } as const;

/**
 * The bodies a forged request carries so that it gets past the checks on the body and reaches the
 * lookup of the id it borrows. Without one, the probe's own body stands (a read has none).
 */
const FORGED_BODIES: Record<string, (own: ProbeIds, borrowed: BorrowedIds) => ProbeBody> = {
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
 * One request of a member of a matter that names a record of another matter: the matter is the
 * caller's own, and one id in the path, the body or the query string is borrowed. The application
 * must answer it as it answers an id that exists nowhere.
 */
export interface ForgedProbe {
  /** For a message: the route and where the borrowed id goes. No id. */
  name: string;
  method: Probe["method"];
  /** The route, for the table of probes. */
  template: string;
  /** The action the route checks, which says which role of the caller's own matter is used. */
  action: MatterAction;
  position: SubResource;
  via: "path" | "body" | "query";
  /** What a member gets for an id the matter does not hold: 404, or 200 for a page that shows no inspector. */
  reaches: number;
  request(own: ProbeIds, borrowed: BorrowedIds): { path: string; body: ProbeBody };
}

const viaName = (via: ForgedProbe["via"], position: SubResource): string =>
  via === "path" ? `${position} in the path` : `${position} in the ${via}`;

function forgedInPath(probe: Probe): ForgedProbe[] {
  return PLACEHOLDERS.filter((entry) => probe.template.includes(entry.token)).map((entry) => ({
    name: `${probeKey(probe)} (${viaName("path", entry.position)})`,
    method: probe.method,
    template: probe.template,
    action: probe.action,
    position: entry.position,
    via: "path" as const,
    reaches: 404,
    request: (own, borrowed) => ({
      path: pathFor(probe.template, { ...own, [entry.field]: borrowed[entry.borrowed] }),
      body: FORGED_BODIES[probeKey(probe)]?.(own, borrowed) ?? probe.body,
    }),
  }));
}

/** The places an id goes outside the path of the route that takes it. */
const FORGED_ELSEWHERE: readonly ForgedProbe[] = [
  {
    name: `POST ${M}/documents/:documentId/operative (version in the body)`,
    method: "POST",
    template: `${M}/documents/:documentId/operative`,
    action: "document.write",
    position: "version",
    via: "body",
    reaches: 404,
    request: (own, borrowed) => ({
      path: pathFor(`${M}/documents/:documentId/operative`, own),
      body: form({ versionId: borrowed.versionId }),
    }),
  },
  {
    name: `PATCH ${A} (document of the operative version in the body)`,
    method: "PATCH",
    template: A,
    action: "matter.update",
    position: "document",
    via: "body",
    reaches: 404,
    request: (own, borrowed) => ({
      path: pathFor(A, own),
      body: json({ operative: { documentId: borrowed.documentId, versionId: own.versionId } }),
    }),
  },
  {
    name: `PATCH ${A} (version of the operative version in the body)`,
    method: "PATCH",
    template: A,
    action: "matter.update",
    position: "version",
    via: "body",
    reaches: 404,
    request: (own, borrowed) => ({
      path: pathFor(A, own),
      body: json({ operative: { documentId: own.firstDocumentId, versionId: borrowed.versionId } }),
    }),
  },
  {
    name: `PATCH ${A} (version of the stated date in the body)`,
    method: "PATCH",
    template: A,
    action: "matter.update",
    position: "version",
    via: "body",
    reaches: 404,
    request: (own, borrowed) => ({
      path: pathFor(A, own),
      body: json({ statedDate: { versionId: borrowed.versionId, statedDate: "2026-01-01" } }),
    }),
  },
  {
    name: `GET ${M}/runs/:runId (finding in the query)`,
    method: "GET",
    template: `${M}/runs/:runId`,
    action: "run.read",
    position: "finding",
    via: "query",
    reaches: 200,
    request: (own, borrowed) => ({
      path: `${pathFor(`${M}/runs/:runId`, own)}?finding=${borrowed.findingId}`,
      body: NONE,
    }),
  },
];

/**
 * Every forged request: one for each id a route of `MATTER_PROBES` takes in its path (so a route
 * added to the table with an id is forged without anyone remembering to), and the places outside
 * the path.
 */
export const FORGED_PROBES: readonly ForgedProbe[] = [
  ...MATTER_PROBES.flatMap(forgedInPath),
  ...FORGED_ELSEWHERE,
];

// ---------------------------------------------------------------------------------------------
// Bodies that would change the store
// ---------------------------------------------------------------------------------------------

/**
 * A matter made to be written to: the NDA with two versions (the earlier is not the operative one)
 * and an amendment, which is the one document that may be removed, and a person to add. When the
 * probe needs more, it has also been reviewed (`run`: a finished run whose findings are open) or
 * reviewed and decided but not exported (`decided`).
 */
export interface Scratch {
  matterId: string;
  documentId: string;
  versionId: string;
  earlierVersionId: string;
  amendmentId: string;
  invitee: string;
  runId?: string;
  findingId?: string;
  /** The decision a reviewer would make on `findingId`, as the suite's own reviewer makes it. */
  decision?: { decision: string; findingContentSha256: string; reason: string | null };
}

/** How far a scratch matter has been taken. */
export type ScratchLevel = "documents" | "run" | "decided";

/** Where a request that must change something if it gets through is aimed. */
export interface Effect {
  /** `scratch`: a matter made for the probe. `fresh`: a new matter for each request. */
  target: "scratch" | "fresh";
  /** What the scratch matter must have been taken through first. */
  needs: ScratchLevel;
  ids: (scratch: Scratch, own: ProbeIds) => ProbeIds;
  body: ProbeBody;
}

const sameIds = (_scratch: Scratch, own: ProbeIds): ProbeIds => own;
const onScratch = (scratch: Scratch, own: ProbeIds): ProbeIds => ({
  ...own,
  matterId: scratch.matterId,
  firstDocumentId: scratch.documentId,
  versionId: scratch.versionId,
  runId: scratch.runId ?? own.runId,
  findingId: scratch.findingId ?? own.findingId,
});
const NEW_DOCUMENT = {
  kind: "multipart",
  fields: { title: "A further amendment", kind: "amendment" },
  file: TEXT_FILE,
} as const satisfies ProbeBody;

const decisionFields = (scratch: Scratch): Record<string, string> => ({
  decision: scratch.decision?.decision ?? "accept",
  findingContentSha256: scratch.decision?.findingContentSha256 ?? "0".repeat(64),
  ...(scratch.decision?.reason == null ? {} : { reason: scratch.decision.reason }),
});

const EFFECTS: Record<string, (scratch: Scratch) => Effect> = {
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
  [`POST ${M}/runs`]: () => ({
    target: "scratch",
    needs: "documents",
    ids: onScratch,
    body: form({ workflow: "v2" }),
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
  [`POST ${A}/runs`]: () => ({
    target: "scratch",
    needs: "documents",
    ids: onScratch,
    body: json({ workflow: "v2" }),
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

/**
 * What to send, instead of the probe's own body, to a caller who must be refused, so that the
 * request changes the store if the guard lets it through. Null for the writes that cannot: the
 * resume and cancel of a run that has finished are answered 409 whoever sends them.
 */
export function effectOf(probe: Probe, scratch: Scratch): Effect | null {
  return EFFECTS[probeKey(probe)]?.(scratch) ?? null;
}

/** The routes of the table that have such a body: the keys, for a test that no key is stale. */
export const EFFECT_KEYS: readonly string[] = Object.keys(EFFECTS);
export const FORGED_BODY_KEYS: readonly string[] = Object.keys(FORGED_BODIES);
export const probeKeyOf = probeKey;
