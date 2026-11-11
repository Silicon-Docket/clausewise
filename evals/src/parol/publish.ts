/**
 * Writes a page document into the application's data folder, where the evaluation page reads it.
 * This is the only writer of that folder: the application never writes a comparison.
 *
 * The file is `<data folder>/evaluations/<id>.json`, named for the fingerprint of its content, so
 * publishing the same comparison twice is one file. It is written whole or not at all and never
 * over another file: a file that is already there is read, and is "already published" if it holds
 * the same document, and an error if it holds anything else. The folder is created for the owner
 * alone (mode 0700), the same protection as the database beside it.
 *
 * Nothing here logs, stores or throws text from a document.
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  pageFileName,
  parseComparisonPage,
  type ComparisonPage,
} from "../../../apps/parol/src/evaluations/document.js";
import { writeFileAtomically } from "../results-file.js";
import { PageError, serialiseComparisonPage } from "./page.js";

/** The folder of the data folder that holds published comparisons. */
export const EVALUATIONS_FOLDER = "evaluations";

export interface Published {
  id: string;
  /** The file, whether written now or found. */
  path: string;
  /** False when a file with the same document was already there and was left as it is. */
  created: boolean;
}

const codeOf = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? "an error";

export async function publishComparison(args: {
  page: ComparisonPage;
  /** The Parol data folder, the one `PAROL_DATA_DIR` names. */
  dataFolder: string;
}): Promise<Published> {
  const { page } = args;
  const text = serialiseComparisonPage(page);
  const name = pageFileName(page.id);
  // Whatever built the page, only a document the application would accept is written.
  const checked = parseComparisonPage(text, name);
  if (!checked.ok) {
    throw new PageError(
      `The page document is not accepted by the application's reader (${checked.problem}), so it is not written.`,
    );
  }
  const folder = join(args.dataFolder, EVALUATIONS_FOLDER);
  const path = join(folder, name);
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new PageError(
      `The folder for published comparisons could not be made (${codeOf(error)}).`,
    );
  }
  try {
    await writeFileAtomically(path, text, { replace: false });
    return { id: page.id, path, created: true };
  } catch (error) {
    if (codeOf(error) !== "EEXIST") {
      throw new PageError(`The page document could not be written (${codeOf(error)}).`);
    }
  }
  // The name is taken. The same document is a repeat of this publish; anything else is not ours.
  let existing: string;
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    throw new PageError(
      `A file that holds this comparison's name could not be read (${codeOf(error)}).`,
    );
  }
  const found = parseComparisonPage(existing, name);
  if (found.ok && found.page.sha256 === page.sha256) {
    return { id: page.id, path, created: false };
  }
  throw new PageError(
    "A different file already holds the name of this comparison, so nothing was written. Move that file away and publish again.",
  );
}
