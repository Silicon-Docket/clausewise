import { sha256Hex } from "../canonical.js";
import type {
  AnalysisAnswer,
  EvidenceRole,
  LocateAnswer,
  Status,
  SupportAnswer,
} from "../contracts.js";
import { fold, type PromptView, type ShownClause } from "./prompt-view.js";
import {
  DURATION,
  EXTRACT_TABLE,
  IDENTITY_NAMES,
  KNOWN_PARAGRAPHS,
  NOT_SHOWN,
  NOT_THE_EXAMPLE,
  PASSAGES,
  RETURN,
  SIMPLE_RULES,
  UNKNOWN_RULE,
  UNORDERED,
  type PassageId,
} from "./worked-example.js";

/**
 * The reasoning of the simulated reader, as plain code over a table of phrases. It is a stand-in
 * for a model that is shown a selection of clauses and reads them, so every conclusion here is a
 * function of the clauses in the request and of nothing else. It has no memory of other requests
 * and no way to look at the rest of the document, which is how a retrieval gap turns into a
 * wrong answer: leave the amendment out of the clauses and the reader says what a reader who
 * never saw the amendment would say.
 *
 * It is not a language model and its answers are not a measurement of one.
 */

// ---------------------------------------------------------------------------------------------
// Finding the passages it knows
// ---------------------------------------------------------------------------------------------

const KNOWN = new Set(
  Object.entries(KNOWN_PARAGRAPHS).flatMap(([doc, digests]) =>
    digests.map((digest) => `${doc}:${digest}`),
  ),
);

/**
 * Whether a shown clause is a paragraph of the worked example, word for word, in the document it is
 * shown under. A paragraph with a word added or changed is not that paragraph, however many of its
 * phrases are still there.
 */
export function isKnownClause(clause: ShownClause): boolean {
  return clause.doc !== null && KNOWN.has(`${clause.doc}:${sha256Hex(fold(clause.text))}`);
}

/**
 * Whether every clause shown is a paragraph of the example (and there is at least one). This is what
 * lets the reader say anything about a block. One clause it does not know could change what the
 * rest mean, or be the clause a rule is about, so a block that holds one is not read at all.
 */
export function isKnownBlock(view: PromptView): boolean {
  return view.clauses.length > 0 && view.clauses.every(isKnownClause);
}

/**
 * The shown clause that holds a known passage: a paragraph of the example, in the document the
 * passage belongs to, with the words that pick it out and the words it will be cited by both
 * present. A clause of another document that happens to hold the same words is not that passage,
 * and nor is an edited paragraph.
 */
export function locate(view: PromptView, id: PassageId): ShownClause | undefined {
  const passage = PASSAGES[id];
  return view.clauses.find(
    (clause) =>
      clause.doc === passage.doc &&
      isKnownClause(clause) &&
      clause.text.includes(passage.find) &&
      clause.text.includes(passage.quote),
  );
}

/**
 * Whether the clauses shown are from the worked example, which is all the reader can read: every
 * one of them is a paragraph of it, and the two parties are named among them.
 */
export function isWorkedExample(view: PromptView): boolean {
  const shown = view.clauses.map((clause) => clause.text).join("\n");
  return isKnownBlock(view) && IDENTITY_NAMES.every((name) => shown.includes(name));
}

// ---------------------------------------------------------------------------------------------
// Extract
// ---------------------------------------------------------------------------------------------

const NOT_LOCATED =
  "No clause shown deals with this topic in words the simulated reader looks for.";

