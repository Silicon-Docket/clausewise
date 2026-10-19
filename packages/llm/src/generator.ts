import type { LanguageModel } from "ai";
import type { LlmConfig, ObjectGenerator } from "./types.js";

// STUB: replaced by the llm workstream.
export function createObjectGenerator(
  _config: LlmConfig,
  _overrides?: { model?: LanguageModel },
): ObjectGenerator {
  throw new Error("not implemented");
}
