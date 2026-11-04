import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { buildDataset, formatTotals, TraceabilityError } from "../fixtures/parol/build.js";
import { CASES, PLAYBOOK_FILE, PLAYBOOK_SLUG } from "../fixtures/parol/cases.js";

/**
 * Builds the Parol evaluation dataset from fixtures/parol/cases.ts: the DOCX and TXT files in
 * fixtures/parol/files, answer-keys.json and splits.json. The output is deterministic, so a
 * second run changes nothing. `--check` writes nothing and exits 1 when what is on disk differs
 * from what the cases build, which is how CI notices a case edited without a rebuild.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "fixtures", "parol");
const check = process.argv.includes("--check");

async function json(path: string, value: unknown): Promise<string> {
  const options = (await resolveConfig(path)) ?? {};
  return format(JSON.stringify(value), { ...options, filepath: path, parser: "json" });
}

async function existing(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

try {
  const dataset = await buildDataset({
    cases: CASES,
    playbookYaml: await readFile(join(root, PLAYBOOK_FILE), "utf8"),
    playbookSlug: PLAYBOOK_SLUG,
  });

  const wanted = new Map<string, Uint8Array | string>();
  for (const file of dataset.files) wanted.set(join(out, "files", file.name), file.bytes);
  wanted.set(
    join(out, "answer-keys.json"),
    await json(join(out, "answer-keys.json"), dataset.answerKeys),
  );
  wanted.set(join(out, "splits.json"), await json(join(out, "splits.json"), dataset.splits));

  const stale: string[] = [];
  const filesDir = join(out, "files");
  for (const name of await readdir(filesDir).catch(() => [] as string[])) {
    if (!dataset.files.some((file) => file.name === name)) stale.push(join(filesDir, name));
  }

  if (check) {
    const drift: string[] = [...stale];
    for (const [path, content] of wanted) {
      const current = await existing(path);
      if (current === null || !current.equals(Buffer.from(content))) drift.push(path);
    }
    if (drift.length > 0) {
      console.error(
        `These differ from the cases; run pnpm fixtures:parol:\n  ${drift.join("\n  ")}`,
      );
      process.exit(1);
    }
    console.log("fixtures/parol is up to date");
  } else {
    await mkdir(filesDir, { recursive: true });
    for (const path of stale) await rm(path);
    for (const [path, content] of wanted) {
      await writeFile(path, content);
      console.log(`wrote ${path.slice(root.length + 1)}`);
    }
  }

  console.log(`\n${formatTotals(dataset.totals)}\n`);
  for (const [split, entry] of Object.entries(dataset.splits.splits)) {
    console.log(`${split.padEnd(8)} sha256 ${entry.sha256} (${entry.files} files)`);
  }
} catch (error) {
  if (error instanceof TraceabilityError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
