import type { Escalation, SourceSpan } from "../../contracts.js";
import { clauseNameOf, referenceNumbers, targetsClause, targetsSpan } from "../clause-refs.js";
import { isUsable, refOf, type Cited } from "./evidence.js";
import { docOf, type CheckOutput, type DocInfo, type RunIndex } from "./run-index.js";
import { clipDetail, listCapped } from "./text.js";

/**
 * Which document governs which, decided in code from intake data (stated dates, document kinds)
 * and the cross-references ingest found, as docs/parol/03 sets out:
 *
 *  1. An amendment span that expressly replaces, amends or deletes clause N governs clause N when
 *     the amendment's stated date is not earlier than the NDA's.
 *  2. Two amendments that touch the same clause: the later stated date governs. Equal or missing
 *     dates are a conflict.
 *
 * The model proposes evidence roles. These checks compare the roles with the rules and report any
 * disagreement; they never change a role. Rules 3 and 4 of the design (an amendment that
 * disagrees without referring to a clause, two definitions in one document) cannot be decided
 * from annotations and stay with the model's own `conflicting` role.
 */

export { targetsClause };

export type Order = "later" | "equal" | "earlier" | "unknown";

/**
 * A stated date as intake enters it: `YYYY-MM-DD`, optionally followed by a time. Anything else
 * (free text, a month alone, an impossible date) is read as no date, because a date that cannot
 * be ordered must not be allowed to order documents.
 */
