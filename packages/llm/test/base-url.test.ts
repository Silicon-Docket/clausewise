import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  LlmConfigError,
  createAnthropicGenerator,
  createObjectGenerator,
  loadLlmConfig,
} from "../src/index.js";
import { BaseUrlError, normalizeBaseUrl } from "../src/endpoint.js";
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

describe("normalizeBaseUrl", () => {
  it.each([
    ["https://gw.example.com", "https://gw.example.com"],
    ["https://gw.example.com/", "https://gw.example.com"],
    ["https://gw.example.com///", "https://gw.example.com"],
    ["https://GW.Example.COM:8443/v1/", "https://gw.example.com:8443/v1"],
    ["  http://localhost:11434/v1  ", "http://localhost:11434/v1"],
    ["https://gw.example.com/team/v1", "https://gw.example.com/team/v1"],
    ["https://gw.example.com/V1", "https://gw.example.com/V1"],
    ["https://gw.example.com/v1/messages", "https://gw.example.com/v1/messages"],
  ])("writes %j as %j and leaves the API path alone", (raw, expected) => {
    expect(normalizeBaseUrl(raw)).toBe(expected);
  });

  it.each([
    ["https://gw.example.com", "https://gw.example.com"],
    ["https://gw.example.com/", "https://gw.example.com"],
    ["https://gw.example.com/v1", "https://gw.example.com"],
    ["https://gw.example.com/v1/", "https://gw.example.com"],
    ["https://gw.example.com/V1", "https://gw.example.com"],
    ["https://gw.example.com/v1/messages", "https://gw.example.com"],
    ["https://gw.example.com/v1/messages/", "https://gw.example.com"],
    ["https://gw.example.com/V1/Messages", "https://gw.example.com"],
    ["https://gw.example.com/messages", "https://gw.example.com"],
    ["http://localhost:4000/v1/messages", "http://localhost:4000"],
    ["https://gw.example.com/anthropic", "https://gw.example.com/anthropic"],
    ["https://gw.example.com/team/v1/", "https://gw.example.com/team"],
    ["https://gw.example.com/team/v1/messages", "https://gw.example.com/team"],
    ["https://gw.example.com/v10", "https://gw.example.com/v10"],
  ])("writes %j as the root %j for the Anthropic SDK", (raw, expected) => {
    expect(normalizeBaseUrl(raw, { anthropicRoot: true })).toBe(expected);
  });

  it.each([
    ["not a url", /valid URL/],
    ["localhost:11434/v1", /http/],
    ["ftp://gw.example.com", /http/],
    ["file:///etc/passwd", /http/],
    ["https://user:hunter2@gw.example.com", /username or password/],
    ["https://user@gw.example.com", /username or password/],
    ["https://:hunter2@gw.example.com", /username or password/],
    ["https://gw.example.com/anthropic?x=1", /query/],
    ["https://gw.example.com/v1?api-version=2", /query/],
    ["https://gw.example.com/v1#frag", /fragment/],
  ])("refuses %j", (raw, reason) => {
    expect(() => normalizeBaseUrl(raw)).toThrow(BaseUrlError);
    expect(() => normalizeBaseUrl(raw)).toThrow(reason);
  });

  it("never repeats the URL it refused", () => {
    for (const raw of [
      "https://user:hunter2@gw.example.com/secret?token=abc123",
      "https://gw.example.com/secret?token=abc123",
    ]) {
      try {
        normalizeBaseUrl(raw);
      } catch (error) {
        const text = (error as Error).message;
        for (const leaked of ["hunter2", "abc123", "secret", "gw.example.com"]) {
          expect(text).not.toContain(leaked);
        }
      }
    }
  });
});

describe("loadLlmConfig", () => {
  const env = { ANTHROPIC_API_KEY: API_KEY };

  it("stores the URL without a trailing slash and keeps the /v1 it was given", () => {
    expect(
      loadLlmConfig({ ...env, CLAUSEWISE_BASE_URL: "https://gw.example.com/v1/" }).baseUrl,
    ).toBe("https://gw.example.com/v1");
    expect(loadLlmConfig({ ...env, CLAUSEWISE_BASE_URL: "https://gw.example.com/" }).baseUrl).toBe(
      "https://gw.example.com",
    );
  });

  it.each([
    "https://user:LEAKME@gw.example.com/v1",
    "https://gw.example.com/anthropic?x=LEAKME",
    "https://gw.example.com/v1#LEAKME",
  ])("refuses %s, naming the variable and not the value", (raw) => {
    const attempt = () => loadLlmConfig({ ...env, CLAUSEWISE_BASE_URL: raw });
    expect(attempt).toThrow(LlmConfigError);
    expect(attempt).toThrow(/CLAUSEWISE_BASE_URL/);
    try {
      attempt();
    } catch (error) {
      expect((error as Error).message).not.toContain("LEAKME");
    }
  });
});

