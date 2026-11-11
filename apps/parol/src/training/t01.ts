import type { DocumentKind } from "../contracts.js";
import { TRAINING_TITLE_MARKER } from "../demo/training-example.js";

/**
 * The training matter T01 (package W2.8): what it is called, who it is for, and its documents. The
 * documents are the two files under `apps/parol/training`, built by `pnpm fixtures:parol:training`
 * from evaluation cases PAROL-D05 and PAROL-D08 (the worked example with one instruction paragraph
 * added to the NDA). The stated dates and the client are those of the demonstration matter, because
 * it is the same pair of documents.
 *
 * The first title carries the marker the simulated reader looks for. It is shown wherever the
 * documents are listed, which is what makes the matter's nature visible to the person reading it.
 */

export const TRAINING_KEY = "T01" as const;

export interface TrainingDocument {
  title: string;
  kind: DocumentKind;
  /** The file under the training folder, and the name the upload carries. */
  fileName: string;
  /** `YYYY-MM-DD`, as intake enters it. */
  statedDate: string;
}

export const T01: {
  readonly key: typeof TRAINING_KEY;
  readonly matterName: string;
  readonly clientLegalName: string;
  /** The slug of the approved playbook the matter pins. */
  readonly playbookSlug: string;
  readonly documents: readonly TrainingDocument[];
} = {
  key: TRAINING_KEY,
  matterName: "Training: Lanternfish / Corvane NDA (T01)",
  clientLegalName: "Lanternfish Software, Inc.",
  playbookSlug: "parol-nda-recipient",
  documents: [
    {
      title: `Mutual NDA ${TRAINING_TITLE_MARKER}`,
      kind: "nda",
      fileName: "t01-nda.docx",
      statedDate: "2026-02-02",
    },
    {
      title: `Amendment No. 1 ${TRAINING_TITLE_MARKER}`,
      kind: "amendment",
      fileName: "t01-amendment-1.txt",
      statedDate: "2026-09-15",
    },
  ],
};
