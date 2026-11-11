import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTrainingFiles } from "./parol-training-files.js";

/**
 * Builds the documents of the training matter T01 into apps/parol/training from the evaluation
 * cases PAROL-D05 and PAROL-D08 (tools/parol-training-files.ts). The output is deterministic, so a
 * second run changes nothing. `--check` writes nothing and exits 1 when what is on disk differs
 * from what the cases build, which is how CI notices a case edited without a rebuild.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "apps", "parol", "training");
const check = process.argv.includes("--check");

async function existing(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

const files = await buildTrainingFiles();

if (check) {
  const drift: string[] = [];
  for (const file of files) {
    const path = join(out, file.name);
    const current = await existing(path);
    if (current === null || !current.equals(Buffer.from(file.bytes))) drift.push(path);
  }
  if (drift.length > 0) {
    console.error(
      `These differ from the cases; run pnpm fixtures:parol:training:\n  ${drift.join("\n  ")}`,
    );
    process.exit(1);
  }
  console.log("apps/parol/training is up to date");
} else {
  await mkdir(out, { recursive: true });
  for (const file of files) {
    const path = join(out, file.name);
    await writeFile(path, file.bytes);
    console.log(`wrote ${path.slice(root.length + 1)}`);
  }
}
