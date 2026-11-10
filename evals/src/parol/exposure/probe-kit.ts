/**
 * The kit the probe tables are written with: the types of a probe, the small builders of a request
 * body, the helpers of an effect body, and the function that composes the base tables and the
 * fragments of the packages into one table (`composeProbeTables`).
 *
 * It holds no probe. The base tables are in probes-base.ts, a package's own probes are in its
 * fragment (probes-<name>.ts), and probes.ts, which composes them, is the module that the exposure
 * suite and the application's tests import. A fragment imports this file and nothing else of the
 * probe modules, so that the composition has no cycle.
 *
 * Nothing here sends a request. It is data and small pure functions, and it must import nothing
 * that imports vitest.
 */
import type { GlobalAction, MatterAction } from "../../../../apps/parol/src/auth/actions.js";
import { EvalError } from "../../errors.js";

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

/** The builders of a request body: none, a form, an upload with no file, and JSON. */
export const NONE: ProbeBody = { kind: "none" };
export const form = (fields: Record<string, string> = {}): ProbeBody => ({ kind: "form", fields });
export const upload: ProbeBody = { kind: "multipart", fields: {} };
export const json = (value: unknown = {}): ProbeBody => ({ kind: "json", json: value });

/** The two prefixes of the routes that name a matter: the pages and the JSON API. */
export const M = "/matters/:matterId";
export const A = "/api/matters/:matterId";

/**
 * The routes that do not name a matter: a person is enough, or not even that. A route that only
 * some global roles may open names the global action it checks (`GLOBAL_ACTIONS`), and the suite
 * derives who is let in from the hand-written table of `DOCUMENTED_GLOBAL_ROLES`.
 */
export interface OtherProbe {
  method: "GET" | "POST";
  template: string;
  access: "public" | "principal";
  body: ProbeBody;
  /**
   * The global action the route checks, for a route that is not open to every signed-in person.
   * Only a route for a signed-in person can name one. The suite expects 403 for a signed-in caller
   * whose global role the documented table does not list for it, and the application's tests check
   * that the route names the same action.
   */
  globalAction?: GlobalAction;
}

/** The ids that fill a template's parameters. A test's `Prepared` fits. */
export interface ProbeIds {
  matterId: string;
  firstDocumentId: string;
  versionId: string;
  runId: string;
  findingId: string;
  memoId: string | null;
}

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

const AMENDMENT_TEXT =
  "AMENDMENT NO. 2 TO MUTUAL NONDISCLOSURE AGREEMENT\n\n" +
  "1. A paragraph of synthetic text that is long enough to be reviewed.\n";
export const TEXT_FILE = { name: "amendment-2.txt", text: AMENDMENT_TEXT } as const;

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
  /** The workflow version a review of this matter is asked for: the one the suite reviews under. */
  workflow: string;
  runId?: string;
  findingId?: string;
  /** The decision a reviewer would make on `findingId`, as the suite's own reviewer makes it. */
  decision?: { decision: string; findingContentSha256: string; reason: string | null };
}

/**
 * How far a scratch matter has been taken: documents only, `run` (reviewed), `decided` (every
 * finding decided, not exported) or `exported` (a memo exists). `makeScratch` of the authorization
 * suite builds the first three; a request that needs `exported` is refused by the suite with a
 * clear error until the package that probes a route which needs a memo adds the branch.
 */
export type ScratchLevel = "documents" | "run" | "decided" | "exported";

/** Where a request that must change something if it gets through is aimed. */
export interface Effect {
  /** `scratch`: a matter made for the probe. `fresh`: a new matter for each request. */
  target: "scratch" | "fresh";
  /** What the scratch matter must have been taken through first. */
  needs: ScratchLevel;
  ids: (scratch: Scratch, own: ProbeIds) => ProbeIds;
  body: ProbeBody;
}

export const sameIds = (_scratch: Scratch, own: ProbeIds): ProbeIds => own;
export const onScratch = (scratch: Scratch, own: ProbeIds): ProbeIds => ({
  ...own,
  matterId: scratch.matterId,
  firstDocumentId: scratch.documentId,
  versionId: scratch.versionId,
  runId: scratch.runId ?? own.runId,
  findingId: scratch.findingId ?? own.findingId,
});
export const NEW_DOCUMENT = {
  kind: "multipart",
  fields: { title: "A further amendment", kind: "amendment" },
  file: TEXT_FILE,
} as const satisfies ProbeBody;

