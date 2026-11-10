/**
 * One request for every route of the application that names a matter, shaped so that a member who
 * is let in reaches the handler and gets a known answer without changing anything: a form with
 * nothing in it (400), a run that has finished (409), a read (200). That is what lets a test send
 * the same request as every kind of caller and know from the answer whether the guard let it in.
 *
 * The authorization matrix, the CSRF test and the forged-id tests all read this table, and a test
 * fails when the application holds a route that is not in it.
 *
 * The table and the request builder live in `evals/src/parol/exposure/probes.ts`, which imports
 * nothing from vitest, because the evaluation's exposure suite (gate G1) sends the same probes as
 * the same callers. They are re-exported here so that there is one table and the tests keep their
 * imports. Add a probe there.
 */
export {
  MATTER_PROBES,
  OTHER_PROBES,
  initFor,
  isApi,
  isUnsafe,
  multipart,
  pathFor,
  probeName,
} from "../../../../evals/src/parol/exposure/probes.js";
export type {
  Init,
  OtherProbe,
  Probe,
  ProbeBody,
  ProbeIds,
  UploadFile,
} from "../../../../evals/src/parol/exposure/probes.js";
