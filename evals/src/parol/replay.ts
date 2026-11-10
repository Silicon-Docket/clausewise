/**
 * Record and replay of model responses (document 5, "Record and replay").
 *
 * A live run can write down every answer the model gave, keyed by a hash of the request, in a
 * recording next to its results file. A later run can read the recording back in place of the
 * model: no request is sent, no key is needed and nothing is spent, so a change to the scoring or
 * to a corrected answer key can be applied to the answers that were already paid for.
 *
 * What a replay is and is not:
 *  - It re-scores what the model said. It is not a new measurement of the model: the file it writes
 *    is labelled as a replay, it never counts as a repeat of the live run, and it records no
 *    latency and no cost, because none was incurred.
 *  - It needs the same prompts. A request is found by the hash of its system text and prompt, so a
 *    change to a prompt, the workflow, the retrieval policy, the playbook or the documents makes
 *    the request different and the replay stops at the first one it cannot find. It never makes up
 *    an answer and never falls through to a model.
 *  - A recording holds the text of the synthetic cases and what the model answered. It lives under
 *    evals/results/, which git ignores, beside the results file, which holds neither.
 *
 * Nothing here logs, or throws, the text of a prompt or an answer.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  ModelOutputError,
  ModelRefusalError,
  ModelRequestError,
  type GenerateObjectRequest,
  type ModelRequestKind,
  type ObjectGenerator,
} from "@clausewise/llm";
import { sha256Hex } from "../../../apps/parol/src/canonical.js";
import { EvalError } from "../errors.js";
import type { Pins } from "./results.js";

export const RECORDING_KIND = "parol-eval-recording" as const;
export const RECORDING_FORMAT = 1 as const;

/** The suffix of a recording, appended to the base name of its results file. */
export const RECORDING_SUFFIX = ".responses.jsonl";

export const recordingPathFor = (resultsPath: string): string =>
  `${resultsPath.replace(/\.json$/, "")}${RECORDING_SUFFIX}`;

// ---------------------------------------------------------------------------------------------
// The request key
// ---------------------------------------------------------------------------------------------

/**
 * What identifies a request: the name of its schema, its system text and its prompt. The shared
 * prefix is part of the prompt, and a signal is not part of the request. The key is a hash, so it
 * can be shown; it reveals nothing of the prompt.
 */
export function requestKey(request: {
  schemaName?: string | undefined;
  system: string;
  prompt: string;
}): string {
  return sha256Hex(JSON.stringify([request.schemaName ?? "", request.system, request.prompt]));
}

// ---------------------------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------------------------

export interface RecordingHeader {
  kind: typeof RECORDING_KIND;
  format: typeof RECORDING_FORMAT;
  recordedAt: string;
  /** The base name of the results file of the run that made it. */
  results: string;
  /** The pins of that run. A replay holds the workflow and the playbook to these. */
  pins: Pins;
}

/** What the model did with one request. Only these outcomes are kept: they are all a run can use. */
export type RecordedOutcome =
  | { outcome: "ok"; value: unknown }
  | { outcome: "refusal"; message: string; category: string | null }
  | { outcome: "output"; message: string; truncated: boolean }
  | {
      outcome: "request";
      message: string;
      status: number | null;
      kind: ModelRequestKind | null;
    };

export type RecordedCall = { key: string; schema: string } & RecordedOutcome;

const text = z.string().max(2_000_000);
const hexKey = z.string().regex(/^[0-9a-f]{64}$/);

const callSchema = z.discriminatedUnion("outcome", [
  z.object({
    key: hexKey,
    schema: z.string().max(200),
    outcome: z.literal("ok"),
    value: z.unknown(),
  }),
  z.object({
    key: hexKey,
    schema: z.string().max(200),
    outcome: z.literal("refusal"),
    message: text,
    category: z.string().max(200).nullable(),
  }),
  z.object({
    key: hexKey,
    schema: z.string().max(200),
    outcome: z.literal("output"),
    message: text,
    truncated: z.boolean(),
  }),
  z.object({
    key: hexKey,
    schema: z.string().max(200),
    outcome: z.literal("request"),
    message: text,
    status: z.number().int().nullable(),
    kind: z.string().max(80).nullable(),
  }),
]);

const headerSchema = z.object({
  kind: z.literal(RECORDING_KIND),
  format: z.literal(RECORDING_FORMAT),
  recordedAt: z.string().max(80),
  results: z.string().max(300),
  pins: z.custom<Pins>((value) => typeof value === "object" && value !== null),
});

/** The last line of a recording the run finished writing. A killed run leaves none. */
export interface RecordingTrailer {
  /** True when the run that wrote it finished every case it was asked to. */
  complete: boolean;
  /** The models the provider named in its responses, when it said. */
  reported: string[] | null;
}

