import { describe, expect, it } from "vitest";
import { createObjectGenerator, type LlmConfig } from "../src/index.js";

function disclosure(overrides: Partial<LlmConfig>): string {
  return createObjectGenerator({
    provider: "anthropic",
    model: "some-model",
    apiKey: "sk-test-key-that-is-not-real",
    baseUrl: undefined,
    maxOutputTokens: 16000,
    effort: undefined,
    concurrency: 4,
    maxContextTokens: undefined,
    maxRetries: 2,
    ...overrides,
  }).disclosure;
}

describe("disclosure", () => {
  it("names the Anthropic API by default", () => {
    expect(disclosure({ provider: "anthropic" })).toBe("Anthropic API (api.anthropic.com)");
  });

  it("names the OpenAI API by default", () => {
    expect(disclosure({ provider: "openai" })).toBe("OpenAI API (api.openai.com)");
  });

  it.each([
    ["anthropic", "Anthropic API", "api.anthropic.com"],
    ["openai", "OpenAI API", "api.openai.com"],
  ] as const)("says the overridden host for %s instead of the default", (provider, name, host) => {
    const text = disclosure({ provider, baseUrl: "https://gateway.example.com:8443/v1" });
    expect(text).toBe(`${name} (gateway.example.com:8443)`);
    expect(text).not.toContain(host);
  });

  it.each([
    ["http://localhost:11434/v1", "localhost:11434"],
    ["http://localhost/v1", "localhost"],
    ["http://127.0.0.1:8080/v1", "127.0.0.1:8080"],
    ["http://[::1]:8080/v1", "[::1]:8080"],
    ["http://host.docker.internal:11434/v1", "host.docker.internal:11434"],
    ["HTTP://LOCALHOST:11434/v1", "localhost:11434"],
  ])("calls %s a server on this machine", (baseUrl, host) => {
    const text = disclosure({ provider: "openai-compatible", baseUrl });
    expect(text).toContain(host);
    expect(text).toContain("on this machine");
    expect(text).not.toContain("remote");
  });

  it.each([
    ["https://llm.example.com/v1", "llm.example.com"],
    ["http://10.0.0.5:8000/v1", "10.0.0.5:8000"],
    ["http://localhost.example.com/v1", "localhost.example.com"],
    ["http://127.0.0.1.nip.io/v1", "127.0.0.1.nip.io"],
    ["http://mylocalhost/v1", "mylocalhost"],
  ])("calls %s a remote server you configured", (baseUrl, host) => {
    const text = disclosure({ provider: "openai-compatible", baseUrl });
    expect(text).toContain(host);
    expect(text).toContain("a remote server you configured");
    expect(text).not.toContain("on this machine");
  });

  it("says only the host, never a path, query, credentials or key", () => {
    const text = disclosure({
      provider: "openai-compatible",
      baseUrl: "https://user:hunter2@llm.example.com/secret-path/v1?token=abc123",
      apiKey: "sk-test-key-that-is-not-real",
    });
    for (const leaked of ["hunter2", "user", "secret-path", "abc123", "sk-test"]) {
      expect(text).not.toContain(leaked);
    }
    expect(text).toContain("llm.example.com");
  });

  it("is one line", () => {
    expect(
      disclosure({ provider: "openai-compatible", baseUrl: "http://localhost:1/v1" }),
    ).not.toMatch(/\n/);
  });
});
