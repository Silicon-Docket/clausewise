import { hashOf } from "../canonical.js";
import type { WorkflowManifest } from "../contracts.js";
import type { RegisteredWorkflow } from "../module-contracts.js";

/**
 * Workflow versions. A version is its manifest: which prompts, which retrieval policy, which
 * check sets, how much context one rule may use, how many repairs. Its hash is the hash of that
 * manifest, so two versions that differ in anything a run depends on cannot share an identity.
 *
 * v2 is v1 with one change, the retrieval policy. That is the controlled revision of the
 * improvement cycle (docs/parol/05-evaluation.md): prompts and checks are held fixed so that any
 * effect on the results is attributable to retrieval.
 *
 * v3 is v2 with two more things switched on: the model support check (prompt support.p1, which
 * reads only the cited passages and says whether they back the claim) and the deterministic
 * supersession check C2. It is a candidate for the evaluation and is not shipped with the
 * application (boot/register.ts registers v1 and v2), so a matter cannot be reviewed with it until
 * a promotion decision says so. Its effect cannot be split between the support check and C2: they
 * are changed together on purpose, to see what the full set of checks does to the gates that need
 * them (G5 and G11). A later version can separate them if the result calls for it.
 */
const BASE = {
  prompts: { extract: "extract.p1", analyze: "analyze.p1", support: null },
  checks: ["C1"],
  budgetTokens: 12000,
  repairAttempts: 1,
} as const;

const freezeList = (items: readonly string[]): string[] => Object.freeze([...items]) as string[];

/**
 * Registered workflows are shared by every caller, so they are frozen: a manifest that someone
 * changed in place would no longer match the hash recorded beside it.
 */
function register(
  label: string,
  retrieval: WorkflowManifest["retrieval"],
  change: { support?: string; checks?: readonly string[] } = {},
): RegisteredWorkflow {
  const manifest: WorkflowManifest = Object.freeze({
    label,
    prompts: Object.freeze({ ...BASE.prompts, support: change.support ?? BASE.prompts.support }),
    retrieval,
    checks: freezeList(change.checks ?? BASE.checks),
    budgetTokens: BASE.budgetTokens,
    repairAttempts: BASE.repairAttempts,
  });
  return Object.freeze({ manifest, sha256: hashOf(manifest) });
}

export const WORKFLOWS: Record<string, RegisteredWorkflow> = Object.freeze({
  v1: register("v1", "R1"),
  v2: register("v2", "R2"),
  v3: register("v3", "R2", { support: "support.p1", checks: ["C1", "C2"] }),
});

/** Throws for a label that is not registered, so a typo cannot silently select no workflow. */
export function workflowFor(label: string): RegisteredWorkflow {
  const found = Object.hasOwn(WORKFLOWS, label) ? WORKFLOWS[label] : undefined;
  if (found === undefined) {
    throw new Error(`unknown workflow version "${label.length > 40 ? label.slice(0, 40) : label}"`);
  }
  return found;
}
