import { ModelRefusalError } from "@clausewise/llm";
import { createScriptedGenerator } from "@clausewise/llm/testing";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/canonical.js";
import type { ContextBundle } from "../../src/contracts.js";
import { getPrompt } from "../../src/prompts/registry.js";
import { runAnalyze } from "../../src/stages/analyze.js";
import { MODEL_FAILURES, SECRET, answerOf, bundleOf, workedExample } from "./support-stages.js";

const fx = workedExample();
const prompt = getPrompt("analyze.p1");
const term = fx.spanStarting("6.1 ");
const bundle: ContextBundle = bundleOf(fx, "dur-1", { duration: [term.label] });

const GOOD = answerOf({
  evidence: [{ span: term.modelLabel, quote: "two (2) years", role: "governing" }],
});

const analyze = (
  generator: ReturnType<typeof createScriptedGenerator>,
  over: { signal?: AbortSignal; repairAttempts?: number } = {},
) =>
  runAnalyze({
    generator,
    ...(over.signal === undefined ? {} : { signal: over.signal }),
    bundle,
    ingest: fx.ingest,
    manifest: fx.manifest,
    prompt,
    repairAttempts: over.repairAttempts ?? 1,
  });

const failing = (make: () => unknown) =>
  createScriptedGenerator(() => {
    throw make();
  });

describe("runAnalyze: a model failure is a result, never an exception", () => {
  for (const failure of MODEL_FAILURES) {
    describe(failure.name, () => {
      it("returns ok false with the failure class and no text", async () => {
        const result = await analyze(failing(failure.make));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.detail).toMatch(failure.detail);
        expect(JSON.stringify(result)).not.toContain(SECRET);
      });

      it("records one call with the outcome, the attempt and the hash of the request", async () => {
        const generator = failing(failure.make);
        const result = await analyze(generator);
        const request = generator.calls[0]!;
        expect(result.calls).toHaveLength(1);
        expect(result.calls[0]).toEqual({
          stage: "analyze",
          ruleKey: "dur-1",
          promptVersionId: "analyze.p1",
          requestSha256: sha256Hex(request.system + request.prompt),
          attempt: 1,
          outcome: failure.outcome,
          latencyMs: expect.any(Number),
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
        });
      });

      it("is not repaired: a model failure is not a semantic error", async () => {
        const generator = failing(failure.make);
        await analyze(generator, { repairAttempts: 3 });
        expect(generator.calls).toHaveLength(1);
      });

      it("ends the result when it happens on the repair attempt too", async () => {
        let call = 0;
        const generator = createScriptedGenerator(() => {
          if (call++ === 0) {
            return answerOf({ evidence: [{ span: "c999", quote: "q", role: "governing" }] });
          }
          throw failure.make();
        });
        const result = await analyze(generator);
        expect(generator.calls).toHaveLength(2);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.detail).toMatch(failure.detail);
        expect(result.calls.map((c) => [c.attempt, c.outcome])).toEqual([
          [1, "semantic_error"],
          [2, failure.outcome],
        ]);
        expect(JSON.stringify(result)).not.toContain(SECRET);
      });
    });
  }

  it("names a refusal's category only when it is a plain word", async () => {
    const plain = await analyze(failing(() => new ModelRefusalError("x", "cyber")));
    expect(plain.ok === false && plain.detail).toBe(
      "refusal: the model declined to answer (cyber)",
    );
    const odd = await analyze(failing(() => new ModelRefusalError("x", `Cyber ${SECRET}`)));
    expect(odd.ok === false && odd.detail).toBe("refusal: the model declined to answer");
    const none = await analyze(failing(() => new ModelRefusalError("x")));
    expect(none.ok === false && none.detail).toBe("refusal: the model declined to answer");
  });

  it("tells a retryable transport error from a fatal one in the outcome, not in the class", async () => {
    const [rate, , key] = [MODEL_FAILURES[3]!, MODEL_FAILURES[4]!, MODEL_FAILURES[5]!];
    const retryable = await analyze(failing(rate.make));
    const fatal = await analyze(failing(key.make));
    expect(retryable.calls[0]!.outcome).toBe("transport");
    expect(fatal.calls[0]!.outcome).toBe("fatal");
    expect(retryable.ok === false && retryable.detail).toMatch(/^transport/);
    expect(fatal.ok === false && fatal.detail).toMatch(/^transport/);
  });
});

