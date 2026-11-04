import type { ObjectGenerator } from "@clausewise/llm";
import { findingContentSha256 } from "../canonical.js";
import {
  FORCES_UNDETERMINED,
  STATUSES,
  type CallRecord,
  type CheckResult,
  type DraftFinding,
  type Escalation,
  type EscalationCode,
  type Status,
  type SupportCheck,
  type VerifiedEvidence,
  type VerifiedFinding,
} from "../contracts.js";
import type {
  MakeUndetermined,
  VerifyArgs,
  VerifyFinding,
  VerifyResult,
} from "../module-contracts.js";
import {
  MAX_EVIDENCE_ITEMS,
  MAX_QUOTE_CHARS,
  MIN_QUOTE_CHARS,
  classifyEvidence,
  isUsable,
  type Cited,
} from "./checks/evidence.js";
import { ADAPTED_THRESHOLD, describeBasis, fallbackBasis } from "./checks/fallback.js";
import { precedenceLabels, supersededEvidence } from "./checks/precedence.js";
import { buildRunIndex, type CheckOutput } from "./checks/run-index.js";
import {
  citationShape,
  definedTerm,
  evidenceSet,
  missingConfirmation,
  modelAbstained,
  numericConsistency,
  parties,
  playbookEscalation,
  quoteExists,
  spanInBundle,
  type CheckContext,
  type Claim,
} from "./checks/suite.js";
import { asText, asTextOrNull, clipDetail } from "./checks/text.js";

/**
 * Verify decides what a reviewer is told about one analysed rule. It is deterministic apart from
 * the optional support checker, and it never trusts the model: every quote is looked up in the
 * run's own spans, every span, escalation id and status is validated against the run and the
 * rule, and a finding that fails a check is not repaired but escalated, with the check that
 * failed and where the reviewer should look.
 *
 * Two kinds of work happen here, and they differ in what `enabledChecks` does to them.
 *
 *  - Evidence is always classified (`classifyEvidence`): the finding cannot be formed without
 *    knowing which quotes are valid. The fallback basis and the content hash are always
 *    computed, and a status of `undetermined` always carries an escalation, because the design
 *    forbids an undetermined finding without one. With no check set enabled, a finding therefore
 *    has well-formed evidence, a basis, a hash and nothing else.
 *  - The checks themselves, which produce the rows of the trail and the escalations, run per
 *    set: `C1` is the baseline and `C2` adds the supersession check, which is measured as a
 *    separate workflow version. The support check runs whenever a checker is given. A name that
 *    is not a check set is a programming error and throws; an empty list is allowed and runs none.
 *
 * No detail, in a check or an escalation, holds document text: only span labels, positions in the
 * finding, counts, ids of the run's own rule and short reasons.
 */

export { ADAPTED_THRESHOLD, MAX_EVIDENCE_ITEMS, MAX_QUOTE_CHARS, MIN_QUOTE_CHARS };

/** The check sets there are. A name outside this list is refused, not ignored. */
const CHECK_SETS: ReadonlySet<string> = new Set(["C1", "C2"]);

/** The order of the trail, which is also the order escalations are listed in. */
const CHECK_ORDER = [
  "quote_exists",
  "span_in_bundle",
  "evidence_set",
  "citation_shape",
  "numeric_consistency",
  "precedence_labels",
  "superseded_evidence",
  "parties",
  "missing_confirmation",
  "playbook_escalation",
  "defined_term",
  "support",
  "model_abstained",
  "status_forced",
  "fallback_basis",
] as const;

// ---------------------------------------------------------------------------------------------
// The claim
// ---------------------------------------------------------------------------------------------

/** The draft as plain values. Whatever it carries that is not the expected type is read as empty. */
function readClaim(draft: DraftFinding): Claim {
  const raw = draft as unknown as Record<string, unknown>;
  const status = raw["status"];
  const valid = typeof status === "string" && (STATUSES as readonly string[]).includes(status);
  return {
    status: valid ? (status as Status) : "undetermined",
    statusValid: valid,
    discrepancy: asText(raw["discrepancy"]),
    explanation: asText(raw["explanation"]),
    fallbackLanguage: asTextOrNull(raw["fallbackLanguage"]),
    matched: Array.isArray(raw["escalateWhenMatched"]) ? raw["escalateWhenMatched"] : [],
    conflict: asTextOrNull(raw["conflict"]),
    abstainReason: asTextOrNull(raw["abstainReason"]),
  };
}

