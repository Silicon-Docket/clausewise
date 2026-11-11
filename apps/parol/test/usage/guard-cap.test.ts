import { afterAll, describe, expect, it } from "vitest";
import { SpendRefusedError } from "../../src/services/errors.js";
import { workflowFor } from "../../src/prompts/workflows.js";
import { planRun, unitKey, upperBoundUsd } from "../../src/usage/plan.js";
import { baseWorld, cleanup, newMatter, reviewed, uploadCase } from "../services/support.js";
import { PRICE, nearWorst, reviewBound, spendWorld, type SpendWorld } from "./spend-support.js";

afterAll(cleanup);

/**
 * The cap: with the real engine, the real guard and the real Anthropic adapter over a scripted
 * wire, a review that would pass a limit is stopped, and no request is sent that could take the
 * recorded spend past one. The usage the wire reports is chosen by the test and the prices are
 * invented; nothing here says what a provider charges.
 */

const BOUND = reviewBound("v2");
const EPS = 1e-12;
/** Responses worth nearly all that their requests were allowed to cost: the cap is what holds the line. */
const COSTLY = nearWorst(0.9);

/** The requests the wire saw, in a form a failed assertion can print. */
const sent = (w: SpendWorld): string[] =>
  w.wire.requests.map((r) => `${r.kind}:${r.ruleKey ?? "*"}`);

describe("a review that stays under its limits", () => {
  it("is not held back, and its responses are in the ledger and in its calls", async () => {
    const w = spendWorld({ limits: { perReviewUsd: BOUND, perDayUsd: BOUND * 2 } });
    const { matterId, am, runId } = await reviewed(w);
    expect(w.services.runs.get(am, runId).status).toBe("succeeded");
    expect(w.wire.sent).toBe(w.model.calls.length);
    expect(w.repo.listModelCalls(matterId, runId)).toHaveLength(w.wire.sent);
    // The ledger holds what the responses were worth, and the run what its calls were.
    const ledger = w.repo.spendToday();
    expect(ledger.responses).toBe(w.wire.sent);
    expect(ledger.costUsd).toBeCloseTo(w.wire.spent(), 10);
    expect(w.repo.summarizeRunUsage(matterId, runId).costUsd).toBeCloseTo(w.wire.spent(), 10);
    for (const request of w.wire.requests)
      expect(request.spentUsd + request.worstUsd).toBeLessThanOrEqual(BOUND);
  });
});

