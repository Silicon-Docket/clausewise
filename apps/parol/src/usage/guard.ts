import { AsyncLocalStorage } from "node:async_hooks";
import type { AnthropicUsage } from "@clausewise/llm";
import type { SpendUsage } from "../store/repo-spend.js";
import type { Repository } from "../store/index.js";
import { SpendRefusedError, SpendStop, type SpendFigures, type SpendStopKind } from "./errors.js";
import { upperBoundUsd, unitKey, type RunPlan } from "./plan.js";
import {
  costOf,
  createCallPricer,
  type CallPricer,
  type Price,
  type PriceTable,
} from "./prices.js";
import { currentRun } from "./scope.js";
import { USAGE_PROVIDER } from "./summary.js";

/**
 * The application's spend guard: a bound planned before a live review starts, a limit for one
 * review and a limit for one UTC day from configuration, a cap that holds each request back when it
 * could take the recorded spend past either limit, and a ledger of the day's spend.
 *
 * It follows the evaluation's guard and budget (evals/src/guard.ts, evals/src/budget.ts) and a
 * parity test pins the arithmetic to them. What it adds is what a server has and a command does
 * not: several runs at once, so reservations are kept per run and the day's total is shared, and a
 * ledger that a deleted matter cannot lower.
 *
 * Nothing here holds or logs text. Log lines carry the class name of a failure and nothing else.
 */

export interface SpendLimits {
  perReviewUsd: number;
  perDayUsd: number;
  /** Output tokens assumed for each call in the planned bound. */
  assumedOutputTokens: number;
}

/** A hold the guard keeps for a run in progress, so that a start at the same moment sees it. */
export interface RunHold {
  /** The most the run's remaining units could cost, as planned. */
  boundUsd: number;
  /** What the run had already used before this execution: the priced calls of a resumed run. */
  spentUsd: number;
}

export interface SpendGuard extends CallPricer {
  readonly limits: SpendLimits;
  readonly provider: string;
  readonly model: string;
  readonly priceTable: PriceTable;
  /** The configured model's price, checked when the server starts. */
  readonly price: Price;
  /** The provider's adapter reports usage, so the cap and the ledger work while a review runs. */
  readonly reportsUsage: boolean;

  /**
   * Synchronous and writes nothing. Throws `SpendRefusedError` when the bound would pass the limit
   * for one review (counting what a resumed run has already used) or the day's limit (counting the
   * ledger, usage not yet written, and what reviews in progress may still spend). A bound equal to
   * a limit is accepted.
   */
  preflight(args: {
    kind: "start" | "resume";
    plan: RunPlan;
    /** `extract:*`, `analyze:dur-1`, `verify:dur-1` of a resumed run's succeeded units. */
    finishedUnits: ReadonlySet<string>;
    /** The priced calls of the run so far; 0 for a start. */
    spentOnRunUsd: number;
  }): { boundUsd: number };

  /** Holds the bound for a run, so that a concurrent start sees it. Synchronous. */
  reserve(runId: string, hold: RunHold): void;
  /** Drops the hold and anything still reserved for the run, and writes any usage the ledger missed. */
  release(runId: string): void;
  /** The engine, once per job: where to send a stop. It must be idempotent. */
  begin(runId: string, onStop: (stop: SpendStop) => void): void;

  /**
   * Runs one model call (one `generate`). What its requests reserved is given back when it ends,
   * whichever way it ends, and a request of the call does not wait for the room that an earlier
   * request of the same call still holds: the requests of one call run one after another.
   */
  scope<T>(work: () => Promise<T>): Promise<T>;
  /** Wraps the real `fetch` with the per-request cap. */
  guardFetch(inner: typeof globalThis.fetch): typeof globalThis.fetch;
  /**
   * For the adapter's `onUsage`: counts the response in the ledger and the run, and trips a limit.
   * Usage that is not made of whole numbers of 0 or more is not the provider's accounting, and a
   * response is never free for that: the worst case of its request is charged instead.
   */
  onUsage(usage: AnthropicUsage): void;
}

