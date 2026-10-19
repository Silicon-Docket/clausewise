import { describe, expect, it, vi } from "vitest";
import { LlmConfigError, loadLlmConfig, type LlmConfig } from "../src/index.js";

const KEY = "sk-ant-api03-SECRET-KEY-VALUE";

const anthropicDefaults: LlmConfig = {
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  apiKey: KEY,
  baseUrl: undefined,
  maxOutputTokens: 16000,
  effort: undefined,
  concurrency: 4,
  maxContextTokens: undefined,
  maxRetries: 2,
};

function configError(env: Record<string, string | undefined>): LlmConfigError {
  try {
    loadLlmConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(LlmConfigError);
    return error as LlmConfigError;
  }
  throw new Error("expected loadLlmConfig to throw");
}

describe("loadLlmConfig defaults", () => {
  it("needs only an Anthropic key and picks claude-sonnet-5-5", () => {
    expect(loadLlmConfig({ ANTHROPIC_API_KEY: KEY })).toEqual(anthropicDefaults);
  });

  it("reads every variable for anthropic", () => {
    expect(
      loadLlmConfig({
        CLAUSEWISE_PROVIDER: "anthropic",
        CLAUSEWISE_MODEL: "claude-opus-5-5",
        ANTHROPIC_API_KEY: KEY,
        CLAUSEWISE_BASE_URL: "https://gateway.example.com/v1",
        CLAUSEWISE_MAX_OUTPUT_TOKENS: "32000",
        CLAUSEWISE_EFFORT: "xhigh",
        CLAUSEWISE_CONCURRENCY: "8",
        CLAUSEWISE_MAX_CONTEXT_TOKENS: "150000",
        CLAUSEWISE_MAX_RETRIES: "5",
      }),
    ).toEqual({
      provider: "anthropic",
      model: "claude-opus-5-5",
      apiKey: KEY,
      baseUrl: "https://gateway.example.com/v1",
      maxOutputTokens: 32000,
      effort: "xhigh",
      concurrency: 8,
      maxContextTokens: 150000,
      maxRetries: 5,
    });
  });

  it("reads openai with its own key and an explicit model", () => {
    expect(
      loadLlmConfig({
        CLAUSEWISE_PROVIDER: "openai",
        CLAUSEWISE_MODEL: "some-openai-model",
        OPENAI_API_KEY: "sk-openai-key",
        ANTHROPIC_API_KEY: KEY,
      }),
    ).toEqual({
      ...anthropicDefaults,
      provider: "openai",
      model: "some-openai-model",
      apiKey: "sk-openai-key",
    });
  });

  it("lets openai-compatible run without a key", () => {
    expect(
      loadLlmConfig({
        CLAUSEWISE_PROVIDER: "openai-compatible",
        CLAUSEWISE_MODEL: "llama3.1",
        CLAUSEWISE_BASE_URL: "http://localhost:11434/v1",
      }),
    ).toEqual({
      ...anthropicDefaults,
      provider: "openai-compatible",
      model: "llama3.1",
      apiKey: undefined,
      baseUrl: "http://localhost:11434/v1",
    });
  });

  it("passes the optional openai-compatible key through", () => {
    const config = loadLlmConfig({
      CLAUSEWISE_PROVIDER: "openai-compatible",
      CLAUSEWISE_MODEL: "m",
      CLAUSEWISE_BASE_URL: "https://models.example.com/v1",
      CLAUSEWISE_API_KEY: "server-key",
    });
    expect(config.apiKey).toBe("server-key");
  });

  it("lets openai take a base URL override", () => {
    const config = loadLlmConfig({
      CLAUSEWISE_PROVIDER: "openai",
      CLAUSEWISE_MODEL: "m",
      OPENAI_API_KEY: "k",
      CLAUSEWISE_BASE_URL: "https://gateway.example.com/v1",
    });
    expect(config.baseUrl).toBe("https://gateway.example.com/v1");
  });

  it("accepts zero retries", () => {
    expect(loadLlmConfig({ ANTHROPIC_API_KEY: KEY, CLAUSEWISE_MAX_RETRIES: "0" }).maxRetries).toBe(
      0,
    );
  });

  it("does not read process.env", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", KEY);
    try {
      expect(() => loadLlmConfig({})).toThrow(LlmConfigError);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("loadLlmConfig fallback", () => {
  it("is off by default and leaves no trace in the config", () => {
    const config = loadLlmConfig({ ANTHROPIC_API_KEY: KEY });
    expect(config.fallback).toBeUndefined();
    expect(config).not.toHaveProperty("fallback");
  });

  it("is on only for the exact word default", () => {
    expect(loadLlmConfig({ ANTHROPIC_API_KEY: KEY, CLAUSEWISE_FALLBACK: "default" })).toEqual({
      ...anthropicDefaults,
      fallback: "default",
    });
  });

  it("trims a trailing newline like every other variable", () => {
    expect(
      loadLlmConfig({ ANTHROPIC_API_KEY: KEY, CLAUSEWISE_FALLBACK: " default\n" }).fallback,
    ).toBe("default");
  });

  it("treats an empty value as off, also for the other providers", () => {
    expect(loadLlmConfig({ ANTHROPIC_API_KEY: KEY, CLAUSEWISE_FALLBACK: " " }).fallback).toBe(
      undefined,
    );
    const config = loadLlmConfig({
      CLAUSEWISE_PROVIDER: "openai",
      CLAUSEWISE_MODEL: "m",
      OPENAI_API_KEY: "k",
      CLAUSEWISE_FALLBACK: "",
    });
    expect(config.fallback).toBeUndefined();
  });

  it.each(["Default", "DEFAULT", "true", "1", "on", "yes", "off", "false", "none", "default,x"])(
    "rejects %s rather than guess whether fallback was meant",
    (value) => {
      const error = configError({ ANTHROPIC_API_KEY: KEY, CLAUSEWISE_FALLBACK: value });
      expect(error.message).toContain("CLAUSEWISE_FALLBACK");
      expect(error.message).toMatch(/\b(set|unset|fix)\b/i);
      expect(error.message).not.toContain(`"${value}"`);
    },
  );

  it("rejects it for providers it does not apply to", () => {
    for (const env of [
      { CLAUSEWISE_PROVIDER: "openai", CLAUSEWISE_MODEL: "m", OPENAI_API_KEY: "k" },
      {
        CLAUSEWISE_PROVIDER: "openai-compatible",
        CLAUSEWISE_MODEL: "m",
        CLAUSEWISE_BASE_URL: "http://localhost:11434/v1",
      },
    ]) {
      const error = configError({ ...env, CLAUSEWISE_FALLBACK: "default" });
      expect(error.message).toContain("CLAUSEWISE_FALLBACK");
      expect(error.message).toContain("anthropic");
    }
  });

  it("rejects it with a custom base URL, naming both variables", () => {
    const error = configError({
      ANTHROPIC_API_KEY: KEY,
      CLAUSEWISE_BASE_URL: "https://gateway.example.com",
      CLAUSEWISE_FALLBACK: "default",
    });
    expect(error.message).toContain("CLAUSEWISE_FALLBACK");
    expect(error.message).toContain("CLAUSEWISE_BASE_URL");
    expect(error.message).toMatch(/\bunset\b/i);
    expect(error.message).not.toContain("gateway.example.com");
  });

  it("still accepts a base URL that is only set to an empty string", () => {
    expect(
      loadLlmConfig({
        ANTHROPIC_API_KEY: KEY,
        CLAUSEWISE_BASE_URL: "",
        CLAUSEWISE_FALLBACK: "default",
      }).fallback,
    ).toBe("default");
  });
});

describe("loadLlmConfig empty and padded values", () => {
  it("treats empty and whitespace-only strings as unset", () => {
    expect(
      loadLlmConfig({
        CLAUSEWISE_PROVIDER: "",
        CLAUSEWISE_MODEL: "  ",
        ANTHROPIC_API_KEY: KEY,
        CLAUSEWISE_BASE_URL: "",
        CLAUSEWISE_MAX_OUTPUT_TOKENS: "",
        CLAUSEWISE_EFFORT: "",
        CLAUSEWISE_CONCURRENCY: " ",
        CLAUSEWISE_MAX_CONTEXT_TOKENS: "",
        CLAUSEWISE_MAX_RETRIES: "",
        CLAUSEWISE_API_KEY: "",
      }),
    ).toEqual(anthropicDefaults);
  });

  it("treats an empty effort as unset for other providers too", () => {
    const config = loadLlmConfig({
      CLAUSEWISE_PROVIDER: "openai",
      CLAUSEWISE_MODEL: "m",
      OPENAI_API_KEY: "k",
      CLAUSEWISE_EFFORT: "",
    });
    expect(config.effort).toBeUndefined();
  });

  it("treats an empty key as missing", () => {
    expect(configError({ ANTHROPIC_API_KEY: "" }).message).toContain("ANTHROPIC_API_KEY");
  });

  it("trims a trailing newline from a key pasted out of a file", () => {
    expect(loadLlmConfig({ ANTHROPIC_API_KEY: `${KEY}\n` }).apiKey).toBe(KEY);
  });
});

describe("loadLlmConfig errors", () => {
  const openaiCompatible = {
    CLAUSEWISE_PROVIDER: "openai-compatible",
    CLAUSEWISE_MODEL: "m",
    CLAUSEWISE_BASE_URL: "http://localhost:11434/v1",
  };

  const cases: [string, Record<string, string | undefined>, string][] = [
    [
      "an unknown provider",
      { CLAUSEWISE_PROVIDER: "gemini", ANTHROPIC_API_KEY: KEY },
      "CLAUSEWISE_PROVIDER",
    ],
    [
      "a provider in the wrong case",
      { CLAUSEWISE_PROVIDER: "Anthropic", ANTHROPIC_API_KEY: KEY },
      "CLAUSEWISE_PROVIDER",
    ],
    ["no Anthropic key", {}, "ANTHROPIC_API_KEY"],
    ["the OpenAI key used for anthropic", { OPENAI_API_KEY: "k" }, "ANTHROPIC_API_KEY"],
    [
      "no model for openai",
      { CLAUSEWISE_PROVIDER: "openai", OPENAI_API_KEY: "k" },
      "CLAUSEWISE_MODEL",
    ],
    [
      "no OpenAI key",
      { CLAUSEWISE_PROVIDER: "openai", CLAUSEWISE_MODEL: "m", ANTHROPIC_API_KEY: KEY },
      "OPENAI_API_KEY",
    ],
    [
      "no model for openai-compatible",
      { ...openaiCompatible, CLAUSEWISE_MODEL: undefined },
      "CLAUSEWISE_MODEL",
    ],
    [
      "no base URL for openai-compatible",
      { ...openaiCompatible, CLAUSEWISE_BASE_URL: undefined },
      "CLAUSEWISE_BASE_URL",
    ],
    [
      "a base URL that is not a URL",
      { ...openaiCompatible, CLAUSEWISE_BASE_URL: "not a url" },
      "CLAUSEWISE_BASE_URL",
    ],
    [
      "a base URL with no scheme",
      { ...openaiCompatible, CLAUSEWISE_BASE_URL: "localhost:11434/v1" },
      "CLAUSEWISE_BASE_URL",
    ],
    [
      "a base URL with another scheme",
      { ...openaiCompatible, CLAUSEWISE_BASE_URL: "ftp://user:hunter2@example.com/v1" },
      "CLAUSEWISE_BASE_URL",
    ],
    [
      "a bad base URL on anthropic",
      { ANTHROPIC_API_KEY: KEY, CLAUSEWISE_BASE_URL: "file:///etc/passwd" },
      "CLAUSEWISE_BASE_URL",
    ],
    [
      "an unknown effort",
      { ANTHROPIC_API_KEY: KEY, CLAUSEWISE_EFFORT: "extreme" },
      "CLAUSEWISE_EFFORT",
    ],
    [
      "effort on openai",
      {
        CLAUSEWISE_PROVIDER: "openai",
        CLAUSEWISE_MODEL: "m",
        OPENAI_API_KEY: "k",
        CLAUSEWISE_EFFORT: "high",
      },
      "CLAUSEWISE_EFFORT",
    ],
    [
      "effort on openai-compatible",
      { ...openaiCompatible, CLAUSEWISE_EFFORT: "low" },
      "CLAUSEWISE_EFFORT",
    ],
    [
      "a bad effort on openai",
      {
        CLAUSEWISE_PROVIDER: "openai",
        CLAUSEWISE_MODEL: "m",
        OPENAI_API_KEY: "k",
        CLAUSEWISE_EFFORT: "bogus",
      },
      "CLAUSEWISE_EFFORT",
    ],
  ];

  it.each(cases)("rejects %s", (_label, env, variable) => {
    const error = configError(env);
    expect(error.message).toContain(variable);
    expect(error.message).toMatch(/\b(set|unset|fix)\b/i);
  });

  const numberVariables = [
    "CLAUSEWISE_MAX_OUTPUT_TOKENS",
    "CLAUSEWISE_CONCURRENCY",
    "CLAUSEWISE_MAX_CONTEXT_TOKENS",
    "CLAUSEWISE_MAX_RETRIES",
  ];
  const badNumbers = [
    "abc",
    "-1",
    "1.5",
    "1e3",
    "0x10",
    "4 workers",
    "+4",
    "NaN",
    "Infinity",
    "99999999999999999999",
  ];

  describe.each(numberVariables)("%s", (variable) => {
    it.each(badNumbers)("rejects %s", (value) => {
      const error = configError({ ANTHROPIC_API_KEY: KEY, [variable]: value });
      expect(error.message).toContain(variable);
      expect(error.message).toMatch(/whole number/);
    });
  });

  it.each(numberVariables.filter((name) => name !== "CLAUSEWISE_MAX_RETRIES"))(
    "rejects zero for %s",
    (variable) => {
      expect(configError({ ANTHROPIC_API_KEY: KEY, [variable]: "0" }).message).toContain(variable);
    },
  );

  it("accepts a padded number", () => {
    expect(
      loadLlmConfig({ ANTHROPIC_API_KEY: KEY, CLAUSEWISE_CONCURRENCY: " 6 " }).concurrency,
    ).toBe(6);
  });

  it("never echoes a secret or a configured value", () => {
    const hostile: Record<string, string>[] = [
      { CLAUSEWISE_PROVIDER: KEY },
      {
        CLAUSEWISE_PROVIDER: "openai",
        CLAUSEWISE_MODEL: "m",
        OPENAI_API_KEY: "",
        CLAUSEWISE_API_KEY: KEY,
      },
      { ANTHROPIC_API_KEY: KEY, CLAUSEWISE_EFFORT: KEY },
      { ANTHROPIC_API_KEY: KEY, CLAUSEWISE_FALLBACK: KEY },
      { ANTHROPIC_API_KEY: KEY, CLAUSEWISE_BASE_URL: `ftp://user:${KEY}@example.com` },
      { ANTHROPIC_API_KEY: KEY, CLAUSEWISE_CONCURRENCY: KEY },
      { ANTHROPIC_API_KEY: KEY, CLAUSEWISE_MAX_OUTPUT_TOKENS: KEY },
      { ANTHROPIC_API_KEY: KEY, CLAUSEWISE_MAX_CONTEXT_TOKENS: KEY },
      { ANTHROPIC_API_KEY: KEY, CLAUSEWISE_MAX_RETRIES: KEY },
      {
        CLAUSEWISE_PROVIDER: "openai-compatible",
        CLAUSEWISE_API_KEY: KEY,
        CLAUSEWISE_BASE_URL: "",
      },
      {
        CLAUSEWISE_PROVIDER: "openai-compatible",
        CLAUSEWISE_API_KEY: KEY,
        CLAUSEWISE_MODEL: "m",
        CLAUSEWISE_BASE_URL: "http://localhost:1/v1",
        CLAUSEWISE_EFFORT: "high",
      },
    ];
    for (const env of hostile) {
      const error = configError(env);
      expect(error.message).not.toContain("SECRET");
      expect(error.message).not.toContain("hunter2");
    }
  });
});
