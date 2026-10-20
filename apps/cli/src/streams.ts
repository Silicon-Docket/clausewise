import type { Writable } from "node:stream";
import { errorCode } from "./files.js";

// A pipe whose reader has gone (`| head`, a crashed log collector) reports EPIPE.
const CLOSED = new Set([
  "EPIPE",
  "ECONNRESET",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
]);

/**
 * A writer for a standard stream that never throws and never takes the process down. Node reports
 * a write to a closed pipe as an 'error' event, and without a listener that kills the process
 * with exit code 1, which would throw away a review that was already paid for or change the exit
 * code of one that had finished. A stream that failed is dropped from then on, because nothing
 * more can reach it, and the review carries on.
 *
 * `onFailure` is told about the first failure that was not a closed pipe, so the other stream can
 * mention it. A closed pipe is the reader's choice and gets no message.
 */
export function guardedWriter(
  stream: Writable,
  onFailure?: (reason: string) => void,
): (text: string) => void {
  let broken = false;
  stream.on("error", (error: unknown) => {
    if (broken) return;
    broken = true;
    const code = errorCode(error);
    if (code === undefined || !CLOSED.has(code)) onFailure?.(code ?? "unknown error");
  });
  return (text) => {
    if (broken || stream.destroyed) return;
    try {
      stream.write(text);
    } catch {
      broken = true;
    }
  };
}
