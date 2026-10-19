import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GenerateObjectRequest, ObjectGenerator } from "@clausewise/llm";
import { createOracleGenerator } from "@clausewise/review/testing";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.js";
import {
  aggressiveOracle,
  compliantScript,
  listing,
  makeIo,
  playbookPath,
  stage,
  tempDirs,
} from "./support.js";

const PLAYBOOK = playbookPath("nda-mutual.yaml");
const SENTINEL = "an earlier file that must survive";

/** A model whose calls start, tell the test, and then never answer unless the test says so. */
function stalledGenerator(onCall: (request: GenerateObjectRequest<unknown>) => void) {
  const requests: GenerateObjectRequest<unknown>[] = [];
  const generator: ObjectGenerator = {
    provider: "stalled",
    model: "stalled-model",
    disclosure: "a stalled test generator (nothing is sent anywhere)",
    generate<T>(request: GenerateObjectRequest<T>): Promise<T> {
      requests.push(request as GenerateObjectRequest<unknown>);
      onCall(request as GenerateObjectRequest<unknown>);
      return new Promise<T>(() => {});
    },
  };
  return { generator, requests };
}

describe("Ctrl-C", () => {
  const makeDir = tempDirs();

  it("stops a review in progress, returns 130 and writes nothing", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-aggressive.docx");
    const controller = new AbortController();
    const { generator, requests } = stalledGenerator(() =>
      controller.abort(new Error("Interrupted")),
    );
    const { io, stderr, stdout } = makeIo({ generator, signal: controller.signal });

    // The model never answers, so this only returns because the abort ends the wait.
    const code = await run(["review", input, "--playbook", PLAYBOOK], io);

    expect(code).toBe(130);
    expect(stderr()).toContain("Interrupted. No files were written.");
    expect(stderr()).not.toContain("Error:");
    expect(stdout()).toBe("");
    expect(await listing(dir)).toEqual(["nda-aggressive.docx"]);
    // The signal reached the model call, so a real adapter can cancel its request.
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.signal === controller.signal)).toBe(true);
  });

  it("starts no model call once it has fired", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-aggressive.docx");
    const controller = new AbortController();
    const { generator, requests } = stalledGenerator(() => controller.abort());
    const { io } = makeIo({ generator, signal: controller.signal });

    await run(["review", input, "--playbook", PLAYBOOK, "--quiet"], io);

    // Four calls were in flight when the abort came; the other six were never launched.
    expect(requests.length).toBeLessThanOrEqual(4);
  });

  it("returns 130 when the signal had already fired, without calling the model", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-aggressive.docx");
    const controller = new AbortController();
    controller.abort();
    const generator = createOracleGenerator(compliantScript());
    const { io, stderr } = makeIo({ generator, signal: controller.signal });

    const code = await run(["review", input, "--playbook", PLAYBOOK], io);

    expect(code).toBe(130);
    expect(generator.calls).toHaveLength(0);
    expect(stderr()).toContain("Interrupted.");
    expect(await listing(dir)).toEqual(["nda-aggressive.docx"]);
  });

  it("returns 130 when the model call ends with the abort reason, as a real adapter does", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-aggressive.docx");
    const controller = new AbortController();
    const generator: ObjectGenerator = {
      provider: "adapter",
      model: "adapter-model",
      disclosure: "a test adapter (nothing is sent anywhere)",
      generate<T>(request: GenerateObjectRequest<T>): Promise<T> {
        return new Promise<T>((_, reject) => {
          request.signal?.addEventListener("abort", () => reject(request.signal?.reason), {
            once: true,
          });
          controller.abort(new DOMException("This operation was aborted", "AbortError"));
        });
      },
    };
    const { io, stderr } = makeIo({ generator, signal: controller.signal });

    expect(await run(["review", input, "--playbook", PLAYBOOK], io)).toBe(130);

    expect(stderr()).not.toContain("Error:");
    expect(await listing(dir)).toEqual(["nda-aggressive.docx"]);
  });

  it("writes nothing when it fires after the model is done, while the redline is being built", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-aggressive.docx");
    const controller = new AbortController();
    // Deviations with comments and an edit, so the redline has real work to do.
    const inner = aggressiveOracle();
    let calls = 0;
    const generator: ObjectGenerator = {
      provider: inner.provider,
      model: inner.model,
      disclosure: inner.disclosure,
      async generate(request) {
        const answer = await inner.generate(request);
        calls += 1;
        // The review only looks at the signal while it waits for the model. This fires once the
        // last answer is in, which is while the document is being written.
        if (calls === 10) setTimeout(() => controller.abort(new Error("Interrupted")), 0);
        return answer;
      },
    };
    const { io, stdout } = makeIo({ generator, signal: controller.signal });

    const code = await run(["review", input, "--playbook", PLAYBOOK], io);

    expect(code).toBe(130);
    expect(stdout()).toBe("");
    expect(await listing(dir)).toEqual(["nda-aggressive.docx"]);
  });

  it("leaves an output that was already there alone, even with --force", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-aggressive.docx");
    const existing = join(dir, "nda-aggressive.report.json");
    await writeFile(existing, SENTINEL);
    const controller = new AbortController();
    const { generator } = stalledGenerator(() => controller.abort());
    const { io } = makeIo({ generator, signal: controller.signal });

    expect(await run(["review", input, "--playbook", PLAYBOOK, "--force"], io)).toBe(130);

    expect(await listing(dir)).toEqual(["nda-aggressive.docx", "nda-aggressive.report.json"]);
    expect(await readFile(existing, "utf8")).toBe(SENTINEL);
  });

  it("changes nothing for a signal that never fires", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-balanced.docx");
    const controller = new AbortController();
    const generator = createOracleGenerator(compliantScript());
    const { io } = makeIo({ generator, signal: controller.signal });

    expect(await run(["review", input, "--playbook", PLAYBOOK], io)).toBe(0);

    expect(generator.calls.every((request) => request.signal === controller.signal)).toBe(true);
    expect(await listing(dir)).toHaveLength(4);
  });
});
