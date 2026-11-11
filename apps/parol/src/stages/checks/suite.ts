import type {
  CheckResult,
  ContextBundle,
  DeterminedStatus,
  Escalation,
  IngestOutput,
  PlaybookRuleRecord,
  RunManifest,
  SpanId,
  Status,
} from "../../contracts.js";
import { hintCountsFor } from "../../ingest/signals.js";
import { MAX_EVIDENCE_ITEMS, isUsable, refOf, type Cited, type EvidenceSet } from "./evidence.js";
import { extractFacts, isPlaceFact, isSupportedFact, type Fact } from "./facts.js";
import type { CheckOutput, RunIndex } from "./run-index.js";
import { findTermUses, isDefinedStemmed, stemTerms } from "./terms.js";
import { clipDetail, fold, listCapped } from "./text.js";

/**
 * The model's claim, cleaned so that every check reads plain values. It holds what the model
 * said and nothing the model could use to reach anything: strings, a status and a list of ids.
 */
export interface Claim {
  /** The status the checks judge: the model's own, or the one the playbook's flags settle it to. */
  status: Status;
  /** False when the draft carried something that is not a status; `status` is then undetermined. */
  statusValid: boolean;
  /**
   * The status the model stated, when settlement changed it to another one, and null otherwise.
   * A check that reads what the model claimed (and not what the playbook makes of it) reads this.
   */
  modelStatus: DeterminedStatus | null;
  discrepancy: string;
  explanation: string;
  fallbackLanguage: string | null;
  matched: unknown[];
  conflict: string | null;
  abstainReason: string | null;
}

export interface CheckContext {
  claim: Claim;
  set: EvidenceSet;
  rule: PlaybookRuleRecord;
  bundle: ContextBundle;
  bundleIds: ReadonlySet<SpanId>;
  ingest: IngestOutput;
  manifest: RunManifest;
  index: RunIndex;
}

function result(
  id: string,
  outcome: CheckResult["outcome"],
  detail: string,
  escalations: Escalation[] = [],
): CheckOutput {
  return {
    result: {
      id,
      kind: "deterministic",
      outcome,
      detail: clipDetail(detail),
    },
    escalations,
  };
}

const holdsDeterminedStatus = (status: Status): boolean =>
  status === "compliant" || status === "deviation";

const isRelied = (item: Cited): boolean => item.role === "governing" || item.role === "supporting";

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

// ---------------------------------------------------------------------------------------------
// quote_exists, span_in_bundle, evidence_set
// ---------------------------------------------------------------------------------------------

/**
 * Quotation validity. It examines the passages that sit in spans the model was shown; a passage
 * from any other span is reported by `span_in_bundle` and is not examined twice. A quote that is
 * ambiguous (it occurs in more than one place) is valid and passes, with the count in the detail.
 */
export function quoteExists({ set }: CheckContext): CheckOutput {
  const examined = set.cited.filter((c) => c.inBundle);
  if (set.cited.length === 0) return result("quote_exists", "not_applicable", "no evidence cited");
  if (examined.length === 0) {
    return result(
      "quote_exists",
      "not_applicable",
      `${plural(set.cited.length, "quote")} not examined, their spans are not in the bundle`,
    );
  }
  const bad = examined.filter((c) => c.problem !== null);
  const ambiguous = examined.filter((c) => c.quoteCheck === "ambiguous");
  const escalations: Escalation[] = bad.map((c) => ({
    code: "quote_not_verified",
    detail: `${refOf(set.cited, c)}: ${c.problem ?? "quote_not_found"}`,
  }));
  const verified = examined.filter((c) => c.quoteCheck === "verified").length;
  const notes = ambiguous.map(
    (c) => `${refOf(set.cited, c)} occurs in ${c.occurrences} places in its span`,
  );
  if (bad.length > 0) {
    return result(
      "quote_exists",
      "fail",
      `${bad.length} of ${examined.length} not verified: ${listCapped(escalations.map((e) => e.detail))}`,
      escalations,
    );
  }
  return result(
    "quote_exists",
    "pass",
    `${verified} verified, ${ambiguous.length} ambiguous${notes.length > 0 ? ` (${listCapped(notes)})` : ""}`,
  );
}

