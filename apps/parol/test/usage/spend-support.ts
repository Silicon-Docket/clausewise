import type { GenerateObjectRequest } from "@clausewise/llm";
import type { ZodType } from "zod";
import { AnalysisSchema, LocateSchema, SupportSchema } from "../../src/contracts.js";
import { workflowFor } from "../../src/prompts/workflows.js";
import { createServices } from "../../src/services/index.js";
import {
  createSpendGuard,
  worstCaseUsd,
  type SpendGuard,
  type SpendLimits,
} from "../../src/usage/guard.js";
import { createLiveGenerator } from "../../src/usage/live.js";
import { planRun, upperBoundUsd } from "../../src/usage/plan.js";
import { costOf, parsePriceTable, type Price } from "../../src/usage/prices.js";
import {
  baseWorld,
  controlledModel,
  makeWorld,
  type ModelOptions,
  type World,
} from "../services/support.js";
import { anthropicConfig, messagesReply, type Wire, type WireUsage } from "./support.js";

/**
 * A world in which a review goes through the real engine, the real spend guard and the real
 * Anthropic adapter, over a wire the test scripts: the adapter's requests are answered by the
 * scripted model of the service tests, with usage that the test chooses. Nothing leaves the
 * machine and no key is real; the prices are invented. What it shows is that the guard's hooks are
 * wired into the adapter the application builds and that the engine obeys a stop.
 */

/** Invented rates, USD per million tokens. Not a price list. */
export const PRICE: Price = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
export const TABLE = parsePriceTable({ "model-a": PRICE });
/** The output a request may ask for, which the cap reserves in full for every request in flight. The default of the model layer. */
export const MAX_OUTPUT_TOKENS = 16_000;

const KINDS = new Map<string, { kind: "extract" | "analyze" | "support"; schema: ZodType }>([
  ["categories", { kind: "extract", schema: LocateSchema }],
  ["evidence", { kind: "analyze", schema: AnalysisSchema }],
  ["verdict", { kind: "support", schema: SupportSchema }],
]);

/** What the wire knows of a request when it works out the usage to report. */
export interface WireAsk {
  kind: "extract" | "analyze" | "support";
  ruleKey: string | undefined;
  /** The output the request may ask for. */
  maxTokens: number;
  /** The size of the body, in bytes. */
  bytes: number;
}

/**
 * Usage that never passes what the cap reserved for the request: the prompt at a quarter of its
 * bytes in tokens (less than the third the cap assumes) and the given share of the output it may
 * ask for. The responses of a provider are never worth more than the request's worst case.
 */
export const nearWorst =
  (share: number) =>
  (ask: WireAsk): WireUsage => ({
    input: Math.ceil(ask.bytes / 4),
    output: Math.floor(ask.maxTokens * share),
  });

export interface WireRequest {
  kind: "extract" | "analyze" | "support";
  /** The rule the prompt names, for an analyze or support request. */
  ruleKey: string | undefined;
  /** The most the request could cost, by the cap's own arithmetic. */
  worstUsd: number;
  /** What the responses answered before it were worth, by the same prices. */
  spentUsd: number;
}

export interface ModelWire extends Wire {
  readonly requests: WireRequest[];
  /** What the responses answered so far were worth. */
  spent(): number;
}

/**
 * A `fetch` that answers a Messages API request from the scripted model: it reads the schema the
 * request asks for and the prompt it carries, asks the model, and replies with the answer and the
 * usage `options.usage` gives for it.
 */
