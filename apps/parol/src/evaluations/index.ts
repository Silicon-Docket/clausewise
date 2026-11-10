/**
 * The application's side of the evaluation comparison page (package W2.5). No module of
 * `apps/parol/src` outside this folder and `services/evaluations.ts` knows about `evals/`; the
 * only thing that crosses is a file in the data folder, read through a `ComparisonSource`.
 */
export {
  CHANGE_KINDS,
  DECISION_OUTCOMES,
  FAILURE_KINDS,
  GATE_IDS,
  GATE_OUTCOMES,
  MAX_PAGE_BYTES,
  PAGE_FORMAT,
  PAGE_KIND,
  RUN_MODES,
  SPLIT_NAMES,
  isPageId,
  pageFileName,
  pageIdOf,
  parseComparisonPage,
  sealComparisonPage,
  type ChangeKind,
  type ChangeView,
  type ComparisonBody,
  type ComparisonPage,
  type DecisionOutcome,
  type FailureKind,
  type GateId,
  type GateOutcome,
  type GateView,
  type PageProblem,
  type ParsedPage,
  type PassageView,
  type RunMode,
  type SectionView,
  type SideFacts,
  type SplitName,
} from "./document.js";
export { draftPromotionRecord } from "./draft.js";
export {
  EMPTY_SOURCE,
  createComparisonSource,
  type ComparisonSource,
  type ComparisonSourceOptions,
  type SourceEntry,
} from "./source.js";
export * from "./words.js";
