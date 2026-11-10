import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ObjectGenerator } from "@clausewise/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { WORKFLOWS } from "../../apps/parol/src/prompts/workflows.js";
import { isAbortError } from "../../apps/parol/src/stages/analyze-call.js";
import { EvalError } from "../src/errors.js";
import {
  RECORDING_FORMAT,
  RECORDING_KIND,
  RECORDING_SUFFIX,
  RecordingWriter,
  loadRecording,
  recordingGenerator,
  recordingPathFor,
  replayGenerator,
  replayRefusal,
  type RecordedCall,
  type RecordingHeader,
} from "../src/parol/replay.js";
import { parseResults, serialiseResults, type Pins } from "../src/parol/results.js";
import {
  makeTempDir,
  oracleFactory,
  readResults,
  removeDir,
  run,
} from "../src/parol/testing-run.js";

/**
 * Second review of the record and replay path: what the recording, the results file and the
 * held-out ledger say after a run that was interrupted, that lost a call, or whose recording could
 * not be written. Every answer here comes from the scripted key oracle or a script of this file:
 * no model produced any of it, and nothing is sent anywhere.
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

const LEDGER = "parol-heldout-runs.jsonl";
const hex = (c: string): string => c.repeat(64);
const recordingsIn = async (folder: string): Promise<string[]> =>
  (await readdir(folder)).filter((name) => name.endsWith(RECORDING_SUFFIX));
const lastLine = async (path: string): Promise<unknown> =>
  JSON.parse((await readFile(path, "utf8")).trim().split("\n").at(-1)!);

/** Wraps a factory so that exactly one call, counted from 1 over the whole run, is made to throw. */
const failingOnce = (
  stand: ReturnType<typeof oracleFactory>,
  at: number,
  error: unknown,
): ReturnType<typeof oracleFactory>["factory"] => {
  let calls = 0;
  return (request) => {
    const inner = stand.factory(request);
    return {
      ...inner,
      generate: (call) => {
        calls += 1;
        return calls === at ? Promise.reject(error) : inner.generate(call);
      },
    };
  };
};

const pins = (over: Partial<Pins> = {}): Pins => ({
  dataset: { label: "x", answerKeysSha256: hex("c"), splitsFileSha256: hex("d"), splits: {} },
  split: "dev",
  cases: [],
  playbook: { slug: "p", version: "1", sha256: hex("b") },
  workflow: {
    label: "v1",
    sha256: hex("a"),
    retrieval: "R1",
    checks: [],
    budgetTokens: 1000,
    repairAttempts: 1,
    prompts: {
      extract: { id: "extract.p1", sha256: hex("1") },
      analyze: { id: "analyze.p1", sha256: hex("2") },
      support: null,
    },
  },
  model: {
    provider: "anthropic",
    requested: "a-model",
    endpoint: "api.example.test",
    reported: null,
    reportedNote: "",
  },
  generation: null,
  prices: null,
  evaluation: { label: "e", sha256: hex("e") },
  code: { commit: null, dirty: null },
  repeats: 1,
  mode: "live",
  ...over,
});
const header = (over: Partial<Pins> = {}): RecordingHeader => ({
  kind: RECORDING_KIND,
  format: RECORDING_FORMAT,
  recordedAt: "2026-11-10T00:00:00.000Z",
  results: "parol-x.json",
  pins: pins(over),
});

const Answer = z.object({ word: z.string() });
const scripted = (respond: () => unknown): ObjectGenerator => ({
  provider: "anthropic",
  model: "a-model",
  disclosure: "a scripted stand-in",
  async generate(request) {
    const out = respond();
    if (out instanceof Error) throw out;
    return request.schema.parse(out);
  },
});
const ask = (generator: ObjectGenerator, prompt = "q") =>
  generator.generate({ system: "sys", prompt, schema: Answer, schemaName: "Answer" });

