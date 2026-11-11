/**
 * The evidence trails of an evaluation run: for every rule slot of every run, what retrieval put in
 * front of the reader, what the finding cited, which checks passed, failed or did not apply, and
 * the escalation codes. They are recorded in the results file (optional field `trails`) so that the
 * comparison page can show, for a slot whose answer changed, where each version looked.
 *
 * A trail is made of labels, indexes, offsets and closed codes. It holds no text: no paragraph,
 * no quotation (the offsets say where a verified quote sits inside a paragraph, and the paragraph
 * is in the case files), no check detail, no prompt and no model answer. The results file keeps its
 * rule that nothing a model wrote is in it, and `trailRecordSchema` enforces the rule on read: every
 * string is a closed code, a label, a key or a hash, so a file that carries text is refused.
 *
 * A trail names paragraphs by document label and paragraph index. The same index names the same
 * paragraph only while the case files are the ones the run read, so the record carries a digest of
 * each case's text as the run read it (`textDigestOf`), and a page that reads the case files again
 * shows a trail only when the digest it computes is the recorded one.
 *
 * Nothing here logs, stores or throws text from a document, a model or a provider.
 */
import { z } from "zod";
import { hashOf } from "../../../apps/parol/src/canonical.js";
import {
  DOC_LABELS,
  ESCALATION_CODES,
  EVIDENCE_ROLES,
  type BundleSpanReason,
  type ContextBundle,
  type DocLabel,
  type EscalationCode,
  type EvidenceRole,
  type QuoteCheck,
  type SourceSpan,
  type VerifiedFinding,
} from "../../../apps/parol/src/contracts.js";
import {
  BUNDLE_SPAN_REASONS,
  PAGE_RULE_KEY,
  QUOTE_CHECKS,
} from "../../../apps/parol/src/evaluations/document.js";
import type { Split } from "../../../fixtures/parol/types.js";
import { EvalError } from "../errors.js";
import type { ObservedRun } from "./results.js";

export const TRAILS_FORMAT = 1 as const;

/** The most trails one results file holds. A run that makes more records none, and says so. */
export const MAX_TRAIL_ITEMS = 20_000;
/** The most paragraphs one trail lists as shown. The page document holds the same number. */
export const MAX_SHOWN_SPANS = 400;
/** The most passages one finding cites (the verify stage's own limit) and checks it lists. */
export const MAX_CITED = 40;
export const MAX_CHECK_IDS = 40;

/** A trail could not be made. The message is a fixed sentence and names no text. */
export class TrailError extends EvalError {
  override name = "TrailError";
}

// ---------------------------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------------------------

/** What retrieval put in front of the reader for one rule. Labels and indexes only. */
export interface TrailShown {
  /** False when the bundle was over the context budget and nothing was sent. */
  sent: boolean;
  /** True when the whole operative document was shown; `spans` is then empty. */
  full: boolean;
  /** Empty when `full` or when nothing was sent. */
  spans: { doc: DocLabel; paragraph: number; why: BundleSpanReason }[];
}

export interface TrailCited {
  doc: DocLabel;
  /** `span.paragraphIndex`. */
  paragraph: number;
  role: EvidenceRole;
  quoteCheck: QuoteCheck;
  /** Offsets of the verified quote inside the paragraph; null unless the quote was verified. */
  start: number | null;
  end: number | null;
}

/** Check ids by outcome, in suite order. No detail text: `CheckResult.detail` is not copied. */
export interface TrailChecks {
  pass: string[];
  fail: string[];
  notApplicable: string[];
}

export interface SlotTrail {
  split: Split;
  caseKey: string;
  ruleKey: string;
  repeat: number;
  verificationState: "verified" | "escalated_by_system";
  /** Each code once, in the order the finding lists them. */
  escalations: EscalationCode[];
  shown: TrailShown;
  cited: TrailCited[];
  checks: TrailChecks;
}

export interface TrailRecord {
  format: typeof TRAILS_FORMAT;
  /** caseKey -> digest of the case's operative document texts as the run read them. */
  cases: Record<string, string>;
  /** Sorted by split, caseKey, ruleKey and repeat, each combination once. */
  items: SlotTrail[];
}

