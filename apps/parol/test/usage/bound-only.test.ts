import { afterAll, describe, expect, it, vi } from "vitest";
import { SpendRefusedError } from "../../src/services/errors.js";
import { createServices } from "../../src/services/index.js";
import { createSpendGuard, type SpendGuard } from "../../src/usage/guard.js";
import { createLiveGenerator } from "../../src/usage/live.js";
import { parsePriceTable } from "../../src/usage/prices.js";
import { cleanup, controlledModel, makeWorld, newMatter, uploadCase } from "../services/support.js";
import { PRICE, reviewBound } from "./spend-support.js";
import { anthropicConfig } from "./support.js";

afterAll(cleanup);

/**
 * A provider whose adapter reports no usage can be served only if the operator has said that only
 * the bound planned before each review is to be checked. The bound still refuses a review that
 * could pass a limit; nothing holds a request back while the review runs, nothing reaches the
 * ledger, and the review page says the cost is not known. The model is a scripted stand-in for the
 * `openai` provider by name only; nothing leaves the machine.
 */

const BOUND = reviewBound("v2");
const TABLE = parsePriceTable({ "model-b": PRICE });

function boundOnlyWorld(
  limits: { perReviewUsd: number; perDayUsd: number },
  before?: Parameters<typeof controlledModel>[0] extends infer O
    ? O extends { before?: infer B }
      ? B
      : never
    : never,
) {
  const model = controlledModel({
    info: { provider: "openai", model: "model-b" },
    ...(before === undefined ? {} : { before }),
  });
  const world = makeWorld({ model2: model });
  const guard = createSpendGuard({
    limits: { ...limits, assumedOutputTokens: 1500 },
    provider: "openai",
    model: "model-b",
    priceTable: TABLE,
    price: PRICE,
    repo: world.repo,
    log: () => undefined,
  });
  const services = createServices({ ...world.deps, spend: guard });
  return { ...world, services, guard };
}

describe("a guard over a provider that reports no usage", () => {
  it("says it does not count usage", () => {
    expect(boundOnlyWorld({ perReviewUsd: 1, perDayUsd: 1 }).guard.reportsUsage).toBe(false);
  });

  it("still refuses a review whose bound is over the limit, and creates nothing", async () => {
    const w = boundOnlyWorld({ perReviewUsd: BOUND * 0.9, perDayUsd: BOUND * 10 });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    expect(() => w.services.runs.start(am, { workflowLabel: "v2" })).toThrow(SpendRefusedError);
    expect(w.repo.listRunsForMatter(matterId)).toEqual([]);
    expect(w.model.calls).toEqual([]);
  });

  it("runs a review that is under the limit, with nothing written to the ledger", async () => {
    const w = boundOnlyWorld({ perReviewUsd: BOUND * 2, perDayUsd: BOUND * 10 });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, { workflowLabel: "v2" });
    await w.services.runs.idle();
    const ended = w.services.runs.get(am, run.id);
    expect(ended.status).toBe("succeeded");
    expect(w.repo.spendToday()).toEqual({ costUsd: 0, responses: 0, unpricedResponses: 0 });
    // The review page says the cost is not known, and prints no figure of money.
    expect(ended.usage?.state).toBe("not_reported");
    expect(ended.usage?.lines).toEqual([
      `The provider did not report usage for the ${ended.usage?.calls} model calls of this review.`,
      "Parol records usage only for the anthropic provider, so the cost of this review is not known.",
    ]);
    expect(ended.usage?.lines.join(" ")).not.toContain("$");
  });

  it("sets aside the bound of a review in progress, which is all it can count for the day", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const w = boundOnlyWorld({ perReviewUsd: BOUND * 2, perDayUsd: BOUND * 1.5 }, () => held);
    const first = newMatter(w);
    await uploadCase(w, first.matterId);
    const second = newMatter(w, "second");
    await uploadCase(w, second.matterId);
    w.services.runs.start(first.am, { workflowLabel: "v2" });
    expect(() => w.services.runs.start(second.am, { workflowLabel: "v2" })).toThrow(
      SpendRefusedError,
    );
    release();
    await w.services.runs.idle();
    // Once the first review has ended it holds nothing, and nothing was ever counted for it.
    expect(w.services.runs.start(second.am, { workflowLabel: "v2" }).status).toBe("queued");
    await w.services.runs.idle();
  });
});

describe("the generator of a provider that reports no usage", () => {
  const spy = (): { guard: SpendGuard; called: string[] } => {
    const called: string[] = [];
    const guard = boundOnlyWorld({ perReviewUsd: 1, perDayUsd: 1 }).guard;
    return {
      called,
      guard: {
        ...guard,
        guardFetch: (inner) => {
          called.push("guardFetch");
          return guard.guardFetch(inner);
        },
        onUsage: (usage) => {
          called.push("onUsage");
          guard.onUsage(usage);
        },
      },
    };
  };

  it("is built without the cap: the guard is not put into a network it cannot meter", () => {
    const { guard, called } = spy();
    const generator = createLiveGenerator(
      anthropicConfig({ provider: "openai", model: "model-b", apiKey: "test-key-not-real" }),
      { guard, fetch: vi.fn() as unknown as typeof globalThis.fetch },
    );
    expect(generator.provider).toBe("openai");
    expect(called).toEqual([]);
  });

  it("is built with the cap for the provider that reports usage", () => {
    const { guard, called } = spy();
    createLiveGenerator(anthropicConfig(), {
      guard,
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
    });
    expect(called).toEqual(["guardFetch"]);
  });
});
