/**
 * Turns what the Parol stages produced into the observations the scorer reads. The runner calls
 * these for each (case, repeat) after the workflow has run, with the extract output, the drafts
 * the analyze stage returned and the findings the verify stage made. Pure: no file, network or
 * clock.
 *
 * The scorer's observations are deliberately small. Each field says what a reviewer would have
 * seen, and none holds document text.
 */
import type {
  DraftFinding,
  ExtractOutput,
  SourceSpan,
  VerifiedFinding,
} from "../../../apps/parol/src/contracts.js";
import { verifyQuote } from "../../../apps/parol/src/quotes.js";
import type { ExtractionObservation, SlotObservation } from "./score.js";

/**
 * One finding for one (case, rule, repeat).
 *
 * `displayed` is whether the memo and the issue table show the quote as a quotation. A quote that
 * did not verify is shown struck through and kept out of exports, so it is not displayed.
 *
 * `modelQuotes` counts the quotes the analyze stage emitted in its final answer and how many of
 * them occur in the span they name, judged against the run's own spans and not against the
 * finding, because verification removes a repeated passage and a passage in a span the run does
 * not have, and neither is the model's quotation going wrong. A rule the workflow could not
 * analyse has no draft and emitted nothing.
 */
export function observeSlot(args: {
  caseKey: string;
  repeat: number;
  finding: VerifiedFinding;
  /** The analyze stage's answer for the rule. Absent when the rule was not analysed. */
  draft: DraftFinding | undefined;
  /** The spans of the run: `ingest.spans`. */
  spans: readonly SourceSpan[];
}): SlotObservation {
  const { finding, draft } = args;
  const byId = new Map(args.spans.map((span) => [span.id, span]));
  const emitted = draft?.evidence ?? [];
  const valid = emitted.filter((item) => {
    const span = byId.get(item.spanId);
    return span !== undefined && verifyQuote(span.text, item.quote).check !== "not_found";
  });
  return {
    caseKey: args.caseKey,
    ruleKey: finding.ruleKey,
    repeat: args.repeat,
    status: finding.status,
    verificationState: finding.verificationState,
    evidence: finding.evidence.map((item) => ({
      spanId: item.spanId,
      role: item.role,
      quoteCheck: item.quoteCheck,
      displayed: item.quoteCheck !== "not_found",
    })),
    escalationCodes: finding.escalations.map((escalation) => escalation.code),
    modelQuotes: { emitted: emitted.length, valid: valid.length },
  };
}

/** What the extract stage did for one case: the spans it located per category, and whether it ran. */
export function observeExtraction(args: {
  caseKey: string;
  repeat: number;
  extract: ExtractOutput;
}): ExtractionObservation {
  return {
    caseKey: args.caseKey,
    repeat: args.repeat,
    categories: Object.fromEntries(
      Object.entries(args.extract.categories).map(([category, entry]) => [
        category,
        // A pointer whose quote was not found is not a location the scorer should credit.
        {
          located: entry.located.filter((p) => p.quoteCheck === "verified").map((p) => p.spanId),
          notFound: entry.notFound,
        },
      ]),
    ),
    degraded: args.extract.degraded,
  };
}
