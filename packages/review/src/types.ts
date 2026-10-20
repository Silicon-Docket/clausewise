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
  // The definitions are the ones in the system prompt, word for word. A rule of kind "absence"
  // forbids something, so for it the clean contract is compliant and missing and not_applicable
  // do not apply.
  status: z
    .enum(["compliant", "deviation", "missing", "not_applicable"])
    .describe(
      "compliant: the contract meets the playbook standard or a stated fallback, or, for an absence rule, contains nothing the standard forbids. deviation: a clause addresses the topic but falls short of the standard, or, for an absence rule, contains what the standard forbids. missing: a presence rule that the playbook requires and no clause covers. not_applicable: a presence rule that the playbook does not require and no clause covers.",
    ),
  clauseIds: z
    .array(z.string())
    .describe(
      "Ids such as c7 of the clauses that bear on the rule, with the clause that contains the problem first (for a compliant result, the one that best shows compliance). Empty if no clause covers the topic.",
    ),
  explanation: z
    .string()
    .describe(
      "Two or three sentences stating the finding for the reviewing lawyer: what the clause says and how it compares with the playbook. Never mention clause ids.",
    ),
  comment: z
    .string()
    .describe(
      "A margin note for the lawyer in the Word file: about 60 words or fewer, plain words, what to change and why. Never mention clause ids. Empty string when status is compliant or not_applicable.",
    ),
  edit: z
    .object({
      clauseId: z.string().describe("The id of the clause that contains the quote."),
      quote: z
        .string()
        .describe(
          "Text copied exactly from ONE paragraph of that clause, starting and ending on whole words, never from the header line. It must occur exactly once in the whole clause, so add neighbouring words until it is unique. Straight and curly quotation marks, dashes and runs of spaces are matched loosely.",
        ),
      replacement: z
        .string()
        .describe(
          "The wording to put in place of the quote, in the contract's style and with its kind of quotation marks. The sentence must read correctly with it in place. An empty string deletes the quote. Use a bracketed placeholder such as [amount] for a value you do not have.",
        ),
    })
    .nullable()
    .describe(
      "One minimal change inside a single paragraph that would bring the clause to the standard. Null when the status is not deviation, when you are unsure what is wrong, or when the fix needs changes in several places.",
    ),
  suggestedClause: z
    .string()
    .nullable()
    .describe(
      "For status missing only: complete wording for the clause to add, using the contract's defined terms. Otherwise null.",
    ),
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
  /**
   * The opening words of each of those clauses that has no number, in the order of `clauseIds`,
   * on one line. It is how a reader is told which clause is meant when the contract gives none.
   * Absent when every clause the finding refers to has a number.
   */
  clauseExcerpts?: string[];
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
  /** Things the lawyer should know about this review that are not findings about a rule. */
  warnings?: string[];
  /** What the file holds that the model never saw: markup, notes, headers, hidden text. */
  notShown?: {
    trackedInsertions: number;
    trackedDeletions: number;
    comments: number;
    footnotes: number;
    endnotes: number;
    headerFooterParts: number;
    hiddenRuns: number;
    images: number;
  };
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
  /**
   * Which party of the contract the lawyer acts for, in their words, such as "Fabrikam Labs LLC,
   * the Recipient". Playbooks say "we"; this says who that is.
   */
  client?: string;
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
}