describe("a held-out live run that does not get to its first call", () => {
  const heldout = ["--yes", "--split", "heldout", "--allow-heldout", "--case", "PAROL-H01"];

  it("writes no ledger line and no recording when its exposure suites are interrupted", async () => {
    const resultsDir = await freshDir();
    const controller = new AbortController();
    const stand = oracleFactory({});
    let stderr = "";
    const out = await run([...heldout, "--exposure"], {
      resultsDir,
      signal: controller.signal,
      generatorFactory: stand.factory,
      stderr: (text) => {
        stderr += text;
        if (text.includes("Running the exposure suites")) controller.abort();
      },
    });
    expect(out.code, stderr).toBe(130);
    expect(stand.calls()).toBe(0);
    // A ledger line says the split was shown to a model. It was not, so there is none.
    expect(await readdir(resultsDir)).toEqual([]);
  }, 30_000);

  it("writes no ledger line and leaves no recording when it was interrupted before it started", async () => {
    const resultsDir = await freshDir();
    const stand = oracleFactory({});
    const out = await run(heldout, {
      resultsDir,
      signal: AbortSignal.abort(),
      generatorFactory: stand.factory,
    });
    expect(out.code, out.stderr).toBe(130);
    expect(stand.calls()).toBe(0);
    expect(await readdir(resultsDir)).toEqual([]);
    expect(out.stderr).not.toContain("Replay them");
  });

  it("lets the same --out be used again after a dev run was interrupted before it started", async () => {
    const resultsDir = await freshDir();
    const out = join(resultsDir, "o.json");
    const args = ["--yes", "--case", "PAROL-D01", "--out", out];
    const first = await run(args, {
      resultsDir,
      signal: AbortSignal.abort(),
      generatorFactory: oracleFactory({}).factory,
    });
    expect(first.code).toBe(130);
    expect(await readdir(resultsDir)).toEqual([]);
    const second = await run(args, { resultsDir, generatorFactory: oracleFactory({}).factory });
    expect(second.code, second.stderr).toBe(0);
  });

  it("keeps the ledger line but not the recording when it stops after the ledger and before any call", async () => {
    const resultsDir = await freshDir();
    const controller = new AbortController();
    const out = await run(heldout, {
      resultsDir,
      signal: controller.signal,
      // Called for the first case, after the recording and the ledger line, and before any call.
      generatorFactory: () => {
        controller.abort();
        throw new Error("stop");
      },
    });
    expect(out.code, out.stderr).toBe(130);
    // A request may already have left in a run that got this far, so the ledger keeps its line.
    expect((await readFile(join(resultsDir, LEDGER), "utf8")).trim().split("\n")).toHaveLength(1);
    // The recording holds a header and a trailer and no call: it is no use and is not kept.
    expect(await recordingsIn(resultsDir)).toEqual([]);
    expect(out.stderr).toContain("Nothing was recorded: the run stopped before its first call.");
    expect(out.stderr).not.toContain("Replay them");
    expect(await readdir(resultsDir)).toEqual([LEDGER]);
  });

  it("leaves no recording when the ledger cannot be written", async () => {
    const resultsDir = await freshDir();
    // The ledger path is a directory, so the line cannot be appended.
    await mkdir(join(resultsDir, LEDGER));
    const stand = oracleFactory({});
    const out = await run(heldout, { resultsDir, generatorFactory: stand.factory });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("Refusing to run the held-out split");
    expect(stand.calls()).toBe(0);
    expect(await recordingsIn(resultsDir)).toEqual([]);
  });
});

