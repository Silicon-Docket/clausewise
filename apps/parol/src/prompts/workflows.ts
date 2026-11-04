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
function register(label: string, retrieval: WorkflowManifest["retrieval"]): RegisteredWorkflow {
  const manifest: WorkflowManifest = Object.freeze({
    label,
    prompts: Object.freeze({ ...BASE.prompts }),
    retrieval,
    checks: freezeList(BASE.checks),
    budgetTokens: BASE.budgetTokens,
    repairAttempts: BASE.repairAttempts,
  });
  return Object.freeze({ manifest, sha256: hashOf(manifest) });
}

export const WORKFLOWS: Record<string, RegisteredWorkflow> = Object.freeze({
  v1: register("v1", "R1"),
  v2: register("v2", "R2"),
});

/** Throws for a label that is not registered, so a typo cannot silently select no workflow. */
export function workflowFor(label: string): RegisteredWorkflow {
  const found = Object.hasOwn(WORKFLOWS, label) ? WORKFLOWS[label] : undefined;
  if (found === undefined) {
    throw new Error(`unknown workflow version "${label.length > 40 ? label.slice(0, 40) : label}"`);
  }
  return found;
}