// ---------------------------------------------------------------------------------------------
// One trail
// ---------------------------------------------------------------------------------------------

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/**
 * The trail of one finding. `cited` keeps the order of `finding.evidence`; a span id that is not
 * among `spans` is dropped (the verify stage has already removed such evidence, so none is lost).
 * `shown.sent` is false when there was no bundle or it was over budget, and nothing was sent then,
 * so no paragraph is listed. A rule whose analysis failed still has a bundle, so `shown` is filled
 * and `cited` is empty.
 */
export function trailOf(args: {
  split: Split;
  caseKey: string;
  repeat: number;
  finding: VerifiedFinding;
  bundle: ContextBundle | undefined;
  spans: readonly SourceSpan[];
}): SlotTrail {
  const { finding, bundle } = args;
  const byId = new Map(args.spans.map((span) => [span.id, span]));

  const cited: TrailCited[] = [];
  for (const item of finding.evidence) {
    const span = byId.get(item.spanId);
    if (span === undefined) continue;
    // Offsets exist only for a unique, verified quote. Anything else records none.
    const at = item.quoteCheck === "verified" ? item.offsets : null;
    cited.push({
      doc: span.docLabel,
      paragraph: span.paragraphIndex,
      role: item.role,
      quoteCheck: item.quoteCheck,
      start: at === null ? null : at.start,
      end: at === null ? null : at.end,
    });
  }

  const sent = bundle !== undefined && !bundle.overBudget;
  const full = bundle !== undefined && bundle.fullDocument;
  const listed: TrailShown["spans"] = [];
  if (sent && !full) {
    for (const entry of bundle.spans) {
      const span = byId.get(entry.spanId);
      if (span === undefined) continue;
      listed.push({ doc: span.docLabel, paragraph: span.paragraphIndex, why: entry.why });
    }
  }
  if (listed.length > MAX_SHOWN_SPANS || cited.length > MAX_CITED) {
    // The workflow's context budget and the verify stage's limit keep a real run far below both.
    throw new TrailError(
      "A rule slot has more paragraphs than a trail holds, so its trail cannot be recorded.",
    );
  }

  const ids = (outcome: "pass" | "fail" | "not_applicable"): string[] =>
    unique(finding.checks.filter((check) => check.outcome === outcome).map((check) => check.id));

  return {
    split: args.split,
    caseKey: args.caseKey,
    ruleKey: finding.ruleKey,
    repeat: args.repeat,
    verificationState: finding.verificationState,
    escalations: unique(finding.escalations.map((escalation) => escalation.code)),
    shown: { sent, full, spans: listed },
    cited,
    checks: { pass: ids("pass"), fail: ids("fail"), notApplicable: ids("not_applicable") },
  };
}

/**
 * A digest of the operative documents of a case as a run read them: the label and the text hash of
 * each, in order. It changes when a case file, the parser or the way text is cut into paragraphs
 * changes, which are the changes that make a paragraph index point at another paragraph.
 */
export function textDigestOf(
  documents: readonly { label: DocLabel; textSha256: string }[],
): string {
  return hashOf(documents.map((document) => [document.label, document.textSha256]));
}

// ---------------------------------------------------------------------------------------------
// The record of a run
// ---------------------------------------------------------------------------------------------

const order = (a: SlotTrail, b: SlotTrail): number =>
  a.split === b.split
    ? a.caseKey === b.caseKey
      ? a.ruleKey === b.ruleKey
        ? a.repeat - b.repeat
        : a.ruleKey < b.ruleKey
          ? -1
          : 1
      : a.caseKey < b.caseKey
        ? -1
        : 1
    : a.split < b.split
      ? -1
      : 1;

/** Why a run's trails were not kept, in a plain sentence for the results file's notes. */
export interface TrailRecordResult {
  record: TrailRecord | undefined;
  /** Set when trails were observed and left out; null when there were none or all were kept. */
  note: string | null;
}

export const TRAILS_TOO_MANY_NOTE =
  "Evidence trails were not recorded: the run has more rule slots than a results file holds trails for.";
export const TRAILS_DISAGREE_NOTE =
  "Evidence trails were not recorded: the repeats of a case read different text, so a trail cannot name a paragraph.";
export const TRAILS_UNDATED_NOTE =
  "Evidence trails were not recorded: a run did not say which text it read, so a trail cannot name a paragraph.";

/**
 * The record for the observed runs of a file, or none. No record when no run carries trails (a
 * scoring failure, or an old code path). When the runs disagree about the text of a case, or there
 * are more trails than a file holds, the record is left out and the note says why: a results file
 * that cannot be read back is worse than one without trails.
 */
