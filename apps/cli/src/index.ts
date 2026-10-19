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
}

// STUB: replaced by the cli workstream. Returns the process exit code.
export async function run(_argv: string[], _io: CliIo): Promise<number> {
  throw new Error("not implemented");
}
