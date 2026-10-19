#!/usr/bin/env -S pnpm tsx
import { run } from "./index.js";

const interrupt = new AbortController();
process.once("SIGINT", () => {
  interrupt.abort(new Error("Interrupted"));
  // A connection that ignores the abort must not keep the process waiting. The timer does not
  // hold the process open on its own.
  setTimeout(() => process.exit(130), 2000).unref();
});

process.exitCode = await run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  signal: interrupt.signal,
});
