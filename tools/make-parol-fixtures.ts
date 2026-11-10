import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import {
  buildDataset,
  formatTotals,
  readPlaybookFacts,
  TraceabilityError,
} from "../fixtures/parol/build.js";
import {
  buildDefaultCalibration,
  CALIBRATION_FILE_NAME,
  CalibrationError,
  withCalibration,
} from "../fixtures/parol/calibration.js";
import { CASES, PLAYBOOK_FILE, PLAYBOOK_SLUG } from "../fixtures/parol/cases.js";

/**
 * Builds the Parol evaluation dataset from fixtures/parol/cases.ts: the DOCX and TXT files in
 * fixtures/parol/files, answer-keys.json and splits.json. The output is deterministic, so a
 * second run changes nothing. `--check` writes nothing and exits 1 when what is on disk differs
 * from what the cases build, which is how CI notices a case edited without a rebuild. The files
 * include those of upload steps (identical copies and re-saves) and of the canary matters that a
 * case names, so a file left over from a case that no longer has them is reported as stale.
 *
 * It also builds the support calibration set (fixtures/parol/calibration/pairs.ts) into
 * calibration.json, and records its hash and counts in splits.json as an entry of its own, outside
 * every split, so the hash of a split is the same with or without it. The pairs are checked first
 * (fixtures/parol/calibration.ts): a set that is not exactly 40 pairs of the right shape, or whose
 * quotes do not occur once in the clause they name, stops the build.
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
  const playbookYaml = await readFile(join(root, PLAYBOOK_FILE), "utf8");
  const dataset = await buildDataset({
    cases: CASES,
    playbookYaml,
    playbookSlug: PLAYBOOK_SLUG,
  });
  const calibration = buildDefaultCalibration(
    CASES,
    readPlaybookFacts(playbookYaml, PLAYBOOK_SLUG),
  );

  const wanted = new Map<string, Uint8Array | string>();
  for (const file of dataset.files) wanted.set(join(out, "files", file.name), file.bytes);
  wanted.set(
    join(out, "answer-keys.json"),
    await json(join(out, "answer-keys.json"), dataset.answerKeys),
  );
  wanted.set(
    join(out, "splits.json"),
    await json(join(out, "splits.json"), withCalibration(dataset.splits, calibration.entry)),
  );
  wanted.set(
    join(out, CALIBRATION_FILE_NAME),
    await json(join(out, CALIBRATION_FILE_NAME), calibration.file),
  );

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
  // Printed only when the dataset has them, so the output of a dataset without them is as before.
  const uploadCases = dataset.answerKeys.cases.filter((key) => key.uploads !== undefined);
  if (uploadCases.length > 0) {
    const steps = uploadCases.reduce((n, key) => n + (key.uploads?.steps.length ?? 0), 0);
    const extra = uploadCases.reduce((n, key) => n + (key.uploads?.files.length ?? 0), 0);
    const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;
    console.log(
      `${count(uploadCases.length, "case")} with upload steps (${count(steps, "step")}, ${count(extra, "extra file")}): ${uploadCases.map((key) => key.case).join(", ")}`,
    );
  }
  const matters = dataset.answerKeys.canary?.matters ?? [];
  if (matters.length > 0) {
    console.log(
      `canary matters: ${matters.map((matter) => `${matter.id} (${matter.split}, ${matter.strings.length} strings)`).join(", ")}`,
    );
  }
  if (uploadCases.length > 0 || matters.length > 0) console.log("");
  for (const [split, entry] of Object.entries(dataset.splits.splits)) {
    console.log(`${split.padEnd(8)} sha256 ${entry.sha256} (${entry.files} files)`);
  }
  const kinds = Object.entries(calibration.entry.byKind)
    .map(([kind, n]) => `${kind} ${n}`)
    .join(", ");
  console.log(
    `${"calibr.".padEnd(8)} sha256 ${calibration.entry.sha256} (${calibration.entry.pairs} pairs: ${calibration.entry.supported} supported, ${calibration.entry.unsupported} unsupported; ${kinds})`,
  );
} catch (error) {
  if (error instanceof TraceabilityError || error instanceof CalibrationError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
