import {
  ModelOutputError,
  ModelRefusalError,
  ModelRequestError,
  type GenerateObjectRequest,
  type ObjectGenerator,
} from "@clausewise/llm";
import { ZodError, type ZodType } from "zod";
import { sha256Hex } from "../canonical.js";
import type { CallRecord } from "../contracts.js";
import { CallCollector, callStore } from "../usage/scope.js";

/**
 * One model call, the way the extract and analyze stages make it: timed, hashed, classified and
 * recorded, and never allowed to throw for a model failure.
 *
 * Nothing here keeps, logs or returns text from the model or from a document. A failure is
 * described by its class, and a call record holds hashes, counts and a name.
 */

/** What a caller does about a failed call, in the words the contracts use for it. */
export type FailureClass = "output_invalid" | "refusal" | "cut_off" | "transport";

export interface ModelFailure {
  failure: FailureClass;
  /** The `outcome` of the call record. A fatal provider error is `fatal`, otherwise `transport`. */
  outcome: Extract<
    CallRecord["outcome"],
    "schema_error" | "refusal" | "cut_off" | "transport" | "fatal"
  >;
  /** The class and nothing else the caller could not safely store or show. */
  detail: string;
}

const SAFE_WORD = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * Sorts a thrown value into a failure class. The provider's own messages are not used: the
 * errors of the AI SDKs can carry the request, which is the contract. A refusal's category is
 * kept only when it is a short plain word.
 */
export function classifyFailure(error: unknown): ModelFailure {
  if (error instanceof ModelRefusalError) {
    const category = error.category;
    return {
      failure: "refusal",
      outcome: "refusal",
      detail:
        category !== undefined && SAFE_WORD.test(category)
          ? `refusal: the model declined to answer (${category})`
          : "refusal: the model declined to answer",
    };
  }
  if (error instanceof ModelOutputError) {
    return error.truncated
      ? {
          failure: "cut_off",
          outcome: "cut_off",
          detail: "cut_off: the reply stopped at the output limit",
        }
      : {
          failure: "output_invalid",
          outcome: "schema_error",
          detail: "output_invalid: the reply did not fit the answer schema",
        };
  }
  // A generator that does not wrap schema mismatches (a scripted one) throws the parser's error.
  if (error instanceof ZodError) {
    return {
      failure: "output_invalid",
      outcome: "schema_error",
      detail: "output_invalid: the reply did not fit the answer schema",
    };
  }
  if (error instanceof ModelRequestError) {
    const status = error.statusCode === undefined ? "" : `, status ${error.statusCode}`;
    return {
      failure: "transport",
      outcome: error.fatal ? "fatal" : "transport",
      detail: `transport: ${error.kind}${status}${error.fatal ? ", fatal for every call of the run" : ""}`,
    };
  }
  return {
    failure: "transport",
    outcome: "transport",
    detail: "transport: the request failed",
  };
}

/** An abort is the caller stopping the run, not a model failure, so it always propagates. */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: unknown }).name === "AbortError"
  );
}

export interface ModelCall<T> {
  generator: ObjectGenerator;
  signal: AbortSignal | undefined;
  stage: CallRecord["stage"];
  ruleKey: string | null;
  promptVersionId: string;
  /** 1 for the first answer, 2 for the first repair. */
  attempt: number;
  system: string;
  prompt: string;
  /** The leading part of `prompt` that a caching provider can reuse. */
  sharedPrefix: string | undefined;
  schema: ZodType<T>;
  schemaName: string;
}

export type ModelCallResult<T> =
  | {
      ok: true;
      value: T;
      /** The record once the caller has judged the answer: `ok`, or `semantic_error`. */
      record: (outcome: "ok" | "semantic_error") => CallRecord;
    }
  | { ok: false; failure: ModelFailure; record: CallRecord };

/** The hash a call record keeps for the request: the system text and the prompt, joined. */
export const requestSha256 = (system: string, prompt: string): string => sha256Hex(system + prompt);

/**
 * Makes one call. Rethrows an abort (the signal, or an `AbortError` from the generator) and
 * returns every other failure as a value with its call record. The token counts of the record are
 * what the provider reported while this call was running, through the metering hooks of
 * `usage/metering.ts` (summed over a retry and a failed attempt), and are null in all four when no
 * hook reported any: a generator that does not report usage, such as a scripted one, leaves them
 * null.
 *
 * The call runs inside its own collector (`usage/scope.ts`), which is how a hook that carries no
 * identity reaches the right call when the engine runs several at once. The latency ends before the
 * collector waits for the copies of the response bodies to be read, so waiting for usage never
 * counts as the provider's time.
 */
export async function callModel<T>(call: ModelCall<T>): Promise<ModelCallResult<T>> {
  call.signal?.throwIfAborted();
  const request: GenerateObjectRequest<T> = {
    system: call.system,
    prompt: call.prompt,
    schema: call.schema,
    schemaName: call.schemaName,
    ...(call.sharedPrefix === undefined ? {} : { sharedPrefix: call.sharedPrefix }),
    ...(call.signal === undefined ? {} : { signal: call.signal }),
  };
  const collector = new CallCollector();
  const recordFor = (outcome: CallRecord["outcome"], latencyMs: number): CallRecord => {
    const usage = collector.usage();
    return {
      stage: call.stage,
      ruleKey: call.ruleKey,
      promptVersionId: call.promptVersionId,
      requestSha256: requestSha256(call.system, call.prompt),
      attempt: call.attempt,
      outcome,
      latencyMs,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      cacheReadTokens: usage?.cacheReadTokens ?? null,
      cacheWriteTokens: usage?.cacheWriteTokens ?? null,
    };
  };

  const started = performance.now();
  try {
    const value = await callStore.run(collector, () => call.generator.generate(request));
    const latencyMs = Math.max(0, Math.round(performance.now() - started));
    await collector.settled();
    return { ok: true, value, record: (outcome) => recordFor(outcome, latencyMs) };
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (call.signal?.aborted) throw call.signal.reason ?? error;
    const latencyMs = Math.max(0, Math.round(performance.now() - started));
    await collector.settled();
    const failure = classifyFailure(error);
    return { ok: false, failure, record: recordFor(failure.outcome, latencyMs) };
  }
}

/**
 * A clause label as the model may write it: `c12`, or `[c12]` copied with the brackets of the
 * header line. Anything else is not a label and maps to nothing.
 */
export function normalizeLabel(raw: string): string {
  const trimmed = raw.trim();
  const inner = /^\[\s*([^\]]*?)\s*\]$/.exec(trimmed);
  return inner === null ? trimmed : inner[1]!;
}