/** A model must not cite what it was not shown. */
export function spanInBundle({ set }: CheckContext): CheckOutput {
  const unknown = set.dropped.filter((d) => d.reason === "unknown_span");
  if (set.cited.length === 0 && unknown.length === 0) {
    return result("span_in_bundle", "not_applicable", "no evidence cited");
  }
  const outside = set.cited.filter((c) => !c.inBundle);
  const escalations: Escalation[] = [
    ...outside.map((c): Escalation => ({
      code: "quote_not_verified",
      detail: `${refOf(set.cited, c)}: span_not_in_bundle`,
    })),
    ...unknown.map((d): Escalation => ({
      code: "quote_not_verified",
      detail: `draft evidence ${d.position}: span_not_in_bundle, the span is not part of this run and the entry was removed`,
    })),
  ];
  if (escalations.length === 0) {
    return result(
      "span_in_bundle",
      "pass",
      `${plural(set.cited.length, "cited span")} all in the bundle`,
    );
  }
  return result(
    "span_in_bundle",
    "fail",
    `${plural(escalations.length, "cited span")} not in the bundle: ${listCapped(escalations.map((e) => e.detail))}`,
    escalations,
  );
}

/**
 * The shape of the evidence list itself: entries that are not evidence at all, the same passage
 * cited twice, and a list longer than a finding can sensibly cite. The offending entries are
 * removed from the finding before it is stored, and this check says how many and why.
 */
export function evidenceSet({ set }: CheckContext): CheckOutput {
  const of = (reason: string) => set.dropped.filter((d) => d.reason === reason);
  const malformed = of("invalid_item");
  const duplicates = of("duplicate");
  const over = of("over_limit");
  const escalations: Escalation[] = [];
  if (malformed.length > 0) {
    escalations.push({
      code: "support_not_confirmed",
      detail: `evidence entries that are not a span, a quote and a role were removed: draft items ${listCapped(malformed.map((d) => String(d.position)))}`,
    });
  }
  if (duplicates.length > 0) {
    const roles = duplicates.filter((d) => d.roleDiffers);
    escalations.push({
      code: "support_not_confirmed",
      detail: `the same passage was cited more than once and the repeats were removed: draft items ${listCapped(duplicates.map((d) => String(d.position)))}${roles.length > 0 ? `; ${plural(roles.length, "repeat")} under a different role` : ""}`,
    });
  }
  if (over.length > 0) {
    escalations.push({
      code: "support_not_confirmed",
      detail: `more than ${MAX_EVIDENCE_ITEMS} passages were cited and ${over.length} beyond the limit were removed`,
    });
  }
  if (escalations.length === 0) {
    return result("evidence_set", "pass", `${plural(set.cited.length, "passage")} cited`);
  }
  return result("evidence_set", "fail", escalations.map((e) => e.detail).join("; "), escalations);
}

// ---------------------------------------------------------------------------------------------
// citation_shape
// ---------------------------------------------------------------------------------------------

/**
 * Whether the evidence has the shape its status needs. A determined status needs a verified (or
 * ambiguous) quote in a governing or supporting role; `missing` and `not_applicable` must cite
 * no passage in those roles; and both must have been judged over the whole document, since a
 * clause the model was not shown cannot be shown to be absent. `not_applicable` also needs a rule
 * the playbook does not require: a required rule that no clause covers is `missing`.
 */
