import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AppDeps } from "../../apps/parol/src/server/deps.js";
import type { Dataset } from "../src/parol/dataset.js";
import { SCRATCH_LEVELS_BUILT } from "../src/parol/exposure/authorization.js";
import { probeKey, type Scratch } from "../src/parol/exposure/probe-kit.js";
import { EFFECT_KEYS, MATTER_PROBES, effectOf } from "../src/parol/exposure/probes.js";
import type { SiteHooks } from "../src/parol/exposure/site.js";
import { runWith } from "./parol-authz-support.js";
import { completeDataset } from "./parol-exposure-support.js";

/**
 * A probe whose body needs a scratch matter with a memo asks for the scratch level `exported`
 * (package W2.6a, slice C: the rating of a matter is given once the matter has been exported). The
 * suite builds that level now, by exporting a memo as the reviewer after every finding is decided,
 * and these tests show what it has to be true of the matter the body is sent to: it has a memo when
 * the body arrives, and the body, sent by a caller who is let in, changes the store.
 *
 * A body sent to a matter that is one level short would be refused for another reason than the one
 * it was written to test (`not_exported`, a conflict), and a clean count of that route would mean
 * nothing. When the level cannot be built the suite stops before anything is sent
 * (`requireScratchLevelBuilt`, tested in parol-authz-global.test.ts), and when the matter is built
 * but is short of its memo the body does not change the store for the caller who is let in, which
 * the suite stops for as well. This file pins the first of the two from the application's side: the
 * rating service is called, in the real application, only on matters that have a memo.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let dataset: Dataset;
beforeAll(async () => {
  dataset = await completeDataset();
});
const run = runWith(() => dataset);

const RATING_ROUTES = ["POST /matters/:matterId/rating", "POST /api/matters/:matterId/rating"];

describe("the probe tables, for the bodies that need a scratch matter with a memo", () => {
  const scratch: Scratch = {
    matterId: "mat_1",
    documentId: "doc_1",
    versionId: "ver_1",
    earlierVersionId: "ver_0",
    amendmentId: "doc_2",
    invitee: "usr_1",
    workflow: "v2",
    runId: "run_1",
    findingId: "fnd_1",
  };

  it("hold the rating as a form and as JSON, each with an effect body that needs the level exported", () => {
    for (const key of RATING_ROUTES) {
      const probe = MATTER_PROBES.find((p) => probeKey(p) === key);
      expect(probe, key).toBeDefined();
      expect(EFFECT_KEYS, key).toContain(key);
      const effect = effectOf(probe!, scratch)!;
      expect(effect.target, key).toBe("scratch");
      expect(effect.needs, key).toBe("exported");
      // The level is one the suite builds, so the body is not refused before it is sent.
      expect(SCRATCH_LEVELS_BUILT, key).toContain(effect.needs);
    }
  });

  it("name no level that the suite does not build, whichever package wrote the body", () => {
    for (const probe of MATTER_PROBES) {
      const effect = effectOf(probe, scratch);
      if (effect?.target === "scratch")
        expect(SCRATCH_LEVELS_BUILT, probeKey(probe)).toContain(effect.needs);
    }
  });
});

describe("a scratch matter taken to the level exported, on the real application", () => {
  /** Records, for each rating the service is asked for, how many memos the matter had and who asked. */
  const watchRatings = (seen: { memos: number; userId: string; threw: boolean }[]): SiteHooks => ({
    beforeRoutes: (_app, deps: AppDeps) => {
      const feedback = deps.services.feedback as { rate: (...a: unknown[]) => unknown };
      const real = feedback.rate.bind(feedback);
      feedback.rate = (...args: unknown[]) => {
        const am = args[0] as { matterId: string; principal: { userId: string } };
        const entry = {
          memos: deps.repo.listMemos(am.matterId).length,
          userId: am.principal.userId,
          threw: false,
        };
        seen.push(entry);
        try {
          return real(...args);
        } catch (error) {
          entry.threw = true;
          throw error;
        }
      };
    },
  });

  it("has a memo when the rating arrives, and the rating, sent by the caller who is let in, is stored", async () => {
    const seen: { memos: number; userId: string; threw: boolean }[] = [];
    const result = await run(watchRatings(seen), ["matrix", "effects"]);
    // One proof for each of the two routes in each of the two modes, and nothing else reached the
    // service: a refused caller never gets that far, and the let-in callers' own bodies are empty.
    expect(seen).toHaveLength(RATING_ROUTES.length * 2);
    for (const entry of seen) {
      expect(entry.memos).toBeGreaterThanOrEqual(1);
      expect(entry.threw).toBe(false);
    }
    // The body changed the store when the let-in caller sent it, so the suite counts no write as
    // unproven and stops for none, and no refused caller changed anything.
    expect(result.writesUnproven).toBe(0);
    expect(result.letInNotReached).toBe(0);
    expect(result.byReason.changed_state).toBe(0);
    expect(result.mismatches).toBe(0);
  });
});
