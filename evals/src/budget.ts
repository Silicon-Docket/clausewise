import { costOf, type Price } from "./prices.js";

/** The recorded spend leaves no room for another request, so no further request was sent. */
export class BudgetExceeded extends Error {
  override name = "BudgetExceeded";
}

export interface Budget {
  /** Stands in for the network in the Anthropic client. It refuses a request that could pass the limit. */
  fetch: typeof globalThis.fetch;
  /** Call once for every response whose usage was recorded, so its reservation is given back. */
  settled: () => void;
  /** The most the requests now under way can still cost. */
  reservedUsd: () => number;
}

interface Reservation {
  usd: number;
}

const usd = (value: number): string => `$${value.toFixed(4)}`;

/**
 * What one request can cost at most: its whole body priced as a prompt at the dearer of the plain
 * and the cache-write rate, and every output token it is allowed. UTF-8 bytes stand in for
 * characters because a script that needs several bytes per character also needs several tokens.
 */
export function worstCaseUsd(body: unknown, price: Price): number {
  if (typeof body !== "string") return Number.POSITIVE_INFINITY;
  let maxTokens: unknown;
  try {
    maxTokens = (JSON.parse(body) as { max_tokens?: unknown }).max_tokens;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  if (typeof maxTokens !== "number" || !Number.isFinite(maxTokens)) {
    return Number.POSITIVE_INFINITY;
  }
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

/**
 * Turns --max-cost into a cap instead of a tripwire. The usage callback only learns what a request
 * cost after the response is back, so with several requests in flight the spend can pass the limit
 * by everything those requests were still allowed to generate. This reserves that allowance before
 * each request is sent, retries of the SDK and of the generator included, because they all pass
 * through here, and sends nothing that could take the total over the limit.
 */
export function createBudget(args: {
  price: Price;
  maxCostUsd: number;
  /** Cost of the usage recorded so far. */
  spentUsd: () => number;
  /** Told once, with the reason, when a request is refused. It should abort the run. */
  stop: (reason: BudgetExceeded) => void;
  inner?: typeof globalThis.fetch;
}): Budget {
  const inner = args.inner ?? globalThis.fetch;
  const pending: Reservation[] = [];
  const waiting = new Set<() => void>();
  const reserved = (): number => pending.reduce((sum, item) => sum + item.usd, 0);
  const wake = (): void => {
    for (const resume of [...waiting]) resume();
  };
  const drop = (item: Reservation): void => {
    const at = pending.indexOf(item);
    if (at !== -1) pending.splice(at, 1);
    wake();
  };

  // A request that fits once the requests under way have settled waits for them, because they
  // usually cost far less than the most they were allowed. One that would not fit even then ends
  // the run.
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
      waiting.add(resume);
      signal?.addEventListener("abort", onAbort, { once: true });
    });

  const guarded = async (...request: Parameters<typeof globalThis.fetch>) => {
    const worst = worstCaseUsd(request[1]?.body, args.price);
    for (;;) {
      if (args.spentUsd() + worst > args.maxCostUsd) {
        const reason = new BudgetExceeded(
          `A request to the model can cost up to ${usd(worst)} and ${usd(args.spentUsd())} is ` +
            `already spent, which would pass the --max-cost limit of ${usd(args.maxCostUsd)}, so no ` +
            "further request was sent. Raise --max-cost, or lower CLAUSEWISE_MAX_OUTPUT_TOKENS to " +
            "shrink what one request can cost.",
        );
        args.stop(reason);
        throw reason;
      }
      if (args.spentUsd() + reserved() + worst <= args.maxCostUsd) break;
      await waitForRoom(request[1]?.signal);
    }
    const item: Reservation = { usd: worst };
    pending.push(item);
    try {
      const response = await inner(...request);
      // A response with no usage never calls settled, so an error status gives its share back here.
      if (!response.ok) drop(item);
      return response;
    } catch (error) {
      drop(item);
      throw error;
    }
  };

  return {
    fetch: guarded,
    // Responses can settle in any order and the reservations differ only by prompt size, so the
    // oldest is given back. The total returns to zero once every response has settled.
    settled: () => {
      pending.shift();
      wake();
    },
    reservedUsd: reserved,
  };
}