describe("the URL the Anthropic SDK is asked to call", () => {
  async function urlFor(baseUrl: string | undefined): Promise<string> {
    const { fetch, requests } = recordingFetch(() => messageResponse(answer));
    await createObjectGenerator(makeConfig({ baseUrl }), { fetch }).generate(request);
    return requests[0]?.url ?? "";
  }

  it.each([
    [undefined, "https://api.anthropic.com/v1/messages"],
    ["https://gw.example.com", "https://gw.example.com/v1/messages"],
    ["https://gw.example.com/", "https://gw.example.com/v1/messages"],
    ["https://gw.example.com/v1", "https://gw.example.com/v1/messages"],
    ["https://gw.example.com/v1/", "https://gw.example.com/v1/messages"],
    ["https://gw.example.com/V1", "https://gw.example.com/v1/messages"],
    ["http://localhost:4000/v1/messages", "http://localhost:4000/v1/messages"],
    ["https://gw.example.com/V1/Messages", "https://gw.example.com/v1/messages"],
    ["https://gw.example.com/messages", "https://gw.example.com/v1/messages"],
    ["https://gw.example.com/anthropic", "https://gw.example.com/anthropic/v1/messages"],
    ["https://gw.example.com/team/v1/messages", "https://gw.example.com/team/v1/messages"],
    ["http://localhost:4000", "http://localhost:4000/v1/messages"],
  ])("is exact for %s", async (baseUrl, expected) => {
    expect(await urlFor(baseUrl)).toBe(expected);
  });

  it("is exact for a URL that went through loadLlmConfig first", async () => {
    for (const [raw, expected] of [
      ["https://gw.example.com/v1/", "https://gw.example.com/v1/messages"],
      ["https://gw.example.com/", "https://gw.example.com/v1/messages"],
      ["http://localhost:4000/v1/messages", "http://localhost:4000/v1/messages"],
    ] as const) {
      const config = loadLlmConfig({ ANTHROPIC_API_KEY: API_KEY, CLAUSEWISE_BASE_URL: raw });
      const { fetch, requests } = recordingFetch(() => messageResponse(answer));
      await createObjectGenerator(config, { fetch }).generate(request);
      expect(requests[0]?.url).toBe(expected);
    }
  });

  it.each([
    "https://gw.example.com/anthropic?x=1",
    "https://gw.example.com/v1#frag",
    "https://user:pw@gw.example.com",
  ])("refuses %s instead of sending to a mangled address", (baseUrl) => {
    expect(() => createAnthropicGenerator(makeConfig({ baseUrl }))).toThrow(LlmConfigError);
  });

  it("still takes a URL it cannot read as it is, and fails on use", () => {
    expect(createAnthropicGenerator(makeConfig({ baseUrl: "not a url" })).disclosure).toBe(
      "Anthropic API (custom endpoint)",
    );
  });
});

describe("the URL the AI SDK is asked to call", () => {
  it.each([
    ["http://localhost:11434/v1", "http://localhost:11434/v1/chat/completions"],
    ["http://localhost:11434/v1/", "http://localhost:11434/v1/chat/completions"],
    ["https://llm.example.com/team/v1", "https://llm.example.com/team/v1/chat/completions"],
  ])("is exact for openai-compatible at %s", async (raw, expected) => {
    const config = loadLlmConfig({
      CLAUSEWISE_PROVIDER: "openai-compatible",
      CLAUSEWISE_MODEL: "llama3.1",
      CLAUSEWISE_BASE_URL: raw,
    });
    const { fetch, requests } = recordingFetch(() => chatCompletion(answer));
    await createObjectGenerator(config, { fetch }).generate(request);
    expect(requests[0]?.url).toBe(expected);
  });

  it("is exact for openai, with and without a base URL", async () => {
    for (const [raw, expected] of [
      [undefined, "https://api.openai.com/v1/responses"],
      ["https://gw.example.com/v1/", "https://gw.example.com/v1/responses"],
    ] as const) {
      const config = loadLlmConfig({
        CLAUSEWISE_PROVIDER: "openai",
        CLAUSEWISE_MODEL: "some-model",
        OPENAI_API_KEY: API_KEY,
        ...(raw === undefined ? {} : { CLAUSEWISE_BASE_URL: raw }),
      });
      const { fetch, requests } = recordingFetch(() => openaiResponse(answer));
      await createObjectGenerator(config, { fetch }).generate(request);
      expect(requests[0]?.url).toBe(expected);
    }
  });
});
