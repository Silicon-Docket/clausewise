import Anthropic from "@anthropic-ai/sdk";
import { tracingChannel } from "node:diagnostics_channel";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createObjectGenerator, type LlmConfig } from "../src/index.js";
import {
  API_KEY,
  PROMPT_TEXT,
  makeConfig,
  messageResponse,
  recordingFetch,
} from "./anthropic-support.js";
import { chatCompletion, openaiResponse } from "./openai-support.js";

const schema = z.object({ verdict: z.enum(["ok", "bad"]) });
const request = { system: "You review contracts.", prompt: PROMPT_TEXT, schema };
const answer = JSON.stringify({ verdict: "ok" });

const CHANNEL = "ai:telemetry";
const globals = globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] };

// Everything an observer could see: events on the diagnostics channel that an APM agent preloaded
// into the process would subscribe to, and the callbacks of a registered telemetry integration.
function observe() {
  const seen: unknown[] = [];
  const channel = tracingChannel(CHANNEL);
  const handlers = {
    start: (message: unknown) => seen.push(message),
    end: (message: unknown) => seen.push(message),
    asyncStart: (message: unknown) => seen.push(message),
    asyncEnd: (message: unknown) => seen.push(message),
    error: (message: unknown) => seen.push(message),
  };
  channel.subscribe(handlers);

  const savedIntegrations = globals.AI_SDK_TELEMETRY_INTEGRATIONS;
  const integration = new Proxy(
    {},
    {
      get: (_target, name) =>
        typeof name === "string" && name.startsWith("on")
          ? (event: unknown) => seen.push({ callback: name, event })
          : undefined,
    },
  );
  globals.AI_SDK_TELEMETRY_INTEGRATIONS = [integration];

  return {
    seen,
    stop() {
      channel.unsubscribe(handlers);
      if (savedIntegrations === undefined) delete globals.AI_SDK_TELEMETRY_INTEGRATIONS;
      else globals.AI_SDK_TELEMETRY_INTEGRATIONS = savedIntegrations;
    },
  };
}

function text(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "function" ? "[function]" : item,
  );
}

const providers: ReadonlyArray<{
  name: string;
  config: LlmConfig;
  reply: () => Response;
}> = [
  {
    name: "openai",
    config: makeConfig({ provider: "openai", model: "test-model", apiKey: API_KEY }),
    reply: () => openaiResponse(answer),
  },
  {
    name: "openai-compatible",
    config: makeConfig({
      provider: "openai-compatible",
      model: "llama3.1",
      apiKey: undefined,
      baseUrl: "http://localhost:11434/v1",
    }),
    reply: () => chatCompletion(answer),
  },
  {
    name: "anthropic",
    config: makeConfig(),
    reply: () => messageResponse(answer),
  },
];

let active: ReturnType<typeof observe> | undefined;

afterEach(() => {
  active?.stop();
  active = undefined;
});

describe("telemetry", () => {
  it.each(providers)(
    "publishes nothing and calls no integration while $name generates",
    async ({ config, reply }) => {
      active = observe();
      const { fetch } = recordingFetch(() => reply());

      await expect(createObjectGenerator(config, { fetch }).generate(request)).resolves.toEqual({
        verdict: "ok",
      });

      expect(active.seen).toEqual([]);
      expect(text(active.seen)).not.toContain("CONFIDENTIAL");
    },
  );

  it("stays silent when the call fails, too", async () => {
    active = observe();
    const { fetch } = recordingFetch(() => new Response("{}", { status: 400 }));
    const config = makeConfig({ provider: "openai", model: "test-model", maxRetries: 0 });
    await expect(createObjectGenerator(config, { fetch }).generate(request)).rejects.toBeDefined();
    expect(active.seen).toEqual([]);
  });

  describe("the check itself", () => {
    // Shows the listeners above would have caught a call that is not switched off, so that a
    // silent result means something.
    it("sees the prompt when the SDK is called with telemetry left on", async () => {
      const { generateText } = await import("ai");
      const { createOpenAI } = await import("@ai-sdk/openai");
      active = observe();
      const { fetch } = recordingFetch(() => openaiResponse(answer));
      const model = createOpenAI({ apiKey: API_KEY, fetch })("test-model");

      await generateText({ model, prompt: PROMPT_TEXT });

      expect(active.seen.length).toBeGreaterThan(0);
      expect(text(active.seen)).toContain("CONFIDENTIAL");
    });
  });
});

// The Anthropic SDK has its own tracing, through the OpenTelemetry API that every APM agent
// registers a provider with. It can put message content into a span when the environment says so.
describe("OpenTelemetry spans of the Anthropic SDK", () => {
  const sdkRequire = createRequire(createRequire(import.meta.url).resolve("@anthropic-ai/sdk"));
  // The package is the SDK's own dependency, so only the few calls used here are typed.
  const otel = sdkRequire("@opentelemetry/api") as {
    INVALID_SPAN_CONTEXT: unknown;
    trace: {
      wrapSpanContext(context: unknown): unknown;
      setGlobalTracerProvider(provider: unknown): boolean;
      disable(): void;
    };
  };

  function agent() {
    const started: string[] = [];
    const span = otel.trace.wrapSpanContext(otel.INVALID_SPAN_CONTEXT);
    const tracer = {
      startSpan: (name: string) => {
        started.push(name);
        return span;
      },
      startActiveSpan: (name: string, ...rest: unknown[]) => {
        started.push(name);
        const callback = rest.at(-1) as (given: unknown) => unknown;
        return callback(span);
      },
    };
    otel.trace.setGlobalTracerProvider({ getTracer: () => tracer });
    return started;
  }

  afterEach(() => {
    otel.trace.disable();
    vi.unstubAllEnvs();
  });

  it("are not started by the adapter, whatever the environment asks for", async () => {
    vi.stubEnv("ANTHROPIC_OPEN_TELEMETRY", "true");
    vi.stubEnv("ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE", "content");
    const started = agent();
    const { fetch } = recordingFetch(() => messageResponse(answer));

    await createObjectGenerator(makeConfig(), { fetch }).generate(request);

    expect(started).toEqual([]);
  });

  it("would be started by a client built the obvious way, which is what the check rules out", async () => {
    vi.stubEnv("ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE", "content");
    const started = agent();
    const { fetch } = recordingFetch(() => messageResponse(answer));

    await new Anthropic({ apiKey: API_KEY, fetch }).messages.create({
      model: "claude-sonnet-5-5",
      max_tokens: 10,
      messages: [{ role: "user", content: PROMPT_TEXT }],
    });

    expect(started.length).toBeGreaterThan(0);
  });
});
