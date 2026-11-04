import { SupportSchema, type CallRecord, type SupportAnswer } from "../contracts.js";
import type { RegisteredPrompt, SupportChecker } from "../module-contracts.js";
import { renderContractBlock, renderRule } from "../prompts/render.js";
import { renderPrompt } from "../prompts/registry.js";
import { callModel } from "../stages/analyze-call.js";

/**
 * The model support check of a workflow that pins a support prompt: does the conclusion follow from
 * the cited passages and nothing else? It sees the rule, the claimed status and discrepancy, and the
 * spans the finding cites. The isolation is the design (docs/parol/03): it cannot fill a gap from
 * text the finding did not cite, which is also why it cannot catch a superseded clause on its own.
 *
 * One call and no retry here; the llm package retries what is retryable. A call that fails is not
 * thrown as an error, because then `verifyFinding` would lose its record: the checker answers with
 * a verdict it cannot have, `verifyFinding` reads that as "no usable verdict" (the finding is not
 * confirmed), and the failed call is recorded with its real outcome.
 */
export function createSupportChecker(prompt: RegisteredPrompt): SupportChecker {
  return async ({ generator, signal, rule, draft, citedSpans }) => {
    const text = renderPrompt(prompt.definition, {
      contractBlock: renderContractBlock(citedSpans),
      rule: renderRule(rule),
      status: draft.status,
      discrepancy: draft.discrepancy === "" ? "(none)" : draft.discrepancy,
    });
    const result = await callModel({
      generator,
      signal,
      stage: "support",
      ruleKey: rule.key,
      promptVersionId: prompt.definition.id,
      attempt: 1,
      system: prompt.definition.system,
      prompt: text,
      sharedPrefix: undefined,
      schema: SupportSchema,
      schemaName: prompt.definition.schemaName,
    });
    if (result.ok) return { answer: result.value, call: result.record("ok") };
    const call: CallRecord = result.record;
    return {
      answer: { verdict: "failed", missingPremise: null } as unknown as SupportAnswer,
      call,
    };
  };
}
