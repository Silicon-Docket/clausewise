import { getEventListeners } from "node:events";
import {
  ModelOutputError,
  ModelRefusalError,
  ModelRequestError,
  type ObjectGenerator,
} from "@clausewise/llm";
import { describe, expect, it, vi } from "vitest";
import { ReviewError } from "../src/errors.js";
import { reviewContract } from "../src/pipeline.js";
import { createOracleGenerator } from "../src/testing.js";
import type { ProgressEvent, ReviewReport } from "../src/types.js";
import {
  aggressiveScript,
  fixture,
  gatedGenerator,
  intercept,
  loadPlaybook,
  onlyRules,
  ruleIdOf,
  tick,
  viewDocx,
  type Request,
} from "./pipeline-support.js";

const input = fixture("nda-aggressive.docx");
const playbook = loadPlaybook();
const CONTRACT_TEXT = "perpetual and shall continue indefinitely";

const failingTerm = (error: () => unknown) =>
  intercept(createOracleGenerator(aggressiveScript()), (request) => {
    if (ruleIdOf(request) === "term") throw error();
  });

const resultFor = (report: ReviewReport, ruleId: string) => {
  const found = report.results.find((r) => r.ruleId === ruleId);
  if (found === undefined) throw new Error(`no result for ${ruleId}`);
  return found;
};

describe("a refusal", () => {
  it("makes the rule an error that names the refusal category, and the review goes on", async () => {
    const generator = failingTerm(
      () => new ModelRefusalError(`refused: ${CONTRACT_TEXT}`, "cyber"),
    );
    const { report, redlined } = await reviewContract({ docx: input, playbook }, generator);

    expect(resultFor(report, "term")).toMatchObject({
      status: "error",
      error: "The model declined to check this rule (refusal category: cyber).",
      explanation: "",
      comment: "",
      clauseIds: [],
      edit: { kind: "none" },
    });
    expect(report.counts).toMatchObject({ error: 1, deviation: 8, missing: 1 });
    expect(report.open).toEqual({ high: 3, medium: 4, low: 2 });
    expect(generator.calls).toHaveLength(10);
    // The other nine findings still get their comments, and the failed rule gets none.
    const { comments } = await viewDocx(redlined);
    expect(comments).toHaveLength(9);
    expect(comments.some((c) => c.text.includes("Duration of confidentiality"))).toBe(false);
    expect(JSON.stringify(report)).not.toContain(CONTRACT_TEXT);
  });

  it("says so plainly when the provider gave no category", async () => {
    const { report } = await reviewContract(
      { docx: input, playbook },
      failingTerm(() => new ModelRefusalError("refused")),
    );
    expect(resultFor(report, "term").error).toBe("The model declined to check this rule.");
  });

  it("does not repeat a category that is not a short plain label", async () => {
    for (const category of [CONTRACT_TEXT.repeat(3), "two\nlines", "<script>"]) {
      const { report } = await reviewContract(
        { docx: input, playbook },
        failingTerm(() => new ModelRefusalError("refused", category)),
      );
      expect(resultFor(report, "term").error).toBe("The model declined to check this rule.");
    }
  });
});

