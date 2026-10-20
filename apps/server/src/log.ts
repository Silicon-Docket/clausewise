/**
 * Log lines carry no document text and no file names: a request line says what was asked of which
 * route and how it ended, and an error line says what kind of error it was and where, never what
 * it said, because the message of an unknown error can quote the contract.
 */

export type LogSink = (line: string) => void;

export interface RequestLine {
  requestId: string;
  method: string;
  /** The route pattern, such as `/api/reviews/:id`, never the address with its ids filled in. */
  route: string;
  status: number;
  durationMs: number;
}

export interface Logger {
  request(entry: RequestLine): void;
  info(message: string, fields?: Record<string, string | number | boolean>): void;
  warn(message: string, fields?: Record<string, string | number | boolean>): void;
  /** Logs the kind and the call stack of an unexpected error, not its message. */
  error(message: string, error: unknown, requestId?: string): void;
}

const SAFE_NAME = /^[\w.]{1,64}$/;
const SAFE_CODE = /^[\w.-]{1,32}$/;
const MAX_FRAMES = 12;

/**
 * The parts of an error that cannot hold contract text: its class name, its error code if it has
 * a short plain one, and the stack frames, without the first line, which is the message.
 */
export function describeUnexpected(error: unknown): {
  name: string;
  code?: string;
  frames: string[];
} {
  const name = error instanceof Error && SAFE_NAME.test(error.name) ? error.name : "Error";
  const rawCode = (error as { code?: unknown } | null | undefined)?.code;
  const code = typeof rawCode === "string" && SAFE_CODE.test(rawCode) ? rawCode : undefined;
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : "";
  // A message can span lines, so only the lines that are frames are kept.
  const frames = stack
    .split("\n")
    .filter((line) => /^\s+at /.test(line))
    .slice(0, MAX_FRAMES)
    .map((line) => line.trim());
  return { name, ...(code === undefined ? {} : { code }), frames };
}

export function createLogger(
  sink: LogSink = (line) => {
    process.stdout.write(`${line}\n`);
  },
  now: () => Date = () => new Date(),
): Logger {
  const write = (level: string, message: string, fields: Record<string, unknown>): void => {
    sink(JSON.stringify({ time: now().toISOString(), level, msg: message, ...fields }));
  };
  return {
    request: (entry) =>
      write("info", "request", {
        requestId: entry.requestId,
        method: entry.method,
        route: entry.route,
        status: entry.status,
        ms: entry.durationMs,
      }),
    info: (message, fields = {}) => write("info", message, fields),
    warn: (message, fields = {}) => write("warn", message, fields),
    error: (message, error, requestId) =>
      write("error", message, {
        ...(requestId === undefined ? {} : { requestId }),
        ...describeUnexpected(error),
      }),
  };
}

/** A logger that says nothing, for code that has no one to tell. */
export const silentLogger: Logger = {
  request: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
