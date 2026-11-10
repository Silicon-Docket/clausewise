/**
 * The authorization probes of Parol: one request for every route of the application that names a
 * matter, shaped so that a member who is let in reaches the handler and gets a known answer
 * without changing anything (a form with nothing in it is a 400, a run that has finished is a 409,
 * a read is a 200). That is what lets the same request be sent as every kind of caller, and the
 * guard's decision be read from the answer.
 *
 * This is the single source of truth for the tables and for the request builder. Two things read
 * it: the application's own tests (apps/parol/test/routes, which re-export this module) and the
 * exposure suite of the evaluation (authorization.ts next to this file). It must therefore import
 * nothing that imports vitest.
 *
 * The tables are composed here from the base (probes-base.ts) and the fragments of the packages
 * that add routes (probes-evaluations.ts, probes-retention.ts, probes-feedback.ts,
 * probes-training.ts and probes-pilot.ts, in that order), by `composeProbeTables`, which refuses
 * a route that two owners both give. The types and the small builders are in probe-kit.ts.
 *
 * Besides the table of the routes that name a matter, it holds three more things the authorization
 * suite sends:
 *  - the forged-id requests: for every route that takes the id of a document, a version, a run, a
 *    finding or a memo, the same request with the id of another matter's record in its place, and
 *    the places outside the path where an id goes (a body, a query string);
 *  - the bodies that would change the store if a caller who must be refused got through, for the
 *    write routes whose probe body is built to change nothing;
 *  - the routes that name no matter, read as every caller;
 *  - the URLs that no route owns (under a matter, and at each probed route under the methods the
 *    table does not probe), which must be answered with the 404 of any URL that nothing owns.
 *
 * Nothing here sends a request. It is data and small pure functions.
 */
import type { MatterAction } from "../../../../apps/parol/src/auth/actions.js";
import {
  A,
  M,
  NONE,
  composeProbeTables,
  form,
  json,
  probeKey,
  type BorrowedIds,
  type Effect,
  type OtherProbe,
  type Probe,
  type ProbeBody,
  type ProbeFragment,
  type ProbeIds,
  type Scratch,
  type SubResource,
} from "./probe-kit.js";
import {
  EFFECTS_BASE,
  FORGED_BODIES_BASE,
  MATTER_PROBES_BASE,
  OTHER_PROBES_BASE,
} from "./probes-base.js";
import {
  EFFECTS_EVALUATIONS,
  FORGED_BODIES_EVALUATIONS,
  MATTER_PROBES_EVALUATIONS,
  OTHER_PROBES_EVALUATIONS,
} from "./probes-evaluations.js";
import {
  EFFECTS_FEEDBACK,
  FORGED_BODIES_FEEDBACK,
  MATTER_PROBES_FEEDBACK,
  OTHER_PROBES_FEEDBACK,
} from "./probes-feedback.js";
import {
  EFFECTS_PILOT,
  FORGED_BODIES_PILOT,
  MATTER_PROBES_PILOT,
  OTHER_PROBES_PILOT,
} from "./probes-pilot.js";
import {
  EFFECTS_RETENTION,
  FORGED_BODIES_RETENTION,
  MATTER_PROBES_RETENTION,
  OTHER_PROBES_RETENTION,
} from "./probes-retention.js";
import {
  EFFECTS_TRAINING,
  FORGED_BODIES_TRAINING,
  MATTER_PROBES_TRAINING,
  OTHER_PROBES_TRAINING,
} from "./probes-training.js";

export type {
  BorrowedIds,
  Effect,
  OtherProbe,
  Probe,
  ProbeBody,
  ProbeFragment,
  ProbeIds,
  Scratch,
  ScratchLevel,
  SubResource,
} from "./probe-kit.js";

/**
 * The owners of the tables, in the order they are composed: the base, then the packages in the
 * order of the phases that add them.
 */
export const PROBE_FRAGMENTS: readonly ProbeFragment[] = [
  {
    name: "base",
    matter: MATTER_PROBES_BASE,
    other: OTHER_PROBES_BASE,
    forgedBodies: FORGED_BODIES_BASE,
    effects: EFFECTS_BASE,
  },
  {
    name: "evaluations",
    matter: MATTER_PROBES_EVALUATIONS,
    other: OTHER_PROBES_EVALUATIONS,
    forgedBodies: FORGED_BODIES_EVALUATIONS,
    effects: EFFECTS_EVALUATIONS,
  },
  {
    name: "retention",
    matter: MATTER_PROBES_RETENTION,
    other: OTHER_PROBES_RETENTION,
    forgedBodies: FORGED_BODIES_RETENTION,
    effects: EFFECTS_RETENTION,
  },
  {
    name: "feedback",
    matter: MATTER_PROBES_FEEDBACK,
    other: OTHER_PROBES_FEEDBACK,
    forgedBodies: FORGED_BODIES_FEEDBACK,
    effects: EFFECTS_FEEDBACK,
  },
  {
    name: "training",
    matter: MATTER_PROBES_TRAINING,
    other: OTHER_PROBES_TRAINING,
    forgedBodies: FORGED_BODIES_TRAINING,
    effects: EFFECTS_TRAINING,
  },
  {
    name: "pilot",
    matter: MATTER_PROBES_PILOT,
    other: OTHER_PROBES_PILOT,
    forgedBodies: FORGED_BODIES_PILOT,
    effects: EFFECTS_PILOT,
  },
];

