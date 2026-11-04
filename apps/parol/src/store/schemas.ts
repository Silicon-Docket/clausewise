import { z } from "zod";
import {
  CATEGORY_IDS,
  DOCUMENT_KINDS,
  DOC_LABELS,
  ESCALATION_CODES,
  EVIDENCE_ROLES,
  FALLBACK_BASES,
  STATUSES,
} from "../contracts.js";

/**
 * Zod schemas for every JSON column and for the structured values the store accepts. The store
 * validates on write because a column is read by modules that were written against the contract,
 * and one bad row would surface far from the call that made it.
 */

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
/** A playbook rule key: short, with no spaces, so a sentence of document text cannot pass for one. */
export const RULE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const id = z.string().min(1).max(200);

export const RunManifestSchema = z
  .object({
    matterId: id,
    clientLegalName: z.string().min(1),
    documents: z
      .array(
        z
          .object({
            documentVersionId: id,
            label: z.enum(DOC_LABELS),
            kind: z.enum(DOCUMENT_KINDS),
            title: z.string(),
            versionNo: z.number().int().positive(),
            statedDate: z.string().nullable(),
            textSha256: sha256,
          })
          .strict(),
      )
      .min(1)
      .max(3),
    playbook: z
      .object({ versionId: id, slug: z.string().min(1), version: z.string().min(1), sha256 })
      .strict(),
    workflow: z.object({ versionId: id, label: z.string().min(1), sha256 }).strict(),
    model: z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict(),
  })
  .strict();

export const WorkflowManifestSchema = z
  .object({
    label: z.string().min(1).max(64),
    prompts: z
      .object({
        extract: z.string().min(1),
        analyze: z.string().min(1),
        support: z.string().min(1).nullable(),
      })
      .strict(),
    retrieval: z.enum(["R1", "R2"]),
    checks: z.array(z.string().min(1)),
    budgetTokens: z.number().int().positive(),
    repairAttempts: z.number().int().min(0),
  })
  .strict();

/** A keyword-hint topic is spelt as a rule id is, which is how a playbook writes it. */
const hintTopic = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/)
  .max(64);

/** What `playbook_rules.rule_json` holds: everything of a rule that has no column of its own. */
export const RuleJsonSchema = z
  .object({
    title: z.string(),
    standard: z.string(),
    fallback: z.string().nullable(),
    unacceptable: z.string().nullable(),
    guidance: z.string().nullable(),
    fallbackLanguage: z.string().nullable(),
    escalateWhen: z.array(z.object({ id: z.string().min(1), text: z.string() }).strict()),
    // Absent on a rule imported before topics existed, which means every topic of its category.
    hintTopics: z.array(hintTopic).optional(),
  })
  .strict();

export const PlaybookRuleRecordSchema = z.object({
  key: z.string().regex(RULE_KEY_PATTERN),
  category: z.enum(CATEGORY_IDS),
  title: z.string(),
  severity: z.enum(["high", "medium", "low"]),
  required: z.boolean(),
  kind: z.enum(["presence", "absence"]),
  standard: z.string(),
  fallback: z.string().nullable(),
  unacceptable: z.string().nullable(),
  guidance: z.string().nullable(),
  fallbackLanguage: z.string().nullable(),
  escalateWhen: z.array(z.object({ id: z.string().min(1), text: z.string() })),
  hintTopics: z.array(hintTopic).optional(),
});

export const AnnotationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("defines_term"), spanId: id, term: z.string().min(1) }),
  z.object({ kind: z.literal("uses_term"), spanId: id, term: z.string().min(1) }),
  z.object({
    kind: z.literal("cross_reference"),
    spanId: id,
    target: z.string().min(1),
    verb: z.enum(["replaces", "amends", "deletes", "refers"]),
  }),
  z.object({ kind: z.literal("instruction_like"), spanId: id, pattern: z.string().min(1) }),
  z.object({
    kind: z.literal("keyword_hint"),
    spanId: id,
    category: z.enum(CATEGORY_IDS),
    // Absent for a category without topics and for an annotation stored before topics existed.
    topic: hintTopic.optional(),
  }),
]);

export const SpanSchema = z.object({
  id,
  documentVersionId: id,
  paragraphIndex: z.number().int().min(0),
  clauseId: z.string().min(1),
  clauseNumber: z.string().nullable(),
  heading: z.string().nullable(),
  text: z.string(),
  textSha256: sha256,
});

export const ReviewEditsSchema = z
  .object({
    status: z.enum(STATUSES).optional(),
    discrepancy: z.string().optional(),
    fallbackLanguage: z.string().optional(),
    evidenceRoles: z
      .array(z.object({ evidenceId: id, role: z.enum(EVIDENCE_ROLES) }).strict())
      .optional(),
  })
  .strict();

/** A verified finding as `saveFindings` accepts it. Extra properties are ignored, not stored. */
export const VerifiedFindingSchema = z.object({
  ruleKey: z.string().min(1),
  category: z.enum(CATEGORY_IDS),
  severity: z.enum(["high", "medium", "low"]),
  status: z.enum(STATUSES),
  evidence: z.array(
    z.object({
      spanId: id,
      quote: z.string(),
      role: z.enum(EVIDENCE_ROLES),
      quoteCheck: z.enum(["verified", "not_found", "ambiguous"]),
      offsets: z
        .object({ start: z.number().int().min(0), end: z.number().int().min(0) })
        .nullable(),
      supportCheck: z.enum(["supported", "not_supported", "insufficient", "not_run"]),
    }),
  ),
  discrepancy: z.string(),
  explanation: z.string(),
  fallbackLanguage: z.string().nullable(),
  fallbackBasis: z.enum(FALLBACK_BASES),
  conflict: z.string().nullable(),
  abstainReason: z.string().nullable(),
  checks: z.array(
    z.object({
      id: z.string().min(1).max(100),
      kind: z.enum(["deterministic", "model"]),
      outcome: z.enum(["pass", "fail", "not_applicable"]),
      detail: z.string(),
    }),
  ),
  escalations: z.array(z.object({ code: z.enum(ESCALATION_CODES), detail: z.string() })),
  verificationState: z.enum(["verified", "escalated_by_system"]),
  contentSha256: sha256,
});

export const CallRecordSchema = z.object({
  stage: z.enum(["extract", "analyze", "support"]),
  ruleKey: z.string().regex(RULE_KEY_PATTERN).nullable(),
  promptVersionId: z.string().min(1),
  requestSha256: sha256,
  attempt: z.number().int().min(1),
  outcome: z.enum([
    "ok",
    "schema_error",
    "semantic_error",
    "refusal",
    "cut_off",
    "transport",
    "fatal",
  ]),
  latencyMs: z.number().min(0),
  inputTokens: z.number().int().min(0).nullable(),
  outputTokens: z.number().int().min(0).nullable(),
  cacheReadTokens: z.number().int().min(0).nullable(),
  cacheWriteTokens: z.number().int().min(0).nullable(),
  costUsdEstimate: z.number().min(0).nullable().optional(),
  priceTableSha256: sha256.nullable().optional(),
});
