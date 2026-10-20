import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ModelRequestError, createObjectGenerator } from "../src/index.js";
import { scrubProviderText } from "../src/request-error.js";
import {
  API_KEY,
  PROMPT_TEXT,
  failure,
  json,
  makeConfig,
  recordingFetch,
} from "./anthropic-support.js";

const schema = z.object({ verdict: z.enum(["ok", "bad"]) });
const request = { system: "You review contracts.", prompt: PROMPT_TEXT, schema };

const char = (code: number) => String.fromCodePoint(code);
const CONTROLS = [0, 1, 7, 8, 11, 12, 27, 127, 0x85, 0x9f].map(char).join("");
// Right-to-left override, a zero width space, a word joiner, the byte order mark and a bidi isolate.
const INVISIBLE = [0x202e, 0x200b, 0x2060, 0xfeff, 0x2066].map(char).join("");

describe("scrubProviderText", () => {
  it("removes control characters and turns line breaks and tabs into single spaces", () => {
    const text = scrubProviderText(`bad${CONTROLS}request\r\nsecond\tline\n\n\nthird`, undefined);
    // The vertical tab and form feed among the controls count as white space.
    expect(text).toBe("bad request second line third");
    expect(text).not.toMatch(/\p{Cc}/u);
  });

  it("removes characters that reorder or hide text", () => {
    const text = scrubProviderText(`a${INVISIBLE}b${char(0x2028)}c${char(0x2029)}d`, undefined);
    expect(text).toBe("ab c d");
  });

  it("caps the length and says it did", () => {
    const text = scrubProviderText("x".repeat(5000), undefined);
    expect(text).toBe(`${"x".repeat(300)}...`);
    expect(scrubProviderText("y".repeat(300), undefined)).toBe("y".repeat(300));
  });

  describe("secrets", () => {
    it("redacts the configured key wherever it is, in any case", () => {
      const text = scrubProviderText(
        `a ${API_KEY} b ${API_KEY.toUpperCase()} c ${API_KEY.toLowerCase()}`,
        API_KEY,
      );
      expect(text).toBe("a [redacted] b [redacted] c [redacted]");
    });

    it("redacts a key that was split by a control character to slip past the match", () => {
      const split = `${API_KEY.slice(0, 20)}${char(0)}${API_KEY.slice(20)}`;
      expect(scrubProviderText(`key ${split}`, API_KEY)).not.toContain(API_KEY.slice(10));
    });

    it("redacts a cut-off rendering of the configured key", () => {
      const text = scrubProviderText(`Incorrect key ${API_KEY.slice(0, 20)}...`, API_KEY);
      expect(text).not.toContain(API_KEY.slice(0, 16));
      expect(text).toContain("[redacted]");
    });

    it("redacts a key with characters that mean something in a pattern", () => {
      const odd = "k+e(y)[1]{2}^$|.*?\\end";
      expect(scrubProviderText(`got ${odd} here`, odd)).toBe("got [redacted] here");
    });

    it.each([
      ["an Anthropic key", "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCd"],
      ["an OpenAI project key", "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"],
      ["a lower cased key", "sk-ant-canarykey0123456789"],
      ["a key masked in the middle", "sk-proj-********************abcd"],
      ["a bare key", "sk-abcdefghijklmnopqrstuv"],
    ])("redacts %s that is not the configured one", (_name, secret) => {
      const text = scrubProviderText(`Incorrect API key provided: ${secret}. See docs.`, undefined);
      expect(text).toBe("Incorrect API key provided: [redacted]. See docs.");
    });

    it("leaves ordinary words that merely contain sk- alone", () => {
      const text = "task-abcdefghijklmnopqrstuvwxyz and sk-short and risk-free";
      expect(scrubProviderText(text, undefined)).toBe(text);
    });

    it.each([
      ["Bearer abc123", "Bearer [redacted]"],
      ["bearer abc.def-ghi_jkl", "Bearer [redacted]"],
      [
        "Authorization: Bearer eyJhbGciOi.eyJzdWIi.c2lnbmF0dXJl, retry",
        "Authorization: Bearer [redacted], retry",
      ],
    ])("redacts the token in %j", (input, expected) => {
      expect(scrubProviderText(input, undefined)).toBe(expected);
    });

    it("redacts before it caps, so a key at the cap leaves no piece behind", () => {
      const text = scrubProviderText(`${"y".repeat(292)}${API_KEY}`, API_KEY);
      expect(text).not.toContain("sk-ant");
      expect(text).not.toContain("sk-");
    });

    it("does nothing special for an empty or missing key", () => {
      expect(scrubProviderText("plain text", "")).toBe("plain text");
      expect(scrubProviderText("plain text", undefined)).toBe("plain text");
    });
  });
});