// ---------------------------------------------------------------------------------------------
// The support check
// ---------------------------------------------------------------------------------------------

/** An abort is the caller stopping the run, not a failure of the check, so it always propagates. */
function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name: unknown }).name === "AbortError")
  );
}

// For a checker that wants a generator when verify was given none. Using it is a wiring mistake,
// which then shows up as a failed support check on every finding instead of a crash.
const NO_GENERATOR: ObjectGenerator = {
  provider: "none",
  model: "none",
  disclosure: "no model: verifyFinding was given no generator",
  cachesSharedPrefix: false,
  generate: () => Promise.reject(new Error("verifyFinding was given no generator")),
};

const VERDICTS: readonly SupportCheck[] = ["supported", "not_supported", "insufficient"];

interface SupportOutcome {
  output: CheckOutput;
  calls: CallRecord[];
  verdict: SupportCheck | null;
}

function modelResult(
  outcome: CheckResult["outcome"],
  detail: string,
  escalations: Escalation[] = [],
): CheckOutput {
  return { result: { id: "support", kind: "model", outcome, detail }, escalations };
}

/**
 * Sends the checker only what the finding rests on: the spans of the quotes that exist, and a
 * copy of the draft with only those quotes in it. A quote that does not exist, a span the run
 * does not have and a repeated passage never reach it. One call, never a retry: a checker that
 * fails is a finding that is not confirmed.
 */