export function parseStatedDate(value: string | null): number | null {
  if (value === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(value.trim());
  if (match === null) return null;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return Number(match[1]) * 10_000 + month * 100 + day;
}

/** Whether `newer` is dated after, with or before `older`. */
export function orderOf(older: DocInfo, newer: DocInfo): Order {
  const a = parseStatedDate(older.statedDate);
  const b = parseStatedDate(newer.statedDate);
  if (a === null || b === null) return "unknown";
  return b > a ? "later" : b < a ? "earlier" : "equal";
}

const nested = (a: string, b: string): boolean => targetsClause(a, b) || targetsClause(b, a);

const bounded = (parts: readonly string[]): string => clipDetail(parts.join("; "));

function opsOf(index: RunIndex, span: SourceSpan) {
  return index.operationsBySpan.get(span.id) ?? [];
}

/**
 * Whether `by` changes the clause that `target` answers to, through an operation it carries. A span
 * answers to its own clause number and to the number its heading starts with, exactly as it does
 * in retrieval (`referenceNumbers`), so an amendment that retrieval put in front of the model for
 * an unnumbered paragraph under "2. Term" is also seen here as changing that paragraph.
 */
function changes(index: RunIndex, by: SourceSpan, target: SourceSpan): boolean {
  return opsOf(index, by).some((op) => targetsSpan(op.target, target));
}

/** Whether two spans both change some clause, or one a clause inside the other's. */
function touchSame(index: RunIndex, a: SourceSpan, b: SourceSpan): boolean {
  const bs = opsOf(index, b);
  return opsOf(index, a).some((x) => bs.some((y) => nested(x.target, y.target)));
}

/**
 * How the amendment span `by` reaches the cited span `target`:
 *  - `number`: through an operation whose target is `target`'s own clause number. For an NDA span
 *    that is the whole story, since the NDA is what an amendment's references are written in. For
 *    an amendment span it reads the reference as being to that amendment's own numbering ("Section
 *    2 of Amendment No. 1 is deleted"), which is a real thing for a later amendment to say.
 *  - `same_clause`: through an operation on the same NDA clause that `target` itself operates on.
 *    An amendment span's own clause number says nothing about which NDA clause it deals with, so a
 *    later amendment that restates Section 6.1 reaches an earlier one that deleted it only here.
 * A bare target carries no designation of the document it is a section of, and ingest does not
 * add one, so the first reading is made for an amendment span as well as the second. When a target
 * means the NDA's Section 2 and the cited amendment span happens to be clause 2 of its own
 * amendment, the first reading is a false alarm. That is the safe direction: it escalates and
 * names both spans.
 */
type Reach = "number" | "same_clause";

function reach(index: RunIndex, by: SourceSpan, target: SourceSpan): Reach | null {
  if (changes(index, by, target)) return "number";
  return touchSame(index, by, target) ? "same_clause" : null;
}

const isAmendment = (index: RunIndex, span: SourceSpan): boolean =>
  docOf(index, span).kind === "amendment";

/**
 * C1 `precedence_labels`: the roles the model gave against the precedence rules, and the model's
 * own report of a conflict.
 *
 *  - A span labelled superseded needs a cited amendment span that changes its clause, in an
 *    amendment dated no earlier than an NDA (later than an earlier amendment). When either date is
 *    missing the two cannot be ordered and the passages conflict, which is what the analysis
 *    prompt tells the model (rule 4a): an amendment that expressly refers to the clause is not
 *    taken as later on that ground alone. An amendment dated before the NDA does not supersede
 *    it. Two amendments with equal or missing dates cannot be ordered: a conflict.
 *  - A governing span cited together with a governing amendment span that changes its clause is
 *    inconsistent: the earlier text should be labelled superseded.
 *  - Two governing amendment spans that change the same clause: the earlier is superseded, and
 *    equal or missing dates are a conflict.
 *  - A `conflicting` role, or a conflict the model described, raises `conflicting_sources`.
 *
 * A label violation raises `superseded_evidence`. Which clause a reference reaches is the
 * ingest module's judgment; this check trusts its annotations and never reads the span text.
 */
export function precedenceLabels(
  items: readonly Cited[],
  conflict: string | null,
  index: RunIndex,
): CheckOutput {
  const escalations: Escalation[] = [];
  const problems: string[] = [];
  const violate = (detail: string): void => {
    escalations.push({ code: "superseded_evidence", detail });
    problems.push(detail);
  };
  const clash = (detail: string): void => {
    escalations.push({ code: "conflicting_sources", detail });
    problems.push(detail);
  };

  // 1. Every superseded label must be backed.
  for (const s of items) {
    if (s.role !== "superseded") continue;
    const sdoc = docOf(index, s.span);
    const clause = referenceNumbers(s.span).length === 0 ? null : clauseNameOf(s.span);
    const backers = items.filter(
      (b) =>
        b !== s &&
        b.span.docLabel !== s.span.docLabel &&
        isAmendment(index, b.span) &&
        (changes(index, b.span, s.span) ||
          (sdoc.kind === "amendment" && touchSame(index, b.span, s.span))),
    );
    let backed = false;
    let unordered = false;
    let undated: string | null = null;
    for (const b of backers) {
      const order = orderOf(sdoc, docOf(index, b.span));
      if (order === "later") backed = true;
      // The same day governs for an NDA (the amendment is "not earlier"), and not between amendments.
      else if (sdoc.kind === "nda" && order === "equal") backed = true;
      else if (order === "unknown") undated ??= b.span.docLabel;
      else if (order !== "earlier") unordered = true;
    }
    const ref = refOf(items, s);
    if (backed) continue;
    if (undated !== null) {
      clash(
        `${ref} is labelled superseded by an amendment, but a stated date is missing for ${sdoc.label} or ${undated}, so the documents do not say which governs`,
      );
    } else if (unordered) {
      clash(
        `${ref} is labelled superseded by an amendment whose stated date does not put it after ${sdoc.label}`,
      );
    } else if (backers.length > 0) {
      violate(
        `${ref} is labelled superseded but the amendment that changes it is dated before ${sdoc.label}`,
      );
    } else {
      violate(
        clause === null
          ? `${ref} is labelled superseded but has no clause number for an amendment to change`
          : `${ref} is labelled superseded but no cited amendment span amends, replaces or deletes clause ${clause}`,
      );
    }
  }

  // 2. A governing span and an amendment span that changes it. It is the amendment that governs
  // the clause, whatever role the model gave the amendment span: a deleted clause labelled
  // governing is wrong beside an amendment cited as supporting or as a definition.
  const governing = items.filter((c) => c.role === "governing");
  for (const g of governing) {
    const gdoc = docOf(index, g.span);
    for (const a of items) {
      if (a === g || a.span.docLabel === g.span.docLabel || !isAmendment(index, a.span)) continue;
      // An amendment span the model has labelled superseded is not what governs; whether that
      // label is right is the first rule's question, and answering it twice would report one
      // mistake as two.
      if (a.role === "superseded") continue;
      const how = reach(index, a.span, g.span);
      if (how === null) continue;
      // Two governing amendment spans on the same NDA clause are the next rule's.
      if (how === "same_clause" && a.role === "governing") continue;
      const order = orderOf(gdoc, docOf(index, a.span));
      const what = how === "number" ? `clause ${clauseNameOf(g.span)}` : "the same clause";
      const detail =
        a.role === "governing"
          ? `${refOf(items, g)} and ${refOf(items, a)} are both labelled governing, but the second changes ${what}`
          : `${refOf(items, g)} is labelled governing, but ${refOf(items, a)}, labelled ${a.role}, changes ${what}`;
      if (gdoc.kind === "nda" || order === "later") {
        violate(`${detail}; the first should be labelled superseded`);
      } else if (order !== "earlier") {
        clash(`${detail}, and their stated dates do not say which governs`);
      }
    }
  }

  // 3. Two governing amendment spans that change the same clause.
  for (let i = 0; i < governing.length; i++) {
    for (let j = i + 1; j < governing.length; j++) {
      const a = governing[i]!;
      const b = governing[j]!;
      if (a.span.docLabel === b.span.docLabel) continue;
      if (!isAmendment(index, a.span) || !isAmendment(index, b.span)) continue;
      if (!touchSame(index, a.span, b.span)) continue;
      const order = orderOf(docOf(index, a.span), docOf(index, b.span));
      const both = `${refOf(items, a)} and ${refOf(items, b)} change the same clause and are both labelled governing`;
      if (order === "later") violate(`${both}; the first is superseded by the later amendment`);
      else if (order === "earlier")
        violate(`${both}; the second is superseded by the later amendment`);
      else clash(`${both}, and their stated dates do not say which governs`);
    }
  }

  // 4. The model's own report of a conflict.
  const conflicting = items.filter((c) => c.role === "conflicting");
  if (conflicting.length > 0 || conflict !== null) {
    const parts: string[] = [];
    if (conflicting.length > 0) {
      parts.push(`labelled conflicting: ${listCapped(conflicting.map((c) => refOf(items, c)))}`);
    }
    if (conflict !== null) parts.push("the analysis described a conflict between passages");
    clash(parts.join("; "));
  }

  const failed = problems.length > 0;
  const usable = items.filter(isUsable).length;
  return {
    result: {
      id: "precedence_labels",
      kind: "deterministic",
      outcome: failed ? "fail" : "pass",
      detail: failed
        ? bounded(problems)
        : `roles agree with the precedence rules over ${items.length} cited (${usable} verified)`,
    },
    escalations,
  };
}

/**
 * C2 `superseded_evidence`: a span cited as governing or supporting that a later amendment
 * deletes, replaces or amends, where the finding does not cite that amendment. It does not ask
 * whether the amendment was in the bundle, because the failure it exists for is a bundle that
 * left the amendment out. An amendment dated before the span's document cannot change it and is
 * ignored; one that cannot be ordered is not.
 *
 * An NDA span is reached through its clause number. An amendment span is reached in both ways
 * `reach` describes: through its own clause number, for an amendment of an amendment, and through
 * the NDA clause it operates on, for a later amendment that changes what the cited one did.
 */
export function supersededEvidence(items: readonly Cited[], index: RunIndex): CheckOutput {
  const citedSpans = new Set(items.map((c) => c.span.id));
  const escalations: Escalation[] = [];
  const checked = items.filter(
    (c) =>
      (c.role === "governing" || c.role === "supporting") &&
      (referenceNumbers(c.span).length > 0 || opsOf(index, c.span).length > 0),
  );
  const reported = new Set<string>();
  for (const c of checked) {
    // A span cited twice is one passage to look at.
    if (reported.has(c.span.id)) continue;
    reported.add(c.span.id);
    const clause = referenceNumbers(c.span).length === 0 ? null : clauseNameOf(c.span);
    const cdoc = docOf(index, c.span);
    const own = opsOf(index, c.span);
    const byNumber: string[] = [];
    const bySameClause: string[] = [];
    const acts = new Set<string>();
    const seen = new Set<string>();
    for (const op of index.operations) {
      if (citedSpans.has(op.spanId) || seen.has(op.spanId)) continue;
      const by = index.spansById.get(op.spanId);
      if (by === undefined || by.docLabel === c.span.docLabel) continue;
      const number = targetsSpan(op.target, c.span);
      const shared = number ? [] : own.filter((o) => nested(o.target, op.target));
      if (!number && shared.length === 0) continue;
      if (orderOf(cdoc, docOf(index, by)) === "earlier") continue;
      seen.add(op.spanId);
      if (number) byNumber.push(`${by.label} (${op.verb})`);
      else {
        bySameClause.push(`${by.label} (${op.verb})`);
        for (const o of shared) acts.add(o.target);
      }
    }
    if (byNumber.length > 0) {
      escalations.push({
        code: "superseded_evidence",
        detail: `${refOf(items, c)}, clause ${clause}, is changed by ${listCapped(byNumber, 5)}, which the finding does not cite`,
      });
    }
    if (bySameClause.length > 0) {
      escalations.push({
        code: "superseded_evidence",
        detail: `${refOf(items, c)}, which acts on ${acts.size === 1 ? "clause" : "clauses"} ${listCapped([...acts], 5)}, is changed by ${listCapped(bySameClause, 5)}, which the finding does not cite`,
      });
    }
  }
  const failed = escalations.length > 0;
  return {
    result: {
      id: "superseded_evidence",
      kind: "deterministic",
      outcome: checked.length === 0 ? "not_applicable" : failed ? "fail" : "pass",
      detail:
        checked.length === 0
          ? "no cited governing or supporting span has a clause number"
          : failed
            ? bounded(escalations.map((e) => e.detail))
            : `${checked.length} cited span(s) are not changed by an uncited amendment`,
    },
    escalations,
  };
}