const trailerSchema = z.object({
  end: z.literal(true),
  complete: z.boolean(),
  reported: z.array(z.string().max(200)).max(50).nullable(),
});

export interface Recording {
  header: RecordingHeader;
  /** Null when the run that wrote the recording did not get to write one. */
  trailer: RecordingTrailer | null;
  /** The calls by key, in the order they were made. */
  calls: Map<string, RecordedCall[]>;
  /** How many calls the file holds. */
  size: number;
}

/**
 * Reads a recording. The error says that the file is not a recording this version can read and
 * never repeats what a line held.
 */
export async function loadRecording(path: string): Promise<Recording> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new EvalError(
      `Cannot read the recording (${(error as NodeJS.ErrnoException).code ?? "an error"}). ` +
        "Give the file a live run wrote next to its results file, ending in " +
        `${RECORDING_SUFFIX}.`,
    );
  }
  const lines = source.split("\n").filter((line) => line.trim() !== "");
  const notRecording = (what: string): EvalError =>
    new EvalError(`The file is not a Parol recording this version can read (${what}).`);
  if (lines.length === 0) throw notRecording("it is empty");
  let header: RecordingHeader;
  try {
    const parsed = headerSchema.safeParse(JSON.parse(lines[0] as string));
    if (!parsed.success) throw new Error("header");
    header = parsed.data as RecordingHeader;
  } catch {
    throw notRecording("its first line is not a recording header");
  }
  const calls = new Map<string, RecordedCall[]>();
  let size = 0;
  let trailer: RecordingTrailer | null = null;
  for (const [index, line] of lines.slice(1).entries()) {
    let call: RecordedCall;
    try {
      const end = trailerSchema.safeParse(JSON.parse(line));
      if (end.success) {
        trailer = { complete: end.data.complete, reported: end.data.reported };
        continue;
      }
    } catch {
      // Not JSON at all: the call parser below deals with it the same way.
    }
    try {
      const parsed = callSchema.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error("line");
      call = parsed.data as RecordedCall;
    } catch {
      // A line cut off by a killed run is the last one. Anywhere else it is a damaged file.
      if (index === lines.length - 2) continue;
      throw notRecording(`line ${index + 2} is not a recorded call`);
    }
    const list = calls.get(call.key);
    if (list === undefined) calls.set(call.key, [call]);
    else list.push(call);
    size += 1;
  }
  return { header, trailer, calls, size };
}

// ---------------------------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------------------------

/** Appends calls to a recording, one line each, in the order they finish. */
export class RecordingWriter {
  private chain: Promise<void> = Promise.resolve();
  private failure: unknown;
  written = 0;

  private constructor(private readonly path: string) {}

  /** Creates the file with its header. It must not exist: a recording is never overwritten. */
  static async create(path: string, header: RecordingHeader): Promise<RecordingWriter> {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx" });
    return new RecordingWriter(path);
  }

  add(call: RecordedCall): void {
    const line = `${JSON.stringify(call)}\n`;
    this.written += 1;
    this.chain = this.chain
      .then(() => appendFile(this.path, line, "utf8"))
      .catch((error: unknown) => {
        this.failure ??= error;
      });
  }

  /** Writes the last line, which says whether the run finished and what the provider named. */
  finish(trailer: RecordingTrailer): void {
    const line = `${JSON.stringify({ end: true, ...trailer })}\n`;
    this.chain = this.chain
      .then(() => appendFile(this.path, line, "utf8"))
      .catch((error: unknown) => {
        this.failure ??= error;
      });
  }

  /** Waits for every line to be written. Throws if one could not be. */
  async settle(): Promise<void> {
    await this.chain;
    if (this.failure !== undefined) {
      throw new EvalError(
        `The recording could not be written (${(this.failure as NodeJS.ErrnoException).code ?? "an error"}). The run's results are not affected, but it cannot be replayed.`,
      );
    }
  }
}

