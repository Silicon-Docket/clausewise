import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ModelOutputError,
  ModelRefusalError,
  ModelRequestError,
  type ObjectGenerator,
} from "@clausewise/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  RECORDING_FORMAT,
  RECORDING_KIND,
  RECORDING_SUFFIX,
  RecordingWriter,
  ReplayMiss,
  loadRecording,
  recordingGenerator,
  recordingPathFor,
  replayGenerator,
  replayRefusal,
  requestKey,
  type RecordingHeader,
} from "../src/parol/replay.js";
import type { Pins } from "../src/parol/results.js";
import {
  makeTempDir,
  oracleFactory,
  readResults,
  removeDir,
  run,
} from "../src/parol/testing-run.js";

/**
 * Record and replay. Every answer in this file is fabricated for a test: no model produced any of
 * it. The model stand-ins are scripted, and nothing is sent anywhere.
 */

let dir = "";
let n = 0;
beforeAll(async () => {
  dir = await makeTempDir();
});
afterAll(async () => {
  await removeDir(dir);
});
const fresh = (): string => join(dir, String(++n));
const freshDir = async (): Promise<string> => {
  const path = fresh();
  await mkdir(path, { recursive: true });
  return path;
};

const Answer = z.object({ word: z.string() });

/** The pins the tests need from a header. The rest of a real header is not read by the replay. */
const pins = (over: Partial<Pins> = {}): Pins =>
  ({
    mode: "live",
    model: {
      provider: "anthropic",
      requested: "a-model",
      endpoint: "api.example.test",
      reported: null,
      reportedNote: "",
    },
    workflow: { label: "v1", sha256: "a".repeat(64) },
    playbook: { slug: "p", version: "1", sha256: "b".repeat(64) },
    generation: null,
    code: { commit: null, dirty: null },
    dataset: {
      label: "x",
      answerKeysSha256: "c".repeat(64),
      splitsFileSha256: "d".repeat(64),
      splits: {},
    },
    ...over,
  }) as unknown as Pins;

const header = (over: Partial<Pins> = {}): RecordingHeader => ({
  kind: RECORDING_KIND,
  format: RECORDING_FORMAT,
  recordedAt: "2026-11-10T00:00:00.000Z",
  results: "parol-x.json",
  pins: pins(over),
});

/** A scripted generator that does what a table says, request by request. */
function scripted(respond: (prompt: string) => unknown, seen: string[] = []): ObjectGenerator {
  return {
    provider: "anthropic",
    model: "a-model",
    disclosure: "a scripted stand-in",
    async generate(request) {
      seen.push(request.prompt);
      const out = respond(request.prompt);
      if (out instanceof Error) throw out;
      return request.schema.parse(out);
    },
  };
}

const ask = (generator: ObjectGenerator, prompt: string, system = "sys") =>
  generator.generate({ system, prompt, schema: Answer, schemaName: "Answer" });

