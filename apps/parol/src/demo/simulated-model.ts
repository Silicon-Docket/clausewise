import type { GenerateObjectRequest, ObjectGenerator } from "@clausewise/llm";
import { viewOfPrompt } from "./prompt-view.js";
import { answerAnalyze, answerExtract, answerSupport } from "./reader.js";

/**
 * The simulated reader. It runs the whole application with no key and no network, and it is the
 * model behind PAROL_SCRIPTED=1.
 *
 * It is a scripted demonstration. It is not a language model, it learns nothing, and what it says
 * is not a measurement of any model: for the worked example (docs/parol/04) and the training matter
 * built from it (docs/parol/08) it answers from a table written in advance, and for any other
 * document it declines. What it adds to the plain stand-in is
 * that it reads only the passages in the request it is given, so that what the workflow chooses to
 * show it decides what it concludes. That lets the baseline failure of docs/parol/05 and its fix
 * be seen on the screens without a key.
 *
 * Its disclosure begins with the words of the built-in stand-in's, because that is what the start-up
 * notice and the matter page have always shown for PAROL_SCRIPTED.
 */

export const SIMULATED_PROVIDER = "simulated";
export const SIMULATED_MODEL = "parol-simulated-reader";
export const SIMULATED_DISCLOSURE =
  "a built-in stand-in model, the scripted simulated reader (not a language model, and not a measurement of one): nothing is sent anywhere";

/** The schema names the stages ask for. See the prompt registry. */
const SCHEMAS = {
  extract: "locate_passages",
  analyze: "analyze_rule",
  support: "check_support",
} as const;

export function createSimulatedModel(): ObjectGenerator {
  return {
    provider: SIMULATED_PROVIDER,
    model: SIMULATED_MODEL,
    disclosure: SIMULATED_DISCLOSURE,
    cachesSharedPrefix: false,
    async generate<T>(request: GenerateObjectRequest<T>): Promise<T> {
      request.signal?.throwIfAborted();
      // Only the prompt is read. The system text is the same for every request and says nothing
      // about the documents.
      const view = viewOfPrompt(request.prompt);
      let answer: unknown;
      switch (request.schemaName) {
        case SCHEMAS.extract:
          answer = answerExtract(view);
          break;
        case SCHEMAS.analyze:
          answer = answerAnalyze(view);
          break;
        case SCHEMAS.support:
          answer = answerSupport(view);
          break;
        default:
          // A request of a kind the application does not make today. The message names no input.
          throw new Error("the simulated reader does not know this kind of request");
      }
      // The caller's own schema decides whether the answer is acceptable, as it does for a model.
      return request.schema.parse(answer);
    },
  };
}