export function citationShape({ claim, set, bundle, rule }: CheckContext): CheckOutput {
  const { status } = claim;
  const relied = set.cited.filter(isRelied);
  const problems: string[] = [];
  if (holdsDeterminedStatus(status)) {
    const good = relied.filter(isUsable);
    // An absence rule is met by the lack of a clause, and there is nothing to quote for that. It
    // is the same whole-document claim as `missing`, so it needs the whole document.
    const nothingToCite = status === "compliant" && rule.kind === "absence" && relied.length === 0;
    if (good.length === 0 && nothingToCite) {
      if (!bundle.fullDocument) {
        problems.push(
          "status compliant on an absence rule cites nothing, so it needs the whole document in the bundle, and it was not",
        );
      }
    } else if (good.length === 0) {
      problems.push(
        `status ${status} needs a verified governing or supporting quote, and none is cited (${plural(set.cited.length, "passage")} cited, ${plural(set.cited.filter(isUsable).length, "quote")} verified)`,
      );
    }
    // Settlement turned the model's missing or not_applicable into compliant (an absence rule). The
    // model's answer was that no clause covers the topic, and that answer must cite no passage in a
    // relied role: a governing quote beside it is a contradiction, and the settled status must not
    // be what hides it. The quote would otherwise satisfy the compliant branch above by itself.
    if (
      (claim.modelStatus === "missing" || claim.modelStatus === "not_applicable") &&
      relied.length > 0
    ) {
      problems.push(
        `the workflow stated ${claim.modelStatus} and cites governing or supporting passages: ${listCapped(relied.map((c) => refOf(set.cited, c)))}`,
      );
    }
  } else if (status === "missing" || status === "not_applicable") {
    if (relied.length > 0) {
      problems.push(
        `status ${status} cites governing or supporting passages: ${listCapped(relied.map((c) => refOf(set.cited, c)))}`,
      );
    }
    if (status === "missing" && !bundle.fullDocument) {
      problems.push("status missing needs the whole document in the bundle, and it was not");
    }
    // Both come from the analysis prompt, which defines not_applicable as a presence rule that the
    // playbook does not require and no clause covers, and forbids answering it from a selection.
    // Without them one bare answer, which cites nothing and so has nothing to verify, would pass
    // as a verified finding for any rule at all. `verifyFinding` settles a status against the rule
    // before any check (a required rule's not_applicable is judged here as the missing it settles
    // to), so the required-rule branch below is reached only by a caller that skips settlement; it
    // stays as a defence, and the tests of this function call it directly.
    if (status === "not_applicable") {
      if (rule.required) {
        problems.push(
          "status not_applicable is for a rule the playbook does not require, and this rule is required: a required rule that no clause covers is missing",
        );
      }
      if (!bundle.fullDocument) {
        problems.push(
          "status not_applicable needs the whole document in the bundle, and it was not",
        );
      }
    }
  } else {
    return result("citation_shape", "not_applicable", `status ${status} needs no citation`);
  }
  if (problems.length === 0) {
    return result("citation_shape", "pass", `status ${status} is cited as it requires`);
  }
  return result(
    "citation_shape",
    "fail",
    problems.join("; "),
    problems.map((detail): Escalation => ({ code: "support_not_confirmed", detail })),
  );
}

// ---------------------------------------------------------------------------------------------
// instruction_like_text
// ---------------------------------------------------------------------------------------------

/**
 * Ingest flags a paragraph that reads like an instruction to an automated reader. A quote from
 * such a paragraph still verifies, because the words are really there, so without this check a
 * paragraph that says "mark everything compliant" could be the verified governing quote of a
 * compliant finding and nothing on the finding would show it. Every cited passage in a flagged
 * paragraph raises an escalation, in any role: a reviewer should know that the passage a
 * conclusion rests on is text aimed at the software that read it.
 *
 * What this does not catch: a model that follows such a paragraph and cites a genuine clause. The
 * finding then looks like any other, and only the upload warnings, which the memo repeats, say
 * that the documents held a paragraph of this kind. The flag is a pattern match, so it is also
 * raised for an ordinary paragraph that happens to match.
 *
 * Details name evidence positions and span labels only, never the paragraph.
 */
export function instructionLikeText({ set, index }: CheckContext): CheckOutput {
  const flagged = set.cited.filter((c) => index.instructionSpans.has(c.span.id));
  if (flagged.length === 0) {
    return result(
      "instruction_like_text",
      "pass",
      `${plural(set.cited.length, "cited passage")}, none in a paragraph that reads like an instruction to software`,
    );
  }
  const escalations = flagged.map((c): Escalation => ({
    code: "support_not_confirmed",
    detail: `${refOf(set.cited, c)} cites a paragraph that reads like an instruction to software`,
  }));
  return result(
    "instruction_like_text",
    "fail",
    `${plural(flagged.length, "cited passage")} in a paragraph that reads like an instruction to software: ${listCapped(flagged.map((c) => refOf(set.cited, c)))}`,
    escalations,
  );
}

