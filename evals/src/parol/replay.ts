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
 *  - It needs the same prompts. A request is found by the run that asked it (a case and a repeat,
 *    or the calibration set), the hash of its schema name, its schema, its system text and its
 *    prompt, and its place among the identical requests of that run. A change to a prompt, a
 *    schema, the workflow, the retrieval policy, the playbook or the documents makes the request
 *    different and the replay stops at the first one it cannot find. It never makes up an answer,
 *    never hands a run the answer that was recorded for another run, and never falls through to a
 *    model.
 *  - A recording holds the text of the synthetic cases and what the model answered. It is written
 *    beside the results file, so it is in the git-ignored evals/results/ only when the results
 *    are; the repository ignores every file ending in ${RECORDING_SUFFIX} wherever it is.
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
import { isAbortError } from "../../../apps/parol/src/stages/analyze-call.js";
import { WORKFLOWS } from "../../../apps/parol/src/prompts/workflows.js";
import { EvalError, shown } from "../errors.js";
import { pinsSchema, type Pins } from "./results.js";

export const RECORDING_KIND = "parol-eval-recording" as const;
/** 2: every call names the run that made it and its place among that run's identical requests. */
export const RECORDING_FORMAT = 2 as const;

/** The suffix of a recording, appended to the base name of its results file. */
export const RECORDING_SUFFIX = ".responses.jsonl";

/** The run id of the calibration set: its calls belong to no case. */
export const CALIBRATION_RUN = "calibration";

export const recordingPathFor = (resultsPath: string): string =>
  `${resultsPath.replace(/\.json$/, "")}${RECORDING_SUFFIX}`;

// ---------------------------------------------------------------------------------------------
// The request key
// ---------------------------------------------------------------------------------------------

const fingerprints = new WeakMap<object, string>();

/**
 * A hash of the schema a request asks the model to answer under. The live adapter sends it to the
 * provider as the output format, and the prompt registry counts a changed field description as a
 * changed prompt, so a replay must too: an answer given under another schema is not an answer to
 * this request.
 */
function schemaFingerprint(schema: z.ZodType | undefined): string {
  if (schema === undefined) return "";
  const known = fingerprints.get(schema);
  if (known !== undefined) return known;
  let fingerprint: string;
  try {
    fingerprint = sha256Hex(JSON.stringify(z.toJSONSchema(schema, { unrepresentable: "any" })));
  } catch {
    fingerprint = "a schema that cannot be written as JSON schema";
  }
  fingerprints.set(schema, fingerprint);
  return fingerprint;
}

/**
 * What identifies a request: the name of its schema, the schema, its system text and its prompt.
 * The shared prefix is part of the prompt, and a signal is not part of the request. The key is a
 * hash, so it can be shown; it reveals nothing of the prompt.
 */
