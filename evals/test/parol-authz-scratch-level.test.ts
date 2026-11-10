import { beforeAll, describe, expect, it, vi } from "vitest";
import { defineMatterRoute } from "../../apps/parol/src/server/matter-route.js";
import type { Dataset } from "../src/parol/dataset.js";
import { ACTORS } from "../src/parol/exposure/authorization.js";
import { MATTER_PROBES } from "../src/parol/exposure/probes.js";
import type { SiteHooks } from "../src/parol/exposure/site.js";
import { failure, runWith } from "./parol-authz-support.js";
import { completeDataset } from "./parol-exposure-support.js";

/**
 * A probe whose body needs a scratch matter with a memo asks for the scratch level `exported`,
 * which is part of the type for the package that probes such a route and which `makeScratch` of the
 * suite cannot build yet. The suite has to stop with a clear error and send nothing for it, and not
 * serve the request a matter that is one level short: a body sent to a matter that lacks what it
 * needs would be refused for another reason than the one it was written to test, and the clean
 * count of that route would mean nothing.
 *
 * The fragment of the feedback package is replaced here by one probe, written as that package will
 * write it, and its route is planted through the suite's hooks.
 */

vi.mock("../src/parol/exposure/probes-feedback.js", () => ({
  MATTER_PROBES_FEEDBACK: [
    {
      method: "POST",
      template: "/matters/:matterId/rating",
      action: "feedback.add",
      body: { kind: "form", fields: {} },
      reaches: 400,
    },
  ],
  OTHER_PROBES_FEEDBACK: [],
  FORGED_BODIES_FEEDBACK: {},
  EFFECTS_FEEDBACK: {
    "POST /matters/:matterId/rating": () => ({
      target: "scratch",
      needs: "exported",
      ids: (scratch: { matterId: string }, own: object) => ({ ...own, matterId: scratch.matterId }),
      body: { kind: "form", fields: { rating: "4", comment: "" } },
    }),
  },
}));

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let dataset: Dataset;
beforeAll(async () => {
  dataset = await completeDataset();
});
const run = runWith(() => dataset);

const plantsTheRoute: SiteHooks = {
  beforeRoutes: (app) =>
    defineMatterRoute(app, {
      method: "POST",
      path: "/matters/:matterId/rating",
      action: "feedback.add",
      handler: (c) => c.text("The rating, saved", 400),
    }),
};

describe("a body that needs a scratch matter with a memo", () => {
  it("is in the probe tables, as the package that adds it will write it", () => {
    expect(MATTER_PROBES.map((probe) => `${probe.method} ${probe.template}`)).toContain(
      "POST /matters/:matterId/rating",
    );
  });

  it("stops the suite, before anything is sent for it, because the level `exported` cannot be built yet", async () => {
    const error = await failure(run(plantsTheRoute, ["matrix", "effects"]));
    expect(error.name).toBe("ExposureSuiteUnavailable");
    expect(error.message).toContain('taken to the level "exported"');
    expect(error.message).toContain("Nothing was sent for it");
  });

  it("is not asked of the group that does not send the bodies that change the store", async () => {
    // Without the group `effects` no refused caller is sent a body of that kind, so no scratch
    // matter is made, and the matrix runs with the probe's own body (a 400 for a form with nothing in it).
    const result = await run(plantsTheRoute, ["matrix"]);
    expect(result.matrixCells).toBe(MATTER_PROBES.length * ACTORS.length * 2);
    expect(result.probesAnsweredWithData).toBe(0);
    expect(result.mismatches).toBe(0);
  });
});
