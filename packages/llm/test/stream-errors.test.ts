import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ModelOutputError, ModelRequestError, createAnthropicGenerator } from "../src/index.js";
import {
  PROMPT_TEXT,
  failure,
  makeConfig,
  recordingFetch,
  streamResponse,
} from "./anthropic-support.js";

const schema = z.object({ verdict: z.enum(["ok", "bad"]) });
const request = { system: "You review contracts.", prompt: PROMPT_TEXT, schema };
const answer = JSON.stringify({ verdict: "ok" });
// Above the size one non-streaming request may have, so the adapter streams.
const STREAMING = 40_000;

function sse(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

// A stream the API opens with 200 and then breaks with an error event, as it does under load.
function brokenStream(
  type: string,
  message: string,
  headers: Record<string, string> = { "retry-after-ms": "1" },
): Response {
  const body = [
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }),
    sse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: '{"verdict":' },
    }),
    sse("error", { type: "error", error: { type, message } }),
  ].join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("an error event in the middle of a stream", () => {
  it("is retried like the HTTP 529 it stands for, and the retry can succeed", async () => {
    const { fetch, requests } = recordingFetch((call) =>
      call === 1 ? brokenStream("overloaded_error", "Overloaded") : streamResponse(answer),
    );
    const generator = createAnthropicGenerator(makeConfig({ maxOutputTokens: STREAMING }), {
      fetch,
    });

    await expect(generator.generate(request)).resolves.toEqual({ verdict: "ok" });

    expect(requests).toHaveLength(2);
    expect(requests[1]?.body).toEqual(requests[0]?.body);
  });

  it("is reported as an overloaded ModelRequestError once the retries are used up", async () => {
    const { fetch, requests } = recordingFetch(() =>
      brokenStream("overloaded_error", "Overloaded"),
    );
    const generator = createAnthropicGenerator(
      makeConfig({ maxOutputTokens: STREAMING, maxRetries: 2 }),
      { fetch },
    );

    const error = (await failure(generator.generate(request))) as ModelRequestError;

    expect(error).toBeInstanceOf(ModelRequestError);
    expect(error).not.toBeInstanceOf(ModelOutputError);
    expect(error.kind).toBe("overloaded");
    expect(error.fatal).toBe(false);
    expect(error.statusCode).toBeUndefined();
    expect(error.message).toContain("Overloaded");
    expect(requests).toHaveLength(3);
  });

  it("makes one request when no retries are allowed", async () => {
    const { fetch, requests } = recordingFetch(() =>
      brokenStream("overloaded_error", "Overloaded"),
    );
    const generator = createAnthropicGenerator(
      makeConfig({ maxOutputTokens: STREAMING, maxRetries: 0 }),
      { fetch },
    );
    const error = (await failure(generator.generate(request))) as ModelRequestError;
    expect(error.kind).toBe("overloaded");
    expect(requests).toHaveLength(1);
  });

  it("is retried for an internal error too, and called a server error", async () => {
    const { fetch, requests } = recordingFetch(() => brokenStream("api_error", "Internal error"));
    const generator = createAnthropicGenerator(
      makeConfig({ maxOutputTokens: STREAMING, maxRetries: 1 }),
      { fetch },
    );
    const error = (await failure(generator.generate(request))) as ModelRequestError;
    expect(error.kind).toBe("server");
    expect(error.fatal).toBe(false);
    expect(requests).toHaveLength(2);
  });

  it("is not retried when it says the request itself is wrong", async () => {
    const { fetch, requests } = recordingFetch(() =>
      brokenStream("invalid_request_error", "max_tokens: too large"),
    );
    const generator = createAnthropicGenerator(
      makeConfig({ maxOutputTokens: STREAMING, maxRetries: 3 }),
      { fetch },
    );
    const error = (await failure(generator.generate(request))) as ModelRequestError;
    expect(error.kind).toBe("other");
    expect(requests).toHaveLength(1);
  });

  it("is not retried when it says the key is no good, and stops the review", async () => {
    const { fetch, requests } = recordingFetch(() =>
      brokenStream("authentication_error", "invalid x-api-key"),
    );
    const generator = createAnthropicGenerator(
      makeConfig({ maxOutputTokens: STREAMING, maxRetries: 3 }),
      { fetch },
    );
    const error = (await failure(generator.generate(request))) as ModelRequestError;
    expect(error.kind).toBe("auth");
    expect(error.fatal).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it("waits the time the server asked for before it tries again", async () => {
    vi.useFakeTimers();
    const { fetch, requests } = recordingFetch((call) =>
      call === 1
        ? brokenStream("overloaded_error", "Overloaded", { "retry-after-ms": "3000" })
        : streamResponse(answer),
    );
    const outcome = createAnthropicGenerator(makeConfig({ maxOutputTokens: STREAMING }), {
      fetch,
    }).generate(request);

    await vi.advanceTimersByTimeAsync(2900);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    await expect(outcome).resolves.toEqual({ verdict: "ok" });
    expect(requests).toHaveLength(2);
  });

  it("backs off from half a second when the server gave no hint", async () => {
    vi.useFakeTimers();
    const { fetch, requests } = recordingFetch((call) =>
      call < 3 ? brokenStream("overloaded_error", "Overloaded", {}) : streamResponse(answer),
    );
    const outcome = createAnthropicGenerator(makeConfig({ maxOutputTokens: STREAMING }), {
      fetch,
    }).generate(request);

    expect(requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(requests).toHaveLength(3);
    await expect(outcome).resolves.toEqual({ verdict: "ok" });
  });

  it("does not wait longer than eight seconds, whatever the server asks", async () => {
    vi.useFakeTimers();
    const { fetch, requests } = recordingFetch((call) =>
      call === 1
        ? brokenStream("overloaded_error", "Overloaded", { "retry-after-ms": "600000" })
        : streamResponse(answer),
    );
    const outcome = createAnthropicGenerator(makeConfig({ maxOutputTokens: STREAMING }), {
      fetch,
    }).generate(request);

    await vi.advanceTimersByTimeAsync(8100);
    await expect(outcome).resolves.toEqual({ verdict: "ok" });
    expect(requests).toHaveLength(2);
  });

  it("is abandoned at once when the review is cancelled during the wait", async () => {
    const { fetch, requests } = recordingFetch(() =>
      brokenStream("overloaded_error", "Overloaded", { "retry-after-ms": "5000" }),
    );
    const controller = new AbortController();
    const outcome = failure(
      createAnthropicGenerator(makeConfig({ maxOutputTokens: STREAMING }), { fetch }).generate({
        ...request,
        signal: controller.signal,
      }),
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    controller.abort(new Error("review cancelled"));

    const error = await outcome;

    expect(error.message).toBe("review cancelled");
    expect(error).not.toBeInstanceOf(ModelRequestError);
    expect(requests).toHaveLength(1);
  });

  it("does not report usage, since the final message never arrived", async () => {
    const onUsage = vi.fn();
    const { fetch } = recordingFetch(() => brokenStream("overloaded_error", "Overloaded"));
    await failure(
      createAnthropicGenerator(makeConfig({ maxOutputTokens: STREAMING, maxRetries: 1 }), {
        fetch,
        onUsage,
      }).generate(request),
    );
    expect(onUsage).not.toHaveBeenCalled();
  });
});
