import { createScriptedGenerator } from "@clausewise/llm/testing";
import { describe, expect, it, vi } from "vitest";
import { CATEGORY_IDS, LocateSchema, type CategoryId } from "../../src/contracts.js";
import { sha256Hex } from "../../src/canonical.js";
import { getPrompt } from "../../src/prompts/registry.js";
import { runExtract } from "../../src/stages/extract.js";
import { splitContract, workedExample } from "./support-stages.js";

type Entry = {
  category: CategoryId;
  passages: { span: string; quote: string }[];
  notFoundReason: string | null;
};

const fx = workedExample();
const prompt = getPrompt("extract.p1");
const term = fx.spanStarting("6.1 ");
const TERM_QUOTE = "shall continue for two (2) years from the date of each disclosure";

/** A model that answers with the given entries and nothing else. */
const modelSaying = (categories: Entry[]) => createScriptedGenerator(() => ({ categories }));

const run = (
  generator: ReturnType<typeof modelSaying>,
  over: Partial<Parameters<typeof runExtract>[0]> = {},
) => runExtract({ generator, ingest: fx.ingest, manifest: fx.manifest, prompt, ...over });

describe("runExtract: mapping the model's answer", () => {
  it("locates a passage by clause label and verifies its quote against the span", async () => {
    const out = await run(
      modelSaying([
        {
          category: "duration",
          passages: [{ span: term.modelLabel, quote: TERM_QUOTE }],
          notFoundReason: null,
        },
      ]),
    );
    expect(out.output.degraded).toBe(false);
    expect(out.output.categories.duration).toMatchObject({
      located: [{ spanId: term.id, quote: TERM_QUOTE, quoteCheck: "verified" }],
      notFound: false,
      notFoundReason: null,
    });
  });

  it("gives hint spans for the category that were not located, in document order", async () => {
    const out = await run(
      modelSaying([
        {
          category: "duration",
          passages: [{ span: term.modelLabel, quote: TERM_QUOTE }],
          notFoundReason: null,
        },
      ]),
    );
    expect(out.output.categories.duration.hintSpans).toEqual([
      fx.spanStarting("6.2 ").id,
      fx.spanStarting("9.3 ").id,
    ]);
  });

  it("leaves a located span out of the hint list even when its quote did not verify", async () => {
    const out = await run(
      modelSaying([
        {
          category: "duration",
          passages: [{ span: term.modelLabel, quote: "no such words" }],
          notFoundReason: null,
        },
      ]),
    );
    expect(out.output.categories.duration.located[0]!.quoteCheck).toBe("not_found");
    expect(out.output.categories.duration.hintSpans).not.toContain(term.id);
  });

  it("has an entry for every category even when the model omitted most of them", async () => {
    const out = await run(
      modelSaying([
        {
          category: "duration",
          passages: [{ span: term.modelLabel, quote: TERM_QUOTE }],
          notFoundReason: null,
        },
      ]),
    );
    expect(Object.keys(out.output.categories).sort()).toEqual([...CATEGORY_IDS].sort());
    for (const category of CATEGORY_IDS) {
      if (category === "duration") continue;
      expect(out.output.categories[category], category).toMatchObject({
        located: [],
        notFound: true,
        notFoundReason: "the model gave no entry for this category",
      });
    }
    // Hints survive for a category the model skipped: retrieval still has them.
    expect(out.output.categories["governing-law"].hintSpans).toEqual(
      fx.ingest.annotations
        .filter((a) => a.kind === "keyword_hint" && a.category === "governing-law")
        .map((a) => a.spanId),
    );
  });

  it("passes the model's reason through when it found nothing, tidied to one line", async () => {
    const out = await run(
      modelSaying([
        {
          category: "governing-law",
          passages: [],
          notFoundReason: "  No clause\n names a governing law.  ",
        },
      ]),
    );
    expect(out.output.categories["governing-law"]).toMatchObject({
      located: [],
      notFound: true,
      notFoundReason: "No clause names a governing law.",
    });
  });

  it("gives a null reason when the model found nothing and did not say why", async () => {
    const out = await run(
      modelSaying([{ category: "governing-law", passages: [], notFoundReason: "   " }]),
    );
    expect(out.output.categories["governing-law"].notFoundReason).toBeNull();
    expect(out.output.categories["governing-law"].notFound).toBe(true);
  });

  it("keeps the model's own characters in a reason, angle brackets included", async () => {
    const out = await run(
      modelSaying([
        {
          category: "governing-law",
          passages: [],
          notFoundReason: "no clause names a law <or a forum>",
        },
      ]),
    );
    expect(out.output.categories["governing-law"].notFoundReason).toBe(
      "no clause names a law <or a forum>",
    );
  });

  it("caps a long reason", async () => {
    const out = await run(
      modelSaying([{ category: "governing-law", passages: [], notFoundReason: "x".repeat(5000) }]),
    );
    expect(out.output.categories["governing-law"].notFoundReason!.length).toBeLessThanOrEqual(500);
  });

  it("ignores a reason when passages survive", async () => {
    const out = await run(
      modelSaying([
        {
          category: "duration",
          passages: [{ span: term.modelLabel, quote: TERM_QUOTE }],
          notFoundReason: "none really",
        },
      ]),
    );
    expect(out.output.categories.duration.notFoundReason).toBeNull();
  });

  it("merges two entries for one category and removes repeats", async () => {
    const other = fx.spanStarting("6.2 ");
    const out = await run(
      modelSaying([
        {
          category: "duration",
          passages: [{ span: term.modelLabel, quote: TERM_QUOTE }],
          notFoundReason: null,
        },
        {
          category: "duration",
          passages: [
            { span: term.modelLabel, quote: TERM_QUOTE },
            { span: other.modelLabel, quote: "Either Party may terminate" },
            { span: term.modelLabel, quote: "two (2) years" },
          ],
          notFoundReason: null,
        },
      ]),
    );
    expect(out.output.categories.duration.located.map((p) => [p.spanId, p.quote])).toEqual([
      [term.id, TERM_QUOTE],
      [other.id, "Either Party may terminate"],
      [term.id, "two (2) years"],
    ]);
  });

  it("can locate the same span under two categories", async () => {
    const out = await run(
      modelSaying([
        {
          category: "duration",
          passages: [{ span: term.modelLabel, quote: "two (2) years" }],
          notFoundReason: null,
        },
        {
          category: "ci-definition",
          passages: [{ span: term.modelLabel, quote: "Confidential Information" }],
          notFoundReason: null,
        },
      ]),
    );
    expect(out.output.categories.duration.located[0]!.spanId).toBe(term.id);
    expect(out.output.categories["ci-definition"].located[0]!.spanId).toBe(term.id);
  });
});