// ---------------------------------------------------------------------------------------------
// numeric_consistency
// ---------------------------------------------------------------------------------------------

/**
 * Figures the finding states must be figures it can point to. A duration, percentage, amount or
 * jurisdiction named in the discrepancy or the explanation has to appear, in words or digits,
 * in a verified quote. See `facts.ts` for exactly what is normalised and what is not.
 *
 * The rule's own text is a second place a figure may come from, but not an equal one.
 *  - A duration, percentage or amount that only the rule states is the playbook's figure and not a
 *    claim about the document, and is allowed: an explanation compares the clause with the
 *    standard ("shorter than the three years the standard allows"). The price is that the check
 *    cannot tell a figure the document states from the same figure the rule also states: if the
 *    rule says three years and the explanation says the document says three years, the rule covers
 *    it.
 *  - A jurisdiction that only the rule names is allowed only when the finding is comparing the
 *    document with the playbook, which it shows by naming a place a verified quote names. When
 *    the quotes name a place and the finding does not, a place from the playbook's list stands in
 *    for the document's ("governed by Delaware law" over a quote that says Texas) and fails. When
 *    no quote names a place, as with a clause that names none or a rule whose finding is that the
 *    clause is missing, the rule's places can only be the standard being compared with, and are
 *    allowed. This rule is narrower than the one for numbers because a jurisdiction is the
 *    substance of a governing-law finding, and the approved list is the likeliest wrong answer.
 */
export function numericConsistency({ claim, set, rule }: CheckContext): CheckOutput {
  const claimed: Fact[] = [];
  const seen = new Set<string>();
  for (const fact of [...extractFacts(claim.discrepancy), ...extractFacts(claim.explanation)]) {
    if (seen.has(fact.key)) continue;
    seen.add(fact.key);
    claimed.push(fact);
  }
  if (claimed.length === 0) {
    return result(
      "numeric_consistency",
      "not_applicable",
      "the discrepancy and explanation state no duration, percentage, amount or jurisdiction",
    );
  }
  const quoted = new Set<string>();
  for (const item of set.cited) {
    if (!isUsable(item)) continue;
    for (const fact of extractFacts(item.quote, { expand: true })) quoted.add(fact.key);
  }
  const ruleTexts = [
    rule.title,
    rule.standard,
    rule.fallback,
    rule.unacceptable,
    rule.guidance,
    rule.fallbackLanguage,
    ...rule.escalateWhen.map((e) => e.text),
  ];
  const stated = new Set<string>();
  for (const text of ruleTexts) {
    if (text === null || text === undefined) continue;
    for (const fact of extractFacts(text, { expand: true })) stated.add(fact.key);
  }
  const quotesNamePlace = [...quoted].some((key) => key.startsWith("jur:"));
  const comparing = !quotesNamePlace || claimed.some((f) => isPlaceFact(f) && quoted.has(f.key));

  const absent: Fact[] = [];
  const ruleOnlyPlaces: Fact[] = [];
  for (const fact of claimed) {
    if (isSupportedFact(fact, quoted)) continue;
    if (!isSupportedFact(fact, stated)) absent.push(fact);
    else if (isPlaceFact(fact) && !comparing) ruleOnlyPlaces.push(fact);
  }
  if (absent.length === 0 && ruleOnlyPlaces.length === 0) {
    return result(
      "numeric_consistency",
      "pass",
      `${plural(claimed.length, "figure")} stated, each in a verified quote or the rule: ${listCapped(claimed.map((f) => f.label))}`,
    );
  }
  const parts: string[] = [];
  if (absent.length > 0) {
    parts.push(`not in any verified quote or the rule: ${listCapped(absent.map((f) => f.label))}`);
  }
  if (ruleOnlyPlaces.length > 0) {
    parts.push(
      `named only by the rule, and the quotes name a different place: ${listCapped(ruleOnlyPlaces.map((f) => f.label))}`,
    );
  }
  const detail = parts.join("; ");
  return result("numeric_consistency", "fail", detail, [{ code: "support_not_confirmed", detail }]);
}

// ---------------------------------------------------------------------------------------------
// parties
// ---------------------------------------------------------------------------------------------