async function runSupportCheck(
  args: VerifyArgs,
  ctx: CheckContext,
  cited: readonly Cited[],
): Promise<SupportOutcome | null> {
  const checker = args.supportChecker;
  if (checker === undefined || checker === null) return null;
  const { claim } = ctx;
  if (claim.status !== "compliant" && claim.status !== "deviation") {
    return {
      output: modelResult("not_applicable", `status ${claim.status} needs no support check`),
      calls: [],
      verdict: null,
    };
  }
  const usable = cited.filter(isUsable);
  if (usable.length === 0) {
    return {
      output: modelResult("not_applicable", "no verified quote to show the checker"),
      calls: [],
      verdict: null,
    };
  }
  if (args.signal?.aborted === true) {
    throw args.signal.reason instanceof Error
      ? args.signal.reason
      : new DOMException("The operation was aborted", "AbortError");
  }

  const spans = [...new Map(usable.map((c) => [c.span.id, c.span])).values()];
  const known = new Set(ctx.rule.escalateWhen.map((e) => e.id));
  const shown: DraftFinding = {
    ruleKey: ctx.rule.key,
    status: claim.status,
    evidence: usable.map((c) => ({ spanId: c.spanId, quote: c.quote, role: c.role })),
    discrepancy: claim.discrepancy,
    explanation: claim.explanation,
    fallbackLanguage: claim.fallbackLanguage,
    escalateWhenMatched: claim.matched.filter(
      (id): id is string => typeof id === "string" && known.has(id),
    ),
    conflict: claim.conflict,
    abstainReason: claim.abstainReason,
  };

  const calls: CallRecord[] = [];
  let verdict: SupportCheck | null = null;
  let failure: string | null = null;
  try {
    const answered = await checker({
      rule: ctx.rule,
      draft: shown,
      citedSpans: spans,
      generator: args.generator ?? NO_GENERATOR,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    const call = (answered as { call?: unknown } | null | undefined)?.call;
    if (typeof call === "object" && call !== null) calls.push(call as CallRecord);
    const value = (answered as { answer?: { verdict?: unknown } } | null | undefined)?.answer
      ?.verdict;
    if (typeof value === "string" && (VERDICTS as readonly string[]).includes(value)) {
      verdict = value as SupportCheck;
    } else failure = "the checker returned no usable verdict";
  } catch (error) {
    if (isAbortError(error, args.signal)) throw error;
    // The message of an error from a model call can carry what the model was shown.
    failure = "the support checker failed and gave no verdict";
  }

  const count = `${spans.length} cited ${spans.length === 1 ? "span" : "spans"}`;
  if (verdict === "supported") {
    return {
      output: modelResult("pass", `the checker found the claim supported by ${count}`),
      calls,
      verdict,
    };
  }
  const detail =
    verdict === null
      ? `${failure ?? "the support check gave no verdict"}, over ${count}`
      : `the checker's verdict over ${count} is ${verdict}`;
  return {
    output: modelResult("fail", detail, [{ code: "support_not_confirmed", detail }]),
    calls,
    verdict,
  };
}

// ---------------------------------------------------------------------------------------------
// verifyFinding
// ---------------------------------------------------------------------------------------------

function dedupe(escalations: readonly Escalation[]): Escalation[] {
  const seen = new Set<string>();
  const out: Escalation[] = [];
  for (const escalation of escalations) {
    const key = `${escalation.code}\u0000${escalation.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ code: escalation.code, detail: clipDetail(escalation.detail) });
  }
  return out;
}

export const verifyFinding: VerifyFinding = async (args): Promise<VerifyResult> => {
  const { draft, bundle, rule, ingest, manifest } = args;
  // These come from the run and the rule, not from the model. A mismatch is a bug in the caller,
  // so it is a plain error that names no ids.
  if (draft.ruleKey !== rule.key || bundle.ruleKey !== rule.key) {
    throw new Error("verifyFinding: the draft, the bundle and the rule are not for the same rule");
  }

  // A check set this module does not have would otherwise be skipped without a word, and a
  // misspelt "C1" would produce a finding that failed no check because it ran none. An empty list
  // is a choice and stays allowed; a name that is not a set is a bug in the caller.
  const unknown = args.enabledChecks.findIndex((name) => !CHECK_SETS.has(name));
  if (unknown !== -1) {
    const name: unknown = args.enabledChecks[unknown];
    const shown = typeof name === "string" ? name : "(not a string)";
    throw new Error(
      `verifyFinding: unknown check set "${shown.length > 24 ? `${shown.slice(0, 24)}...` : shown}"`,
    );
  }
  const enabled = new Set(args.enabledChecks);
  const index = buildRunIndex(ingest, manifest);
  const bundleIds = new Set(bundle.spans.map((s) => s.spanId));
  const claim = readClaim(draft);
  const set = classifyEvidence(
    (draft as unknown as Record<string, unknown>)["evidence"],
    index,
    bundleIds,
  );
  const ctx: CheckContext = { claim, set, rule, bundle, bundleIds, ingest, manifest, index };
  const items = set.cited;

  const outputs = new Map<string, CheckOutput>();
  if (enabled.has("C1")) {
    outputs.set("quote_exists", quoteExists(ctx));
    outputs.set("span_in_bundle", spanInBundle(ctx));
    outputs.set("evidence_set", evidenceSet(ctx));
    outputs.set("citation_shape", citationShape(ctx));
    outputs.set("numeric_consistency", numericConsistency(ctx));
    outputs.set("precedence_labels", precedenceLabels(items, claim.conflict, index));
    outputs.set("parties", parties(ctx));
    outputs.set("missing_confirmation", missingConfirmation(ctx));
    outputs.set("playbook_escalation", playbookEscalation(ctx));
    outputs.set("defined_term", definedTerm(ctx));
  }
  if (enabled.has("C2")) outputs.set("superseded_evidence", supersededEvidence(items, index));

  // An undetermined finding always carries an escalation, whatever is enabled.
  const abstained = modelAbstained(ctx);
  if (enabled.has("C1") || abstained.result.outcome === "fail") {
    outputs.set("model_abstained", abstained);
  }

  const calls: CallRecord[] = [];
  const support = await runSupportCheck(args, ctx, items);
  if (support !== null) {
    outputs.set("support", support.output);
    calls.push(...support.calls);
    if (support.verdict !== null) {
      for (const item of items) if (isUsable(item)) item.supportCheck = support.verdict;
    }
  }

  // Status. A forcing escalation turns any determined status into `undetermined`; the discrepancy
  // and explanation stay as the model wrote them, and nothing is added.
  const escalations = dedupe(CHECK_ORDER.flatMap((id) => outputs.get(id)?.escalations ?? []));
  const forcing = [
    ...new Set(escalations.filter((e) => FORCES_UNDETERMINED.has(e.code)).map((e) => e.code)),
  ];
  let status: Status = claim.status;
  if (status !== "undetermined" && forcing.length > 0) {
    outputs.set("status_forced", {
      result: {
        id: "status_forced",
        kind: "deterministic",
        outcome: "fail",
        detail: `status ${status} was changed to undetermined because of ${forcing.join(", ")}`,
      },
      escalations: [],
    });
    status = "undetermined";
  }

  // Fallback language. It is guidance on a change, so a finding that needs no change offers none.
  const needsNoChange = claim.status === "compliant" || claim.status === "not_applicable";
  const fallbackLanguage = needsNoChange ? null : claim.fallbackLanguage;
  const basis = fallbackBasis(fallbackLanguage, rule);
  if (enabled.has("C1")) {
    outputs.set("fallback_basis", {
      result: {
        id: "fallback_basis",
        kind: "deterministic",
        outcome: fallbackLanguage === null ? "not_applicable" : "pass",
        detail:
          claim.fallbackLanguage === null
            ? "the finding offers no fallback language"
            : needsNoChange
              ? `fallback language dropped, status ${claim.status} needs no change`
              : describeBasis(basis),
      },
      escalations: [],
    });
  }

  const checks: CheckResult[] = CHECK_ORDER.flatMap((id) => {
    const output = outputs.get(id);
    return output === undefined
      ? []
      : [{ ...output.result, detail: clipDetail(output.result.detail) }];
  });

  const evidence: VerifiedEvidence[] = items.map((item) => ({
    spanId: item.spanId,
    quote: item.quote,
    role: item.role,
    quoteCheck: item.quoteCheck,
    offsets: item.offsets,
    supportCheck: item.supportCheck,
  }));

  const content = {
    ruleKey: rule.key,
    status,
    discrepancy: claim.discrepancy,
    explanation: claim.explanation,
    fallbackLanguage,
    fallbackBasis: basis.basis,
    conflict: claim.conflict,
    evidence,
    escalations,
  };
  const finding: VerifiedFinding = {
    ruleKey: rule.key,
    category: rule.category,
    severity: rule.severity,
    status,
    evidence,
    discrepancy: claim.discrepancy,
    explanation: claim.explanation,
    fallbackLanguage,
    fallbackBasis: basis.basis,
    conflict: claim.conflict,
    abstainReason: claim.abstainReason,
    checks,
    escalations,
    verificationState:
      escalations.length === 0 && checks.every((c) => c.outcome !== "fail")
        ? "verified"
        : "escalated_by_system",
    contentSha256: findingContentSha256(content),
  };
  return { finding, calls };
};

// ---------------------------------------------------------------------------------------------
// makeUndetermined
// ---------------------------------------------------------------------------------------------

const REASON_IN_WORDS: Record<EscalationCode, string> = {
  output_invalid: "the analysis did not return a valid answer for this rule",
  context_over_budget:
    "the passages this rule needs are longer than the context budget allows, so the rule was not analysed",
  model_abstained: "the analysis declined to state a status for this rule",
  conflicting_sources:
    "passages of the documents disagree in a way the precedence rules do not settle",
  quote_not_verified: "a passage the analysis cited could not be found where it said",
  support_not_confirmed: "the passages cited do not establish the conclusion",
  superseded_evidence: "the analysis relied on a clause that an amendment changes",
  missing_not_confirmed: "keyword hints point to passages that the analysis did not explain",
  defined_term_unresolved: "a defined term that the analysis relied on has no definition",
  parties_mismatch: "the client's legal name does not appear in the parties passage",
  playbook_escalation: "the playbook sends this situation to an attorney",
};

/**
 * A finding for a rule the workflow could not analyse. It states no status and cites nothing; it
 * names the reason in plain words and carries the one escalation the caller gives. The detail is
 * the caller's: ids, counts and reasons, never document text. It is cut at a fixed length so a
 * careless caller cannot put a page of text in a finding.
 */
export const makeUndetermined: MakeUndetermined = ({ rule, code, detail }) => {
  const escalations: Escalation[] = [{ code, detail: clipDetail(detail) }];
  const explanation = `No status is stated for rule ${rule.key} (${rule.title}) because ${
    REASON_IN_WORDS[code] ?? "the workflow could not apply it"
  }. A reviewer needs to read the documents and decide this rule.`;
  const content = {
    ruleKey: rule.key,
    status: "undetermined" as const,
    discrepancy: "",
    explanation,
    fallbackLanguage: null,
    fallbackBasis: "none" as const,
    conflict: null,
    evidence: [],
    escalations,
  };
  return {
    ruleKey: rule.key,
    category: rule.category,
    severity: rule.severity,
    status: "undetermined",
    evidence: [],
    discrepancy: "",
    explanation,
    fallbackLanguage: null,
    fallbackBasis: "none",
    conflict: null,
    abstainReason: null,
    checks: [],
    escalations,
    verificationState: "escalated_by_system",
    contentSha256: findingContentSha256(content),
  };
};
