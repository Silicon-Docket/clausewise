import { normalizeForAnchor } from "@clausewise/review";
import { sha256Hex } from "../../canonical.js";
import {
  EVIDENCE_ROLES,
  type EvidenceRole,
  type QuoteCheck,
  type SourceSpan,
  type SpanId,
  type SupportCheck,
} from "../../contracts.js";
import { verifyQuote } from "../../quotes.js";
import type { RunIndex } from "./run-index.js";

/**
 * A quote shorter than this, once normalised, is not evidence: "the Agreement" or "two (2)" occurs
 * in nearly every contract, so finding it in a span shows nothing about the span. It is treated
 * as not found rather than as a weak match.
 */
export const MIN_QUOTE_CHARS = 12;

/**
 * A quote longer than this is not evidence either: it is a paragraph pasted in place of the words
 * that matter, and a reviewer cannot read what it points at. It is the model's job to quote the
 * clause's operative words.
 */
export const MAX_QUOTE_CHARS = 2000;

/** A finding that cites more than this has stopped citing. The rest are dropped and reported. */
export const MAX_EVIDENCE_ITEMS = 40;

// A quote past this is not even normalised: one pass over a pasted document would be wasted.
const RAW_QUOTE_LIMIT = 20_000;
// What is kept of a quote that was refused for its length, so the finding stays a sensible size.
const STORED_QUOTE_LIMIT = 4_000;

export type EvidenceProblem =
  "span_not_in_bundle" | "quote_empty" | "quote_too_short" | "quote_too_long" | "quote_not_found";

/** One cited passage as verify holds it. The span is always one the run really has. */
export interface Cited {
  spanId: SpanId;
  quote: string;
  role: EvidenceRole;
  span: SourceSpan;
  inBundle: boolean;
  quoteCheck: QuoteCheck;
  offsets: { start: number; end: number } | null;
  /** How many times a verified or ambiguous quote occurs in the span. */
  occurrences: number;
  problem: EvidenceProblem | null;
  supportCheck: SupportCheck;
}

export type DropReason = "invalid_item" | "unknown_span" | "duplicate" | "over_limit";

/** A cited item that could not be kept, by its place in the model's list. Never its content. */
export interface Dropped {
  /** 1-based position in the draft's evidence list. */
  position: number;
  reason: DropReason;
  /** The same passage cited again under a different role. */
  roleDiffers: boolean;
}

export interface EvidenceSet {
  cited: Cited[];
  dropped: Dropped[];
  /** How many items the draft listed. */
  received: number;
}

/** A passage whose quote exists in its span: verified, or ambiguous (valid, but in several places). */
export const isUsable = (item: Cited): boolean =>
  item.quoteCheck === "verified" || item.quoteCheck === "ambiguous";

/** How a reviewer finds the item: its place in the finding and the span's label. */
export const refOf = (items: readonly Cited[], item: Cited): string =>
  `evidence ${items.indexOf(item) + 1} (${item.span.label})`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRole = (value: unknown): value is EvidenceRole =>
  typeof value === "string" && (EVIDENCE_ROLES as readonly string[]).includes(value);

// Cutting between the halves of a surrogate pair would leave a lone surrogate, which a database
// column or a document writer may refuse.
function clipQuote(quote: string): string {
  if (quote.length <= STORED_QUOTE_LIMIT) return quote;
  const last = quote.charCodeAt(STORED_QUOTE_LIMIT - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? STORED_QUOTE_LIMIT - 1 : STORED_QUOTE_LIMIT;
  return quote.slice(0, end);
}

/**
 * Turns the model's evidence list into cited passages. This is not a check: it runs whatever
 * check sets are enabled, because a finding cannot be formed without knowing which quotes are
 * valid. The checks then read the result and report on it.
 *
 * Quotation validity is decided here and only here: the span must be one the model was shown
 * (the bundle), the quote must have a plausible length once normalised, and it must occur in the
 * span text under the fixed normalisation of `verifyQuote`. A span the run does not have cannot
 * be stored or shown, so such an item is dropped and counted. Duplicates (the same span and the
 * same words) are dropped so a finding cannot look better supported by repeating itself.
 */
export function classifyEvidence(
  input: unknown,
  index: RunIndex,
  bundleIds: ReadonlySet<SpanId>,
): EvidenceSet {
  const list: unknown[] = Array.isArray(input) ? input : [];
  const cited: Cited[] = [];
  const dropped: Dropped[] = [];
  const seen = new Map<string, Cited>();

  list.forEach((entry, at) => {
    const position = at + 1;
    if (
      !isRecord(entry) ||
      typeof entry["spanId"] !== "string" ||
      typeof entry["quote"] !== "string" ||
      !isRole(entry["role"])
    ) {
      dropped.push({ position, reason: "invalid_item", roleDiffers: false });
      return;
    }
    const spanId = entry["spanId"];
    const role = entry["role"];
    const raw = entry["quote"];

    const span = index.spansById.get(spanId);
    if (span === undefined) {
      dropped.push({ position, reason: "unknown_span", roleDiffers: false });
      return;
    }

    const tooLongToRead = raw.length > RAW_QUOTE_LIMIT;
    const normalised = tooLongToRead ? null : normalizeForAnchor(raw).trim();
    const key = `${span.id}\u0000${normalised ?? `long:${sha256Hex(raw)}`}`;
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      dropped.push({ position, reason: "duplicate", roleDiffers: earlier.role !== role });
      return;
    }
    if (cited.length >= MAX_EVIDENCE_ITEMS) {
      dropped.push({ position, reason: "over_limit", roleDiffers: false });
      return;
    }

    const inBundle = bundleIds.has(span.id);
    let problem: EvidenceProblem | null = null;
    let quoteCheck: QuoteCheck = "not_found";
    let offsets: Cited["offsets"] = null;
    let occurrences = 0;
    if (!inBundle) problem = "span_not_in_bundle";
    else if (normalised === null || normalised.length > MAX_QUOTE_CHARS) problem = "quote_too_long";
    else if (normalised.length === 0) problem = "quote_empty";
    else if (normalised.length < MIN_QUOTE_CHARS) problem = "quote_too_short";
    else {
      const verdict = verifyQuote(span.text, raw);
      quoteCheck = verdict.check;
      offsets = verdict.offsets;
      occurrences = verdict.occurrences;
      if (verdict.check === "not_found") problem = "quote_not_found";
    }

    const item: Cited = {
      spanId: span.id,
      // A quote with a problem is not evidence, whatever the problem is, and is kept short. One
      // that verified is at most RAW_QUOTE_LIMIT characters, because a longer one is refused.
      quote: problem !== null ? clipQuote(raw) : raw,
      role,
      span,
      inBundle,
      quoteCheck,
      offsets,
      occurrences,
      problem,
      supportCheck: "not_run",
    };
    cited.push(item);
    seen.set(key, item);
  });

  return { cited, dropped, received: list.length };
}