function containsName(haystack: string, needle: string): boolean {
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const before = at === 0 ? "" : haystack[at - 1]!;
    const after = haystack[at + needle.length] ?? "";
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
  }
  return false;
}

/**
 * For a rule in the parties category, the client's legal name as entered at intake has to appear
 * in a verified governing or supporting quote, or in some span of the bundle (the preamble may be
 * in the bundle without being quoted). The names are compared after the fixed normalisation,
 * without regard to case, whole words only: "Lanternfish Software, Inc." is not found in
 * "Lanternfish Software Holdings, Inc.".
 */
export function parties({ rule, set, manifest, bundle, index }: CheckContext): CheckOutput {
  if (rule.category !== "parties") {
    return result("parties", "not_applicable", "the rule is not in the parties category");
  }
  const name = fold(manifest.clientLegalName);
  if (name === "") {
    const detail = "the run has no client legal name to look for";
    return result("parties", "fail", detail, [{ code: "parties_mismatch", detail }]);
  }
  const quoted = set.cited.filter((c) => isUsable(c) && isRelied(c));
  const inQuote = quoted.find((c) => containsName(fold(c.quote), name));
  if (inQuote !== undefined) {
    return result(
      "parties",
      "pass",
      `the client's name is in the quote of ${refOf(set.cited, inQuote)}`,
    );
  }
  let spans = 0;
  for (const entry of bundle.spans) {
    const span = index.spansById.get(entry.spanId);
    if (span === undefined) continue;
    spans++;
    if (containsName(fold(span.text), name)) {
      return result("parties", "pass", `the client's name is in bundle span ${span.label}`);
    }
  }
  const detail = `the client's legal name from intake is in no cited governing or supporting quote and in none of the ${plural(spans, "bundle span")}`;
  return result("parties", "fail", detail, [{ code: "parties_mismatch", detail }]);
}

// ---------------------------------------------------------------------------------------------
// missing_confirmation
// ---------------------------------------------------------------------------------------------

/**
 * "Missing" must survive the keyword hints. If ingest hinted a span of the rule's category, the
 * span is in the bundle and the finding neither cites nor explains it, the claim that no clause
 * exists is not confirmed. This is why `missing` needs the whole document in the bundle: the
 * hints can only be tested against what the model was shown.
 *
 * Only the hints that belong to the rule count. A category several rules share holds hints for
 * each rule's subject, and the clause that lets the recipient share with advisers is no candidate
 * for a missing clause about disclosure that law requires. A rule names its topics (`hintTopics`);
 * a hint of another topic is ignored, and a hint with no topic, or a rule with no topics, counts
 * as before.
 */
export function missingConfirmation({
  claim,
  set,
  rule,
  ingest,
  bundleIds,
  index,
}: CheckContext): CheckOutput {
  // An absence rule found compliant by citing no clause is the same claim as `missing`: that
  // nothing in the documents addresses the topic. So is a `missing` that settlement turned into
  // `not_applicable` (an optional rule): the model's claim that no clause exists is the thing to
  // confirm, and the playbook's reading of it does not make the claim any less in need of it.
  const claimsAbsence =
    claim.status === "missing" ||
    claim.modelStatus === "missing" ||
    (claim.status === "compliant" && rule.kind === "absence" && !set.cited.some(isRelied));
  if (!claimsAbsence) {
    return result(
      "missing_confirmation",
      "not_applicable",
      `status ${claim.status} claims no absence`,
    );
  }
  const cited = new Set(set.cited.map((c) => c.span.id));
  const labels: string[] = [];
  const seen = new Set<SpanId>();
  for (const annotation of ingest.annotations) {
    if (annotation.kind !== "keyword_hint" || annotation.category !== rule.category) continue;
    if (!hintCountsFor(rule.hintTopics, annotation.topic)) continue;
    if (!bundleIds.has(annotation.spanId) || cited.has(annotation.spanId)) continue;
    if (seen.has(annotation.spanId)) continue;
    seen.add(annotation.spanId);
    const span = index.spansById.get(annotation.spanId);
    if (span !== undefined) labels.push(span.label);
  }
  if (labels.length === 0) {
    return result(
      "missing_confirmation",
      "pass",
      `no uncited keyword hint for ${rule.category} in the bundle`,
    );
  }
  const detail = `keyword hints for ${rule.category} on ${listCapped(labels)} are in the bundle and are not cited`;
  return result("missing_confirmation", "fail", detail, [
    { code: "missing_not_confirmed", detail },
  ]);
}

