import { describe, expect, it } from "vitest";
import { z } from "zod";
import { callModel, type ModelCall } from "../../src/stages/analyze-call.js";
import { createLiveGenerator } from "../../src/usage/live.js";
import { meteringFetch } from "../../src/usage/metering.js";
import { CallCollector, callStore, createRunScope, runStore } from "../../src/usage/scope.js";
import { anthropicConfig, errorReply, messagesReply, pause, scriptedWire } from "./support.js";

/**
 * The real Anthropic adapter, over a wire the test scripts: nothing leaves the machine, and no key
 * is real. What is shown is that the application's two hooks are wired into the adapter it builds,
 * and read what the adapter reports. A live provider has never answered these code paths.
 */

const schema = z.object({ answer: z.string() });

const call = (
  generator: ModelCall<{ answer: string }>["generator"],
): ModelCall<{ answer: string }> => ({
  generator,
  signal: undefined,
  stage: "analyze",
  ruleKey: null,
  promptVersionId: "analyze.p1",
  attempt: 1,
  system: "system text",
  prompt: "prompt text",
  sharedPrefix: undefined,
  schema,
  schemaName: "scripted",
});

const OK = { answer: "yes" };

describe("the Anthropic adapter, built by createLiveGenerator", () => {
  it("reports usage and the model through the hooks, and a response with no usage adds none", async () => {
    // The first response is an overload with no usage; the SDK sends the request again.
    const wire = scriptedWire([
      () => errorReply(529),
      () =>
        messagesReply({
          answer: OK,
          model: "model-a-20260101",
          usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 10 },
        }),
    ]);
    const generator = createLiveGenerator(anthropicConfig(), { fetch: wire.fetch });
    const scope = createRunScope("run_x");
    const result = await runStore.run(scope, () => callModel(call(generator)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(wire.sent).toBe(2);
    expect(result.record("ok")).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
    });
    expect([...scope.models]).toEqual(["model-a-20260101"]);
  });

  it("counts the usage of a response that did not fit the schema together with the retry's", async () => {
    const wire = scriptedWire([
      () =>
        messagesReply({
          answer: { not: "the shape" },
          model: "model-a-20260101",
          usage: { input: 50, output: 5 },
        }),
      () =>
        messagesReply({
          answer: OK,
          model: "model-a-20260101",
          usage: { input: 100, output: 20, cacheRead: 3 },
        }),
    ]);
    const generator = createLiveGenerator(anthropicConfig(), { fetch: wire.fetch });
    const result = await callModel(call(generator));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(wire.sent).toBe(2);
    expect(result.record("ok")).toMatchObject({
      inputTokens: 150,
      outputTokens: 25,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
    });
  });

  it("keeps the usage of a call that then failed, because the provider billed it", async () => {
    const wire = scriptedWire([
      () =>
        messagesReply({
          answer: { not: "the shape" },
          model: "model-a",
          usage: { input: 40, output: 4 },
        }),
    ]);
    const generator = createLiveGenerator(anthropicConfig({ maxRetries: 1 }), {
      fetch: wire.fetch,
    });
    const result = await callModel(call(generator));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(wire.sent).toBe(2);
    expect(result.record).toMatchObject({
      outcome: "schema_error",
      inputTokens: 80,
      outputTokens: 8,
    });
  });

  it("records nothing for a call whose every response was an error", async () => {
    const wire = scriptedWire([() => errorReply(529)]);
    const generator = createLiveGenerator(anthropicConfig({ maxRetries: 0 }), {
      fetch: wire.fetch,
    });
    const scope = createRunScope("run_x");
    const result = await runStore.run(scope, () => callModel(call(generator)));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.record).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    });
    expect(scope.models.size).toBe(0);
  });

  it("tells the next consumer of usage too, once the call has its share", async () => {
    const seen: number[] = [];
    const wire = scriptedWire([
      () => messagesReply({ answer: OK, model: "model-a", usage: { input: 11, output: 1 } }),
    ]);
    const generator = createLiveGenerator(anthropicConfig(), {
      fetch: wire.fetch,
      onUsage: (usage) => seen.push(usage.inputTokens),
    });
    const result = await callModel(call(generator));
    expect(result.ok && result.record("ok").inputTokens).toBe(11);
    expect(seen).toEqual([11]);
  });

  it("keeps two calls in flight at once apart", async () => {
    // The first call's response is slow, so the second's arrives first.
    const wire = scriptedWire([
      async () => {
        await pause(40);
        return messagesReply({ answer: OK, model: "model-slow", usage: { input: 1000 } });
      },
      () => messagesReply({ answer: OK, model: "model-fast", usage: { input: 7 } }),
    ]);
    const generator = createLiveGenerator(anthropicConfig(), { fetch: wire.fetch });
    const scope = createRunScope("run_x");
    const [slow, fast] = await runStore.run(scope, async () => {
      const first = callModel(call(generator));
      await pause(5);
      const second = callModel(call(generator));
      return Promise.all([first, second]);
    });
    expect(slow.ok && slow.record("ok").inputTokens).toBe(1000);
    expect(fast.ok && fast.record("ok").inputTokens).toBe(7);
    expect([...scope.models].sort()).toEqual(["model-fast", "model-slow"]);
  });
});