export function trailRecordOf(observed: readonly ObservedRun[]): TrailRecordResult {
  const items: SlotTrail[] = [];
  const cases: Record<string, string> = {};
  for (const run of observed) {
    if (run.trails === undefined) continue;
    if (run.textDigest === undefined) return { record: undefined, note: TRAILS_UNDATED_NOTE };
    items.push(...run.trails);
    const seen = cases[run.caseKey];
    if (seen !== undefined && seen !== run.textDigest) {
      return { record: undefined, note: TRAILS_DISAGREE_NOTE };
    }
    cases[run.caseKey] = run.textDigest;
  }
  if (items.length === 0) return { record: undefined, note: null };
  if (items.length > MAX_TRAIL_ITEMS) return { record: undefined, note: TRAILS_TOO_MANY_NOTE };
  items.sort(order);
  return {
    record: {
      format: TRAILS_FORMAT,
      cases: Object.fromEntries(Object.entries(cases).sort(([a], [b]) => (a < b ? -1 : 1))),
      items,
    },
    note: null,
  };
}

/** Undefined when no observed run carries trails. */
export const buildTrailRecord = (observed: readonly ObservedRun[]): TrailRecord | undefined =>
  trailRecordOf(observed).record;

// ---------------------------------------------------------------------------------------------
// The schema: what a file may hold
// ---------------------------------------------------------------------------------------------

const count = z.number().int().min(0).max(1_000_000);
const paragraph = z.number().int().min(0).max(100_000);
const offset = z.number().int().min(0).max(10_000_000);
const sha = z.string().regex(/^[0-9a-f]{64}$/);
/** The same alphabets as the page document, which carries these keys on. */
const caseKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/);
const ruleKey = z.string().regex(PAGE_RULE_KEY);
const checkId = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const docLabel = z.enum(DOC_LABELS);

const shownSchema = z
  .strictObject({
    sent: z.boolean(),
    full: z.boolean(),
    spans: z
      .array(z.strictObject({ doc: docLabel, paragraph, why: z.enum(BUNDLE_SPAN_REASONS) }))
      .max(MAX_SHOWN_SPANS),
  })
  // The whole document is one statement and nothing sent lists nothing.
  .refine((shown) => (shown.full || !shown.sent ? shown.spans.length === 0 : true));

const citedSchema = z
  .strictObject({
    doc: docLabel,
    paragraph,
    role: z.enum(EVIDENCE_ROLES),
    quoteCheck: z.enum(QUOTE_CHECKS),
    start: offset.nullable(),
    end: offset.nullable(),
  })
  .refine((item) =>
    item.start === null || item.end === null
      ? item.start === null && item.end === null
      : item.quoteCheck === "verified" && item.start < item.end,
  );

const checksSchema = z.strictObject({
  pass: z.array(checkId).max(MAX_CHECK_IDS),
  fail: z.array(checkId).max(MAX_CHECK_IDS),
  notApplicable: z.array(checkId).max(MAX_CHECK_IDS),
});

const itemSchema = z.strictObject({
  split: z.enum(["dev", "heldout"]),
  caseKey,
  ruleKey,
  repeat: count.min(1),
  verificationState: z.enum(["verified", "escalated_by_system"]),
  escalations: z.array(z.enum(ESCALATION_CODES)).max(ESCALATION_CODES.length),
  shown: shownSchema,
  cited: z.array(citedSchema).max(MAX_CITED),
  checks: checksSchema,
});

/**
 * The record as a file may hold it. Every object is strict and every string a closed code, a label,
 * a key or a hash, so a trail that carries text, or a field this version does not know, is refused.
 * Items are sorted and each combination of split, case, rule and repeat is there once, which is
 * what lets a reader look one up without choosing between two; each case has its digest.
 */
export const trailRecordSchema: z.ZodType<TrailRecord> = z
  .strictObject({
    format: z.literal(TRAILS_FORMAT),
    cases: z.record(caseKey, sha),
    items: z.array(itemSchema).max(MAX_TRAIL_ITEMS),
  })
  .refine((record) =>
    record.items.every(
      (item, index) =>
        Object.hasOwn(record.cases, item.caseKey) &&
        (index === 0 || order(record.items[index - 1] as SlotTrail, item as SlotTrail) < 0),
    ),
  ) as unknown as z.ZodType<TrailRecord>;
