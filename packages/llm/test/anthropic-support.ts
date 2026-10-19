import type { LlmConfig } from "../src/index.js";

export const PROMPT_TEXT = "CONFIDENTIAL-PROMPT: the Supplier shall pay 4,250,000 to Acme";
export const REPLY_TEXT = "CONFIDENTIAL-REPLY: clause 7.2 is unusual";
export const API_KEY = "sk-ant-test-key-that-is-not-real";

export interface Recorded {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: Record<string, unknown>;
}

// Stands in for the network, so these tests see exactly what the real SDK puts on the wire.
export function recordingFetch(
  respond: (call: number, sent: Recorded) => Response | Promise<Response>,
) {
  const requests: Recorded[] = [];
  const fetch = (async (url: unknown, init?: RequestInit) => {
    const sent: Recorded = {
      url: String(url),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    requests.push(sent);
    return respond(requests.length, sent);
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export interface ReplyOptions {
  content?: unknown[];
  stopReason?: string;
  stopDetails?: unknown;
  usage?: Record<string, unknown>;
}

const DEFAULT_USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 200,
};

function textContent(text: string): unknown[] {
  return text === "" ? [] : [{ type: "text", text }];
}

/** A minimal valid Messages API response whose text is `text`. */
export function messageResponse(text: string, options: ReplyOptions = {}): Response {
  return json({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: options.content ?? textContent(text),
    stop_reason: options.stopReason ?? "end_turn",
    stop_sequence: null,
    stop_details: options.stopDetails ?? null,
    usage: { ...DEFAULT_USAGE, ...options.usage },
  });
}

function event(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The same response as `messageResponse`, delivered as a server-sent event stream. */
export function streamResponse(text: string, options: ReplyOptions = {}): Response {
  const usage = { ...DEFAULT_USAGE, ...options.usage };
  const { output_tokens: outputTokens, ...started } = usage;
  const content = options.content ?? textContent(text);
  const body = [
    event("message_start", {
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
        usage: { ...started, output_tokens: 1 },
      },
    }),
    ...content.flatMap((block, index) => {
      const entry = block as { type: string; text?: string };
      if (entry.type !== "text") {
        return [
          event("content_block_start", {
            type: "content_block_start",
            index,
            content_block: block,
          }),
          event("content_block_stop", { type: "content_block_stop", index }),
        ];
      }
      const half = Math.ceil((entry.text ?? "").length / 2);
      return [
        event("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        }),
        ...[(entry.text ?? "").slice(0, half), (entry.text ?? "").slice(half)].map((piece) =>
          event("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: piece },
          }),
        ),
        event("content_block_stop", { type: "content_block_stop", index }),
      ];
    }),
    event("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: options.stopReason ?? "end_turn",
        stop_sequence: null,
        stop_details: options.stopDetails ?? null,
      },
      usage: { ...started, output_tokens: outputTokens },
    }),
    event("message_stop", { type: "message_stop" }),
  ].join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export function errorResponse(
  status: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return json({ type: "error", error: { type: "api_error", message } }, status, {
    // The SDK waits half a second or more between retries unless the server names a delay.
    "retry-after-ms": "1",
    ...headers,
  });
}

export function makeConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    apiKey: API_KEY,
    baseUrl: undefined,
    maxOutputTokens: 12345,
    effort: undefined,
    concurrency: 4,
    maxContextTokens: undefined,
    maxRetries: 2,
    ...overrides,
  };
}

export async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the promise to reject");
}

/** Every header name and value as one string, for checking that something is not among them. */
export function headerText(headers: Headers): string {
  const lines: string[] = [];
  headers.forEach((value, name) => lines.push(`${name}: ${value}`));
  return lines.join("\n");
}