describe("runExtract: labels that are not in the contract", () => {
  const entry = (labels: string[]): Entry[] => [
    {
      category: "duration",
      passages: labels.map((span) => ({ span, quote: "two (2) years" })),
      notFoundReason: "ignored",
    },
  ];

  it("drops a label that no clause has", async () => {
    const out = await run(modelSaying(entry(["c999", term.modelLabel])));
    expect(out.output.categories.duration.located.map((p) => p.spanId)).toEqual([term.id]);
    expect(out.output.categories.duration.notFound).toBe(false);
  });

  it("does not take a document label, a clause number or a span id for a clause label", async () => {
    const out = await run(
      modelSaying(entry([term.label, "6.1", term.id, "C" + term.modelLabel.slice(1), "", "c0"])),
    );
    expect(out.output.categories.duration.located).toEqual([]);
  });

  it("is not found when every passage was dropped, and says so without repeating the labels", async () => {
    const out = await run(modelSaying(entry(["c999", "c998"])));
    const duration = out.output.categories.duration;
    expect(duration.notFound).toBe(true);
    expect(duration.notFoundReason).toBe(
      "every passage the model named has a label that is not in the documents",
    );
    expect(duration.hintSpans.length).toBeGreaterThan(0);
  });

  it("reads a label copied with the brackets of its header line", async () => {
    const out = await run(modelSaying(entry([`[${term.modelLabel}]`, `  ${term.modelLabel}  `])));
    expect(out.output.categories.duration.located.map((p) => p.spanId)).toEqual([term.id]);
  });
});

describe("runExtract: quote checks", () => {
  const check = async (spanLabel: string, quote: string) => {
    const out = await run(
      modelSaying([
        { category: "duration", passages: [{ span: spanLabel, quote }], notFoundReason: null },
      ]),
    );
    return out.output.categories.duration.located[0]!;
  };

  it("verifies a quote that occurs once", async () => {
    expect((await check(term.modelLabel, "two (2) years")).quoteCheck).toBe("verified");
  });

  it("verifies a quote after the loose matching of quotation marks, dashes and spaces", async () => {
    const written = fx.spanStarting("6.2 ");
    expect(
      (await check(written.modelLabel, "thirty (30)  days\u2019 written notice")).quoteCheck,
    ).toBe("verified");
  });

  it("counts a quote that occurs more than once as verified, because it is in the span", async () => {
    // "Party" occurs several times in clause 1.2: ambiguous for highlighting, present for location.
    const definition = fx.spanStarting('1.2 "Confidential Information"');
    const verdict = await check(definition.modelLabel, "Party");
    expect(verdict.quoteCheck).toBe("verified");
  });

  it("marks a quote that is not in the span not_found, but keeps the location", async () => {
    const verdict = await check(term.modelLabel, "for a period of five years");
    expect(verdict).toMatchObject({ spanId: term.id, quoteCheck: "not_found" });
  });

  it("marks a quote taken from a different clause not_found", async () => {
    const verdict = await check(term.modelLabel, "Either Party may terminate");
    expect(verdict.quoteCheck).toBe("not_found");
  });

  it("marks an empty or blank quote not_found", async () => {
    expect((await check(term.modelLabel, "")).quoteCheck).toBe("not_found");
    expect((await check(term.modelLabel, "   ")).quoteCheck).toBe("not_found");
  });

  it("does not take part of a word for a match", async () => {
    expect((await check(term.modelLabel, "ntinue for tw")).quoteCheck).toBe("not_found");
  });
});

