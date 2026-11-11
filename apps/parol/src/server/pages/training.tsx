import type { TrainingProgressView } from "../../services/views.js";

/**
 * The training matter on the matter page and the run page (package W2.8): a banner that says what
 * the exercise is, and the table of steps with where each stands.
 *
 * Contract commit CC2: the props are final; both components render nothing until W2.8 fills them.
 * The banner decides for itself whether to show: it is given the matter's training key and shows
 * nothing when there is none, so a host page calls it for every matter. The run page calls it with
 * `compact` (`run.tsx` belongs to W2.6a from here on). The matter page calls both from
 * `matter.tsx`, which W2.8 owns in phase 2, so that call is W2.8's to add. The file name is
 * letters only because a page may import another page only by such a name (the static test).
 */

export interface TrainingBannerProps {
  /** The short form for the run page; the matter page shows the full form. */
  compact?: boolean;
  /** `MatterSummary.training`. Null or absent: an ordinary matter, and nothing is shown. */
  training?: string | null | undefined;
  /** The provider of the run being shown (`RunSummary.model.provider`), for the run page's second sentence. */
  provider?: string | undefined;
}

export function TrainingBanner(_props: TrainingBannerProps) {
  // STUB(W2.8): renders nothing.
  return null;
}

export interface TrainingSectionProps {
  /** `MatterView.training`. Null or absent: an ordinary matter, and nothing is shown. */
  progress?: TrainingProgressView | null | undefined;
}

export function TrainingSection(_props: TrainingSectionProps) {
  // STUB(W2.8): renders nothing.
  return null;
}