describe("the model a provider names", () => {
  it("is read from a copy of the response, and the adapter still gets the whole of it", async () => {
    const wire = scriptedWire([
      () => messagesReply({ answer: OK, model: "model-a-20260101", usage: { input: 1 } }),
    ]);
    const fetch = meteringFetch(wire.fetch);
    const collector = new CallCollector();
    const response = await callStore.run(collector, () => fetch("https://provider.invalid/v1"));
    await collector.settled();
    expect(collector.models()).toEqual(["model-a-20260101"]);
    expect((await response.json()) as { model: string }).toMatchObject({
      model: "model-a-20260101",
    });
  });

  it("is read in the background, so the response is handed back at once, and the collector can be waited on for it", async () => {
    const slowBody = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode(JSON.stringify({ model: "model-slow" })));
              controller.close();
            }, 40);
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const fetch = meteringFetch(async () => slowBody());
    const collector = new CallCollector();
    const scope = createRunScope("run_x");
    const response = await runStore.run(scope, () =>
      callStore.run(collector, () => fetch("https://provider.invalid/v1")),
    );
    // The body has not arrived, so the model is not known yet.
    expect(collector.models()).toEqual([]);
    await collector.settled();
    expect(collector.models()).toEqual(["model-slow"]);
    expect([...scope.models]).toEqual(["model-slow"]);
    expect(await response.json()).toEqual({ model: "model-slow" });
  });

  it("is read from the start of a streamed response, before the stream ends", async () => {
    const stream = new Response(
      [
        'event: message_start\ndata: {"type":"message_start","message":{"model":"model-a-stream","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const fetch = meteringFetch(async () => stream);
    const collector = new CallCollector();
    const response = await callStore.run(collector, () => fetch("https://provider.invalid/v1"));
    await collector.settled();
    expect(collector.models()).toEqual(["model-a-stream"]);
    expect(await response.text()).toContain("message_stop");
  });

  it("is not read from a failed response, from one with no model, or from one that is not a name", async () => {
    for (const reply of [
      errorReply(500),
      messagesReply({ answer: OK, usage: { input: 1 } }),
      messagesReply({ answer: OK, model: "not a model\nname", usage: { input: 1 } }),
      new Response("plain text", { status: 200, headers: { "content-type": "text/plain" } }),
    ]) {
      const fetch = meteringFetch(async () => reply);
      const collector = new CallCollector();
      const scope = createRunScope("run_x");
      await runStore.run(scope, () =>
        callStore.run(collector, async () => {
          await fetch("https://provider.invalid/v1");
          await collector.settled();
        }),
      );
      expect(collector.models()).toEqual([]);
      expect(scope.models.size).toBe(0);
    }
  });

  it("does not break the request when the copy of a response cannot be read", async () => {
    const broken = new Response("{ not json", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const fetch = meteringFetch(async () => broken);
    const collector = new CallCollector();
    const response = await callStore.run(collector, () => fetch("https://provider.invalid/v1"));
    await collector.settled();
    expect(collector.models()).toEqual([]);
    expect(await response.text()).toBe("{ not json");
  });
});

describe("a provider that reports no usage", () => {
  it("is built without the hooks, and says who it is", () => {
    for (const provider of ["openai", "openai-compatible"] as const) {
      const generator = createLiveGenerator(
        anthropicConfig({
          provider,
          model: "model-b",
          apiKey: "test-key-not-real",
          baseUrl: provider === "openai-compatible" ? "http://localhost:9" : undefined,
        }),
      );
      expect(generator.provider).toBe(provider);
      expect(generator.model).toBe("model-b");
    }
  });
});
