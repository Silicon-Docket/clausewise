import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadPlaybook } from "../playbooks/load.js";
import { promptRecord } from "../prompts/registry.js";
import { workflowFor } from "../prompts/workflows.js";
import {
  DEMO_USER_IDS,
  NotFoundError,
  type FileStore,
  type PlaybookVersionRow,
  type Repository,
  type WorkflowVersionRow,
} from "../store/index.js";

/** The playbook the demo ships, by slug. */
export const DEMO_PLAYBOOK_SLUG = "parol-nda-recipient";

/**
 * Where the demo playbook is, found from this file and not from the working directory, so the
 * server starts the same from any folder and from a test.
 */
export const DEMO_PLAYBOOK_PATH = fileURLToPath(
  new URL("../../playbooks/parol-nda-recipient.yaml", import.meta.url),
);

/** The prompts every shipped workflow version pins, in the order they are registered. */
export const PROMPT_IDS = ["extract.p1", "analyze.p1", "support.p1"] as const;

/** The workflow versions the build ships. */
export const WORKFLOW_LABELS = ["v1", "v2"] as const;

export interface Registration {
  playbook: PlaybookVersionRow;
  workflows: WorkflowVersionRow[];
}

/**
 * Puts what a run depends on into the database: the prompts, the workflow versions that pin them,
 * and the demo playbook, approved. Each step is idempotent, so the server calls this at every start
 * and a second call changes nothing and writes no audit event.
 *
 * Prompts come first because `model_calls` has a foreign key to them and a workflow refuses a
 * prompt that is not registered. The playbook is imported by a legal engineer and approved by an
 * administrator, as docs/parol/06 has it, which is why the demo users have to exist (`seedDemoUsers`
 * seeds them, and is itself safe to repeat).
 *
 * A playbook file that changed without a new version number is refused by the store; so is a prompt
 * whose text changed under an id. Either stops the boot, which is the point.
 */
export function registerAll(
  repo: Repository,
  options: { seedDemoUsers: boolean; playbookPath?: string },
): Registration {
  if (options.seedDemoUsers) repo.seedDemoUsers();

  for (const id of PROMPT_IDS) repo.upsertPromptVersion(promptRecord(id), { actorId: null });
  const workflows = WORKFLOW_LABELS.map((label) =>
    repo.upsertWorkflowVersion(workflowFor(label), { actorId: null }),
  );

  const loaded = loadPlaybook({
    yaml: readFileSync(options.playbookPath ?? DEMO_PLAYBOOK_PATH, "utf8"),
    slug: DEMO_PLAYBOOK_SLUG,
  });
  let playbook = repo.findPlaybookVersion(loaded.slug, loaded.version);
  try {
    // The same version with other text is refused by the import, whatever state the stored one is in.
    if (playbook === undefined || playbook.sha256 !== loaded.sha256)
      playbook = repo.importPlaybookDraft(
        {
          slug: loaded.slug,
          version: loaded.version,
          yaml: loaded.yaml,
          sha256: loaded.sha256,
          rules: loaded.rules,
        },
        { actorId: DEMO_USER_IDS.legalEngineer },
      );
    if (playbook.status === "draft")
      playbook = repo.approvePlaybookVersion(playbook.id, { actorId: DEMO_USER_IDS.admin });
  } catch (error) {
    if (error instanceof NotFoundError && error.entity === "user")
      throw new Error(
        "registerAll: the demo playbook is imported and approved by the demo users, which do not exist; seed them",
      );
    throw error;
  }
  return { playbook, workflows };
}

/**
 * Runs left in flight by the last process become `failed` with `interrupted`, so that the associate
 * can resume them. Called once at start-up, before the server accepts a request. Returns what it
 * changed, as ids.
 */
export function markInterruptedRuns(
  repo: Repository,
  log: (line: string) => void = () => {},
): { matterId: string; runId: string }[] {
  const interrupted = repo.markInterruptedOnBoot();
  for (const { matterId, runId } of interrupted)
    log(`run ${runId} (matter ${matterId}): interrupted by a restart, it can be resumed`);
  return interrupted;
}

/**
 * Removes the folder of a matter whose rows are gone: deleting a matter removes the rows first and
 * the files after, so a stop between the two leaves a folder no row names.
 */
export function sweepOrphanFiles(
  repo: Repository,
  files: FileStore,
  log: (line: string) => void = () => {},
): string[] {
  const removed = files.sweepOrphans(repo.listMatterIds());
  for (const matterId of removed) log(`matter ${matterId}: removed files that had no matter`);
  return removed;
}
