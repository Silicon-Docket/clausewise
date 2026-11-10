import { settledStatus } from "@clausewise/review";
import type { PlaybookRuleRecord, Status } from "./contracts.js";

/**
 * Status settlement: the playbook's flags, not the model, say when a clause that is absent matters.
 *
 *  - A rule that forbids something (kind "absence") is met by a contract without it, so `missing`
 *    and `not_applicable` both become `compliant`.
 *  - A rule that asks for a clause and is not required is `not_applicable` when no clause covers
 *    it, so `missing` becomes `not_applicable`.
 *  - A rule that asks for a clause and is required is `missing` when no clause covers it, so
 *    `not_applicable` becomes `missing`.
 *
 * Every other status is left as it is. The rule itself is the one in `@clausewise/review`
 * (`settledStatus`), which the single-contract review applies right after parsing the model's
 * answer; this file adds nothing to it but the pass-through of `undetermined` (a rule that has no
 * status to settle) and the mapping from the stored rule to the playbook package's rule shape.
 * The store needs it too, so it lives here and not under `stages/`.
 *
 * The verify stage calls it first, before any check, for every workflow version (see
 * `verifyFinding`). It reads only `kind` and `required`.
 */

/**
 * The version of the settlement rule. The verify stage's input hash carries it, so a run that
 * was resumed after the rule changed does not reuse a verify output made under the old one.
 */
export const SETTLEMENT_VERSION = "s1";

export function settleStatus(
  rule: Pick<PlaybookRuleRecord, "key" | "title" | "severity" | "kind" | "required" | "standard">,
  status: Status,
): Status {
  if (status === "undetermined") return status;
  return settledStatus(
    {
      id: rule.key,
      title: rule.title,
      severity: rule.severity,
      kind: rule.kind,
      required: rule.required,
      standard: rule.standard,
    },
    status,
  );
}

/**
 * Why the rule settles a status the way it does, as a short clause that reads on its own in a
 * sentence ("..., so the status is ..."). It is one of three fixed texts chosen by the rule's flags
 * and holds nothing from a document or a playbook.
 */
export function settlementReason(rule: Pick<PlaybookRuleRecord, "kind" | "required">): string {
  if (rule.kind === "absence") return "the rule forbids something and a contract without it passes";
  return rule.required ? "the rule is required" : "the rule is not required";
}
