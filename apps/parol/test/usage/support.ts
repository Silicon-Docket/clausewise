import type {
  AnthropicUsage,
  GenerateObjectRequest,
  LlmConfig,
  ObjectGenerator,
} from "@clausewise/llm";
import type { ServiceConfig } from "../../src/services/deps.js";
import { createServices } from "../../src/services/index.js";
import type { CallPricer } from "../../src/usage/prices.js";
import { createUsageSink, noteModel } from "../../src/usage/metering.js";
import { controlledModel, makeWorld, type ModelOptions, type World } from "../services/support.js";

/**
 * Stand-ins for the provider, for the tests of usage recording. Nothing here calls a network: the
 * "wire" is a function that takes the place of `fetch` and answers with Messages API replies the
 * test scripted. Model names are placeholders (`model-a`), and the key is a dummy that no service
 * would accept.
 */

export const anthropicConfig = (over: Partial<LlmConfig> = {}): LlmConfig => ({
  provider: "anthropic",
  model: "model-a",
  apiKey: "test-key-not-real",
  baseUrl: undefined,
  maxOutputTokens: 4000,
  effort: undefined,
  concurrency: 4,
  maxContextTokens: undefined,
  maxRetries: 2,
  ...over,
});

export interface WireUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** A successful Messages API reply carrying `answer` as the text of its one content block. */
export function messagesReply(options: {
  answer: unknown;
  model?: string | undefined;
  usage?: WireUsage;
  stopReason?: string;
}): Response {
  const usage = options.usage ?? {};
  const body = {
    id: "msg_test",
    type: "message",
    role: "assistant",
    ...(options.model === undefined ? {} : { model: options.model }),
    content: [{ type: "text", text: JSON.stringify(options.answer) }],
    stop_reason: options.stopReason ?? "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.input ?? 0,
      output_tokens: usage.output ?? 0,
      cache_read_input_tokens: usage.cacheRead ?? 0,
      cache_creation_input_tokens: usage.cacheWrite ?? 0,
    },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** An error reply the way the API sends one. `retry-after-ms: 1` keeps a retry from waiting. */
export function errorReply(status: number, type = "overloaded_error"): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message: "scripted" } }), {
    status,
    headers: { "content-type": "application/json", "retry-after-ms": "1" },
  });
}

export interface Wire {
  fetch: typeof globalThis.fetch;
  /** How many requests were sent. */
  readonly sent: number;
}

/**
 * A `fetch` that answers the n-th request with the n-th reply (the last one repeats). Each reply is
 * made when it is asked for: a `Response` handed out twice would be split in two, and the SDK waits
 * for the cancel of an error body, which a split body does not settle until its other half is read.
 */
export function scriptedWire(replies: readonly (() => Response | Promise<Response>)[]): Wire {
  let sent = 0;
  const fetch = async (): Promise<Response> => {
    const reply = replies[Math.min(sent, replies.length - 1)];
    sent += 1;
    if (reply === undefined) throw new Error("the wire has no reply");
    return reply();
  };
  return {
    fetch,
    get sent() {
      return sent;
    },
  };
}

export const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface ReportingOptions {
  /** What the call reports, from its request. Undefined reports nothing. */
  usageFor?: (request: GenerateObjectRequest<unknown>) => AnthropicUsage | undefined;
  /** The model the response names, from the request. Undefined names none. */
  modelFor?: (request: GenerateObjectRequest<unknown>) => string | undefined;
  /** How long the response takes to arrive, so that calls finish in an order of the test's choosing. */
  delayMs?: (request: GenerateObjectRequest<unknown>) => number;
  /**
   * `after` (the default): the response arrives once the scripted model has answered, or failed,
   * which is when the Anthropic adapter reports usage. `before`: it arrives first, and the call is
   * then held or worked on by the scripted model, as a response is while the engine goes on with it.
   */
  report?: "before" | "after";
}

/**
 * Wraps a generator so that each call reports usage and a model name the way the Anthropic adapter
 * does: from inside `generate`, after a delay of the test's choosing, through the sink and
 * `noteModel` of `usage/metering.ts`. The wrapper is told nothing about which call or which run it
 * is in; the attribution under test is the stores' alone.
 */
export function reporting(inner: ObjectGenerator, options: ReportingOptions): ObjectGenerator {
  const sink = createUsageSink();
  return {
    provider: inner.provider,
    model: inner.model,
    disclosure: inner.disclosure,
    ...(inner.cachesSharedPrefix === undefined
      ? {}
      : { cachesSharedPrefix: inner.cachesSharedPrefix }),
    async generate<T>(request: GenerateObjectRequest<T>): Promise<T> {
      const asked = request as GenerateObjectRequest<unknown>;
      const arrive = async (): Promise<void> => {
        await pause(options.delayMs?.(asked) ?? 0);
        const model = options.modelFor?.(asked);
        if (model !== undefined) noteModel(model);
        const usage = options.usageFor?.(asked);
        if (usage !== undefined) sink(usage);
      };
      if (options.report === "before") await arrive();
      try {
        return await inner.generate(request);
      } finally {
        if (options.report !== "before") await arrive();
      }
    },
  };
}

/**
 * A scripted model that reports usage as the Anthropic adapter does, for a world or a site that
 * takes a model of its own (`model2`). Its provider is `anthropic` by name only: nothing leaves the
 * machine, and the run is not a stand-in.
 */
export function meteredModel(
  options: { reporter?: ReportingOptions; model?: ModelOptions } = {},
): ReturnType<typeof controlledModel> {
  const base = controlledModel({
    ...options.model,
    info: { provider: "anthropic", model: "model-a", ...options.model?.info },
  });
  const generator = Object.assign(reporting(base.generator, options.reporter ?? {}), {
    calls: base.generator.calls,
  });
  return { ...base, generator };
}

/**
 * The service tests' world, with a scripted model that reports usage, and the services built with
 * the given price table.
 */
export function meteredWorld(
  options: {
    reporter?: ReportingOptions;
    model?: ModelOptions;
    pricing?: CallPricer;
    config?: Partial<ServiceConfig>;
  } = {},
): World {
  const world = makeWorld({
    model2: meteredModel(options),
    ...(options.config === undefined ? {} : { config: options.config }),
  });
  const services = createServices({
    ...world.deps,
    ...(options.pricing === undefined ? {} : { pricing: options.pricing }),
  });
  return { ...world, services };
}