describe("the message of a ModelRequestError", () => {
  const hostile =
    `echo ${API_KEY.toUpperCase()} ${CONTROLS}${INVISIBLE} Bearer abcdef123456 ` +
    `sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ ${"z".repeat(1000)}`;

  function expectClean(error: Error) {
    expect(error.message).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(error.message).not.toContain(API_KEY);
    expect(error.message.toLowerCase()).not.toContain(API_KEY.toLowerCase());
    expect(error.message).not.toContain("abcdef123456");
    expect(error.message).not.toContain("ZZZZZZZZZZZZZZZZ");
    expect(error.message.length).toBeLessThan(600);
  }

  it("is built from the provider's sentence, cleaned, for Anthropic", async () => {
    const { fetch } = recordingFetch(() =>
      json({ type: "error", error: { type: "invalid_request_error", message: hostile } }, 400),
    );
    const error = await failure(
      createObjectGenerator(makeConfig({ maxRetries: 0 }), { fetch }).generate(request),
    );
    expect(error).toBeInstanceOf(ModelRequestError);
    expectClean(error);
    expect(error.message).toContain("[redacted]");
  });

  it.each(["openai", "openai-compatible"] as const)(
    "is built from the provider's sentence, cleaned, for %s",
    async (provider) => {
      const { fetch } = recordingFetch(() =>
        json({ error: { message: hostile, type: "invalid_request_error", code: null } }, 400),
      );
      const config = makeConfig({
        provider,
        model: "some-model",
        baseUrl: "https://llm.example.com/v1",
        maxRetries: 0,
      });
      const error = await failure(createObjectGenerator(config, { fetch }).generate(request));
      expectClean(error);
      expect(error.message).toContain("[redacted]");
    },
  );

  it("does not repeat the cause of a network failure on the AI SDK path", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({
          message: `Cannot connect to API: ECONNREFUSED 10.9.8.7:5432 CAUSE-CANARY ${PROMPT_TEXT}`,
          url: "https://llm.example.com/v1/responses",
          requestBodyValues: { messages: [{ content: PROMPT_TEXT }] },
          isRetryable: false,
        });
      },
    });
    const config = makeConfig({ provider: "openai", model: "test-model", maxRetries: 0 });

    const error = (await failure(
      createObjectGenerator(config, { model }).generate(request),
    )) as ModelRequestError;

    expect(error.kind).toBe("network");
    expect(error.message).not.toContain("CAUSE-CANARY");
    expect(error.message).not.toContain("10.9.8.7");
    expect(error.message).not.toContain("CONFIDENTIAL");
  });

  it("does not repeat the sentence of a redirect, which may name where it points", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({
          message: "Moved. Redirecting to https://elsewhere.example/steal?token=abc123",
          url: "https://llm.example.com/v1/responses",
          requestBodyValues: {},
          statusCode: 307,
          isRetryable: false,
        });
      },
    });
    const config = makeConfig({ provider: "openai", model: "test-model", maxRetries: 0 });
    const error = (await failure(
      createObjectGenerator(config, { model }).generate(request),
    )) as ModelRequestError;
    expect(error.message).not.toContain("elsewhere.example");
    expect(error.message).not.toContain("abc123");
    expect(error.kind).toBe("other");
    expect(error.fatal).toBe(true);
  });
});