const TABLES = composeProbeTables(PROBE_FRAGMENTS);

export const MATTER_PROBES: readonly Probe[] = TABLES.matter;

/** The routes that do not name a matter: a person is enough, or not even that. */
export const OTHER_PROBES: readonly OtherProbe[] = TABLES.other;

const FORGED_BODIES: Readonly<Record<string, (own: ProbeIds, borrowed: BorrowedIds) => ProbeBody>> =
  TABLES.forgedBodies;
const EFFECTS: Readonly<Record<string, (scratch: Scratch) => Effect>> = TABLES.effects;

export const isApi = (template: string): boolean => template.startsWith("/api/");
export const isUnsafe = (method: string): boolean => method !== "GET";

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
  /**
   * The ids of other records that the application checks against the borrowed one, which the
   * request also names: a version must belong to the document named with it. A request that has
   * any is sent in two forms, and `consistent` says which this is.
   */
  pairedWith: readonly SubResource[];
  /**
   * Every id the request names, the paired ones too, comes from one record of the other matter.
   * When it is false the id under test is the other matter's and the paired ones are the caller's
   * own, which the application's check of the pair turns away whether or not the lookups are
   * scoped to the matter; when it is true that check is passed and the lookups are what answers.
   */
  consistent: boolean;
  /** What a member gets for an id the matter does not hold: 404, or 200 for a page that shows no inspector. */
  reaches: number;
  request(own: ProbeIds, borrowed: BorrowedIds): { path: string; body: ProbeBody };
}

const viaName = (via: ForgedProbe["via"], position: SubResource): string =>
  via === "path" ? `${position} in the path` : `${position} in the ${via}`;

/**
 * The ids a body carries besides the one in the path, for the routes where the application checks
 * the two against each other. The other ids that the path itself names are paired with it as well,
 * and are read from the template, so that a route added to the table with several ids in its path
 * has the consistent form without anyone listing it here.
 */
const PAIRED_IN_BODY: Record<string, readonly SubResource[]> = {
  [`POST ${M}/documents/:documentId/operative`]: ["version"],
};

