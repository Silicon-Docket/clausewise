import { afterAll, describe, expect, it } from "vitest";
import { createServices } from "../../src/services/index.js";
import type { Repository } from "../../src/store/index.js";
import { cleanup, makeWorld, newMatter, uploadCase } from "./support.js";

afterAll(cleanup);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A repository whose writes fail while `state.down` is set, with an error that is not the store's
 * own: what a disk that is full or a log that cannot be written throws is a plain error from the
 * database driver.
 */
function flakyRepository(repo: Repository, state: { down: boolean }): Repository {
  const writes = new Set(["transaction", "updateRunStatus"]);
  return new Proxy(repo, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof property !== "string" || !writes.has(property) || typeof value !== "function")
        return value;
      return (...args: unknown[]) => {
        if (state.down) throw new Error("disk I/O error");
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

describe("a run whose database could not be written", () => {
  it("is settled as failed once the database can be written again, and can then be resumed", async () => {
    const state = { down: false };
    let tripped = false;
    const w = makeWorld({
      model: {
        before: (call) => {
          // The database goes away while the first rule is being answered, and comes back a little later.
          if (call.kind === "analyze" && !tripped) {
            tripped = true;
            state.down = true;
            setTimeout(() => (state.down = false), 400);
          }
        },
      },
    });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const services = createServices({ ...w.deps, repo: flakyRepository(w.repo, state) });

    const run = services.runs.start(am, { workflowLabel: "v2" });
    await services.runs.idle();

    // Not left "analyzing" with nothing executing: the run ended, and the matter can be worked on.
    expect(services.runs.get(am, run.id)).toMatchObject({
      status: "failed",
      errorKind: "internal",
    });
    expect(w.repo.getMatter(matterId)?.status).toBe("ready");
    expect(
      w.logs.some((l) => l.includes("could not be settled") && l.includes("trying again")),
    ).toBe(true);
    // Nothing a person wrote or uploaded is in those lines.
    expect(w.logs.join("\n")).not.toContain("disk I/O error");

    // The way out the design promises for a failed run.
    const resumed = services.runs.resume(am, run.id);
    expect(resumed.status).toBe("queued");
    await services.runs.idle();
    expect(services.runs.get(am, run.id)).toMatchObject({ status: "succeeded", findingCount: 8 });
  });

  it("does not hold the process open for a run that a cancel has ended in the meantime", async () => {
    const state = { down: false };
    let tripped = false;
    const w = makeWorld({
      model: {
        before: (call) => {
          if (call.kind === "analyze" && !tripped) {
            tripped = true;
            state.down = true;
          }
        },
      },
    });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const services = createServices({ ...w.deps, repo: flakyRepository(w.repo, state) });

    const run = services.runs.start(am, { workflowLabel: "v2" });
    // Long enough for the run to meet the fault and start settling.
    await sleep(150);
    expect(w.repo.getRun(matterId, run.id)?.status).not.toBe("failed");
    // The database comes back and the person cancels before the next try.
    state.down = false;
    services.runs.cancel(am, run.id);
    await services.runs.idle();
    expect(w.repo.getRun(matterId, run.id)?.status).toBe("cancelled");
  });
});
