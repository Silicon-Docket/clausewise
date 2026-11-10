/**
 * Support for the fault tests of the authorization half of the exposure suite
 * (parol-authz-*.test.ts). Not a test file. Every request is made to the application in process
 * and every matter, document and person is synthetic; nothing calls a model.
 */
import {
  runAuthorizationProbes,
  type AuthorizationGroup,
  type AuthorizationResult,
} from "../src/parol/exposure/authorization.js";
import {
  FORGED_PROBES,
  LIST_PROBES,
  MATTER_PROBES,
  noRecordIds,
  unroutedRequests,
} from "../src/parol/exposure/probes.js";
import type { SiteHooks } from "../src/parol/exposure/site.js";
import type { Dataset } from "../src/parol/dataset.js";
import { never, playbook, ROOT } from "./parol-exposure-support.js";

export const STRANGER = "usr_exposure_stranger";
export const OUTSIDER = "usr_exposure_outsider";

/** Runs the authorization probes on a dataset, with the faults a test plants and the groups it needs. */
export const runWith =
  (dataset: () => Dataset) =>
  (hooks: SiteHooks, groups?: readonly AuthorizationGroup[]): Promise<AuthorizationResult> =>
    runAuthorizationProbes({
      dataset: dataset(),
      root: ROOT,
      playbook,
      signal: never(),
      hooks,
      ...(groups === undefined ? {} : { groups }),
    });

/** The error a promise rejects with. */
export async function failure(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof Error)) throw new Error("expected the promise to reject with an error");
  return error;
}

/** The matter that a row of `table` belongs to, whichever matter that is. */
export const ownerOf =
  (deps: { repo: { db: { prepare(sql: string): { get(...a: string[]): unknown } } } }) =>
  (table: string, id: string): string | undefined =>
    (
      deps.repo.db.prepare(`SELECT matter_id AS owner FROM ${table} WHERE id = ?`).get(id) as
        { owner: string } | undefined
    )?.owner;

/** The longest names a cell can have, from the tables, as findings (what the sentence names). */
export function longestExposed(count: number): AuthorizationResult["exposed"] {
  const names = [
    ...MATTER_PROBES.map((probe) => `${probe.method} ${probe.template}`),
    ...FORGED_PROBES.map((probe) => probe.name),
    ...LIST_PROBES.map((probe) => `${probe.method} ${probe.template}`),
    ...unroutedRequests(noRecordIds()).map((request) => request.name),
  ].sort((a, b) => b.length - a.length);
  return names
    .slice(0, count)
    .map((probe) => ({ probe, actor: "anonymous", relaxed: true, reasons: ["handler_answered"] }));
}

/**
 * Every field of a result at its worst for the length of the sentence: the longest names the
 * tables have, counts of as many digits as a run could reach, drift, and cells that did not reach.
 */
export function worstResult(): Omit<AuthorizationResult, "sentence"> {
  return {
    probesRun: 9999,
    probesAnsweredWithData: 9999,
    byReason: {
      handler_answered: 9999,
      carried_data: 9999,
      refusal_differs: 9999,
      changed_state: 9999,
    },
    mismatches: 9999,
    letInNotReached: 999,
    shouldBeLetIn: 9999,
    mustBeRefused: 9999,
    comparedWithMissing: 9999,
    matrixCells: 9999,
    forgedCells: 9999,
    listCells: 9999,
    unroutedCells: 9999,
    routes: 99,
    forgedRequests: 99,
    forgedPlaces: 98,
    listRoutes: 99,
    unroutedRequests: 999,
    callers: 7,
    modes: 2,
    writeRoutes: 99,
    writesWithEffect: 98,
    writesWithoutBody: MATTER_PROBES.filter((probe) => probe.method !== "GET").map(
      (probe) => `${probe.method} ${probe.template}`,
    ),
    writesUnproven: 99,
    tableDrift: 99,
    exposed: longestExposed(8),
    mismatched: [],
  };
}
