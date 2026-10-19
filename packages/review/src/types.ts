import type { Severity } from "@clausewise/playbook";
import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// The contract as the reviewer sees it
// ---------------------------------------------------------------------------------------------

export interface ClauseParagraph {
  /** The docx paragraph id, `p:<index>`. */
  id: string;
  text: string;
}

/** A unit the model can point at: usually one numbered paragraph, sometimes with sub-items. */
export interface Clause {
  /** `c1`, `c2`, ... in document order. The model refers to clauses by this id only. */
  id: string;
  /** The clause's own number as written, such as `3.1`, when its text starts with one. */
  number: string | undefined;
  /** Text of the nearest heading above this clause, if any. */
  heading: string | undefined;
  /** One or more paragraphs. Edits are anchored inside exactly one of these. */
  paragraphs: ClauseParagraph[];
  /** The paragraphs' text joined with a newline. */
  text: string;
}

// ---------------------------------------------------------------------------------------------
// What the model is asked to return for each playbook rule
// ---------------------------------------------------------------------------------------------

/**
 * This is the model-facing schema, so it stays plain: no optional keys (use nullable, which
 * strict structured-output modes require), no min/max constraints. Checks that need more than the
 * shape are done in code after parsing.
 */
export const RuleCheckSchema = z.object({
  status: z
    .enum(["compliant", "deviation", "missing", "not_applicable"])
    .describe(
      "compliant: the contract meets the playbook standard or a stated fallback. deviation: a clause addresses the topic but falls short of the standard. missing: the playbook requires this and no clause covers it. not_applicable: no clause covers the topic and the playbook does not require one.",
    ),
  clauseIds: z
    .array(z.string())
    .describe(
      "Ids such as c7 of the clauses this finding is about. Empty if none covers the topic.",
    ),
  explanation: z
    .string()
    .describe(
      "Two or three sentences for the reviewing lawyer: what the clause says and how it compares with the playbook.",
    ),
  comment: z
    .string()
    .describe(
      "A short margin comment for the lawyer. Empty string when status is compliant or not_applicable.",
    ),
  edit: z
    .object({
      clauseId: z.string().describe("The clause containing the quote."),
      quote: z
        .string()
        .describe(
          "Text copied exactly, character for character, from ONE paragraph of that clause. It must occur there once. Keep it as short as possible while staying unique.",
        ),
      replacement: z.string().describe("The wording to put in place of the quote."),
    })
    .nullable()
    .describe(
      "A minimal edit that would bring the clause to the playbook standard, or null if no safe single-paragraph edit exists.",
    ),
  suggestedClause: z
    .string()
    .nullable()
    .describe("For status missing only: complete wording for the clause to add. Otherwise null."),
});

export type RuleCheck = z.infer<typeof RuleCheckSchema>;
export type ProposedEdit = NonNullable<RuleCheck["edit"]>;

// ---------------------------------------------------------------------------------------------
// What a review produces
// ---------------------------------------------------------------------------------------------

export type RuleStatus = "compliant" | "deviation" | "missing" | "not_applicable" | "error";

export type EditOutcome =
  /** The model proposed no edit. */
  | { kind: "none" }
  /** The edit was anchored and written into the document as a tracked change. */
  | {
      kind: "applied";
      paragraphId: string;
      start: number;
      end: number;
      original: string;
      replacement: string;
    }
  /** An edit was proposed but could not be anchored or applied, so only a comment was written. */
  | { kind: "comment-only"; proposed: ProposedEdit; reason: string };

export interface RuleResult {
  ruleId: string;
  title: string;
  severity: Severity;
  required: boolean;
  status: RuleStatus;
  /** Ids of clauses the finding refers to, validated against the document. */
  clauseIds: string[];
  /** The numbers of those clauses as written in the contract, where they have one. */
  clauseNumbers: string[];
  explanation: string;
  comment: string;
  suggestedClause: string | null;
  edit: EditOutcome;
  /** Set when status is `error`: why this rule could not be checked. */
  error?: string;
}

export interface ReviewReport {
  document: string | undefined;
  playbook: { name: string; contractTypes: string[] };
  model: { provider: string; model: string; disclosure: string };
  counts: Record<RuleStatus, number>;
  /** Number of deviations and missing clauses by severity. */
  open: Record<Severity, number>;
  results: RuleResult[];
  stats: { paragraphs: number; clauses: number; windows: number; editsApplied: number };
}

export type ProgressEvent =
  | { type: "start"; rules: number; clauses: number; windows: number }
  | { type: "rule"; ruleId: string; status: RuleStatus; done: number; total: number };

export interface ReviewOptions {
  /** Author name written on tracked changes and comments. Default "Clausewise". */
  author?: string;
  /** Timestamp written on tracked changes and comments. Default: now. */
  date?: Date;
  /** Rule checks in flight at once. Default 4. */
  concurrency?: number;
  /** Largest prompt, in estimated tokens. Unset sends the whole contract every time. */
  maxContextTokens?: number;
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
}