describe("a review whose limit is reached while it runs", () => {
  async function stopped() {
    const w = spendWorld({ limits: { perReviewUsd: BOUND, perDayUsd: BOUND * 10 }, usage: COSTLY });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, { workflowLabel: "v2" });
    await w.services.runs.idle();
    return { w, matterId, am, run };
  }

  it("ends failed with the kind of the limit it reached, and saves no finding", async () => {
    const { w, matterId, am, run } = await stopped();
    const ended = w.services.runs.get(am, run.id);
    expect(ended.status).toBe("failed");
    expect(ended.errorKind).toBe("spend_review_limit");
    expect(w.repo.listFindings(matterId, run.id)).toEqual([]);
    // The matter is ready for the review to be resumed.
    expect(w.repo.getMatter(matterId)?.status).toBe("ready");
    // It was stopped part-way: some requests were sent and not all that a review makes.
    expect(w.wire.sent).toBeGreaterThan(1);
    expect(w.wire.sent).toBeLessThan(9);
    expect(w.logs.at(-1)).toContain("failed (spend_review_limit)");
  });

  it("sends no request that could take the recorded spend past the limit, so the spend stays under it", async () => {
    const { w } = await stopped();
    for (const request of w.wire.requests)
      expect(
        request.spentUsd + request.worstUsd,
        `${request.kind} ${request.ruleKey}`,
      ).toBeLessThanOrEqual(BOUND + EPS);
    expect(w.wire.spent()).toBeLessThanOrEqual(BOUND + EPS);
    expect(w.repo.spendToday().costUsd).toBeLessThanOrEqual(BOUND + EPS);
  });

  it("keeps the units that finished, with their calls, and tells the audit log why the run ended", async () => {
    const { w, matterId, run } = await stopped();
    const done = w.repo.listStages(matterId, run.id).filter((s) => s.status === "succeeded");
    expect(done.some((s) => s.stage === "extract")).toBe(true);
    expect(done.some((s) => s.stage === "analyze")).toBe(true);
    const rows = w.repo.listModelCalls(matterId, run.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(w.wire.sent);
    const events = w.repo
      .listMatterAuditEvents(matterId, {})
      .events.filter((e) => e.action === "run.status");
    expect(events.at(-1)?.detail).toMatchObject({ to: "failed", errorKind: "spend_review_limit" });
  });

  it("counts every response in the day's total, the ones cut short included, and says so on the page", async () => {
    const { w, matterId, am, run } = await stopped();
    const ledger = w.repo.spendToday();
    expect(ledger.responses).toBe(w.wire.requests.length);
    expect(ledger.costUsd).toBeGreaterThanOrEqual(
      (w.repo.summarizeRunUsage(matterId, run.id).costUsd ?? 0) - EPS,
    );
    expect(w.services.runs.get(am, run.id).usage?.lines.at(-1)).toBe(
      "Calls that were cut short when the review stopped are counted in the day's total and are not listed here.",
    );
  });

  it("is resumed, once the limit is raised, without a request for a unit that was finished", async () => {
    const { w, matterId, am, run } = await stopped();
    const finished = new Set(
      w.repo
        .listStages(matterId, run.id)
        .filter((s) => s.status === "succeeded")
        .map((s) => `${s.stage}:${s.unit}`),
    );
    const before = w.wire.requests.length;

    // The server is started again with a higher limit, and the review is resumed.
    const again = w.restart({ perReviewUsd: BOUND * 100, perDayUsd: BOUND * 1000 });
    again.services.runs.resume(again.grant(w.associate, matterId), run.id);
    await again.services.runs.idle();

    expect(again.services.runs.get(am, run.id).status).toBe("succeeded");
    const resent = sent(w).slice(before);
    for (const unit of finished) expect(resent, unit).not.toContain(unit);
    expect(resent.length).toBeGreaterThan(0);
    expect(w.repo.listFindings(matterId, run.id)).toHaveLength(8);
    // What it cost is what its responses were worth, before the stop and after the restart.
    expect(w.repo.spendToday().costUsd).toBeCloseTo(w.wire.spent(), 10);
  });

  it("is resumed on a limit that fits the rest of the review and not the whole of it, because only the units not finished are planned", async () => {
    const { w, matterId, am, run } = await stopped();
    const finished = new Set(
      w.repo
        .listStages(matterId, run.id)
        .filter((s) => s.status === "succeeded")
        .map((s) => `${s.stage}:${s.unit}`),
    );
    const plan = planRun({
      ingest: baseWorld.ingest,
      manifest: baseWorld.manifest,
      rules: baseWorld.playbook.rules,
      workflow: workflowFor("v2").manifest,
      assumedOutputTokens: 1500,
    });
    const rest = upperBoundUsd(plan, PRICE, (unit) => !finished.has(unitKey(unit)));
    const spent = w.repo.summarizeRunUsage(matterId, run.id).costUsd ?? 0;
    expect(rest).toBeLessThan(BOUND);
    expect(spent).toBeGreaterThan(0);
    // The limit has room for what is left and for what was used, and not for the whole bound on top of it.
    const limit = spent + rest * 1.001;
    expect(spent + BOUND).toBeGreaterThan(limit);

    const again = w.restart({ perReviewUsd: limit, perDayUsd: BOUND * 1000 });
    const spentBefore = w.wire.spent();
    const resumed = again.services.runs.resume(again.grant(w.associate, matterId), run.id);
    expect(resumed.status).toBe("queued");
    await again.services.runs.idle();
    // The responses are worth far more than the plan assumed, so it stops again: on the limit for
    // the whole review, which counts what the review used before the resume (the calls on record).
    const ended = again.services.runs.get(am, run.id);
    expect(ended.status).toBe("failed");
    expect(ended.errorKind).toBe("spend_review_limit");
    const since = w.wire.spent() - spentBefore;
    expect(since).toBeGreaterThan(0);
    expect(spent + since).toBeLessThanOrEqual(limit + EPS);
  });

  it("is refused a resume that would pass the limit again, with the work done not paid for twice", async () => {
    const { w, matterId, run } = await stopped();
    const same = w.restart({});
    let refused: unknown;
    try {
      same.services.runs.resume(same.grant(w.associate, matterId), run.id);
    } catch (error) {
      refused = error;
    }
    // The rest of the review could cost up to its bound, and the review has used some of its limit.
    expect(refused).toBeInstanceOf(SpendRefusedError);
    const error = refused as SpendRefusedError;
    expect(error.kind).toBe("resume");
    expect(error.code).toBe("spend_over_review_limit");
    expect(error.figures.usedUsd).toBeGreaterThan(0);
    expect(error.userText()).toContain("the work already done is not paid for again");
    // Nothing changed: the run is still failed.
    expect(w.repo.getRun(matterId, run.id)?.status).toBe("failed");
  });
});