/** Wraps a generator so that what it answers, or how it fails, is written to the recording. */
export function recordingGenerator(
  base: ObjectGenerator,
  writer: RecordingWriter,
): ObjectGenerator {
  return {
    provider: base.provider,
    model: base.model,
    disclosure: base.disclosure,
    ...(base.cachesSharedPrefix === undefined
      ? {}
      : { cachesSharedPrefix: base.cachesSharedPrefix }),
    ...(base.minCacheableChars === undefined ? {} : { minCacheableChars: base.minCacheableChars }),
    async generate<T>(request: GenerateObjectRequest<T>): Promise<T> {
      const key = requestKey(request);
      const schema = request.schemaName ?? "";
      try {
        const value = await base.generate(request);
        writer.add({ key, schema, outcome: "ok", value });
        return value;
      } catch (error) {
        // Failures a run can use are kept. A fatal provider error ends the run, an abort is not
        // an answer, and a bug is not the model's: none of those is recorded.
        if (error instanceof ModelRefusalError) {
          writer.add({
            key,
            schema,
            outcome: "refusal",
            message: error.message,
            category: error.category ?? null,
          });
        } else if (error instanceof ModelOutputError) {
          writer.add({
            key,
            schema,
            outcome: "output",
            message: error.message,
            truncated: error.truncated,
          });
        } else if (error instanceof ModelRequestError && !error.fatal) {
          writer.add({
            key,
            schema,
            outcome: "request",
            message: error.message,
            status: error.statusCode ?? null,
            kind: error.kind,
          });
        }
        throw error;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Replaying
// ---------------------------------------------------------------------------------------------

/** Raised when a request has no recorded answer. The run stops: nothing is sent and nothing is made up. */
export class ReplayMiss extends EvalError {
  override name = "ReplayMiss";
}

export interface ReplayCounts {
  /** Requests answered from the recording. */
  replayed: number;
}

/**
 * A generator that answers from a recording. A request whose answer is not there, or has already
 * been given as many times as it was recorded, stops the run with `ReplayMiss`. A recorded answer
 * is checked against the schema of the request that asks for it, so a schema that has changed
 * since the recording is a miss too, and not a wrong answer.
 */
export function replayGenerator(
  recording: Recording,
  options: { onMiss?: (miss: ReplayMiss) => void } = {},
): ObjectGenerator & { counts: ReplayCounts } {
  const given = new Map<string, number>();
  const counts: ReplayCounts = { replayed: 0 };
  const { pins } = recording.header;
  // The stages turn any error that is not an abort into a failed call, which is scored as an
  // undetermined finding. A request with no recorded answer must not be scored as if the model had
  // failed, so the caller is told, and ends the run by aborting it.
  const missed = (miss: ReplayMiss): ReplayMiss => {
    options.onMiss?.(miss);
    return miss;
  };
  return {
    provider: pins.model.provider,
    model: pins.model.requested,
    disclosure: "a recording of an earlier run, so that no request is sent anywhere",
    counts,
    async generate<T>(request: GenerateObjectRequest<T>): Promise<T> {
      request.signal?.throwIfAborted();
      const key = requestKey(request);
      const list = recording.calls.get(key);
      const used = given.get(key) ?? 0;
      const call = list?.[used];
      const stage = request.schemaName ?? "a stage";
      if (call === undefined) {
        throw missed(
          new ReplayMiss(
            `The recording has no answer for a request of ${/^[\w.-]{1,60}$/.test(stage) ? stage : "a stage"} ` +
              `(request ${key.slice(0, 12)}${used > 0 ? `, asked ${used + 1} times against ${used} recorded` : ""}). ` +
              "A replay re-scores recorded answers and cannot make new ones: the prompts, the workflow, " +
              "the playbook or the documents differ from the run that was recorded. Nothing was sent.",
          ),
        );
      }
      given.set(key, used + 1);
      counts.replayed += 1;
      switch (call.outcome) {
        case "ok": {
          const parsed = request.schema.safeParse(call.value);
          if (!parsed.success) {
            throw missed(
              new ReplayMiss(
                `A recorded answer (request ${key.slice(0, 12)}) no longer fits the schema of the request that asks for it, so the schema has changed since the recording. Nothing was sent.`,
              ),
            );
          }
          return parsed.data;
        }
        case "refusal":
          throw new ModelRefusalError(call.message, call.category ?? undefined);
        case "output":
          throw new ModelOutputError(call.message, call.truncated);
        case "request":
          throw new ModelRequestError(
            call.message,
            call.status ?? undefined,
            false,
            (call.kind ?? undefined) as ModelRequestKind | undefined,
          );
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// What a replay may be asked to do
// ---------------------------------------------------------------------------------------------

/**
 * Why a recording cannot stand in for the run that was asked for, or null. The workflow and the
 * playbook are what the prompts are made of, so they must be the recorded ones. The dataset may
 * differ: re-scoring against a corrected answer key is what a replay is for, and a changed
 * document makes a request that is not in the recording, which the replay reports when it meets it.
 */
export function replayRefusal(args: {
  recording: Recording;
  workflowSha256: string;
  workflowLabel: string;
  playbookSha256: string;
}): string | null {
  const { pins } = args.recording.header;
  if (pins.mode !== "live") {
    return "The recording is not of a live run, so it holds no model answers.";
  }
  if (pins.workflow.sha256 !== args.workflowSha256) {
    return (
      `The recording was made with workflow ${pins.workflow.label}, and this run is of ` +
      `${args.workflowLabel}. Their prompts or checks differ, so no request would be found. ` +
      `Replay with --workflow ${pins.workflow.label}.`
    );
  }
  if (pins.playbook.sha256 !== args.playbookSha256) {
    return "The recording was made with a different version of the playbook, so no request would be found.";
  }
  return null;
}