describe("a failure of one call", () => {
  const cases: { name: string; error: () => unknown; expected: string }[] = [
    {
      name: "an output error",
      error: () => new ModelOutputError(`bad output near ${CONTRACT_TEXT}`),
      expected: "The model did not return an answer in the expected format for this rule.",
    },
    {
      name: "a server error",
      error: () => new ModelRequestError(`failed: ${CONTRACT_TEXT}`, 500),
      expected: "The request to the model failed (HTTP 500).",
    },
    {
      name: "a rate limit",
      error: () => new ModelRequestError("slow down", 429),
      expected: "The request to the model failed (HTTP 429).",
    },
    {
      name: "a request error with no status",
      error: () => new ModelRequestError(`no connection ${CONTRACT_TEXT}`, undefined),
      expected: "The request to the model failed.",
    },
    {
      name: "any other error",
      error: () => new Error(`unexpected ${CONTRACT_TEXT}`),
      expected: "The check failed unexpectedly (Error).",
    },
    {
      name: "an error with its own name",
      error: () => new RangeError(`out of range ${CONTRACT_TEXT}`),
      expected: "The check failed unexpectedly (RangeError).",
    },
    {
      name: "an error whose name is not a plain label",
      error: () => Object.assign(new Error("x"), { name: `Err ${CONTRACT_TEXT.repeat(3)}` }),
      expected: "The check failed unexpectedly (Error).",
    },
    {
      name: "a thrown string",
      error: () => CONTRACT_TEXT,
      expected: "The check failed unexpectedly (Error).",
    },
  ];

  it.each(cases)("$name makes only that rule an error, without contract text", async (item) => {
    const { report } = await reviewContract({ docx: input, playbook }, failingTerm(item.error));
    expect(resultFor(report, "term")).toMatchObject({ status: "error", error: item.expected });
    expect(report.counts.error).toBe(1);
    expect(report.counts.deviation + report.counts.missing).toBe(9);
    expect(JSON.stringify(report)).not.toContain(CONTRACT_TEXT);
  });

  it("treats an answer that does not fit the schema as an output error", async () => {
    const generator: ObjectGenerator = {
      provider: "broken",
      model: "broken",
      disclosure: "nowhere",
      async generate<T>(request: { prompt: string }): Promise<T> {
        return { status: "perhaps", clauseIds: request.prompt } as T;
      },
    };
    const { report, redlined } = await reviewContract({ docx: input, playbook }, generator);
    expect(report.counts.error).toBe(10);
    expect(new Set(report.results.map((r) => r.error))).toEqual(
      new Set(["The model did not return an answer in the expected format for this rule."]),
    );
    expect(JSON.stringify(report)).not.toContain("Singapore");
    // Nothing was found, so the document goes back exactly as it came.
    expect(Buffer.from(redlined).equals(Buffer.from(input))).toBe(true);
  });
});

