import { createScriptedGenerator } from "@clausewise/llm/testing";
import { describe, expect, it, vi } from "vitest";
import { CATEGORY_IDS } from "../../src/contracts.js";
import { sha256Hex } from "../../src/canonical.js";
import { getPrompt } from "../../src/prompts/registry.js";
import { runExtract } from "../../src/stages/extract.js";
import { MODEL_FAILURES, SECRET, workedExample } from "./support-stages.js";

const fx = workedExample();
const prompt = getPrompt("extract.p1");

const failingWith = (make: () => unknown) =>
  createScriptedGenerator(() => {
    throw make();
  });

const run = (generator: ReturnType<typeof failingWith>, signal?: AbortSignal) =>
  runExtract({
    generator,
    ...(signal === undefined ? {} : { signal }),
    ingest: fx.ingest,
    manifest: fx.manifest,
    prompt,
  });

describe("runExtract: a model failure degrades the stage and never throws", () => {
  for (const failure of MODEL_FAILURES) {
    describe(failure.name, () => {
      it("returns a degraded output with nothing located and only the keyword hints", async () => {
        const out = await run(failingWith(failure.make));
        expect(out.output.degraded).toBe(true);
        expect(Object.keys(out.output.categories).sort()).toEqual([...CATEGORY_IDS].sort());
        for (const category of CATEGORY_IDS) {
          const entry = out.output.categories[category];
          expect(entry.located, category).toEqual([]);
          expect(entry.notFound, category).toBe(false);
          expect(entry.notFoundReason, category).toBeNull();
          expect(entry.hintSpans, category).toEqual(
            fx.ingest.annotations
              .filter((a) => a.kind === "keyword_hint" && a.category === category)
              .map((a) => a.spanId),
          );
        }
      });

      it("records one call with the right outcome and the hash of the request", async () => {
        const generator = failingWith(failure.make);
        const out = await run(generator);
        const request = generator.calls[0]!;
        expect(out.calls).toHaveLength(1);
        expect(out.calls[0]).toMatchObject({
          stage: "extract",
          ruleKey: null,
          promptVersionId: "extract.p1",
          attempt: 1,
          outcome: failure.outcome,
          requestSha256: sha256Hex(request.system + request.prompt),
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
        });
      });

      it("keeps the text of the error out of everything it returns", async () => {
        const out = await run(failingWith(failure.make));
        expect(JSON.stringify(out)).not.toContain(SECRET);
      });

      it("is not retried at this level: the generator already retried", async () => {
        const generator = failingWith(failure.make);
        await run(generator);
        expect(generator.calls).toHaveLength(1);
      });
    });
  }

  it("does not log a failure", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    await run(failingWith(MODEL_FAILURES[0]!.make));
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});

describe("runExtract: an abort is not a model failure", () => {
  it("rejects with the signal's reason, before any call, when already aborted", async () => {
    const generator = createScriptedGenerator(() => ({ categories: [] }));
    const controller = new AbortController();
    controller.abort();
    await expect(run(generator, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(generator.calls).toHaveLength(0);
  });

  it("rethrows an AbortError raised by the generator", async () => {
    const generator = failingWith(() => new DOMException("stopped", "AbortError"));
    await expect(run(generator)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rethrows when the signal is aborted during the call, whatever the generator throws", async () => {
    const controller = new AbortController();
    const generator = createScriptedGenerator(() => {
      controller.abort(new Error("run cancelled"));
      throw new Error("connection reset");
    });
    await expect(run(generator, controller.signal)).rejects.toThrow("run cancelled");
  });

  it("passes the signal to the generator", async () => {
    const controller = new AbortController();
    const generator = createScriptedGenerator(() => ({ categories: [] }));
    await run(generator, controller.signal);
    expect(generator.calls[0]!.signal).toBe(controller.signal);
  });
});