describe("runExtract: what the model is sent", () => {
  it("sends the prompt's system text, the extract schema and every span of every document", async () => {
    const generator = modelSaying([]);
    await run(generator);
    expect(generator.calls).toHaveLength(1);
    const request = generator.calls[0]!;
    expect(request.system).toBe(prompt.definition.system);
    expect(request.schema).toBe(LocateSchema);
    expect(request.schemaName).toBe(prompt.definition.schemaName);

    const { inside } = splitContract(request.prompt);
    const headers = inside.split("\n").filter((line) => /^\[c\d+\]/.test(line));
    expect(headers).toHaveLength(fx.ingest.spans.length);
    for (const span of fx.ingest.spans) {
      expect(inside).toContain(span.text);
      expect(inside).toContain(`[${span.modelLabel}]`);
    }
  });

  it("puts the document list and the client name after the contract block, not inside it", async () => {
    const generator = modelSaying([]);
    await run(generator);
    const { inside, outside } = splitContract(generator.calls[0]!.prompt);
    expect(outside).toContain("D1 (the NDA): Mutual NDA, stated date 2026-02-02");
    expect(outside).toContain("D2 (an amendment): Amendment No. 1, stated date 2026-09-15");
    expect(outside).toContain("Our client: Lanternfish Software, Inc.");
    expect(inside).not.toContain("stated date");
    expect(inside).not.toContain("Our client");
  });

  it("starts the section of each header with the document label", async () => {
    const generator = modelSaying([]);
    await run(generator);
    const headers = generator.calls[0]!.prompt.split("\n").filter((l) => /^\[c\d+\]/.test(l));
    expect(headers.every((h) => /\(section: D[12]( \| .+)?\)$/.test(h))).toBe(true);
    expect(headers.some((h) => h.includes("(section: D2 | "))).toBe(true);
  });

  it("does not pass the model a hint, an annotation or a span id", async () => {
    const generator = modelSaying([]);
    await run(generator);
    const sent = generator.calls[0]!.prompt;
    expect(sent).not.toContain("dv_d1");
    expect(sent).not.toContain("keyword_hint");
  });

  it("sends the same request twice for the same input", async () => {
    const a = modelSaying([]);
    const b = modelSaying([]);
    await run(a);
    await run(b);
    expect(a.calls[0]!.prompt).toBe(b.calls[0]!.prompt);
  });

  it("makes no call, and finds nothing, when the documents have no reviewable text", async () => {
    const generator = modelSaying([]);
    const out = await run(generator, { ingest: { spans: [], annotations: [], warnings: [] } });
    expect(generator.calls).toHaveLength(0);
    expect(out.calls).toEqual([]);
    expect(out.output.degraded).toBe(false);
    expect(Object.keys(out.output.categories)).toHaveLength(CATEGORY_IDS.length);
    expect(out.output.categories.duration).toMatchObject({
      located: [],
      notFound: true,
      hintSpans: [],
    });
  });
});

describe("runExtract: the call record", () => {
  it("records one successful call with the hash of what was sent and no token counts", async () => {
    const generator = modelSaying([]);
    const out = await run(generator);
    const request = generator.calls[0]!;
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]).toEqual({
      stage: "extract",
      ruleKey: null,
      promptVersionId: "extract.p1",
      requestSha256: sha256Hex(request.system + request.prompt),
      attempt: 1,
      outcome: "ok",
      latencyMs: expect.any(Number),
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    });
    expect(Number.isInteger(out.calls[0]!.latencyMs)).toBe(true);
    expect(out.calls[0]!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("records a latency that reflects the wait", async () => {
    const generator = createScriptedGenerator(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { categories: [] };
    });
    const out = await run(generator);
    expect(out.calls[0]!.latencyMs).toBeGreaterThanOrEqual(20);
  });

  it("hashes a different request differently", async () => {
    const a = await run(modelSaying([]));
    const other = workedExample();
    other.manifest.clientLegalName = "Some Other Client Ltd";
    const b = await run(modelSaying([]), { manifest: other.manifest });
    expect(a.calls[0]!.requestSha256).not.toBe(b.calls[0]!.requestSha256);
  });
});

describe("runExtract: determinism", () => {
  it("gives the same output for the same answer, and does not change its input", async () => {
    const answer: Entry[] = [
      {
        category: "duration",
        passages: [{ span: term.modelLabel, quote: TERM_QUOTE }],
        notFoundReason: null,
      },
    ];
    const before = JSON.stringify(fx.ingest);
    const first = await run(modelSaying(answer));
    const second = await run(modelSaying(answer));
    expect(second.output).toEqual(first.output);
    expect(JSON.stringify(fx.ingest)).toBe(before);
  });

  it("does not log", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    await run(modelSaying([]));
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});
