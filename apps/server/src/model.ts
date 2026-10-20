import { LlmConfigError, createObjectGenerator, loadLlmConfig } from "@clausewise/llm";
import type { ModelSetup } from "./deps.js";

/**
 * Builds the model from the environment, the way the command line does. A missing or wrong key
 * must not stop the server: the web app shows the problem on its start screen and the review
 * routes answer 503 with it. `LlmConfigError` messages name the variable and never echo a value.
 */
export function modelFromEnv(env: Record<string, string | undefined>): ModelSetup {
  try {
    const config = loadLlmConfig(env);
    return {
      generator: createObjectGenerator(config),
      limits: {
        concurrency: config.concurrency,
        ...(config.maxContextTokens === undefined
          ? {}
          : { maxContextTokens: config.maxContextTokens }),
      },
    };
  } catch (error) {
    if (error instanceof LlmConfigError) return { problem: error.message };
    // Not a message to repeat: an error from a client library can quote what it was given.
    const name = error instanceof Error && /^[\w.]{1,64}$/.test(error.name) ? error.name : "Error";
    return {
      problem: `The model settings could not be used (${name}). Check the CLAUSEWISE_ variables.`,
    };
  }
}
