import { ModelRequestError } from "@clausewise/llm";
import { afterAll, describe, expect, it } from "vitest";
import { markInterruptedRuns } from "../../src/boot/register.js";
import { cleanup, decideAll, gate, makeWorld, newMatter, reviewed, uploadCase } from "./support.js";

afterAll(cleanup);

/**
 * A re-run discards the decisions made on the review it replaces. If the re-run then never
 * finishes, the matter has no current review and no current decision, and it must not read as if
 * it were untouched ("ready"): the earlier results are stale, and it says so.
 */

describe("a re-run that does not finish", () => {
  it("leaves the matter out of date, with the reason, when it is cancelled", async () => {
    const hold = gate();
    let hooked = false;
    const w = makeWorld({
      model: {
        before: async (call) => {
          if (hooked && call.kind === "analyze") await hold.pass();
        },
      },
    });
    const { am, reviewerAm, runId } = await reviewed(w);
    decideAll(w, reviewerAm, w.services.runs.issues(am, runId));
    expect(w.services.matters.view(am).matter.status).toBe("review_complete");

    hooked = true;
    const again = w.services.runs.start(am, { workflowLabel: "v1" });
    await hold.reached(1);
    w.services.runs.cancel(am, again.id);
    hold.open();
    await w.services.runs.idle();

    const view = w.services.matters.view(am);
    expect(view.matter.status).toBe("stale");
    expect(view.staleReason).toBe("A new review was requested.");
    // The earlier decisions are stale, as they were the moment the re-run began.
    expect(
      w.services.runs.issues(am, runId).every((i) => i.validity === "stale" && i.review !== null),
    ).toBe(true);
    // And a new review can be started from here.
    expect(view.start.ready).toBe(true);
  });

  it("leaves the matter out of date when it fails", async () => {
    let broken = false;
    const w = makeWorld({
      model: {
        before: (call) => {
          if (broken && call.kind === "extract") throw new ModelRequestError("no key", 401);
        },
      },
    });
    const { am, runId } = await reviewed(w);
    broken = true;
    const again = w.services.runs.start(am, { workflowLabel: "v2" });
    await w.services.runs.idle();
    expect(w.services.runs.get(am, again.id)).toMatchObject({
      status: "failed",
      errorKind: "provider_auth",
    });
    expect(w.services.matters.view(am).matter.status).toBe("stale");
    expect(w.services.runs.issues(am, runId).every((i) => i.validity === "stale")).toBe(true);

    // Resuming it, once the provider works, brings the matter back to review.
    broken = false;
    w.services.runs.resume(am, again.id);
    await w.services.runs.idle();
    expect(w.services.matters.view(am).matter.status).toBe("in_review");
  });

  it("leaves the matter out of date when a restart interrupts it", async () => {
    const hold = gate();
    let hooked = false;
    const w = makeWorld({
      model: {
        before: async (call) => {
          if (hooked && call.kind === "analyze") await hold.pass();
        },
      },
    });
    const { am } = await reviewed(w);
    hooked = true;
    w.services.runs.start(am, { workflowLabel: "v1" });
    await hold.reached(1);
    markInterruptedRuns(w.repo);
    expect(w.services.matters.view(am).matter.status).toBe("stale");
    hold.open();
    await w.services.runs.idle();
  });

  it("still returns a matter whose first review failed to ready: there was nothing to lose", async () => {
    const w = makeWorld({
      model: {
        before: (call) => {
          if (call.kind === "extract") throw new ModelRequestError("no key", 401);
        },
      },
    });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    w.services.runs.start(am, {});
    await w.services.runs.idle();
    expect(w.services.matters.view(am).matter.status).toBe("ready");
  });
});
