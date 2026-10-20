import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// The line depends on how Node was started and on the proxy variables, which a developer's shell or
// a CI runner may well set, so every test begins without any of them.
const AMBIENT = [
  "NODE_USE_ENV_PROXY",
  "NODE_OPTIONS",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
];

beforeEach(() => {
  for (const name of AMBIENT) vi.stubEnv(name, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

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

describe("an unencrypted connection", () => {
  it.each([
    ["anthropic", "http://gateway.corp.example/v1", "gateway.corp.example"],
    ["anthropic", "http://203.0.113.9:4000", "203.0.113.9:4000"],
    ["openai", "http://203.0.113.9/v1", "203.0.113.9"],
    ["openai-compatible", "http://10.0.0.5:8000/v1", "10.0.0.5:8000"],
    ["openai-compatible", "http://llm.internal.example/v1", "llm.internal.example"],
    ["openai-compatible", "HTTP://LLM.EXAMPLE.COM/v1", "llm.example.com"],
  ] as const)("is said for %s at %s", (provider, baseUrl, host) => {
    const text = disclosure({ provider, baseUrl, apiKey: "sk-test-key-that-is-not-real" });
    expect(text).toContain(host);
    expect(text).toContain("not encrypted");
    expect(text).not.toMatch(/\n/);
  });

  it.each([
    "http://localhost:11434/v1",
    "http://127.0.0.1:8080/v1",
    "http://[::1]:8080/v1",
    "http://host.docker.internal:11434/v1",
    "HTTP://LOCALHOST:11434/v1",
  ])("is not said for %s, which never leaves this machine", (baseUrl) => {
    for (const provider of ["anthropic", "openai", "openai-compatible"] as const) {
      expect(disclosure({ provider, baseUrl })).not.toContain("not encrypted");
    }
  });

  it.each(["anthropic", "openai", "openai-compatible"] as const)(
    "is not said for https with %s",
    (provider) => {
      expect(disclosure({ provider, baseUrl: "https://llm.example.com/v1" })).not.toContain(
        "not encrypted",
      );
    },
  );

  it("is not said for the default endpoints", () => {
    expect(disclosure({ provider: "anthropic" })).not.toContain("not encrypted");
    expect(disclosure({ provider: "openai" })).not.toContain("not encrypted");
  });

  it("still says only the host, never the path, query or credentials", () => {
    const text = disclosure({
      provider: "openai-compatible",
      baseUrl: "http://user:hunter2@llm.example.com/secret-path/v1?token=abc123",
    });
    for (const leaked of ["hunter2", "user", "secret-path", "abc123"]) {
      expect(text).not.toContain(leaked);
    }
    expect(text).toContain("not encrypted");
  });
});

describe("a proxy taken from the environment", () => {
  const PROXY = "http://user:hunter2@proxy.corp.example:3128/secret-path";

  function proxied(env: Record<string, string>, overrides: Partial<LlmConfig>): string {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    return disclosure(overrides);
  }

  it.each(["anthropic", "openai"] as const)(
    "is named by its host for %s over https",
    (provider) => {
      const text = proxied({ NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: PROXY }, { provider });
      expect(text).toContain("through a proxy");
      expect(text).toContain("proxy.corp.example:3128");
      for (const leaked of ["hunter2", "user", "secret-path"]) expect(text).not.toContain(leaked);
      expect(text).not.toMatch(/\n/);
    },
  );

  it("is named for http destinations through HTTP_PROXY", () => {
    const text = proxied(
      { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: PROXY },
      { provider: "openai-compatible", baseUrl: "http://10.0.0.5:8000/v1" },
    );
    expect(text).toContain("through a proxy (proxy.corp.example:3128)");
    expect(text).toContain("not encrypted");
  });

  it("is named when Node was started with --use-env-proxy", () => {
    const text = proxied(
      { NODE_OPTIONS: "--max-old-space-size=8192 --use-env-proxy", HTTPS_PROXY: PROXY },
      { provider: "anthropic" },
    );
    expect(text).toContain("proxy.corp.example:3128");
  });

  it("stops calling a local server a server on this machine, because the proxy decides", () => {
    const text = proxied(
      { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: PROXY },
      { provider: "openai-compatible", baseUrl: "http://localhost:11434/v1" },
    );
    expect(text).toContain("localhost:11434");
    expect(text).toContain("through a proxy");
    expect(text).not.toContain("on this machine");
  });

  it("keeps saying so when NO_PROXY excludes the local server", () => {
    const text = proxied(
      { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: PROXY, NO_PROXY: "localhost" },
      { provider: "openai-compatible", baseUrl: "http://localhost:11434/v1" },
    );
    expect(text).toContain("on this machine");
    expect(text).not.toContain("proxy");
  });

  it("says nothing when Node does not read the variables, even though they are set", () => {
    const text = proxied(
      { HTTP_PROXY: PROXY, HTTPS_PROXY: PROXY, ALL_PROXY: PROXY },
      { provider: "openai-compatible", baseUrl: "http://localhost:11434/v1" },
    );
    expect(text).not.toContain("proxy");
    expect(text).toContain("on this machine");
  });

  it("says nothing for ALL_PROXY alone, which Node does not read", () => {
    const text = proxied({ NODE_USE_ENV_PROXY: "1", ALL_PROXY: PROXY }, { provider: "anthropic" });
    expect(text).not.toContain("proxy");
  });
});