describe("a fatal failure", () => {
  it.each([401, 403, 404])("HTTP %i stops the review with a ReviewError", async (status) => {
    const generator = intercept(createOracleGenerator(aggressiveScript()), () => {
      throw new ModelRequestError(`rejected: ${CONTRACT_TEXT}`, status);
    });
    const failure = await reviewContract({ docx: input, playbook }, generator, {
      concurrency: 1,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ReviewError);
    const message = (failure as Error).message;
    expect(message).toContain(`HTTP ${status}`);
    expect(message).toMatch(/API key/);
    expect(message).toMatch(/permissions/);
    expect(message).toMatch(/model name/);
    expect(message).toContain("oracle");
    expect(message).not.toContain(CONTRACT_TEXT);
    // The first call was fatal, so nothing else was launched.
    expect(generator.calls).toHaveLength(1);
  });

  it("does not report progress for the rules it never checked", async () => {
    const events: ProgressEvent[] = [];
    const generator = intercept(createOracleGenerator(aggressiveScript()), () => {
      throw new ModelRequestError("no", 401);
    });
    await expect(
      reviewContract({ docx: input, playbook }, generator, {
        concurrency: 1,
        onProgress: (event) => events.push(event),
      }),
    ).rejects.toBeInstanceOf(ReviewError);
    expect(events.map((e) => e.type)).toEqual(["start"]);
  });

  it("lets calls already in flight settle and launches no more", async () => {
    const gate = gatedGenerator();
    let outcome: "pending" | "resolved" | "rejected" = "pending";
    let reason: unknown;
    const review = reviewContract({ docx: input, playbook }, gate, { concurrency: 3 }).then(
      () => (outcome = "resolved"),
      (error: unknown) => {
        outcome = "rejected";
        reason = error;
      },
    );
    await vi.waitFor(() => expect(gate.calls).toHaveLength(3));

    gate.calls[0]!.reject(new ModelRequestError("rejected", 401));
    await tick(20);
    // Two calls are still in flight, so the review waits for them and starts nothing new.
    expect(outcome).toBe("pending");
    expect(gate.calls).toHaveLength(3);

    gate.calls[1]!.resolve();
    await tick(20);
    expect(outcome).toBe("pending");
    expect(gate.calls).toHaveLength(3);

    gate.calls[2]!.resolve();
    await review;
    expect(outcome).toBe("rejected");
    expect(reason).toBeInstanceOf(ReviewError);
    expect(gate.calls).toHaveLength(3);
  });

  it("is fatal when it comes after earlier calls have succeeded", async () => {
    let seen = 0;
    const generator = intercept(createOracleGenerator(aggressiveScript()), () => {
      seen += 1;
      if (seen === 4) throw new ModelRequestError("rejected", 403);
    });
    await expect(
      reviewContract({ docx: input, playbook }, generator, { concurrency: 1 }),
    ).rejects.toBeInstanceOf(ReviewError);
    expect(generator.calls).toHaveLength(4);
  });
});

describe("abort", () => {
  it("rejects with the abort reason without calling the model when already aborted", async () => {
    const reason = new Error("stopped before it began");
    const generator = createOracleGenerator(aggressiveScript());
    await expect(
      reviewContract({ docx: input, playbook }, generator, { signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    expect(generator.calls).toHaveLength(0);
  });

  it("stops launching calls and rejects with the reason when aborted mid-review", async () => {
    const controller = new AbortController();
    const gate = gatedGenerator({ honourSignal: true });
    const events: ProgressEvent[] = [];
    const review = reviewContract({ docx: input, playbook }, gate, {
      concurrency: 2,
      signal: controller.signal,
      onProgress: (event) => events.push(event),
    });
    const settled = review.then(
      () => "resolved",
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(gate.calls).toHaveLength(2));
    gate.calls[0]!.resolve();
    await vi.waitFor(() => expect(gate.calls).toHaveLength(3));

    const reason = new Error("user pressed cancel");
    controller.abort(reason);
    expect(await settled).toBe(reason);
    await tick(20);
    expect(gate.calls).toHaveLength(3);
    expect(gate.inFlight).toBe(0);
    // The one rule that finished before the abort was reported, and nothing after it.
    expect(events.map((e) => e.type)).toEqual(["start", "rule"]);
  });

  it("rejects at once even when the model ignores the signal", async () => {
    const controller = new AbortController();
    const gate = gatedGenerator({ honourSignal: false });
    const settled = reviewContract({ docx: input, playbook }, gate, {
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(gate.calls.length).toBeGreaterThan(0));
    controller.abort();
    const reason = await settled;
    expect((reason as Error).name).toBe("AbortError");
    // The calls that were in flight are abandoned, and no further ones start when they end.
    const started = gate.calls.length;
    gate.calls.forEach((call) => call.resolve());
    await tick(20);
    expect(gate.calls).toHaveLength(started);
  });

  it("does not turn an aborted call into a rule error", async () => {
    const controller = new AbortController();
    const generator = intercept(createOracleGenerator(aggressiveScript()), (request: Request) => {
      if (ruleIdOf(request) === "term") controller.abort(new Error("cancelled"));
    });
    const failure = await reviewContract(
      { docx: input, playbook: onlyRules(playbook, "term") },
      {
        ...generator,
        generate: async (request) => {
          await generator.generate(request);
          throw request.signal?.reason;
        },
      },
      { signal: controller.signal },
    ).catch((error: unknown) => error);
    expect(failure).toEqual(new Error("cancelled"));
  });

  it("removes its listener from the signal when the review ends", async () => {
    const controller = new AbortController();
    await reviewContract(
      { docx: input, playbook: onlyRules(playbook, "term") },
      createOracleGenerator(aggressiveScript()),
      { signal: controller.signal },
    );
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("passes the signal to every model call", async () => {
    const controller = new AbortController();
    const generator = createOracleGenerator(aggressiveScript());
    await reviewContract({ docx: input, playbook }, generator, { signal: controller.signal });
    expect(generator.calls.every((call) => call.signal === controller.signal)).toBe(true);
  });
});

describe("a progress callback that throws", () => {
  it("ends the review with that error once calls in flight have settled", async () => {
    const boom = new Error("the callback broke");
    const generator = createOracleGenerator(aggressiveScript());
    await expect(
      reviewContract({ docx: input, playbook }, generator, {
        concurrency: 1,
        onProgress: (event) => {
          if (event.type === "rule") throw boom;
        },
      }),
    ).rejects.toBe(boom);
    expect(generator.calls).toHaveLength(1);
  });

  it("fails before any call when the start event throws", async () => {
    const boom = new Error("no");
    const generator = createOracleGenerator(aggressiveScript());
    await expect(
      reviewContract({ docx: input, playbook }, generator, {
        onProgress: () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
    expect(generator.calls).toHaveLength(0);
  });
});