// ---------------------------------------------------------------------------------------------
// playbook_escalation
// ---------------------------------------------------------------------------------------------

/**
 * The ids a model returns for the rule's escalation conditions have to be the rule's own. An id
 * the rule does not have is dropped: a model cannot invent policy. Each valid id escalates.
 */
export function playbookEscalation({ claim, rule }: CheckContext): CheckOutput {
  if (claim.matched.length === 0) {
    return result(
      "playbook_escalation",
      "not_applicable",
      "the analysis matched no escalation condition",
    );
  }
  const known = new Set(rule.escalateWhen.map((e) => e.id));
  const raised = new Set<string>();
  let unknown = 0;
  for (const id of claim.matched) {
    if (typeof id === "string" && known.has(id)) raised.add(id);
    else unknown++;
  }
  const escalations = [...raised].map((id): Escalation => ({
    code: "playbook_escalation",
    detail: `escalateWhen: ${id}`,
  }));
  if (unknown === 0) {
    return result("playbook_escalation", "pass", `raised ${listCapped([...raised])}`, escalations);
  }
  // An id the rule does not have came from the model and may be any text, so it is counted and
  // never repeated.
  return result(
    "playbook_escalation",
    "fail",
    `${plural(unknown, "id")} the rule does not have ${unknown === 1 ? "was" : "were"} dropped${raised.size > 0 ? `; raised ${listCapped([...raised])}` : ""}`,
    escalations,
  );
}

// ---------------------------------------------------------------------------------------------
// defined_term
// ---------------------------------------------------------------------------------------------

/**
 * A defined term in a quote needs a definition somewhere in the run. The heuristic that finds
 * terms, and what it misses, is in `terms.ts`. The detail gives where in the quote the term is
 * and never the term, which is document text.
 */
export function definedTerm({ set, manifest, index }: CheckContext): CheckOutput {
  const usable = set.cited.filter(isUsable);
  if (usable.length === 0) {
    return result("defined_term", "not_applicable", "no verified quote to read");
  }
  const escalations: Escalation[] = [];
  const stems = stemTerms(index.definedTerms);
  for (const item of usable) {
    const open = findTermUses(item.quote, manifest.clientLegalName).filter(
      (use) => !isDefinedStemmed(use.folded, stems),
    );
    if (open.length === 0) continue;
    const where = open.map((use) => `${use.start}-${use.end}`);
    escalations.push({
      code: "defined_term_unresolved",
      detail: `${refOf(set.cited, item)} uses ${plural(open.length, "term")} that no span of the run defines, at characters ${listCapped(where, 4)} of the normalised quote`,
    });
  }
  if (escalations.length === 0) {
    return result(
      "defined_term",
      "pass",
      `every defined term in ${plural(usable.length, "quote")} is defined`,
    );
  }
  return result("defined_term", "fail", escalations.map((e) => e.detail).join("; "), escalations);
}

// ---------------------------------------------------------------------------------------------
// model_abstained
// ---------------------------------------------------------------------------------------------

/**
 * `undetermined` is the model declining to state a status. It always carries an escalation, and
 * so does a draft whose status is not one of the five. The abstain reason is the model's text
 * and stays on the finding; it is not copied into the detail.
 */
export function modelAbstained({ claim }: CheckContext): CheckOutput {
  if (!claim.statusValid) {
    const detail = "the analysis gave a status that is not one of the five allowed values";
    return result("model_abstained", "fail", detail, [{ code: "output_invalid", detail }]);
  }
  if (claim.status === "undetermined") {
    const detail =
      claim.abstainReason === null
        ? "the analysis stated no status and gave no reason"
        : "the analysis stated no status and gave a reason, which is on the finding";
    return result("model_abstained", "fail", detail, [{ code: "model_abstained", detail }]);
  }
  return result("model_abstained", "pass", `the analysis stated status ${claim.status}`);
}