describe("runAnalyze: an abort is not a model failure", () => {
  it("rejects before any call when the signal is already aborted", async () => {
    const generator = createScriptedGenerator(() => GOOD);
    const controller = new AbortController();
    controller.abort();
    await expect(analyze(generator, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(generator.calls).toHaveLength(0);
  });

  it("rethrows an AbortError raised by the generator", async () => {
    await expect(
      analyze(failing(() => new DOMException("stopped", "AbortError"))),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rethrows when the signal aborts during the call, whatever the generator then throws", async () => {
    const controller = new AbortController();
    const generator = createScriptedGenerator(() => {
      controller.abort(new Error("run cancelled"));
      throw new Error("connection reset");
    });
    await expect(analyze(generator, { signal: controller.signal })).rejects.toThrow(
      "run cancelled",
    );
  });

  it("rethrows an abort that happens on the repair attempt, and makes no further call", async () => {
    const controller = new AbortController();
    let call = 0;
    const generator = createScriptedGenerator(() => {
      if (call++ === 0)
        return answerOf({ evidence: [{ span: "c999", quote: "q", role: "governing" }] });
      controller.abort();
      throw new DOMException("stopped", "AbortError");
    });
    await expect(analyze(generator, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(generator.calls).toHaveLength(2);
  });

  it("does not make the repair call when the run was cancelled between the two", async () => {
    const controller = new AbortController();
    const generator = createScriptedGenerator(() => {
      controller.abort();
      return answerOf({ evidence: [{ span: "c999", quote: "q", role: "governing" }] });
    });
    await expect(analyze(generator, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(generator.calls).toHaveLength(1);
  });

  it("hands the signal to the generator", async () => {
    const controller = new AbortController();
    const generator = createScriptedGenerator(() => GOOD);
    await analyze(generator, { signal: controller.signal });
    expect(generator.calls[0]!.signal).toBe(controller.signal);
  });
});

describe("runAnalyze: call records", () => {
  it("times each call", async () => {
    const generator = createScriptedGenerator(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return GOOD;
    });
    const result = await analyze(generator);
    expect(result.calls[0]!.latencyMs).toBeGreaterThanOrEqual(20);
    expect(Number.isInteger(result.calls[0]!.latencyMs)).toBe(true);
  });

  it("numbers the attempts from 1 and keeps the rule key and prompt id on every record", async () => {
    // Two different problems, so that the two repair notes (and so the requests) differ: a
    // note never repeats what the model wrote, so the same problem twice is the same request.
    const answers = [
      answerOf({ escalateWhenMatched: ["nope"] }),
      answerOf({ evidence: [{ span: "c999", quote: "q", role: "governing" }] }),
      GOOD,
    ];
    let call = 0;
    const generator = createScriptedGenerator(() => answers[call++]!);
    const result = await analyze(generator, { repairAttempts: 2 });
    expect(result.calls.map((c) => c.attempt)).toEqual([1, 2, 3]);
    expect(new Set(result.calls.map((c) => c.ruleKey))).toEqual(new Set(["dur-1"]));
    expect(new Set(result.calls.map((c) => c.promptVersionId))).toEqual(new Set(["analyze.p1"]));
    expect(new Set(result.calls.map((c) => c.requestSha256)).size).toBe(3);
  });

  it("hashes the same request the same way every time", async () => {
    const a = await analyze(createScriptedGenerator(() => GOOD));
    const b = await analyze(createScriptedGenerator(() => GOOD));
    expect(a.calls[0]!.requestSha256).toBe(b.calls[0]!.requestSha256);
  });
});
