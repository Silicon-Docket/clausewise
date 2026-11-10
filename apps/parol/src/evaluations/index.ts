/**
 * The application's side of the evaluation comparison page (package W2.5). No module of
 * `apps/parol/src` outside this folder and `services/evaluations.ts` knows about `evals/`; the
 * only thing that crosses is a file in the data folder, read through a `ComparisonSource`.
 */
export {
  EMPTY_SOURCE,
  createComparisonSource,
  type ComparisonPage,
  type ComparisonSource,
  type ComparisonSourceOptions,
  type PageProblem,
  type SourceEntry,
} from "./source.js";