/** The guard of a server whose reader is a stand-in, or of a test that builds none: it does nothing. */
export const NO_SPEND: Pick<SpendGuard, "reserve" | "release" | "begin" | "priceCalls"> = {
  reserve: () => undefined,
  release: () => undefined,
  begin: () => undefined,
  priceCalls: (calls) =>
    calls.map((call) => ({ ...call, costUsdEstimate: null, priceTableSha256: null })),
};

/**
 * What one request can cost at most: its whole body priced as a prompt at the dearer of the plain
 * and the cache-write rate, and every output token it is allowed. UTF-8 bytes stand in for
 * characters because a script that needs several bytes per character also needs several tokens. A
 * body that cannot be sized is infinite (and so is refused). The same function as the evaluation's
 * `worstCaseUsd` (a parity test pins them).
 */
export function worstCaseUsd(body: unknown, price: Price): number {
  if (typeof body !== "string") return Number.POSITIVE_INFINITY;
  let maxTokens: unknown;
  try {
    maxTokens = (JSON.parse(body) as { max_tokens?: unknown }).max_tokens;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  if (typeof maxTokens !== "number" || !Number.isFinite(maxTokens)) return Number.POSITIVE_INFINITY;
  return costOf(
    {
      inputTokens: Math.ceil(Buffer.byteLength(body) / 3),
      outputTokens: maxTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    { ...price, input: Math.max(price.input, price.cacheWrite) },
  );
}

interface RunState {
  /** The bound held for the run. */
  boundUsd: number;
  /** Used before this execution (a resumed run's earlier calls). */
  priorUsd: number;
  /** Used by the responses of this execution. */
  spentUsd: number;
  onStop: ((stop: SpendStop) => void) | null;
  /** The worst case of each request in flight, oldest first. */
  pending: Reservation[];
}

/** One model call (`scope`): the identity that the reservations of its requests carry. */
type CallOwner = Record<string, never>;

interface Reservation {
  /** The most the request can cost. */
  worst: number;
  /** The call it belongs to; null for a request made outside `scope`. */
  owner: CallOwner | null;
}

/** Which call is running, for the guarded `fetch` and `onUsage` that carry no identity of their own. */
const ownerStore = new AsyncLocalStorage<CallOwner>();

const ZERO: SpendUsage = {
  responses: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  unpricedResponses: 0,
};

const add = (a: SpendUsage, b: SpendUsage): SpendUsage => ({
  responses: a.responses + b.responses,
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  costUsd: a.costUsd + b.costUsd,
  unpricedResponses: a.unpricedResponses + b.unpricedResponses,
});

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const nameOf = (error: unknown): string => (error instanceof Error ? error.name : "unknown error");

export function createSpendGuard(args: {
  limits: SpendLimits;
  provider: string;
  model: string;
  priceTable: PriceTable;
  price: Price;
  repo: Pick<Repository, "addSpend" | "spendToday">;
  log: (line: string) => void;
}): SpendGuard {
  const { limits, repo, price, log } = args;
  const pricer = createCallPricer(args.priceTable);
  const runs = new Map<string, RunState>();
  const waiting = new Set<() => void>();
  /** Usage that could not be written to the ledger yet; counted in every check until it is. */
  let unflushed: SpendUsage = ZERO;

  const wake = (): void => {
    for (const resume of [...waiting]) resume();
  };

  /** Writes what the ledger is missing. A failure is logged by class name and kept for the next try. */
  const write = (extra: SpendUsage): void => {
    const total = add(unflushed, extra);
    if (total.responses === 0) return;
    try {
      repo.addSpend(total);
      unflushed = ZERO;
    } catch (error) {
      unflushed = total;
      log(`spend ledger: could not write the day's usage (${nameOf(error)}), will try again`);
    }
  };

  /** The day's recorded spend, counting usage the ledger has not taken yet. */
  const dayUsd = (): number => repo.spendToday().costUsd + unflushed.costUsd;
  const heldUsd = (): number => {
    let held = 0;
    for (const state of runs.values()) held += Math.max(0, state.boundUsd - state.spentUsd);
    return held;
  };
  const reservedUsd = (state: RunState): number =>
    state.pending.reduce((total, reservation) => total + reservation.worst, 0);
  const reservedAllUsd = (): number => {
    let total = 0;
    for (const state of runs.values()) total += reservedUsd(state);
    return total;
  };

  const stopRun = (state: RunState, kind: SpendStopKind): SpendStop => {
    const stop = new SpendStop(kind);
    state.onStop?.(stop);
    return stop;
  };

  /** Waits until a request in flight settles, or the request's own signal aborts. */
  const waitForRoom = (signal: AbortSignal | null | undefined): Promise<void> =>
    new Promise((resolve, reject) => {
      const resume = (): void => {
        waiting.delete(resume);
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = (): void => {
        waiting.delete(resume);
        reject(signal?.reason);
      };
      if (signal?.aborted === true) {
        reject(signal.reason);
        return;
      }
      waiting.add(resume);
      signal?.addEventListener("abort", onAbort, { once: true });
    });

  const stateOfCurrentRun = (): RunState | undefined => {
    const scope = currentRun();
    return scope === undefined ? undefined : runs.get(scope.runId);
  };

  /** Gives back what the requests of a call hold, and tells the requests that wait. */
  const giveBack = (state: RunState, owner: CallOwner): void => {
    const kept = state.pending.filter((reservation) => reservation.owner !== owner);
    if (kept.length === state.pending.length) return;
    state.pending = kept;
    wake();
  };

  return {
    limits,
    provider: args.provider,
    model: args.model,
    priceTable: args.priceTable,
    price,
    reportsUsage: args.provider === USAGE_PROVIDER,

    priceCalls: pricer.priceCalls,

    preflight({ kind, plan, finishedUnits, spentOnRunUsd }) {
      const boundUsd = upperBoundUsd(plan, price, (unit) => !finishedUnits.has(unitKey(unit)));
      if (spentOnRunUsd + boundUsd > limits.perReviewUsd)
        throw new SpendRefusedError(
          "spend_over_review_limit",
          { boundUsd, limitUsd: limits.perReviewUsd, usedUsd: spentOnRunUsd, heldUsd: 0 },
          kind,
        );
      const used = dayUsd();
      const held = heldUsd();
      if (used + held + boundUsd > limits.perDayUsd) {
        const figures: SpendFigures = {
          boundUsd,
          limitUsd: limits.perDayUsd,
          usedUsd: used,
          heldUsd: held,
        };
        throw new SpendRefusedError("spend_over_daily_limit", figures, kind);
      }
      return { boundUsd };
    },

    reserve(runId, hold) {
      runs.set(runId, {
        boundUsd: hold.boundUsd,
        priorUsd: hold.spentUsd,
        spentUsd: 0,
        onStop: null,
        pending: [],
      });
    },

    release(runId) {
      if (runs.delete(runId)) wake();
      // The end of a run is the other moment, besides the next response, that the ledger is tried.
      write(ZERO);
    },

    begin(runId, onStop) {
      // A run that was not reserved (it did not come through the run service) is held to the
      // limits by the cap alone, counting this execution only.
      let state = runs.get(runId);
      if (state === undefined) {
        state = { boundUsd: 0, priorUsd: 0, spentUsd: 0, onStop: null, pending: [] };
        runs.set(runId, state);
      }
      state.onStop = onStop;
    },

    async scope(work) {
      const state = stateOfCurrentRun();
      // A call outside a run has nothing to give back: its requests are refused.
      if (state === undefined) return work();
      const owner: CallOwner = {};
      try {
        return await ownerStore.run(owner, work);
      } finally {
        // A response that reported no usable usage (a gateway's reply that is not a Messages reply,
        // a stream that broke) never reaches `onUsage`, so this is the one place its share is
        // certain to come back.
        giveBack(state, owner);
      }
    },

    guardFetch(inner) {
      return async (...request: Parameters<typeof globalThis.fetch>): Promise<Response> => {
        const state = stateOfCurrentRun();
        // A request that does not belong to a run cannot be counted against one: refuse it.
        if (state === undefined) throw new SpendStop("no_run_scope");
        const worst = worstCaseUsd(request[1]?.body, price);
        if (!Number.isFinite(worst)) throw stopRun(state, "unsizable_request");
        // The requests of one call run one after another (a retry, or the next attempt, starts
        // after the last one was answered), so whatever an earlier request of this call still holds
        // is settled. Waiting for it would wait for a wake that nothing is left to send.
        const owner = ownerStore.getStore() ?? null;
        if (owner !== null) giveBack(state, owner);
        for (;;) {
          let day: number;
          try {
            day = dayUsd();
          } catch {
            throw stopRun(state, "ledger_unreadable");
          }
          const runSpent = state.priorUsd + state.spentUsd;
          if (runSpent + worst > limits.perReviewUsd) throw stopRun(state, "review_limit");
          if (day + worst > limits.perDayUsd) throw stopRun(state, "daily_limit");
          // It fits once the requests under way have settled, because they usually cost far less
          // than the most they were allowed to: wait for one. Otherwise send it.
          if (
            runSpent + reservedUsd(state) + worst <= limits.perReviewUsd &&
            day + reservedAllUsd() + worst <= limits.perDayUsd
          )
            break;
          await waitForRoom(request[1]?.signal);
        }
        const reservation: Reservation = { worst, owner };
        state.pending.push(reservation);
        const drop = (): void => {
          const at = state.pending.indexOf(reservation);
          if (at !== -1) state.pending.splice(at, 1);
          wake();
        };
        try {
          const response = await inner(...request);
          // A response that reports usage gives its share back in `onUsage`; one that did not is
          // given back here.
          if (!response.ok) drop();
          return response;
        } catch (error) {
          drop();
          throw error;
        }
      };
    },

    onUsage(usage) {
      const state = stateOfCurrentRun();
      // The response answers the oldest request of its call, or of its run when it was made outside
      // a call: the reservations of a call differ only by prompt size, and the total returns to
      // zero once every response settled.
      let held: number | undefined;
      if (state !== undefined) {
        const owner = ownerStore.getStore() ?? null;
        const at = state.pending.findIndex((reservation) => reservation.owner === owner);
        if (at !== -1) held = state.pending.splice(at, 1)[0]?.worst;
        wake();
      }
      // A figure that is not a count is not the provider's accounting. It does not make the
      // response free: nothing is known of its cost but the most its request could have cost, so
      // that is charged, with no token counts in the ledger (a count would be an invented one).
      // With no request to take that figure from, a run has nothing to bound the response by and
      // is stopped as for a request that cannot be sized.
      let counts = usage;
      let costUsd: number;
      if (
        isCount(usage.inputTokens) &&
        isCount(usage.outputTokens) &&
        isCount(usage.cacheReadTokens) &&
        isCount(usage.cacheWriteTokens)
      ) {
        costUsd = costOf(usage, price);
      } else if (held !== undefined) {
        counts = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
        costUsd = held;
        log(
          "spend guard: a response reported usage that could not be read, so the most its request could cost was charged",
        );
      } else {
        if (state !== undefined) stopRun(state, "unsizable_request");
        return;
      }
      write({
        responses: 1,
        inputTokens: counts.inputTokens,
        outputTokens: counts.outputTokens,
        cacheReadTokens: counts.cacheReadTokens,
        cacheWriteTokens: counts.cacheWriteTokens,
        costUsd,
        unpricedResponses: 0,
      });
      if (state === undefined) return;
      state.spentUsd += costUsd;
      // The bound should keep a run under its limits and the cap holds each request to them. This
      // is for the day neither does: a wrong price, a prompt bigger than estimated.
      if (state.priorUsd + state.spentUsd > limits.perReviewUsd) stopRun(state, "review_limit");
      else {
        let day = 0;
        try {
          day = dayUsd();
        } catch {
          stopRun(state, "ledger_unreadable");
          return;
        }
        if (day > limits.perDayUsd) stopRun(state, "daily_limit");
      }
    },
  };
}
