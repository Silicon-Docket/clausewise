import type { AnthropicUsage } from "@clausewise/llm";
import { isModelName, modelOfResponse } from "./reported-model.js";
import { currentCall, currentRun } from "./scope.js";

/**
 * The two hooks the provider's adapter offers, wired to the stores of `scope.ts`.
 *
 * Both are called from inside `generate`, so `currentCall()` is the collector that `callModel`
 * opened for that call and `currentRun()` is the scope the engine opened for that run. Neither hook
 * reads, keeps or returns anything but token counts and a plain model name.
 */

/**
 * Records a model name the provider reported, for the call being made and for the run it belongs
 * to. A hook that is called outside a call or outside a run reaches whichever of the two exists.
 */
export function noteModel(model: string): void {
  // A response is provider data. Only something that reads as a model name is kept, so a reply that
  // names a sentence in its model field leaves nothing behind.
  if (!isModelName(model)) return;
  currentCall()?.addModel(model);
  currentRun()?.models.add(model);
}

/**
 * Wraps `inner` so that the model named by each successful response is noted, and the read of the
 * copy of the body is registered with the collector of the call, so that `callModel` can wait for
 * it before it writes the call's record. The response is returned as `inner` returned it.
 *
 * It does not wait for the read itself: several calls are in flight, each with its own collector.
 * A body that cannot be read leaves the model unreported, which a page prints as "not reported",
 * and never affects the request.
 */
export function meteringFetch(inner: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (...request: Parameters<typeof globalThis.fetch>): Promise<Response> => {
    const response = await inner(...request);
    // Read here, in the async chain of the request, and not in the callback below.
    const call = currentCall();
    const run = currentRun();
    if (response.ok && (call !== undefined || run !== undefined)) {
      const read: Promise<void> = modelOfResponse(response.clone()).then(
        (model) => {
          if (model === undefined) return;
          call?.addModel(model);
          run?.models.add(model);
        },
        () => undefined,
      );
      call?.track(read);
    }
    return response;
  };
}

/**
 * The `onUsage` for the adapter: adds the usage of a response to the call being made, and then
 * passes it to `also` (the spend guard, where there is one). Outside a call the first part does
 * nothing.
 */
export function createUsageSink(
  also?: (usage: AnthropicUsage) => void,
): (usage: AnthropicUsage) => void {
  return (usage) => {
    currentCall()?.add(usage);
    also?.(usage);
  };
}
