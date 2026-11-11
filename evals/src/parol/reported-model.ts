/**
 * The reader of the model a provider names in its responses moved to the application
 * (apps/parol/src/usage/reported-model.ts), where the server uses it for every run. This file
 * re-exports it, so the evaluation runner and its tests read the same code.
 */
export * from "../../../apps/parol/src/usage/reported-model.js";
