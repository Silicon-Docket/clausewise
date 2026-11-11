import { D05 } from "../fixtures/parol/cases/d05.js";
import { D08 } from "../fixtures/parol/cases/d08.js";
import { expandDocument, renderDocx, renderTxt } from "../fixtures/parol/render.js";
import type { SourceParagraph } from "../fixtures/parol/types.js";

/**
 * The two documents of the training matter T01 (package W2.8), built from the evaluation cases so
 * that they cannot drift from them: the NDA of PAROL-D05 with the instruction paragraph of
 * PAROL-D08 as its second paragraph, and the amendment of PAROL-D05 as it is. Pure: it reads the
 * case definitions and returns bytes. `tools/make-parol-training.ts` writes them to
 * `apps/parol/training`, and a test rebuilds them in memory and compares.
 *
 * The files are kept outside `fixtures/parol` on purpose. The dataset builder treats a file there
 * that no case names as stale, and the evaluation reads only that folder, so keeping T01 apart is
 * what makes "T01 is never used in evaluation" a fact about where the files are.
 */

export const TRAINING_FILE_NAMES = ["t01-nda.docx", "t01-amendment-1.txt"] as const;

export interface TrainingFile {
  name: (typeof TRAINING_FILE_NAMES)[number];
  bytes: Uint8Array;
}

/** The paragraphs of the T01 NDA: D05's, with D08's instruction paragraph after the title. */
export function trainingNdaParagraphs(): SourceParagraph[] {
  const nda = D05.documents.find((d) => d.label === "D1");
  const note = D08.documents
    .find((d) => d.label === "D1")
    ?.paragraphs.find((p) => p.injected === true);
  if (nda === undefined || note === undefined)
    throw new Error("PAROL-D05 or PAROL-D08 no longer has the document T01 is built from");
  const [first, ...rest] = nda.paragraphs;
  // The title is first in D05 and in D08, so the paragraph goes where D08 has it.
  if (first === undefined || first.kind !== "title")
    throw new Error("the NDA of PAROL-D05 no longer starts with its title");
  return [first, note, ...rest];
}

export async function buildTrainingFiles(): Promise<TrainingFile[]> {
  const nda = D05.documents.find((d) => d.label === "D1");
  const amendment = D05.documents.find((d) => d.label === "D2");
  if (nda === undefined || amendment === undefined)
    throw new Error("PAROL-D05 no longer has the documents T01 is built from");
  return [
    {
      name: "t01-nda.docx",
      bytes: await renderDocx({ title: nda.title, paragraphs: trainingNdaParagraphs() }),
    },
    { name: "t01-amendment-1.txt", bytes: renderTxt(expandDocument(amendment)) },
  ];
}