describe("the request key", () => {
  it("is a SHA-256 that depends on the schema name, the system text and the prompt", () => {
    const base = { schemaName: "A", system: "s", prompt: "p" };
    expect(requestKey(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(requestKey({ ...base })).toBe(requestKey(base));
    expect(requestKey({ ...base, schemaName: "B" })).not.toBe(requestKey(base));
    expect(requestKey({ ...base, system: "t" })).not.toBe(requestKey(base));
    expect(requestKey({ ...base, prompt: "q" })).not.toBe(requestKey(base));
  });

  it("does not let two fields run together", () => {
    const a = requestKey({ schemaName: "A", system: "bc", prompt: "d" });
    const b = requestKey({ schemaName: "A", system: "b", prompt: "cd" });
    expect(a).not.toBe(b);
  });

  it("does not reveal the prompt", () => {
    expect(requestKey({ system: "s", prompt: "a secret clause" })).not.toContain("secret");
  });
});

describe("recording and replaying through the generators", () => {
  it("replays an answer, a refusal, a cut-off answer and a failed request as they were", async () => {
    const path = join(fresh(), "r.responses.jsonl");
    const writer = await RecordingWriter.create(path, header());
    const seen: string[] = [];
    const model = scripted((prompt) => {
      if (prompt === "refuse") return new ModelRefusalError("declined", "cyber");
      if (prompt === "cut") return new ModelOutputError("cut off", true);
      if (prompt === "net") return new ModelRequestError("overloaded", 529, false);
      return { word: `answer to ${prompt}` };
    }, seen);
    const recording = recordingGenerator(model, writer);
    expect(await ask(recording, "one")).toEqual({ word: "answer to one" });
    await expect(ask(recording, "refuse")).rejects.toBeInstanceOf(ModelRefusalError);
    await expect(ask(recording, "cut")).rejects.toMatchObject({ truncated: true });
    await expect(ask(recording, "net")).rejects.toMatchObject({ statusCode: 529, fatal: false });
    writer.finish({ complete: true, reported: ["a-model-2026"] });
    await writer.settle();
    expect(writer.written).toBe(4);

    const loaded = await loadRecording(path);
    expect(loaded.size).toBe(4);
    expect(loaded.trailer).toEqual({ complete: true, reported: ["a-model-2026"] });

    const replay = replayGenerator(loaded);
    expect(replay.provider).toBe("anthropic");
    expect(replay.model).toBe("a-model");
    expect(await ask(replay, "one")).toEqual({ word: "answer to one" });
    await expect(ask(replay, "refuse")).rejects.toMatchObject({
      name: "ModelRefusalError",
      category: "cyber",
    });
    await expect(ask(replay, "cut")).rejects.toMatchObject({
      name: "ModelOutputError",
      truncated: true,
    });
    await expect(ask(replay, "net")).rejects.toMatchObject({
      name: "ModelRequestError",
      statusCode: 529,
      fatal: false,
    });
    expect(replay.counts.replayed).toBe(4);
    // The model was asked four times while recording and not at all while replaying.
    expect(seen).toHaveLength(4);
  });

  it("stops at a request that is not in the recording, and says nothing of the prompt", async () => {
    const path = join(fresh(), "r.responses.jsonl");
    const writer = await RecordingWriter.create(path, header());
    await ask(
      recordingGenerator(
        scripted(() => ({ word: "x" })),
        writer,
      ),
      "known",
    );
    await writer.settle();
    const replay = replayGenerator(await loadRecording(path));
    const miss = await ask(replay, "A SECRET CLAUSE ABOUT SALTMARSH").catch((e: unknown) => e);
    expect(miss).toBeInstanceOf(ReplayMiss);
    const message = (miss as Error).message;
    expect(message).toContain("Nothing was sent");
    expect(message).toContain("Answer");
    expect(message).not.toContain("SALTMARSH");
  });

  it("gives an answer as many times as it was recorded and no more", async () => {
    const path = join(fresh(), "r.responses.jsonl");
    const writer = await RecordingWriter.create(path, header());
    let counter = 0;
    const model = scripted(() => ({ word: `take ${++counter}` }));
    const recording = recordingGenerator(model, writer);
    await ask(recording, "same");
    await ask(recording, "same");
    await writer.settle();
    const replay = replayGenerator(await loadRecording(path));
    expect(await ask(replay, "same")).toEqual({ word: "take 1" });
    expect(await ask(replay, "same")).toEqual({ word: "take 2" });
    await expect(ask(replay, "same")).rejects.toThrow(/asked 3 times against 2 recorded/);
  });

  it("refuses a recorded answer that no longer fits the schema of the request", async () => {
    const path = join(fresh(), "r.responses.jsonl");
    const writer = await RecordingWriter.create(path, header());
    await ask(
      recordingGenerator(
        scripted(() => ({ word: "x" })),
        writer,
      ),
      "q",
    );
    await writer.settle();
    const replay = replayGenerator(await loadRecording(path));
    const Changed = z.object({ word: z.string(), number: z.number() });
    await expect(
      replay.generate({ system: "sys", prompt: "q", schema: Changed, schemaName: "Answer" }),
    ).rejects.toThrow(/no longer fits the schema/);
  });

  it("does not record a fatal provider error, an abort or a bug", async () => {
    const path = join(fresh(), "r.responses.jsonl");
    const writer = await RecordingWriter.create(path, header());
    const failing = (error: Error): ObjectGenerator => scripted(() => error);
    for (const error of [
      new ModelRequestError("bad key", 401, true),
      new DOMException("aborted", "AbortError"),
      new TypeError("a bug"),
    ]) {
      await expect(ask(recordingGenerator(failing(error), writer), "q")).rejects.toBe(error);
    }
    await writer.settle();
    expect(writer.written).toBe(0);
  });

  it("never overwrites a recording", async () => {
    const path = join(fresh(), "r.responses.jsonl");
    await RecordingWriter.create(path, header());
    await expect(RecordingWriter.create(path, header())).rejects.toMatchObject({ code: "EEXIST" });
  });
});

describe("reading a recording", () => {
  const write = async (lines: string[]): Promise<string> => {
    const path = join(fresh(), "r.responses.jsonl");
    await RecordingWriter.create(path, header());
    await writeFile(path, `${JSON.stringify(header())}\n${lines.join("\n")}\n`);
    return path;
  };
  const call = (word: string): string =>
    JSON.stringify({ key: "e".repeat(64), schema: "Answer", outcome: "ok", value: { word } });

  it("says a file that is not a recording is not one, without quoting it", async () => {
    const path = join(await freshDir(), "x.jsonl");
    await writeFile(path, "SECRET {not json\n");
    const error = await loadRecording(path).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/not a Parol recording/);
    expect((error as Error).message).not.toContain("SECRET");
  });

  it("says so for a file that is missing", async () => {
    await expect(loadRecording(join(fresh(), "none.jsonl"))).rejects.toThrow(
      /Cannot read the recording \(ENOENT\)/,
    );
  });

  it("reads a recording whose last line was cut off by a killed run, and has no trailer", async () => {
    const path = await write([call("a"), '{"key":"ee']);
    const loaded = await loadRecording(path);
    expect(loaded.size).toBe(1);
    expect(loaded.trailer).toBeNull();
  });

  it("refuses a recording with a damaged line in the middle", async () => {
    const path = await write([call("a"), "garbage", call("b")]);
    await expect(loadRecording(path)).rejects.toThrow(/line 3 is not a recorded call/);
  });

  it("refuses an empty file", async () => {
    const path = join(await freshDir(), "empty.jsonl");
    await writeFile(path, "");
    await expect(loadRecording(path)).rejects.toThrow(/it is empty/);
  });

  it("names its files after the results file", () => {
    expect(recordingPathFor("/x/parol-1.json")).toBe(`/x/parol-1${RECORDING_SUFFIX}`);
  });
});

describe("what a replay may be asked to do", () => {
  const recording = async (over: Partial<Pins> = {}) => {
    const path = join(fresh(), "r.responses.jsonl");
    await RecordingWriter.create(path, header(over));
    return loadRecording(path);
  };
  const ok = {
    workflowSha256: "a".repeat(64),
    workflowLabel: "v1",
    playbookSha256: "b".repeat(64),
  };

  it("allows the recorded workflow and playbook", async () => {
    expect(replayRefusal({ recording: await recording(), ...ok })).toBeNull();
  });

  it("refuses another workflow, and names the one to use", async () => {
    const refusal = replayRefusal({
      recording: await recording(),
      ...ok,
      workflowSha256: "f".repeat(64),
      workflowLabel: "v2",
    });
    expect(refusal).toMatch(/made with workflow v1/);
    expect(refusal).toMatch(/--workflow v1/);
  });

  it("refuses another version of the playbook", async () => {
    expect(
      replayRefusal({ recording: await recording(), ...ok, playbookSha256: "f".repeat(64) }),
    ).toMatch(/different version of the playbook/);
  });

  it("refuses a recording that is not of a live run", async () => {
    const refusal = replayRefusal({ recording: await recording({ mode: "selftest" }), ...ok });
    expect(refusal).toMatch(/not of a live run/);
  });
});

describe("a live run that records, and a replay of it", () => {
  const live = (resultsDir: string, extra: string[] = []) => {
    const stand = oracleFactory({
      usage: () => ({
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    });
    return {
      stand,
      go: () =>
        run(["--yes", "--case", "PAROL-D01", ...extra], {
          resultsDir,
          generatorFactory: stand.factory,
          clock: (() => {
            let t = 0;
            return () => (t += 5);
          })(),
        }),
    };
  };

  it("writes a recording beside the results, and a replay of it gives the same scores without a model", async () => {
    const resultsDir = fresh();
    const first = live(resultsDir);
    const done = await first.go();
    expect(done.code, done.stderr).toBe(0);
    const names = (await readdir(resultsDir)).sort();
    expect(names).toHaveLength(2);
    const resultsName = names.find((name) => name.endsWith(".json"))!;
    const recordingName = names.find((name) => name.endsWith(RECORDING_SUFFIX))!;
    expect(recordingName).toBe(`${resultsName.replace(/\.json$/, "")}${RECORDING_SUFFIX}`);
    expect(done.stderr).toContain("Model answers recorded to");

    const recorded = await readResults(join(resultsDir, resultsName));
    expect(recorded.mode).toBe("live");
    expect(recorded.recording).toMatchObject({ role: "recorded", file: recordingName, calls: 9 });

    // The recording holds a header, nine calls and a trailer, and it holds document text.
    const lines = (await readFile(join(resultsDir, recordingName), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(11);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ end: true, complete: true });

    // The replay needs no model: an unset factory would fail a live run, and the env has no key.
    const replayDir = fresh();
    const replayed = await run(
      ["--replay", join(resultsDir, recordingName), "--case", "PAROL-D01"],
      {
        resultsDir: replayDir,
        env: {},
      },
    );
    expect(replayed.code, replayed.stderr).toBe(0);
    expect(replayed.stdout).toContain("# Parol evaluation, REPLAY");
    expect(replayed.stdout).toContain("RECORDED FROM AN EARLIER LIVE RUN");
    expect(replayed.stderr).toContain("Answers replayed from the recording: 9");
    const [replayName] = await readdir(replayDir);
    const again = await readResults(join(replayDir, replayName!));
    expect(again.mode).toBe("replay");
    expect(again.pins.mode).toBe("replay");
    expect(again.pins.model.requested).toBe(recorded.pins.model.requested);
    expect(again.recording).toMatchObject({
      role: "replayed",
      file: recordingName,
      calls: 9,
      recordedResults: resultsName,
      datasetChanged: false,
    });
    // Same answers, same scores. Nothing that only a live run has is recorded.
    expect(again.sections[0]!.metrics!.summary).toEqual(recorded.sections[0]!.metrics!.summary);
    expect(again.runs[0]!.totalMs).toBeNull();
    expect(again.runs[0]!.usage).toBeNull();
    expect(again.runs[0]!.costUsd).toBeNull();
    expect(again.usage).toMatchObject({ available: false, total: null, costUsd: null });
    expect(again.sections[0]!.latency).toBeNull();
    expect(again.sections[0]!.cost).toBeNull();
    // A replay is not scripted, so its scores are not labelled as those of a stand-in.
    expect(again.selftest).toBe(false);
    expect(again.simulated).toBe(false);
    expect(replayed.stdout).not.toContain("NOT SCORES OF ANY MODEL");
  });

  it("writes nothing with --no-record", async () => {
    const resultsDir = fresh();
    const done = await live(resultsDir, ["--no-record"]).go();
    expect(done.code, done.stderr).toBe(0);
    const names = await readdir(resultsDir);
    expect(names.filter((name) => name.endsWith(RECORDING_SUFFIX))).toEqual([]);
    const [name] = names;
    expect((await readResults(join(resultsDir, name!))).recording).toBeNull();
  });

  it("stops at a case the recording does not hold, with nothing made up", async () => {
    const resultsDir = fresh();
    expect((await live(resultsDir).go()).code).toBe(0);
    const recordingName = (await readdir(resultsDir)).find((name) =>
      name.endsWith(RECORDING_SUFFIX),
    )!;
    const replayed = await run(
      ["--replay", join(resultsDir, recordingName), "--case", "PAROL-D03"],
      {
        resultsDir: fresh(),
        env: {},
      },
    );
    expect(replayed.code).toBe(1);
    expect(replayed.stderr).toContain("The recording has no answer for a request");
    expect(replayed.stderr).toContain("Nothing was sent");
  });

  it("refuses to replay with another workflow before it reads a single case", async () => {
    const resultsDir = fresh();
    expect((await live(resultsDir).go()).code).toBe(0);
    const recordingName = (await readdir(resultsDir)).find((name) =>
      name.endsWith(RECORDING_SUFFIX),
    )!;
    const replayed = await run(
      ["--replay", join(resultsDir, recordingName), "--workflow", "v2", "--case", "PAROL-D01"],
      { resultsDir: fresh(), env: {} },
    );
    expect(replayed.code).toBe(1);
    expect(replayed.stderr).toMatch(/made with workflow v1/);
    expect(replayed.stderr).toContain("Nothing was run");
  });

  it("will not mix --replay with --selftest, --simulate or --yes", async () => {
    for (const flag of ["--selftest", "--simulate", "--yes"]) {
      const out = await run(["--replay", "x.responses.jsonl", flag], {
        resultsDir: fresh(),
        env: {},
      });
      expect(out.code, flag).toBe(1);
      expect(out.stderr).toContain("pnpm eval:parol --help");
    }
  });

  it("refuses to compare a replay with a live run unless the mode difference is allowed", async () => {
    const resultsDir = fresh();
    expect((await live(resultsDir).go()).code).toBe(0);
    const names = await readdir(resultsDir);
    const resultsName = names.find((name) => name.endsWith(".json"))!;
    const recordingName = names.find((name) => name.endsWith(RECORDING_SUFFIX))!;
    const args = [
      "--replay",
      join(resultsDir, recordingName),
      "--case",
      "PAROL-D01",
      "--compare",
      join(resultsDir, resultsName),
    ];
    const refused = await run(args, { resultsDir: fresh(), env: {} });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/mode/);
    expect(refused.stderr).toContain("Nothing was sent");
  });
});
