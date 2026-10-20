import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { loadPlaybookFile } from "@clausewise/playbook/node";
import type { Playbook } from "@clausewise/playbook";
import type { RuleStatus } from "@clausewise/review";
import { z } from "zod";
import { EvalError, UsageError, shown } from "./errors.js";

export type ExpectedStatus = Exclude<RuleStatus, "error">;

export const EXPECTED_STATUSES: readonly ExpectedStatus[] = [
  "compliant",
  "deviation",
  "missing",
  "not_applicable",
];

const ExpectedFile = z.record(
  z.string(),
  z.strictObject({
    playbook: z.string().min(1),
    rules: z.record(z.string(), z.enum(["compliant", "deviation", "missing", "n/a"])),
  }),
);

export interface Fixture {
  /** The file name in fixtures/, which is also its key in expected.json. */
  name: string;
  /** The playbook path as written in expected.json, relative to the repository root. */
  playbookPath: string;
  playbook: Playbook;
  docx: Uint8Array;
  /** The status a correct review gives each rule, with "n/a" already mapped to not_applicable. */
  expected: Record<string, ExpectedStatus>;
}

function fsReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" ? "it does not exist" : (code ?? "it cannot be read");
}

async function readExpected(root: string): Promise<z.infer<typeof ExpectedFile>> {
  const path = join(root, "fixtures", "expected.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const why = error instanceof SyntaxError ? "it is not valid JSON" : fsReason(error);
    throw new EvalError(`Cannot read ${path}: ${why}.`);
  }
  const parsed = ExpectedFile.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new EvalError(`${path} is invalid: ${problems}`);
  }
  return parsed.data;
}

/**
 * Loads the fixtures named, or all of them. A fixture is a key of expected.json, never a path,
 * so the harness cannot be pointed at a document that is not part of the repository.
 */
export async function loadFixtures(root: string, selected: readonly string[]): Promise<Fixture[]> {
  const file = await readExpected(root);
  const known = Object.keys(file);
  if (known.length === 0) throw new EvalError("fixtures/expected.json lists no fixtures.");

  const names =
    selected.length === 0 ? known : [...new Set(selected.map((name) => basename(name)))];
  for (const name of names) {
    if (!Object.hasOwn(file, name)) {
      throw new UsageError(
        `Unknown fixture: ${shown(name, "fixture name")}. Known fixtures: ${known.join(", ")}.`,
      );
    }
  }

  const playbooks = new Map<string, Playbook>();
  const fixtures: Fixture[] = [];
  for (const name of names) {
    const entry = file[name];
    if (entry === undefined) continue;

    let playbook = playbooks.get(entry.playbook);
    if (playbook === undefined) {
      playbook = await loadPlaybookFile(join(root, entry.playbook));
      playbooks.set(entry.playbook, playbook);
    }

    const ids = new Set(playbook.rules.map((rule) => rule.id));
    const unexpected = Object.keys(entry.rules).filter((id) => !ids.has(id));
    const unscored = playbook.rules
      .map((rule) => rule.id)
      .filter((id) => !Object.hasOwn(entry.rules, id));
    if (unexpected.length > 0 || unscored.length > 0) {
      throw new EvalError(
        `${name} and ${entry.playbook} disagree about the rules. ` +
          (unexpected.length > 0 ? `Only in expected.json: ${unexpected.join(", ")}. ` : "") +
          (unscored.length > 0 ? `Only in the playbook: ${unscored.join(", ")}. ` : "") +
          "Every rule needs an expected status, or its score means nothing.",
      );
    }

    const path = join(root, "fixtures", name);
    let docx: Uint8Array;
    try {
      docx = await readFile(path);
    } catch (error) {
      throw new EvalError(
        `Cannot read the fixture ${path}: ${fsReason(error)}. Run pnpm fixtures to create it.`,
      );
    }

    fixtures.push({
      name,
      playbookPath: entry.playbook,
      playbook,
      docx,
      expected: Object.fromEntries(
        Object.entries(entry.rules).map(([id, status]) => [
          id,
          status === "n/a" ? "not_applicable" : status,
        ]),
      ),
    });
  }
  return fixtures;
}
