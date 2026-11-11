import { afterAll, describe, expect, it } from "vitest";
import { ForbiddenError, SpendRefusedError } from "../../src/services/errors.js";
import { reviewBound, spendWorld, type SpendWorld } from "../usage/spend-support.js";
import { cleanup, gate, newMatter, reviewed, uploadCase } from "./support.js";

afterAll(cleanup);

/**
 * Starting and resuming a review under the spend guard. The guard decides inside the transaction
 * that makes the run, so a review it refuses leaves nothing behind. The model is the real adapter
 * over a scripted wire, the prices are invented, and the documents are synthetic.
 */

const BOUND = reviewBound("v2");

const count = (w: SpendWorld, table: string): number =>
  (w.repo.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** A world whose limit for one review is below what any review of the base case is planned to cost. */
const tight = () => spendWorld({ limits: { perReviewUsd: BOUND * 0.9, perDayUsd: BOUND * 10 } });

function refusal(fn: () => unknown): SpendRefusedError {
  try {
    fn();
  } catch (error) {
    if (error instanceof SpendRefusedError) return error;
    throw error;
  }
  throw new Error("expected the start to be refused");
}

describe("a start that is refused", () => {
  it("throws the refusal, with the figures, and creates nothing: no run, no change to the matter, no audit event", async () => {
    const w = tight();
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const before = {
      runs: count(w, "runs"),
      audit: count(w, "audit_events"),
      stages: count(w, "run_stages"),
      status: w.repo.getMatter(matterId)?.status,
    };
    const error = refusal(() => w.services.runs.start(am, { workflowLabel: "v2" }));
    expect(error.code).toBe("spend_over_review_limit");
    expect(error.figures.boundUsd).toBeCloseTo(BOUND, 10);
    expect(error.figures.limitUsd).toBeCloseTo(BOUND * 0.9, 10);
    expect(count(w, "runs")).toBe(before.runs);
    expect(count(w, "audit_events")).toBe(before.audit);
    expect(count(w, "run_stages")).toBe(before.stages);
    expect(w.repo.getMatter(matterId)?.status).toBe(before.status);
    // Nothing was sent, held or written to the day.
    expect(w.wire.sent).toBe(0);
    expect(w.repo.spendToday().costUsd).toBe(0);
    await w.services.runs.idle();
  });

  it("holds nothing for the day afterwards", async () => {
    const w = tight();
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    refusal(() => w.services.runs.start(am, { workflowLabel: "v2" }));
    // The same limit for a day that holds one review: nothing is set aside for the refused one.
    const again = w.restart({ perReviewUsd: BOUND * 2, perDayUsd: BOUND * 1.1 });
    const run = again.services.runs.start(am, { workflowLabel: "v2" });
    expect(run.status).toBe("queued");
    await again.services.runs.idle();
  });

  it("keeps the earlier findings current when it is a re-run that is refused", async () => {
    const w = spendWorld({ limits: { perReviewUsd: BOUND * 2, perDayUsd: BOUND * 10 } });
    const { matterId, am, runId } = await reviewed(w);
    const findings = w.repo.listFindings(matterId, runId);
    expect(findings).toHaveLength(8);
    expect(findings.every((f) => f.validity === "current")).toBe(true);
    const statusBefore = w.repo.getMatter(matterId)?.status;
    const runsBefore = count(w, "runs");
    const auditBefore = count(w, "audit_events");

    // The same matter, started again under a limit too low for it.
    const strict = w.restart({ perReviewUsd: BOUND * 0.9 });
    refusal(() => strict.services.runs.start(am, { workflowLabel: "v2" }));

    // The change of inputs a re-run makes was rolled back with the refusal.
    expect(w.repo.getMatter(matterId)?.status).toBe(statusBefore);
    expect(w.repo.listFindings(matterId, runId).every((f) => f.validity === "current")).toBe(true);
    expect(w.repo.getRun(matterId, runId)?.status).toBe("succeeded");
    expect(count(w, "runs")).toBe(runsBefore);
    expect(count(w, "audit_events")).toBe(auditBefore);
  });

  it("is a 403 for a person who may not start a review, whatever the guard would say", async () => {
    const w = tight();
    const { matterId } = newMatter(w);
    await uploadCase(w, matterId);
    const reviewerAm = w.grant(w.reviewer, matterId);
    expect(() => w.services.runs.start(reviewerAm, { workflowLabel: "v2" })).toThrow(
      ForbiddenError,
    );
  });

  it("is refused after the other checks: a run in flight is the conflict it always was", async () => {
    const hold = gate();
    const w = spendWorld({
      limits: { perReviewUsd: BOUND * 2, perDayUsd: BOUND * 10 },
      model: { before: () => hold.pass() },
    });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    w.services.runs.start(am, { workflowLabel: "v2" });
    await hold.reached();
    const tighter = w.restart({ perReviewUsd: BOUND * 0.9 });
    // The matter already has a run in flight; that is what is said, not the spend.
    expect(() => tighter.services.runs.start(am, { workflowLabel: "v2" })).toThrow(
      expect.objectContaining({ code: "active_run" }),
    );
    hold.open();
    await w.services.runs.idle();
  });
});

describe("two reviews that share a day", () => {
  it("see each other's hold: the second is refused although each alone would fit", async () => {
    const hold = gate();
    const w = spendWorld({
      limits: { perReviewUsd: BOUND * 2, perDayUsd: BOUND * 1.5 },
      model: { before: () => hold.pass() },
    });
    const first = newMatter(w, "first");
    await uploadCase(w, first.matterId);
    const second = newMatter(w, "second");
    await uploadCase(w, second.matterId);

    w.services.runs.start(first.am, { workflowLabel: "v2" });
    await hold.reached();
    const error = refusal(() => w.services.runs.start(second.am, { workflowLabel: "v2" }));
    expect(error.code).toBe("spend_over_daily_limit");
    // Nothing is in the ledger yet: what the day is short of is what the first review has set aside.
    expect(error.figures.usedUsd).toBe(0);
    expect(error.figures.heldUsd).toBeCloseTo(BOUND, 10);
    expect(error.userText()).toContain("is used or set aside for reviews in progress");

    // Alone, the second would be accepted: the first, once it ends, holds nothing.
    hold.open();
    await w.services.runs.idle();
    const accepted = w.services.runs.start(second.am, { workflowLabel: "v2" });
    expect(accepted.status).toBe("queued");
    await w.services.runs.idle();
    expect(w.services.runs.get(second.am, accepted.id).status).toBe("succeeded");
  });

  it("see the ledger: what a review that ended spent still counts against the day", async () => {
    const w = spendWorld({ limits: { perReviewUsd: BOUND * 2, perDayUsd: BOUND * 1.5 } });
    // The first review spends about $0.036 of the day, as its responses are worth.
    await reviewed(w);
    const spent = w.repo.spendToday().costUsd;
    expect(spent).toBeGreaterThan(0.01);
    // A day with room for one bound and not for a second on top of what was used.
    const narrow = w.restart({ perDayUsd: BOUND + spent * 0.5 });
    const second = newMatter(narrow, "second");
    await uploadCase(narrow, second.matterId);
    const error = refusal(() => narrow.services.runs.start(second.am, { workflowLabel: "v2" }));
    expect(error.code).toBe("spend_over_daily_limit");
    expect(error.figures.usedUsd).toBeCloseTo(spent, 12);
    expect(error.figures.heldUsd).toBe(0);
  });
});

describe("the day's total", () => {
  it("is not lowered by deleting the matter whose review spent it", async () => {
    const w = spendWorld({ limits: { perReviewUsd: BOUND * 2, perDayUsd: BOUND * 10 } });
    const { matterId, am, runId } = await reviewed(w);
    const spent = w.repo.spendToday();
    expect(spent.costUsd).toBeGreaterThan(0);
    expect(w.repo.summarizeRunUsage(matterId, runId).costUsd).toBeCloseTo(spent.costUsd, 10);

    await w.services.matters.delete(am);

    // The matter's calls went with it, and the day's total did not.
    expect(count(w, "model_calls")).toBe(0);
    expect(w.repo.spendToday()).toEqual(spent);
    // So a review started afterwards is judged against the same day.
    const narrow = w.restart({ perDayUsd: BOUND + spent.costUsd * 0.5 });
    const next = newMatter(narrow, "next");
    await uploadCase(narrow, next.matterId);
    expect(
      refusal(() => narrow.services.runs.start(next.am, { workflowLabel: "v2" })).figures.usedUsd,
    ).toBeCloseTo(spent.costUsd, 12);
  });
});
