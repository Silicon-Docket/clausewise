#!/usr/bin/env -S node --import tsx
import { run } from "./index.js";
import { guardedWriter } from "./streams.js";

const interrupt = new AbortController();
process.once("SIGINT", () => {
  interrupt.abort(new Error("Interrupted"));
  // A connection that ignores the abort must not keep the process waiting. The timer does not
  // hold the process open on its own.
  setTimeout(() => process.exit(130), 2000).unref();
});

const stderr = guardedWriter(process.stderr);
const stdout = guardedWriter(process.stdout, (reason) =>
  stderr(`Warning: the standard output cannot be written to (${reason}).\n`),
);

process.exitCode = await run(process.argv.slice(2), {
  stdout,
  stderr,
  env: process.env,
  signal: interrupt.signal,
});
