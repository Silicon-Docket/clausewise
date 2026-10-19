import type { ObjectGenerator } from "@clausewise/llm";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  /** Defaults to the real file system. Tests may pass fakes. */
  readFile?: (path: string) => Promise<Uint8Array>;
  writeFile?: (path: string, data: Uint8Array | string) => Promise<void>;
  /** Defaults to building the real model from the environment. Tests inject a scripted one. */
  generatorFactory?: (env: Record<string, string | undefined>) => ObjectGenerator;
  /** When it aborts, no further model calls are started and the run ends with code 130. */
  signal?: AbortSignal;
}
