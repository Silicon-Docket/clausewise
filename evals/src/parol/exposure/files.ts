/**
 * The bytes of a file of the dataset, checked against the hash the answer key records for it.
 *
 * `loadDataset` reads the files that the cases and their twins name as documents. The exposure
 * suite also needs files it does not name: the NDA of a canary matter and the extra files of an
 * upload case (an identical copy, a re-save). When the loaded dataset does not hold one, it is read
 * from `fixtures/parol/files` under the repository root, by a plain file name only, so a changed
 * key cannot make the suite read another path. A file whose bytes do not hash to the recorded
 * value is an integrity failure (exit code 2). Messages name the file, never its content.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex } from "../../../../apps/parol/src/canonical.js";
import { EvalError } from "../../errors.js";
import type { Dataset } from "../dataset.js";
import { DATASET_DIR } from "../dataset.js";
import { EXIT_UNTRUSTED } from "./errors.js";

const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export async function fileBytes(
  dataset: Pick<Dataset, "files">,
  root: string,
  name: string,
  sha256: string,
): Promise<Uint8Array> {
  if (!SAFE_FILE.test(name))
    throw new EvalError(
      "The answer key names a file whose name is not a plain name.",
      EXIT_UNTRUSTED,
    );
  let bytes = dataset.files.get(name);
  if (bytes === undefined) {
    try {
      bytes = new Uint8Array(await readFile(join(root, DATASET_DIR, "files", name)));
    } catch {
      throw new EvalError(`The dataset file ${name} is missing.`, EXIT_UNTRUSTED);
    }
  }
  if (sha256Hex(bytes) !== sha256)
    throw new EvalError(
      `The dataset file ${name} differs from the hash in the answer key.`,
      EXIT_UNTRUSTED,
    );
  return bytes;
}