export function modelWire(
  model: ReturnType<typeof controlledModel>,
  options: {
    usage?: (ask: WireAsk) => WireUsage;
    modelName?: string;
    delayMs?: number;
  } = {},
): ModelWire {
  const requests: WireRequest[] = [];
  let spent = 0;
  const fetch = async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal;
    signal?.throwIfAborted();
    const body = String(init?.body ?? "");
    const parsed = JSON.parse(body) as {
      system?: string;
      max_tokens: number;
      messages: { content: string | { text?: string }[] }[];
      output_config: { format: { schema: { properties?: Record<string, unknown> } } };
    };
    const properties = Object.keys(parsed.output_config.format.schema.properties ?? {});
    const found = properties.map((p) => KINDS.get(p)).find((k) => k !== undefined);
    if (found === undefined) throw new Error("the wire does not know this request");
    const content = parsed.messages[0]?.content;
    const prompt =
      typeof content === "string" ? content : (content ?? []).map((b) => b.text ?? "").join("");
    const ruleKey = /^Rule ID: (\S+)$/m.exec(prompt)?.[1];
    requests.push({
      kind: found.kind,
      ruleKey,
      worstUsd: worstCaseUsd(body, PRICE),
      spentUsd: spent,
    });
    if (options.delayMs !== undefined)
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    const request = {
      system: parsed.system ?? "",
      prompt,
      schema: found.schema,
      schemaName:
        found.kind === "extract"
          ? "locate_passages"
          : found.kind === "analyze"
            ? "analyze_rule"
            : "check_support",
    } as GenerateObjectRequest<unknown>;
    const answer = await model.generator.generate(request);
    signal?.throwIfAborted();
    const usage = options.usage?.({
      kind: found.kind,
      ruleKey,
      maxTokens: parsed.max_tokens,
      bytes: Buffer.byteLength(body),
    }) ?? { input: 1000, output: 200 };
    spent += costOf(
      {
        inputTokens: usage.input ?? 0,
        outputTokens: usage.output ?? 0,
        cacheReadTokens: usage.cacheRead ?? 0,
        cacheWriteTokens: usage.cacheWrite ?? 0,
      },
      PRICE,
    );
    return messagesReply({ answer, model: options.modelName ?? "model-a-20260101", usage });
  };
  return {
    fetch: fetch as typeof globalThis.fetch,
    get sent() {
      return requests.length;
    },
    requests,
    spent: () => spent,
  };
}

export interface SpendWorld extends World {
  guard: SpendGuard;
  wire: ModelWire;
  /** The same repository and files under a new guard, as after a restart of the server with other limits. */
  restart(limits: Partial<SpendLimits>): SpendWorld;
}

export const LIMITS: SpendLimits = {
  perReviewUsd: 100,
  perDayUsd: 1000,
  assumedOutputTokens: 1500,
};

export interface SpendWorldOptions {
  limits?: Partial<SpendLimits>;
  model?: ModelOptions;
  usage?: (ask: WireAsk) => WireUsage;
  maxConcurrentRuns?: number;
  delayMs?: number;
}

/** The world of the service tests, with its provider the real adapter over a scripted wire and its guard in place. */
export function spendWorld(options: SpendWorldOptions = {}): SpendWorld {
  const model = controlledModel(options.model);
  const world = makeWorld({
    model2: model,
    ...(options.maxConcurrentRuns === undefined
      ? {}
      : { config: { maxConcurrentRuns: options.maxConcurrentRuns } }),
  });
  return attachSpend(world, model, options);
}

/**
 * Puts the guard and the real adapter over a scripted wire into a world that was made with `model`:
 * the services of the world are replaced, its repository and files are kept.
 */
export function attachSpend(
  world: World,
  model: ReturnType<typeof controlledModel>,
  options: Pick<SpendWorldOptions, "limits" | "usage" | "delayMs"> = {},
): SpendWorld {
  const wire = modelWire(model, {
    ...(options.usage === undefined ? {} : { usage: options.usage }),
    ...(options.delayMs === undefined ? {} : { delayMs: options.delayMs }),
  });
  return build(world, model, wire, { ...LIMITS, ...options.limits });
}

function build(
  world: World,
  model: ReturnType<typeof controlledModel>,
  wire: ModelWire,
  limits: SpendLimits,
): SpendWorld {
  const guard = createSpendGuard({
    limits,
    provider: "anthropic",
    model: "model-a",
    priceTable: TABLE,
    price: PRICE,
    repo: world.repo,
    log: (line) => world.logs.push(line),
  });
  const generator = createLiveGenerator(
    anthropicConfig({ maxOutputTokens: MAX_OUTPUT_TOKENS, maxRetries: 0 }),
    { fetch: wire.fetch, guard },
  );
  const deps = { ...world.deps, generator, spend: guard };
  return {
    ...world,
    deps,
    services: createServices(deps),
    guard,
    wire,
    restart: (over) => build(world, model, wire, { ...limits, ...over }),
  };
}

/**
 * The bound the guard plans for a review of the base case under `workflow`. The prompts name the
 * client, so a matter made with another client name has another bound: pass the name it was made
 * with.
 */
export function reviewBound(
  workflow = "v2",
  assumedOutputTokens = LIMITS.assumedOutputTokens,
  clientLegalName: string = baseWorld.manifest.clientLegalName,
): number {
  return upperBoundUsd(
    planRun({
      ingest: baseWorld.ingest,
      manifest: { ...baseWorld.manifest, clientLegalName },
      rules: baseWorld.playbook.rules,
      workflow: workflowFor(workflow).manifest,
      assumedOutputTokens,
    }),
    PRICE,
  );
}