export function requestKey(request: {
  schemaName?: string | undefined;
  schema?: z.ZodType | undefined;
  system: string;
  prompt: string;
}): string {
  return sha256Hex(
    JSON.stringify([
      request.schemaName ?? "",
      schemaFingerprint(request.schema),
      request.system,
      request.prompt,
    ]),
  );
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

/**
 * One call. `run` names the run that made it (a case and a repeat, or the calibration set) and `n`
 * is its place among the calls of that run with the same key, counted when the request started and
 * not when it finished, so two identical requests in flight together keep their own answers.
 */
export type RecordedCall = {
  key: string;
  schema: string;
  run: string;
  n: number;
} & RecordedOutcome;

const text = z.string().max(2_000_000);
const hexKey = z.string().regex(/^[0-9a-f]{64}$/);
const callBase = {
  key: hexKey,
  schema: z.string().max(200),
  run: z.string().max(300),
  n: z.number().int().nonnegative(),
};

const callSchema = z.discriminatedUnion("outcome", [
  z.object({ ...callBase, outcome: z.literal("ok"), value: z.unknown() }),
  z.object({
    ...callBase,
    outcome: z.literal("refusal"),
    message: text,
    category: z.string().max(200).nullable(),
  }),
  z.object({
    ...callBase,
    outcome: z.literal("output"),
    message: text,
    truncated: z.boolean(),
  }),
  z.object({
    ...callBase,
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
  // The same schema a results file checks its pins with: every field a replay reads is there, and
  // every string is bounded, so a replay cannot copy into its results what the tool cannot read back.
  pins: pinsSchema,
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
  /** The calls by run, key and place among that run's identical requests: see `callId`. */
  calls: Map<string, RecordedCall>;
  /** How many calls the file holds. */
  size: number;
}

const callId = (run: string, key: string, n: number): string => `${run}\u0000${key}\u0000${n}`;

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
  const calls = new Map<string, RecordedCall>();
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
    const id = callId(call.run, call.key, call.n);
    // A call recorded twice under one place is a damaged file: which of the two answered is unknown.
    if (calls.has(id)) throw notRecording(`line ${index + 2} repeats a recorded call`);
    calls.set(id, call);
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
  /** Calls whose line was appended: counted after the append succeeded, never before. */
  written = 0;
  /**
   * Calls the run scored that the recording does not hold: an error that is neither an answer of
   * the model nor an abort, such as a bug. A recording with any of them is not complete, because
   * replaying it would stop at the call that is missing.
   */
  unrecorded = 0;

  private constructor(private readonly path: string) {}

  /** Creates the file with its header. It must not exist: a recording is never overwritten. */
  static async create(path: string, header: RecordingHeader): Promise<RecordingWriter> {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx" });
    return new RecordingWriter(path);
  }

  /** True when a line could not be written, so the file cannot be replayed. */
  get failed(): boolean {
    return this.failure !== undefined;
  }

  add(call: RecordedCall): void {
    const line = `${JSON.stringify(call)}\n`;
    this.chain = this.chain
      .then(async () => {
        // Checked here and not above: the failure of an earlier line is only known once it has
        // happened, which is after this call was handed in.
        if (this.failure !== undefined) return;
        await appendFile(this.path, line, "utf8");
        this.written += 1;
      })
      .catch((error: unknown) => {
        this.failure ??= error;
      });
  }

  /** Notes a call that was scored and could not be recorded. */
  noteUnrecorded(): void {
    this.unrecorded += 1;
  }

  /** Writes the last line, which says whether the run finished and what the provider named. */
  finish(trailer: RecordingTrailer): void {
    // A line that failed leaves a gap; later lines (see `add`) and the trailer are not written
    // after it, so the file is cut short and reads as an unfinished run and not as a complete one
    // with holes.
    const line = `${JSON.stringify({ end: true, ...trailer, complete: trailer.complete && this.unrecorded === 0 })}\n`;
    this.chain = this.chain
      .then(() => (this.failure === undefined ? appendFile(this.path, line, "utf8") : undefined))
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

/**
 * Wraps a generator so that what it answers, or how it fails, is written to the recording. `run`
 * names the run whose calls these are: give each run its own wrapper, so that the recording can
 * hand a run the answers it was given and not those of another run that asked the same thing.
 */
export function recordingGenerator(
  base: ObjectGenerator,
  writer: RecordingWriter,
  run = "",
): ObjectGenerator {
  // Counted when a request starts, so that two identical requests in flight together are told
  // apart by the order they were asked in, which does not depend on which finishes first.
  const asked = new Map<string, number>();
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
      const n = asked.get(key) ?? 0;
      asked.set(key, n + 1);
      const place = { key, schema, run, n };
      try {
        const value = await base.generate(request);
        writer.add({ ...place, outcome: "ok", value });
        return value;
      } catch (error) {
        // Failures a run can use are kept. A fatal provider error ends the run, an abort is not
        // an answer, and a bug is not the model's: none of those is recorded.
        if (error instanceof ModelRefusalError) {
          writer.add({
            ...place,
            outcome: "refusal",
            message: error.message,
            category: error.category ?? null,
          });
        } else if (error instanceof ModelOutputError) {
          writer.add({
            ...place,
            outcome: "output",
            message: error.message,
            truncated: error.truncated,
          });
        } else if (error instanceof ModelRequestError && !error.fatal) {
          writer.add({
            ...place,
            outcome: "request",
            message: error.message,
            status: error.statusCode ?? null,
            kind: error.kind,
          });
        } else if (
          !(error instanceof ModelRequestError) &&
          request.signal?.aborted !== true &&
          !isAbortError(error)
        ) {
          // The stages score this as a failed call, and the recording has no line for it.
          writer.noteUnrecorded();
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
  /** Requests answered from the recording, not counting a request that was a miss. */
  replayed: number;
}

export interface ReplayGenerator extends ObjectGenerator {
  counts: ReplayCounts;
  /**
   * The generator of one run. It hands out the answers recorded for that run and no other, in the
   * order the run asked its identical requests, whatever else was asked in the meantime. The same
   * `run` string given to `recordingGenerator` made them.
   */
  forRun(run: string): ObjectGenerator;
}

/**
 * A generator that answers from a recording. A request whose answer is not there, or has already
 * been given as many times as it was recorded, stops the run with `ReplayMiss`. A recorded answer
 * is checked against the schema of the request that asks for it, and the schema is part of the
 * request key, so a schema that has changed since the recording is a miss too, and not a wrong
 * answer.
 */
export function replayGenerator(
  recording: Recording,
  options: { onMiss?: (miss: ReplayMiss) => void } = {},
): ReplayGenerator {
  const counts: ReplayCounts = { replayed: 0 };
  const { pins } = recording.header;
  const unfinished = recording.trailer === null || !recording.trailer.complete;
  // The stages turn any error that is not an abort into a failed call, which is scored as an
  // undetermined finding. A request with no recorded answer must not be scored as if the model had
  // failed, so the caller is told, and ends the run by aborting it.
  const missed = (miss: ReplayMiss): ReplayMiss => {
    options.onMiss?.(miss);
    return miss;
  };
  const viewOf = (run: string): ObjectGenerator => {
    const asked = new Map<string, number>();
    return {
      provider: pins.model.provider,
      model: pins.model.requested,
      disclosure: "a recording of an earlier run, so that no request is sent anywhere",
      async generate<T>(request: GenerateObjectRequest<T>): Promise<T> {
        request.signal?.throwIfAborted();
        const key = requestKey(request);
        // Counted when the request starts, as the recording counted it.
        const n = asked.get(key) ?? 0;
        asked.set(key, n + 1);
        const call = recording.calls.get(callId(run, key, n));
        const stage = request.schemaName ?? "a stage";
        if (call === undefined) {
          throw missed(
            new ReplayMiss(
              `The recording has no answer for a request of ${/^[\w.-]{1,60}$/.test(stage) ? stage : "a stage"} ` +
                `(request ${key.slice(0, 12)}${n > 0 ? `, asked ${n + 1} times in this run` : ""}). ` +
                "A replay re-scores recorded answers and cannot make new ones. " +
                (unfinished
                  ? "The recording may be of a run that did not finish or that lost a call it could not record, so it may never have got this far; otherwise the prompts, the schemas, the workflow, the playbook or the documents differ from the run that was recorded. "
                  : "The prompts, the schemas, the workflow, the playbook or the documents differ from the run that was recorded, or this run asks for a case or a repeat that the recorded run did not. ") +
                "Nothing was sent.",
            ),
          );
        }
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
            counts.replayed += 1;
            return parsed.data;
          }
          case "refusal":
            counts.replayed += 1;
            throw new ModelRefusalError(call.message, call.category ?? undefined);
          case "output":
            counts.replayed += 1;
            throw new ModelOutputError(call.message, call.truncated);
          case "request":
            counts.replayed += 1;
            throw new ModelRequestError(
              call.message,
              call.status ?? undefined,
              false,
              (call.kind ?? undefined) as ModelRequestKind | undefined,
            );
        }
      },
    };
  };
  const unscoped = viewOf("");
  return {
    ...unscoped,
    counts,
    generate: unscoped.generate,
    forRun: viewOf,
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
  /** The prompts of the workflow as this code has them: the workflow hash covers their ids only. */
  prompts: Pins["workflow"]["prompts"];
}): string | null {
  const { pins } = args.recording.header;
  if (pins.mode !== "live") {
    return "The recording is not of a live run, so it holds no model answers.";
  }
  if (pins.workflow.sha256 !== args.workflowSha256) {
    // The label is the recording's and not this code's, so it is repeated only when it reads as a
    // plain name, and offered as an option only when it is a workflow this code knows under that
    // hash. A registered label whose definition has changed since is not the recorded workflow, and
    // naming it would send the reader back to the run that was just refused.
    const label = shown(pins.workflow.label, "workflow label");
    const plain = label === pins.workflow.label;
    const known = plain && Object.hasOwn(WORKFLOWS, label);
    const offered =
      known && label !== args.workflowLabel && WORKFLOWS[label]!.sha256 === pins.workflow.sha256;
    return (
      `The recording was made with ${plain ? `workflow ${label}` : "a workflow whose label is not repeated here"}, and this run is of ` +
      `${args.workflowLabel}. Their prompts or checks differ, so no request would be found. ` +
      (offered
        ? `Replay with --workflow ${label}.`
        : known
          ? `This code's workflow ${label} is not the recorded definition. Replay with the code the recording was made with.`
          : "No workflow this code knows matches the recording.")
    );
  }
  if (pins.playbook.sha256 !== args.playbookSha256) {
    return "The recording was made with a different version of the playbook, so no request would be found.";
  }
  // The workflow hash covers the ids of the prompts and not their text or their schemas, so a
  // prompt edited without a new id is the same workflow with other requests. Name the prompt.
  const recorded = pins.workflow.prompts;
  const changed = (["extract", "analyze", "support"] as const).filter((role) => {
    const was = recorded[role];
    const now = args.prompts[role];
    return was === null || now === null
      ? was !== now
      : was.id !== now.id || was.sha256 !== now.sha256;
  });
  if (changed.length > 0) {
    return `The recording was made with another version of the ${changed.join(" and ")} prompt (its text or its schema differs), so its answers are not answers to the requests this code makes. Replay with the code the recording was made with.`;
  }
  return null;
}