describe("a recording that could not be completed, as the results and the report say it", () => {
  it("says so in stderr, the results and the report when a line could not be written", async () => {
    const resultsDir = await freshDir();
    const out = join(resultsDir, "o.json");
    const recording = recordingPathFor(out);
    const stand = oracleFactory({});
    let swapped = false;
    const result = await run(["--yes", "--case", "PAROL-D01", "--out", out], {
      resultsDir,
      generatorFactory: (request) => {
        const inner = stand.factory(request);
        return {
          ...inner,
          async generate(call) {
            // The recording is replaced by a directory before its first line is appended.
            if (!swapped) {
              swapped = true;
              await rm(recording);
              await mkdir(recording);
            }
            return inner.generate(call);
          },
        };
      },
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain("could not be completed");
    expect(result.stderr).not.toContain("Replay them with --replay");
    const file = await readResults(out);
    expect(file.recording).toEqual({
      role: "recorded",
      file: "o.responses.jsonl",
      calls: 0,
      failed: true,
    });
    expect(file.notes.join(" ")).toContain("could not be written");
    expect(result.stdout).toContain("could not be recorded completely");
    expect(result.stdout).not.toContain("Replay them with --replay");
  });

  it("says so when a call the run scored has no line, and a replay of it stops at the call", async () => {
    const resultsDir = await freshDir();
    const stand = oracleFactory({});
    // The fourth call fails with an error that is neither the model's nor an abort: a bug.
    const result = await run(["--yes", "--case", "PAROL-D01"], {
      resultsDir,
      generatorFactory: failingOnce(stand, 4, new TypeError("a bug")),
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain("1 call could not be recorded, so a replay will stop at it.");
    expect(result.stderr).not.toContain("Replay them with --replay");
    const [recordingName] = await recordingsIn(resultsDir);
    const resultsName = (await readdir(resultsDir)).find((name) => name.endsWith(".json"))!;
    const file = await readResults(join(resultsDir, resultsName));
    // Eight of the nine calls have a line, and the file is not one to replay.
    expect(file.recording).toMatchObject({ role: "recorded", calls: 8, failed: true });
    expect(result.stdout).toContain("could not be recorded completely (8 calls written");
    expect(result.stdout).not.toContain("Replay them with --replay");
    expect(await lastLine(join(resultsDir, recordingName!))).toMatchObject({
      end: true,
      complete: false,
    });

    const replayDir = fresh();
    const replayed = await run(
      ["--replay", join(resultsDir, recordingName!), "--case", "PAROL-D01"],
      {
        resultsDir: replayDir,
        env: {},
      },
    );
    expect(replayed.code).toBe(1);
    expect(replayed.stderr).toContain("The recording has no answer for a request");
    // The run finished and lost a call: the message does not claim only that it did not finish.
    expect(replayed.stderr).toContain("lost a call it could not record");
    const [replayName] = await readdir(replayDir);
    const again = await readResults(join(replayDir, replayName!));
    expect(again.notes.join(" ")).toContain("lost a call it could not record");
  });

  it("counts a call that timed out in the generator as one the recording lacks", async () => {
    const path = join(fresh(), "r.responses.jsonl");
    await mkdir(join(path, ".."), { recursive: true });
    const writer = await RecordingWriter.create(path, header());
    // Not an abort: the stages score it as a failed call, so the recording must not be called complete.
    const timeout = new DOMException("timed out", "TimeoutError");
    await expect(
      ask(
        recordingGenerator(
          scripted(() => timeout),
          writer,
        ),
      ),
    ).rejects.toBe(timeout);
    writer.finish({ complete: true, reported: null });
    await writer.settle();
    expect(writer.unrecorded).toBe(1);
    expect((await loadRecording(path)).trailer).toEqual({ complete: false, reported: null });
  });

  it("decides what an abort is the way the stages do", async () => {
    const path = join(fresh(), "r.responses.jsonl");
    await mkdir(join(path, ".."), { recursive: true });
    const writer = await RecordingWriter.create(path, header());
    const errors: unknown[] = [
      new DOMException("aborted", "AbortError"),
      new DOMException("timed out", "TimeoutError"),
      new TypeError("a bug"),
      Object.assign(new Error("named like an abort"), { name: "AbortError" }),
      { name: "AbortError" },
    ];
    for (const error of errors) {
      const before = writer.unrecorded;
      const throwing: ObjectGenerator = {
        ...scripted(() => ({ word: "x" })),
        generate: () => Promise.reject(error),
      };
      await expect(ask(recordingGenerator(throwing, writer))).rejects.toBe(error);
      // An error the stages treat as an abort is not a lost call, and any other one is.
      expect(writer.unrecorded - before, JSON.stringify(error)).toBe(isAbortError(error) ? 0 : 1);
    }
  });
});

describe("a replay of a recording that was cut short", () => {
  const recordLive = async (extra: string[] = [], gitCommit = "a".repeat(40)) => {
    const resultsDir = await freshDir();
    const result = await run(["--yes", "--case", "PAROL-D01", ...extra], {
      resultsDir,
      generatorFactory: oracleFactory({}).factory,
      gitInfo: async () => ({ commit: gitCommit, dirty: false }),
    });
    expect(result.code, result.stderr).toBe(0);
    const [name] = await recordingsIn(resultsDir);
    return join(resultsDir, name!);
  };

  it("counts the answers it gave and not the request it had no answer for", async () => {
    const recording = await recordLive();
    const replayDir = fresh();
    const replayed = await run(
      ["--replay", recording, "--case", "PAROL-D01", "--case", "PAROL-D03"],
      { resultsDir: replayDir, env: {} },
    );
    expect(replayed.code).toBe(1);
    expect(replayed.stderr).toContain("Answers replayed from the recording: 9.");
    const [name] = await readdir(replayDir);
    const file = await readResults(join(replayDir, name!));
    // The ninth answer of PAROL-D01 is the last one given. The request of PAROL-D03 that was
    // missing is not an answer, and is not in the count.
    expect(file.usage.calls).toBe(9);
    expect(file.recording).toMatchObject({ role: "replayed", calls: 9 });
  });

  it("says the recording did not finish, and at which commit it was made", async () => {
    const recording = await recordLive();
    // A killed run leaves no trailer.
    const lines = (await readFile(recording, "utf8")).trimEnd().split("\n");
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ end: true });
    await writeFile(recording, `${lines.slice(0, -1).join("\n")}\n`);

    const replayDir = fresh();
    const replayed = await run(["--replay", recording, "--case", "PAROL-D01"], {
      resultsDir: replayDir,
      env: {},
      gitInfo: async () => ({ commit: "b".repeat(40), dirty: false }),
    });
    expect(replayed.code, replayed.stderr).toBe(0);
    const [name] = await readdir(replayDir);
    const notes = (await readResults(join(replayDir, name!))).notes.join(" ");
    expect(notes).toContain("did not finish");
    expect(notes).toContain(
      `The recording was made at commit ${"a".repeat(12)} and this replay is scored at ${"b".repeat(12)}.`,
    );
  });

  it("does not answer a request after the run was aborted", async () => {
    const path = join(fresh(), "r.responses.jsonl");
    await mkdir(join(path, ".."), { recursive: true });
    const writer = await RecordingWriter.create(path, header());
    await ask(
      recordingGenerator(
        scripted(() => ({ word: "x" })),
        writer,
      ),
    );
    writer.finish({ complete: true, reported: null });
    await writer.settle();
    const replay = replayGenerator(await loadRecording(path));
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      replay.generate({
        system: "sys",
        prompt: "q",
        schema: Answer,
        schemaName: "Answer",
        signal: controller.signal,
      }),
    ).rejects.toThrow("stop");
    expect(replay.counts.replayed).toBe(0);
  });
});

describe("the writer after a line that could not be written", () => {
  const call = (index: number): RecordedCall => ({
    key: hex("e"),
    schema: "Answer",
    run: "",
    n: index,
    outcome: "ok",
    value: { word: "x" },
  });

  it("writes no later line and no trailer, so the file reads as unfinished and not as one with a hole", async () => {
    const folder = await freshDir();
    const path = join(folder, "r.responses.jsonl");
    const writer = await RecordingWriter.create(path, header());
    // The path becomes a directory for the first line and a file again for the ones after it.
    const kept = await readFile(path, "utf8");
    await rm(path);
    await mkdir(path);
    writer.add(call(0));
    await expect(writer.settle()).rejects.toThrow(/could not be written/);
    await rm(path, { recursive: true });
    await writeFile(path, kept);

    writer.add(call(1));
    writer.finish({ complete: true, reported: null });
    await expect(writer.settle()).rejects.toThrow(/could not be written/);
    expect(writer.written).toBe(0);
    expect(writer.failed).toBe(true);
    // The file is the header and nothing else: no call after the gap and no end line.
    expect(await readFile(path, "utf8")).toBe(kept);
    const loaded = await loadRecording(path);
    expect(loaded.size).toBe(0);
    expect(loaded.trailer).toBeNull();
  });
});

describe("a recording header or a results file with a hostile workflow label", () => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const hostile = `v9${ESC}[2J${ESC}[1;31mFAKE: no held-out run was made${BEL}`;

  it("is not a recording this version can read, and the label is not repeated", async () => {
    const resultsDir = await freshDir();
    const made = await run(["--yes", "--case", "PAROL-D01"], {
      resultsDir,
      generatorFactory: oracleFactory({}).factory,
    });
    expect(made.code, made.stderr).toBe(0);
    const [name] = await recordingsIn(resultsDir);
    const path = join(resultsDir, name!);
    const lines = (await readFile(path, "utf8")).split("\n");
    const edited = JSON.parse(lines[0]!) as RecordingHeader;
    edited.pins.workflow.label = hostile;
    edited.pins.workflow.sha256 = "f".repeat(64);
    lines[0] = JSON.stringify(edited);
    await writeFile(path, lines.join("\n"));

    const replayed = await run(["--replay", path, "--case", "PAROL-D01"], {
      resultsDir: fresh(),
      env: {},
    });
    expect(replayed.code).toBe(1);
    expect(replayed.stderr).toContain("not a Parol recording this version can read");
    expect(replayed.stderr).not.toMatch(/\u001b|\u0007/);
    expect(replayed.stderr).not.toContain("FAKE");
    expect(replayed.stderr).not.toContain("--workflow");
  });

  it("is refused by the reader of a results file too", async () => {
    const resultsDir = await freshDir();
    const made = await run(["--selftest", "--case", "PAROL-D01"], { resultsDir });
    expect(made.code, made.stderr).toBe(0);
    const [name] = await readdir(resultsDir);
    const file = await readResults(join(resultsDir, name!));
    for (const label of [hostile, "has a space", "x".repeat(65), "", "-v1"]) {
      const edited = JSON.parse(serialiseResults(file)) as { pins: Pins };
      edited.pins.workflow.label = label;
      expect(() => parseResults(JSON.stringify(edited)), JSON.stringify(label)).toThrow(
        /pins\.workflow\.label/,
      );
    }
    for (const label of ["v1", "v3", "wf-2.0_rc1"]) {
      const edited = JSON.parse(serialiseResults(file)) as { pins: Pins };
      edited.pins.workflow.label = label;
      expect(parseResults(JSON.stringify(edited)).pins.workflow.label).toBe(label);
    }
  });

  it("is not repeated by the refusal of a recording that got past the reader", async () => {
    const path = join(await freshDir(), "r.responses.jsonl");
    await RecordingWriter.create(path, header());
    const recording = await loadRecording(path);
    // The reader would refuse this header. The refusal must not depend on that alone.
    recording.header.pins.workflow.label = hostile;
    recording.header.pins.workflow.sha256 = hex("f");
    const refusal = replayRefusal({
      recording,
      workflowSha256: hex("a"),
      workflowLabel: "v1",
      playbookSha256: hex("b"),
      prompts: pins().workflow.prompts,
    })!;
    expect(refusal).not.toMatch(/\u001b|\u0007/);
    expect(refusal).not.toContain("FAKE");
    // And it does not offer the label as a command to run.
    expect(refusal).not.toContain("--workflow");
  });

  it("offers a registered workflow by name only under the hash it has, and another label only as a label", async () => {
    // `sha` is the hash the recording says its workflow had; `label` is the run that is refused.
    const make = async (label: string, sha: string, runOf = "v2") => {
      const path = join(await freshDir(), "r.responses.jsonl");
      await RecordingWriter.create(path, header());
      const recording = await loadRecording(path);
      recording.header.pins.workflow.label = label;
      recording.header.pins.workflow.sha256 = sha;
      return replayRefusal({
        recording,
        workflowSha256: hex("a"),
        workflowLabel: runOf,
        playbookSha256: hex("b"),
        prompts: pins().workflow.prompts,
      })!;
    };
    // The recorded hash is the one this code has for v1: the option is a command that would work.
    expect(await make("v1", WORKFLOWS.v1!.sha256)).toMatch(
      /made with workflow v1.*Replay with --workflow v1\./,
    );
    // A registered label with another hash is not the recorded workflow, and naming it as the
    // option would be the advice to run what was just refused. Neither is it for the run's own label.
    for (const [label, runOf] of [
      ["v1", "v2"],
      ["v2", "v2"],
    ] as const) {
      const changed = await make(label, hex("f"), runOf);
      expect(changed).toContain(`made with workflow ${label}`);
      expect(changed).not.toContain("--workflow");
      expect(changed).toContain(`This code's workflow ${label} is not the recorded definition.`);
      expect(changed).toContain("Replay with the code the recording was made with.");
    }
    // The run's own label is never offered back to it, whatever the hash.
    expect(await make("v1", WORKFLOWS.v1!.sha256, "v1")).not.toContain("Replay with --workflow");
    const unknown = await make("v9", hex("f"));
    expect(unknown).toContain("made with workflow v9");
    expect(unknown).not.toContain("Replay with --workflow");
    expect(unknown).toContain("No workflow this code knows matches the recording.");
    // A label that reads like a secret is withheld, as every name from a file is.
    const secretLike = await make("keyed-1", hex("f"));
    expect(secretLike).not.toContain("keyed-1");
    expect(secretLike).not.toContain("--workflow");
  });
});

