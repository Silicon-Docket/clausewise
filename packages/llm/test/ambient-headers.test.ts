import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAnthropicGenerator, createObjectGenerator } from "../src/index.js";
import {
  API_KEY,
  PROMPT_TEXT,
  headerText,
  makeConfig,
  messageResponse,
  recordingFetch,
  streamResponse,
} from "./anthropic-support.js";

const schema = z.object({ verdict: z.enum(["ok", "bad"]) });
const request = { system: "You review contracts.", prompt: PROMPT_TEXT, schema };
const answer = JSON.stringify({ verdict: "ok" });

// Meant for another tool's gateway: a credential, a header that changes what the API does and one
// that has no business being set at all.
const CUSTOM =
  "x-api-key: OVERRIDE-KEY\nauthorization: Bearer GATEWAY-TOKEN\nX-Exfil: 1\n" +
  "anthropic-beta: weird-beta\nhost: evil.example\nx-gateway-user: someone@example.com";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ANTHROPIC_CUSTOM_HEADERS", () => {
  function expectNoneSent(headers: Headers) {
    const text = headerText(headers);
    for (const leaked of [
      "OVERRIDE-KEY",
      "GATEWAY-TOKEN",
      "weird-beta",
      "evil.example",
      "someone@",
    ]) {
      expect(text).not.toContain(leaked);
    }
    expect(headers.get("x-exfil")).toBeNull();
    expect(headers.get("x-gateway-user")).toBeNull();
    expect(headers.get("anthropic-beta")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-api-key")).toBe(API_KEY);
  }

  it("sends none of the headers it describes", async () => {
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", CUSTOM);
    const { fetch, requests } = recordingFetch(() => messageResponse(answer));
    await createObjectGenerator(makeConfig(), { fetch }).generate(request);
    expectNoneSent(requests[0]?.headers ?? new Headers());
  });

  it("sends none of them on a streamed request either", async () => {
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", CUSTOM);
    const { fetch, requests } = recordingFetch(() => streamResponse(answer));
    await createAnthropicGenerator(makeConfig({ maxOutputTokens: 64_000 }), { fetch }).generate(
      request,
    );
    expectNoneSent(requests[0]?.headers ?? new Headers());
  });

  it("leaves the fallback beta header as the only one", async () => {
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", CUSTOM);
    const { fetch, requests } = recordingFetch(() => messageResponse(answer));
    await createAnthropicGenerator(makeConfig({ fallback: "default" }), { fetch }).generate(
      request,
    );
    expect(requests[0]?.headers.get("anthropic-beta")).toBe("server-side-fallback-2026-07-01");
    expect(headerText(requests[0]?.headers ?? new Headers())).not.toContain("weird-beta");
  });

  it("is back in the environment afterwards, for the tool it belongs to", () => {
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", CUSTOM);
    createAnthropicGenerator(makeConfig());
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBe(CUSTOM);
  });

  it("is not created in the environment when it was never there", () => {
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", undefined);
    createAnthropicGenerator(makeConfig());
    expect("ANTHROPIC_CUSTOM_HEADERS" in process.env).toBe(false);
  });

  it("is restored even when the SDK refuses to build the client", () => {
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", CUSTOM);
    expect(() => createAnthropicGenerator(makeConfig({ maxRetries: -1 }))).toThrow();
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBe(CUSTOM);
  });

  it("does not reach a client the caller built before the variable was set", async () => {
    const { fetch, requests } = recordingFetch(() => messageResponse(answer));
    const client = new Anthropic({ apiKey: "the-clients-own-key", fetch });
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", CUSTOM);

    await createAnthropicGenerator(makeConfig(), { client }).generate(request);

    const headers = requests[0]?.headers ?? new Headers();
    expect(headers.get("x-exfil")).toBeNull();
    expect(headers.get("anthropic-beta")).toBeNull();
    expect(headers.get("x-api-key")).toBe("the-clients-own-key");
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBe(CUSTOM);
  });

  it("would be sent by a client built the obvious way, which is what the check rules out", async () => {
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", CUSTOM);
    const { fetch, requests } = recordingFetch(() => messageResponse(answer));
    await new Anthropic({ apiKey: API_KEY, fetch }).messages.create({
      model: "claude-sonnet-5-5",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(requests[0]?.headers.get("x-exfil")).toBe("1");
    expect(requests[0]?.headers.get("anthropic-beta")).toBe("weird-beta");
  });
});
