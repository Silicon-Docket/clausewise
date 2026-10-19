import type { Playbook } from "@clausewise/playbook";
import type { ObjectGenerator } from "@clausewise/llm";
import type { ReviewOptions, ReviewReport } from "./types.js";

// STUB: replaced by the pipeline workstream.
export async function reviewContract(
  _input: { docx: Uint8Array; playbook: Playbook; fileName?: string },
  _generator: ObjectGenerator,
  _options?: ReviewOptions,
): Promise<{ report: ReviewReport; redlined: Uint8Array }> {
  throw new Error("not implemented");
}