describe("a response worth more than its request could be", () => {
  it("stops the review once it is recorded, because the recorded spend passed the limit", async () => {
    // The provider's accounting is bigger than the plan, the price or the prompt allowed for. The
    // cap cannot see it coming; the recorded spend is what is compared with the limit afterwards.
    const w = spendWorld({
      limits: { perReviewUsd: BOUND, perDayUsd: BOUND * 10 },
      // $0.25 a response at the invented rates: more than the request's body could be worth.
      usage: () => ({ input: 100_000, output: 5_000 }),
    });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, { workflowLabel: "v2" });
    await w.services.runs.idle();
    expect(w.services.runs.get(am, run.id).errorKind).toBe("spend_review_limit");
    // The spend went past the limit by what the responses in flight were worth.
    expect(w.wire.spent()).toBeGreaterThan(BOUND);
    expect(w.repo.spendToday().costUsd).toBeCloseTo(w.wire.spent(), 10);
  });
});

describe("the limit for a day", () => {
  it("stops reviews that share it, and a review that has ended holds nothing of the day", async () => {
    // Room for two bounds, so that both reviews are accepted, and not for what both go on to cost.
    const w = spendWorld({
      limits: { perReviewUsd: BOUND * 100, perDayUsd: BOUND * 2.2 },
      usage: COSTLY,
    });
    const first = newMatter(w, "first");
    await uploadCase(w, first.matterId);
    const second = newMatter(w, "second");
    await uploadCase(w, second.matterId);
    const a = w.services.runs.start(first.am, { workflowLabel: "v2" });
    const b = w.services.runs.start(second.am, { workflowLabel: "v2" });
    await w.services.runs.idle();

    for (const [am, id] of [
      [first.am, a.id],
      [second.am, b.id],
    ] as const) {
      const ended = w.services.runs.get(am, id);
      expect(ended.status).toBe("failed");
      expect(ended.errorKind).toBe("spend_daily_limit");
    }
    // The day's recorded spend stayed under its limit, and no request that could pass it was sent.
    expect(w.repo.spendToday().costUsd).toBeLessThanOrEqual(BOUND * 2.2 + EPS);
    // Both are over, so nothing is held: a new review is refused for what the day has used and
    // for nothing set aside.
    const third = newMatter(w, "third");
    await uploadCase(w, third.matterId);
    let refused: unknown;
    try {
      w.services.runs.start(third.am, { workflowLabel: "v2" });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(SpendRefusedError);
    expect((refused as SpendRefusedError).code).toBe("spend_over_daily_limit");
    expect((refused as SpendRefusedError).figures.heldUsd).toBe(0);
    expect((refused as SpendRefusedError).figures.usedUsd).toBeCloseTo(
      w.repo.spendToday().costUsd,
      10,
    );
  });
});