describe("a results file that this version cannot read back", () => {
  it("is kept, and the run says it is too long for its own reader and does not exit 0", async () => {
    const resultsDir = await freshDir();
    const out = join(resultsDir, "o.json");
    const stand = oracleFactory({});
    // The second case cannot start: the error that ends the run is longer than the results file
    // holds for the reason a run stopped. The first case is finished and on record.
    const long = `A made-up failure that goes on. ${"x".repeat(2500)}`;
    const result = await run(
      ["--yes", "--case", "PAROL-D01", "--case", "PAROL-D03", "--out", out],
      {
        resultsDir,
        generatorFactory: (request) => {
          if (request.prepared.runnable.caseKey === "PAROL-D03") throw new EvalError(long);
          return stand.factory(request);
        },
      },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Results written to");
    expect(result.stderr).toContain("too long or malformed for its own reader");
    expect(result.stderr).toContain("The file was kept as written.");
    // The evidence of the run is on disk, as valid JSON, and this version cannot parse it.
    const source = await readFile(out, "utf8");
    const raw = JSON.parse(source) as { stoppedBecause: string; runs: unknown[] };
    expect(raw.stoppedBecause.length).toBeGreaterThan(2000);
    expect(raw.runs).toHaveLength(1);
    expect(() => parseResults(source)).toThrow(/stoppedBecause/);
    // The report is still printed.
    expect(result.stdout).toContain("# Parol evaluation");
  });

  it("says nothing of the kind about a file it can read", async () => {
    const resultsDir = await freshDir();
    const result = await run(["--yes", "--case", "PAROL-D01"], {
      resultsDir,
      generatorFactory: oracleFactory({}).factory,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("for its own reader");
  });
});
