import type { GenerateObjectRequest, ObjectGenerator } from "./types.js";

/**
 * A model stand-in for tests. `answer` returns whatever the model would have said; the result is
 * parsed with the request's own schema, so a test that drifts from the real schema fails here
 * instead of passing quietly.
 */
export function createScriptedGenerator(
  answer: (request: GenerateObjectRequest<unknown>) => unknown | Promise<unknown>,
  info: {
    provider?: string;
    model?: string;
    disclosure?: string;
    cachesSharedPrefix?: boolean;
    minCacheableChars?: number;
  } = {},
): ObjectGenerator & { readonly calls: GenerateObjectRequest<unknown>[] } {
  const calls: GenerateObjectRequest<unknown>[] = [];
  return {
    provider: info.provider ?? "scripted",
    model: info.model ?? "scripted-model",
    disclosure: info.disclosure ?? "a scripted test generator (nothing is sent anywhere)",
    cachesSharedPrefix: info.cachesSharedPrefix ?? false,
    ...(info.minCacheableChars === undefined ? {} : { minCacheableChars: info.minCacheableChars }),
    calls,
    async generate<T>(request: GenerateObjectRequest<T>): Promise<T> {
      calls.push(request as GenerateObjectRequest<unknown>);
      const raw = await answer(request as GenerateObjectRequest<unknown>);
      return request.schema.parse(raw);
    },
  };
}
