/**
 * Entry point of `pnpm eval:parol`. Everything of substance is in cli.ts, so that the tests can
 * run it with an injected model and capture its output.
 */
import { runParol } from "./cli.js";

const interrupt = new AbortController();
// A terminal that closes sends SIGHUP and a job runner or container stop sends SIGTERM. Both end
// the run the way Ctrl-C does, so that what finished is still written.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    interrupt.abort(new Error("Interrupted"));
    // A connection that ignores the abort must not keep the process waiting. The timer does not
    // hold the process open on its own.
    setTimeout(() => process.exit(130), 2000).unref();
  });
}

process.exitCode = await runParol(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  signal: interrupt.signal,
});
