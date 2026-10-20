import type { Logger } from "./log.js";

/** What `process` offers: the two events it raises for an error that nothing caught. */
export interface CrashTarget {
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  on(event: "uncaughtException", listener: (error: unknown) => void): unknown;
}

/**
 * What to do with an error that nothing caught: write one line to the log and stop. Left alone,
 * Node prints the error with its message to the error output, and the message of an unknown error
 * can quote the contract that was being read. The line has the kind of error and where it was
 * raised, as every other unexpected error in the server does, and not what it said.
 *
 * The process stops because after an error that nobody expected, nothing says what state it is in.
 * A review that was running is marked as failed at the next start, and a lock on the data folder
 * that is left behind is taken over, so starting it again is safe.
 */
export function stopOnUncaught(args: {
  target: CrashTarget;
  log: Logger;
  exit: (code: number) => void;
}): void {
  const handler = (message: string) => (error: unknown) => {
    try {
      args.log.error(message, error);
    } finally {
      args.exit(1);
    }
  };
  args.target.on("unhandledRejection", handler("an unhandled promise rejection"));
  args.target.on("uncaughtException", handler("an uncaught exception"));
}
