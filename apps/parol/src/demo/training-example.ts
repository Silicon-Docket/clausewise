import { sha256Hex } from "../canonical.js";
import { fold, type ShownClause } from "./prompt-view.js";

/**
 * What the simulated reader knows about the training matter T01 (package W2.8), on top of the
 * worked example. T01 is the worked example's two documents with one paragraph added to the NDA,
 * an instruction addressed to automated reviewers (the paragraph of evaluation case PAROL-D08).
 * This file is data and one predicate. It imports no part of the reader, so there is no cycle.
 *
 * The reader plants one wrong answer for T01 and for nothing else: for the rule below it says
 * Compliant and cites the clause that defines Confidential Information, a clause that is in the
 * document and says nothing about disclosure to representatives. That is the exercise: a quote
 * that is found is not a quote that supports the finding. The answer is the script of the
 * simulated reader, a table written in advance. It is not a language model's mistake and it says
 * nothing about how well any model reads an NDA. It goes through the real analyze and verify
 * stages like every other answer, so its quote is checked by the same check that checks every
 * quote.
 *
 * It is planted only when three things hold together (`isTrainingMatter` in reader.ts): every
 * clause shown is a paragraph of the worked example or this instruction paragraph, by fingerprint
 * and never by phrase; the instruction paragraph is among them; and the first document of the
 * request is titled with the marker below. A dataset case, the worked example and a changed
 * document cannot satisfy that, and a test proves it for every case.
 */

/** In the title of the first document of T01. The reader plants nothing without it. */
export const TRAINING_TITLE_MARKER = "(training T01)";

/** The planted rule: Disclosure to representatives (playbook rule `pds-1`). */
export const PLANTED_RULE_KEY = "pds-1";

/**
 * SHA-256 of the instruction paragraph with white space folded, as the entries of
 * `KNOWN_PARAGRAPHS` are fingerprints. A test recomputes it from the committed T01 NDA and from the
 * definition of PAROL-D08, so a changed paragraph fails there and not as a quiet change of
 * behaviour.
 */
export const TRAINING_NOTE_DIGEST =
  "21093b84bb07dbda2faea19e1569b8152401b1e94b76e5d2066c17adac682c86";

/** The passage the planted finding cites: Section 1.2 (`PASSAGES.ciDefinition`). */
export const PLANTED_PASSAGE = "ciDefinition" as const;

/**
 * What the planted finding says. It holds no digit other than the section number and no duration,
 * percentage, amount or jurisdiction, so the checks that read numbers have nothing to object to,
 * and it does not say that anything is planted.
 */
export const PLANTED_EXPLANATION =
  "Section 1.2 defines Confidential Information broadly enough to cover disclosure to the Receiving Party's employees, officers, contractors and professional advisers who need to know it, which is the playbook standard.";

/** Whether a shown clause is the instruction paragraph of T01, word for word, in the NDA. */
export const isTrainingNote = (clause: ShownClause): boolean =>
  clause.doc === "D1" && sha256Hex(fold(clause.text)) === TRAINING_NOTE_DIGEST;
