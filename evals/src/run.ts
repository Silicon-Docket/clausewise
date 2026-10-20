import { runEvals } from "./harness.js";

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

process.exitCode = await runEvals(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  signal: interrupt.signal,
});