export const decisionFields = (scratch: Scratch): Record<string, string> => ({
  decision: scratch.decision?.decision ?? "accept",
  findingContentSha256: scratch.decision?.findingContentSha256 ?? "0".repeat(64),
  ...(scratch.decision?.reason == null ? {} : { reason: scratch.decision.reason }),
});

/** The body a forged request carries to get past the checks on the body, for one route. */
export type ForgedBody = (own: ProbeIds, borrowed: BorrowedIds) => ProbeBody;

/** The body that changes the store, with where it is aimed, for one route. */
export type EffectOf = (scratch: Scratch) => Effect;

/** `GET /api/matters/:matterId`: how a route is named in a table, a message and a key. */
export const probeKey = (probe: Pick<Probe, "method" | "template">): string =>
  `${probe.method} ${probe.template}`;

// ---------------------------------------------------------------------------------------------
// Composing the tables
// ---------------------------------------------------------------------------------------------

/**
 * One owner's share of the tables: the base tables, or a package's fragment. `name` is for a
 * message only.
 */
export interface ProbeFragment {
  name: string;
  /** Routes that name a matter. */
  matter: readonly Probe[];
  /** Routes that name no matter. */
  other: readonly OtherProbe[];
  /** Bodies of forged requests, by route key. */
  forgedBodies: Readonly<Record<string, ForgedBody>>;
  /** Bodies that change the store, by route key. */
  effects: Readonly<Record<string, EffectOf>>;
}

/** The tables, with every fragment's share in the order the fragments were given. */
export interface ProbeTables {
  matter: Probe[];
  other: OtherProbe[];
  forgedBodies: Record<string, ForgedBody>;
  effects: Record<string, EffectOf>;
}

/**
 * Puts the fragments' shares into one set of tables, in the order given, and refuses what would
 * make a table mean less than it says: a route probed twice (in one fragment or across two), a
 * route that is both a route that names a matter and one that does not, a body or an effect given
 * twice for one route, and a global action on a route that is public (only a route for a signed-in
 * person can name one, as `defineRoute` refuses it too). The message names the route key and the
 * fragments, never data.
 */
export function composeProbeTables(fragments: readonly ProbeFragment[]): ProbeTables {
  const tables: ProbeTables = { matter: [], other: [], forgedBodies: {}, effects: {} };
  const owner = new Map<string, string>();
  const claim = (kind: string, key: string, fragment: string): void => {
    const id = `${kind} ${key}`;
    const earlier = owner.get(id);
    if (earlier !== undefined)
      throw new EvalError(
        `The probe tables list ${kind} ${key} twice (in ${earlier}${earlier === fragment ? "" : ` and in ${fragment}`}). One owner, one entry.`,
      );
    owner.set(id, fragment);
  };
  const routeOwner = new Map<string, string>();
  const claimRoute = (key: string, fragment: string): void => {
    const earlier = routeOwner.get(key);
    if (earlier !== undefined)
      throw new EvalError(
        `The probe tables list the route ${key} twice (in ${earlier}${earlier === fragment ? "" : ` and in ${fragment}`}), whether as a route that names a matter or as one that does not. One owner, one entry.`,
      );
    routeOwner.set(key, fragment);
  };
  for (const fragment of fragments) {
    for (const probe of fragment.matter) {
      claimRoute(probeKey(probe), fragment.name);
      tables.matter.push(probe);
    }
    for (const probe of fragment.other) {
      if (probe.globalAction !== undefined && probe.access !== "principal")
        throw new EvalError(
          `The probe for ${probeKey(probe)} (in ${fragment.name}) names a global action but is not for a signed-in person. Only a route for a signed-in person can name one.`,
        );
      claimRoute(probeKey(probe), fragment.name);
      tables.other.push(probe);
    }
    for (const [key, build] of Object.entries(fragment.forgedBodies)) {
      claim("the forged-id body for", key, fragment.name);
      tables.forgedBodies[key] = build;
    }
    for (const [key, build] of Object.entries(fragment.effects)) {
      claim("the effect body for", key, fragment.name);
      tables.effects[key] = build;
    }
  }
  return tables;
}