export function answerExtract(view: PromptView): LocateAnswer {
  const known = isWorkedExample(view);
  return {
    categories: EXTRACT_TABLE.map(({ category, passages }) => {
      const found = known
        ? passages.flatMap((id) => {
            const clause = locate(view, id);
            return clause === undefined ? [] : [{ span: clause.label, quote: PASSAGES[id].quote }];
          })
        : [];
      return {
        category,
        passages: found,
        notFoundReason: found.length > 0 ? null : known ? NOT_LOCATED : NOT_THE_EXAMPLE.reason,
      };
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Analyze
// ---------------------------------------------------------------------------------------------

type Evidence = AnalysisAnswer["evidence"][number];

const cite = (clause: ShownClause, id: PassageId, role: EvidenceRole): Evidence => ({
  span: clause.label,
  quote: PASSAGES[id].quote,
  role,
});

function answer(status: Status, fields: Partial<AnalysisAnswer> = {}): AnalysisAnswer {
  return {
    status,
    evidence: [],
    discrepancy: "",
    explanation: "",
    fallbackLanguage: null,
    escalateWhenMatched: [],
    conflict: null,
    abstainReason: null,
    ...fields,
  };
}

function abstain(reason: string): AnalysisAnswer {
  return answer("undetermined", { explanation: reason, abstainReason: reason });
}

/**
 * A clause the rule needs is not among the passages. Shown every paragraph, the reader can say the
 * documents do not cover the topic. Shown a selection, it cannot, because the clause may be in a
 * paragraph it was not given; that is the difference between missing and undetermined.
 */
function notShown(view: PromptView, topic: string): AnalysisAnswer {
  if (view.coverage === "selection") {
    const reason = NOT_SHOWN.selection(topic);
    return answer("undetermined", { explanation: reason, abstainReason: reason });
  }
  return answer(view.required === false ? "not_applicable" : "missing", {
    explanation: NOT_SHOWN.absent(topic),
  });
}

/**
 * Whether the amendment that holds `clause` is later than the NDA, from the stated dates the
 * request lists. A request with no list (a support check) is read as the passages stand.
 */
function governs(view: PromptView, clause: ShownClause): boolean {
  if (view.documents.length === 0) return true;
  const nda = view.documents.find((document) => document.kind === "nda");
  const amendment = view.documents.find((document) => document.label === clause.doc);
  if (nda?.statedDate == null || amendment?.statedDate == null) return false;
  return amendment.statedDate >= nda.statedDate;
}

function unordered(changing: Evidence, changed: Evidence): AnalysisAnswer {
  return answer("undetermined", {
    evidence: [
      { ...changing, role: "conflicting" },
      { ...changed, role: "conflicting" },
    ],
    explanation: UNORDERED.explanation,
    conflict: UNORDERED.conflict,
    abstainReason: UNORDERED.abstainReason,
  });
}

function simple(view: PromptView, ruleKey: string): AnalysisAnswer {
  const rule = SIMPLE_RULES[ruleKey]!;
  const clause = locate(view, rule.passage);
  if (clause === undefined) return notShown(view, rule.topic);
  return answer("compliant", {
    evidence: [cite(clause, rule.passage, "governing")],
    explanation: rule.compliantExplanation,
  });
}

/** The approved text, set under the clause it restates, with the words that name its place changed. */
function adapted(
  approved: string | null,
  prefix: string,
  replace?: { from: string; to: string },
): string | null {
  if (approved === null) return null;
  const text = replace === undefined ? approved : approved.replace(replace.from, replace.to);
  return `${prefix}${text}`;
}

function duration(view: PromptView): AnalysisAnswer {
  const term = locate(view, "term");
  const deletion = locate(view, "deletion");
  const survival = locate(view, "survival");

  if (deletion !== undefined) {
    if (term === undefined)
      return answer("undetermined", {
        evidence: [cite(deletion, "deletion", "governing")],
        explanation: DURATION.deletionWithoutTerm.explanation,
        abstainReason: DURATION.deletionWithoutTerm.abstainReason,
      });
    if (!governs(view, deletion))
      return unordered(cite(deletion, "deletion", "governing"), cite(term, "term", "superseded"));
    return answer("deviation", {
      evidence: [
        cite(deletion, "deletion", "governing"),
        cite(term, "term", "superseded"),
        ...(survival === undefined ? [] : [cite(survival, "survival", "supporting")]),
      ],
      discrepancy:
        survival === undefined
          ? DURATION.deviationDiscrepancyWithoutSurvival
          : DURATION.deviationDiscrepancy,
      explanation:
        survival === undefined
          ? DURATION.deviationExplanationWithoutSurvival
          : DURATION.deviationExplanation,
      fallbackLanguage: adapted(
        view.approvedFallback,
        DURATION.adaptation.clausePrefix,
        DURATION.adaptation,
      ),
    });
  }

  // No amendment among the passages: the NDA's own term is all there is to read, and two years
  // is within the standard. This is the answer of a reader who never saw the amendment.
  if (term !== undefined)
    return answer("compliant", {
      evidence: [cite(term, "term", "governing")],
      explanation: DURATION.baselineExplanation,
    });
  return notShown(view, DURATION.topic);
}

function returns(view: PromptView): AnalysisAnswer {
  const deadline = locate(view, "returnDeadline");
  const copies = locate(view, "returnCopies");
  const amendment = locate(view, "returnAmendment");

  if (amendment !== undefined) {
    if (deadline === undefined)
      return answer("undetermined", {
        evidence: [cite(amendment, "returnAmendment", "governing")],
        explanation: RETURN.amendmentWithoutClause.explanation,
        abstainReason: RETURN.amendmentWithoutClause.abstainReason,
      });
    if (!governs(view, amendment))
      return unordered(
        cite(amendment, "returnAmendment", "governing"),
        cite(deadline, "returnDeadline", "conflicting"),
      );
    return answer("compliant", {
      evidence: [
        cite(amendment, "returnAmendment", "governing"),
        ...(copies === undefined ? [] : [cite(copies, "returnCopies", "supporting")]),
      ],
      explanation: RETURN.curedExplanation,
    });
  }

  // The NDA alone: a ten business day deadline is shorter than the standard allows. Whether an
  // amendment cures it is a question the reader can only answer if the amendment is shown.
  if (deadline !== undefined)
    return answer("deviation", {
      evidence: [cite(deadline, "returnDeadline", "governing")],
      discrepancy: RETURN.deviationDiscrepancy,
      explanation: RETURN.deviationExplanation,
      fallbackLanguage: adapted(view.approvedFallback, RETURN.adaptation.clausePrefix),
    });
  return notShown(view, RETURN.topic);
}

/** The rule's reading once the documents are known to be the example's. */
function readKnown(view: PromptView): AnalysisAnswer {
  const key = view.ruleId;
  if (key === DURATION.ruleKey) return duration(view);
  if (key === RETURN.ruleKey) return returns(view);
  if (key !== null && Object.hasOwn(SIMPLE_RULES, key)) return simple(view, key);
  return abstain(UNKNOWN_RULE.reason);
}

export function answerAnalyze(view: PromptView): AnalysisAnswer {
  if (!isWorkedExample(view)) return abstain(NOT_THE_EXAMPLE.reason);
  return readKnown(view);
}

// ---------------------------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------------------------

/**
 * Does the proposed status follow from the cited passages and nothing else? Answered by reading
 * the passages as a selection and comparing: the same reading that produced the finding, which is
 * why a finding that cited too little (the baseline's duration) is supported by what it cited.
 */
export function answerSupport(view: PromptView): SupportAnswer {
  // The checker is shown only the passages a finding cites, which need not include the preamble
  // that names the parties, so it recognises the example by its paragraphs alone: all of them, as
  // for every other request. One clause of another document does not make a block the example's.
  if (!isKnownBlock(view))
    return { verdict: "insufficient", missingPremise: NOT_THE_EXAMPLE.support };
  const reading = readKnown({ ...view, coverage: "selection" });
  if (reading.status === "undetermined")
    return { verdict: "insufficient", missingPremise: reading.abstainReason };
  if (reading.status === view.proposedStatus) return { verdict: "supported", missingPremise: null };
  return {
    verdict: "not_supported",
    missingPremise:
      "Read as they stand, the passages shown point to a different status from the one proposed.",
  };
}
