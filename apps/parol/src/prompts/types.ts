import type { ZodType } from "zod";
import type { PromptDefinition } from "../contracts.js";

/** A prompt as its own file writes it: data only. The registry adds the hash. */
export interface PromptSource {
  definition: PromptDefinition;
  /** The schema the model's answer is parsed with. Its JSON form is part of the prompt's hash. */
  schema: ZodType;
  /**
   * Fixed prose that the stage code puts into the request around the user template (a sentence
   * on how much of the documents is shown, the note of a repair call), by name, with `{{name}}`
   * placeholders for what varies. It is part of the prompt's hash, so changing a word of it is a
   * new prompt, and the stage reads it with `getFragment` instead of keeping its own copy.
   */
  fragments?: Record<string, string>;
}
