import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Dataset } from "../src/parol/dataset.js";
import { FORGED_PROBES } from "../src/parol/exposure/probes.js";
import type { SiteHooks } from "../src/parol/exposure/site.js";
import { ownerOf, runWith } from "./parol-authz-support.js";
import { completeDataset } from "./parol-exposure-support.js";

/**
 * A route that names two ids that the application checks against each other (a version must be a
 * version of the document named with it) is forged in two forms. A mixed pair (a document of the
 * other matter with a version of the caller's own, or the other way round) is turned away by that
 * check whether or not the lookups are scoped to the matter, so it cannot find a lookup that
 * ignores the matter. Only a pair from one record of the other matter gets past the check.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let dataset: Dataset;
beforeAll(async () => {
  dataset = await completeDataset();
});
const run = runWith(() => dataset);

const CONSISTENT = FORGED_PROBES.filter((probe) => probe.consistent).map((probe) => probe.name);

describe("a version looked up by its own matter and not the caller's", () => {
  const hook: SiteHooks = {
    beforeRoutes: (_app, deps) => {
      const owner = ownerOf(deps);
      const repo = deps.repo as unknown as Record<string, (...a: unknown[]) => unknown>;
      // The version is found, and made operative, by its own id: the matter in the request is not what finds it.
      for (const method of ["getVersion", "setOperativeVersion"]) {
        const real = repo[method]!.bind(deps.repo);
        repo[method] = (matterId, versionId, ...rest) =>
          real(owner("document_versions", versionId as string) ?? matterId, versionId, ...rest);
      }
    },
  };

  it("is not found by a request that mixes the ids: the check of the pair turns each of them away", async () => {
    const result = await run(hook, ["forged"]);
    const mixed = FORGED_PROBES.filter((probe) => !probe.consistent && probe.pairedWith.length > 0);
    expect(mixed.length).toBeGreaterThanOrEqual(4);
    const names = new Set(result.exposed.map((cell) => cell.probe));
    for (const probe of mixed) expect(names.has(probe.name), probe.name).toBe(false);
  });

  it("is found by the request that takes both ids from one record of the other matter, in both modes, and by nothing else", async () => {
    const result = await run(hook, ["forged"]);
    // The page form and the PATCH body, each in two modes.
    expect(CONSISTENT).toHaveLength(2);
    expect(result.forgedCells).toBe(FORGED_PROBES.length * 2);
    expect(result.probesAnsweredWithData).toBe(CONSISTENT.length * 2);
    expect(result.exposed.map((cell) => cell.probe).sort()).toEqual(
      [...CONSISTENT, ...CONSISTENT].sort(),
    );
    expect(new Set(result.exposed.map((cell) => cell.relaxed))).toEqual(new Set([false, true]));
    for (const mode of [false, true])
      expect(
        result.exposed
          .filter((cell) => cell.relaxed === mode)
          .map((cell) => cell.probe)
          .sort(),
      ).toEqual([...CONSISTENT].sort());
    // The answer is not the answer for an id of no record, and the PATCH is a success.
    expect(result.byReason.refusal_differs).toBe(CONSISTENT.length * 2);
    expect(result.byReason.handler_answered).toBe(2);
    expect(result.mismatches).toBe(0);
  });

  it("is not a finding on the application as it is: the same request is answered as an id of no record", async () => {
    const result = await run({}, ["forged"]);
    expect(result.forgedCells).toBe(FORGED_PROBES.length * 2);
    expect(result.probesAnsweredWithData).toBe(0);
    expect(result.mismatches).toBe(0);
    expect(result.forgedRequests).toBe(FORGED_PROBES.length);
    expect(result.forgedPlaces).toBe(FORGED_PROBES.length - CONSISTENT.length);
  });
});
