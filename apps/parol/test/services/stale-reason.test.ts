import { afterAll, describe, expect, it } from "vitest";
import { cleanup, gate, makeWorld, newMatter, uploadCase } from "./support.js";

afterAll(cleanup);

/**
 * A matter whose first review was stopped by a change of its inputs has no findings to read the
 * reason from, and still says which input changed.
 */

describe("the reason a matter is out of date when its first review never produced a finding", () => {
  it("names the stated date that changed, and says the review was still running", async () => {
    const hold = gate();
    const w = makeWorld({
      model: {
        before: async (call) => {
          if (call.kind === "analyze") await hold.pass();
        },
      },
    });
    const { matterId, am } = newMatter(w);
    const uploaded = await uploadCase(w, matterId);
    const run = w.services.runs.start(am, { workflowLabel: "v2" });
    await hold.reached(1);

    w.services.matters.setStatedDate(am, uploaded.versionIds[1]!, "2026-09-30");
    hold.open();
    await w.services.runs.idle();

    expect(w.services.runs.get(am, run.id)).toMatchObject({
      status: "superseded",
      findingCount: 0,
    });
    const view = w.services.matters.view(am);
    expect(view.matter.status).toBe("stale");
    expect(view.staleReason).toBe(
      "The stated date of a document changed while the review was running.",
    );
  });
});