function forgedInPath(probe: Probe): ForgedProbe[] {
  return PLACEHOLDERS.filter((entry) => probe.template.includes(entry.token)).map((entry) => ({
    name: `${probeKey(probe)} (${viaName("path", entry.position)})`,
    method: probe.method,
    template: probe.template,
    action: probe.action,
    position: entry.position,
    via: "path" as const,
    pairedWith: [
      ...new Set([
        ...subResourcesOf(probe.template).filter((kind) => kind !== entry.position),
        ...(PAIRED_IN_BODY[probeKey(probe)] ?? []),
      ]),
    ],
    consistent: false,
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
    pairedWith: ["document"],
    consistent: false,
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
    pairedWith: ["version"],
    consistent: false,
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
    pairedWith: ["document"],
    consistent: false,
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
    pairedWith: [],
    consistent: false,
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
    // The page picks the finding from the run's own list, so there is no pair to check.
    pairedWith: [],
    consistent: false,
    reaches: 200,
    request: (own, borrowed) => ({
      path: `${pathFor(`${M}/runs/:runId`, own)}?finding=${borrowed.findingId}`,
      body: NONE,
    }),
  },
];

/**
 * Every id of a record that a request can name, taken from one record of the other matter and not
 * only the one under test: the matter stays the caller's own.
 */
const wholeRecord = (own: ProbeIds, borrowed: BorrowedIds): ProbeIds => ({
  ...own,
  firstDocumentId: borrowed.documentId,
  versionId: borrowed.versionId,
  runId: borrowed.runId,
  findingId: borrowed.findingId,
  memoId: borrowed.memoId,
});

/**
 * The consistent form of the requests that name several ids: one for each route and set of ids,
 * made from the first of the mixed requests that names them, with the ids the caller would have
 * kept as their own taken from the record of the other matter as well. A route that names several
 * ids is therefore never forged only in the form that its own check of the pair turns away. The
 * form is a path form when every id it names is in the path, and a body form when one is not.
 */
function consistentForms(mixed: readonly ForgedProbe[]): ForgedProbe[] {
  const seen = new Set<string>();
  const out: ForgedProbe[] = [];
  for (const base of mixed) {
    if (base.pairedWith.length === 0) continue;
    const kinds = [base.position, ...base.pairedWith].sort();
    const identity = `${base.method} ${base.template} ${kinds.join(" ")}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const inPath = subResourcesOf(base.template);
    out.push({
      ...base,
      name: `${base.method} ${base.template} (${kinds.join(" and ")} of one record of the other matter)`,
      via: base.via === "path" && kinds.every((kind) => inPath.includes(kind)) ? "path" : "body",
      consistent: true,
      request: (own, borrowed) => base.request(wholeRecord(own, borrowed), borrowed),
    });
  }
  return out;
}

/**
 * The forged requests for a table of routes: one for each id a route takes in its path (so a route
 * added to the table with an id is forged without anyone remembering to), the places outside the
 * path, and, for each route that names several ids, the request with all of them from one record
 * of the other matter. Exported so that a test can ask what a route added to the table would get.
 */
export function forgedProbesFor(table: readonly Probe[]): ForgedProbe[] {
  const mixed = [...table.flatMap(forgedInPath), ...FORGED_ELSEWHERE];
  return [...mixed, ...consistentForms(mixed)];
}

/** Every forged request of the application's routes: `forgedProbesFor(MATTER_PROBES)`. */
export const FORGED_PROBES: readonly ForgedProbe[] = forgedProbesFor(MATTER_PROBES);

// ---------------------------------------------------------------------------------------------
// URLs that no route owns
// ---------------------------------------------------------------------------------------------

/** The methods sent to a URL that no route owns. HEAD is answered by the GET handler, so it adds nothing. */
export const UNROUTED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type UnroutedMethod = (typeof UNROUTED_METHODS)[number];

/** One request to a URL that no route owns, and so must get the answer of any URL that nothing owns. */
export interface UnroutedRequest {
  method: UnroutedMethod;
  /** The route it was made from, parameters and no ids, for a message. */
  template: string;
  /** For a message: the method and the route, and why no route owns it. No id. */
  name: string;
  path: string;
  body: ProbeBody;
}

/** The segment that no route has. */
const NOWHERE = "unrouted";

/** A matter's URL with one, two and three segments that no route has after it. */
const UNROUTED_TAILS: readonly string[] = [
  NOWHERE,
  `${NOWHERE}/${NOWHERE}`,
  `${NOWHERE}/${NOWHERE}/${NOWHERE}`,
];

/**
 * The requests that nothing should answer, with the real ids of the matter the probes go to:
 *  - a matter's pages and its API with segments after them that no route has, in every method;
 *  - each route of `MATTER_PROBES` under every method that the table does not probe on it, which
 *    is where an `ALL` route registered at a probed path would answer a method nobody sent;
 *  - the path of each wildcard route (`wildcards`, as registered, at any prefix and whether or not
 *    it names a matter), with the wildcard filled in with two segments that no route has, which is
 *    the URL that a wildcard under a longer prefix answers and the shapes above do not reach.
 * A route that hands on (middleware) leaves every one of them to the 404 of the application. One
 * that answers, whatever the route list says about it, does not.
 */
export function unroutedRequests(
  ids: ProbeIds,
  wildcards: readonly string[] = [],
): UnroutedRequest[] {
  const probed = new Set(MATTER_PROBES.map(probeKey));
  const wanted: { method: UnroutedMethod; template: string; why: string }[] = [];
  const fixed = [M, A].flatMap((prefix) => UNROUTED_TAILS.map((tail) => `${prefix}/${tail}`));
  // Two segments in place of the wildcard, so that the URL is not one that a route with a parameter there owns.
  const filled = wildcards.map((path) => path.replace(/\*/g, `${NOWHERE}/${NOWHERE}`));
  for (const template of [...fixed, ...filled])
    for (const method of UNROUTED_METHODS) wanted.push({ method, template, why: "no route" });
  for (const template of new Set(MATTER_PROBES.map((probe) => probe.template)))
    for (const method of UNROUTED_METHODS)
      if (!probed.has(`${method} ${template}`))
        wanted.push({ method, template, why: "unprobed method" });
  const seen = new Set<string>();
  const out: UnroutedRequest[] = [];
  for (const { method, template, why } of wanted) {
    const identity = `${method} ${template}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push({
      method,
      template,
      name: `${identity} (${why})`,
      path: pathFor(template, ids).replace(/:[A-Za-z_]\w*(?:\{[^}]*\})?\??/g, NOWHERE),
      body: method === "GET" ? NONE : isApi(template) ? json() : form(),
    });
  }
  return out;
}

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
