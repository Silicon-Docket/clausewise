import { EVIDENCE_ROLES, REVIEW_DECISIONS, STATUSES, type EvidenceRole } from "../../contracts.js";
import type { DecisionRequest, FindingView } from "../../services/views.js";
import { ValidationError } from "../../store/errors.js";
import { formString, type FormFields } from "../http.js";
import { FIELDS, evidenceIdOfRoleField, normalizeNewlines } from "../pages/forms.js";
import type { DecisionDraft } from "../pages/finding.js";
import {
  DecisionBody,
  FINDING_HASH,
  MAX_EDIT_TEXT,
  MAX_REASON,
  MAX_ROLE_EDITS,
} from "./schemas.js";

/**
 * The decision form and the decision JSON, both made into the one `DecisionRequest` the review
 * service takes.
 */

type Edits = NonNullable<DecisionRequest["edits"]>;

/** A blank reason is no reason: the store then says whether the decision needed one. */
const reasonOf = (value: string | null | undefined): string | null =>
  value === undefined || value === null || value.trim() === "" ? null : value;

/**
 * What a route makes of the decision form (pages/finding.tsx).
 *
 * Only what the reviewer changed becomes an edit, and only for the Edit decision, because the form
 * starts out holding the finding's own text and posts all of it back whatever was chosen. Every
 * posted text goes through `normalizeNewlines` first: a browser sends the line breaks of a text
 * area as CR LF, so without it an untouched field would look edited. The fallback language is
 * compared as an empty string against a null `fallbackLanguage`, because an empty text area is how
 * the form says "none".
 *
 * A passage that is not one of this finding's is not skipped. It is passed on so that the store
 * refuses it as an id it does not know (404), the same answer the JSON API gives.
 */
export function decisionFromForm(form: FormFields, finding: FindingView): DecisionRequest {
  const text = (name: string): string | undefined => {
    const value = formString(form, name);
    return value === undefined ? undefined : normalizeNewlines(value);
  };
  const decision = REVIEW_DECISIONS.find((candidate) => candidate === text(FIELDS.decision));
  if (decision === undefined) throw new ValidationError("bad_decision", "choose a decision");
  const hash = FINDING_HASH.safeParse(formString(form, FIELDS.findingContentSha256));
  if (!hash.success)
    throw new ValidationError("bad_hash", "the form does not say which finding it was made on");

  let edits: DecisionRequest["edits"] = null;
  if (decision === "edit") {
    const changed: Edits = {};
    const status = STATUSES.find((candidate) => candidate === text(FIELDS.status));
    if (text(FIELDS.status) !== undefined && status === undefined)
      throw new ValidationError("bad_status", "choose one of the listed statuses");
    if (status !== undefined && status !== finding.issue.status) changed.status = status;

    const discrepancy = text(FIELDS.discrepancy);
    if (discrepancy !== undefined && discrepancy !== finding.discrepancy)
      changed.discrepancy = discrepancy;

    const fallback = text(FIELDS.fallbackLanguage);
    if (fallback !== undefined && fallback !== (finding.fallbackLanguage ?? ""))
      changed.fallbackLanguage = fallback;

    const roles: { evidenceId: string; role: EvidenceRole }[] = [];
    for (const name of Object.keys(form)) {
      const evidenceId = evidenceIdOfRoleField(name);
      if (evidenceId === null) continue;
      if (roles.length >= MAX_ROLE_EDITS)
        throw new ValidationError("too_many_roles", "the form names too many passages");
      const role = EVIDENCE_ROLES.find((candidate) => candidate === text(name));
      if (role === undefined)
        throw new ValidationError("bad_role", "choose one of the listed labels");
      const current = finding.evidence.find((e) => e.evidenceId === evidenceId);
      // A passage the finding does not have is kept, so that the store refuses it.
      if (current === undefined || current.role !== role) roles.push({ evidenceId, role });
    }
    if (roles.length > 0) changed.evidenceRoles = roles;
    edits = Object.keys(changed).length === 0 ? null : changed;
  }
  return {
    decision,
    findingContentSha256: hash.data,
    edits,
    reason: reasonOf(text(FIELDS.reason)),
  };
}

/**
 * What the reviewer had typed, to show in the form again when the decision was refused (a reason
 * left out, say), so that a long edit is not lost to a missing sentence. Only choices that exist
 * are kept (a decision, a status, a label) and text is cut to the length the store accepts, so a
 * crafted post cannot put anything on the page that the form could not have held. The text is the
 * reviewer's own, returned to the reviewer who typed it, and goes through the same escaping as
 * every other text on the page. It is never logged or stored.
 */
export function draftFromForm(form: FormFields): DecisionDraft {
  const text = (name: string, max: number): string | undefined => {
    const value = formString(form, name);
    return value === undefined ? undefined : normalizeNewlines(value).slice(0, max);
  };
  const draft: DecisionDraft = {};
  const decision = REVIEW_DECISIONS.find((candidate) => candidate === text(FIELDS.decision, 20));
  if (decision !== undefined) draft.decision = decision;
  const reason = text(FIELDS.reason, MAX_REASON);
  if (reason !== undefined) draft.reason = reason;
  const status = STATUSES.find((candidate) => candidate === text(FIELDS.status, 40));
  if (status !== undefined) draft.status = status;
  const discrepancy = text(FIELDS.discrepancy, MAX_EDIT_TEXT);
  if (discrepancy !== undefined) draft.discrepancy = discrepancy;
  const fallback = text(FIELDS.fallbackLanguage, MAX_EDIT_TEXT);
  if (fallback !== undefined) draft.fallbackLanguage = fallback;
  const roles: Record<string, EvidenceRole> = {};
  for (const name of Object.keys(form).slice(0, 4 * MAX_ROLE_EDITS)) {
    const evidenceId = evidenceIdOfRoleField(name);
    if (evidenceId === null || Object.keys(roles).length >= MAX_ROLE_EDITS) continue;
    const role = EVIDENCE_ROLES.find((candidate) => candidate === text(name, 40));
    if (role !== undefined) roles[evidenceId] = role;
  }
  if (Object.keys(roles).length > 0) draft.roles = roles;
  return draft;
}

/**
 * The decision JSON of docs/parol/03. The edits are taken as given: the store drops what does not
 * differ from the finding and refuses an edit that changes nothing, and an edit sent with any
 * other decision.
 */
export function decisionFromBody(body: unknown): DecisionRequest {
  const parsed = DecisionBody.parse(body);
  let edits: DecisionRequest["edits"] = null;
  if (parsed.edits !== undefined && parsed.edits !== null) {
    const given: Edits = {};
    if (parsed.edits.status !== undefined) given.status = parsed.edits.status;
    if (parsed.edits.discrepancy !== undefined) given.discrepancy = parsed.edits.discrepancy;
    if (parsed.edits.fallbackLanguage !== undefined)
      given.fallbackLanguage = parsed.edits.fallbackLanguage;
    if (parsed.edits.evidenceRoles !== undefined) given.evidenceRoles = parsed.edits.evidenceRoles;
    edits = given;
  }
  return {
    decision: parsed.decision,
    findingContentSha256: parsed.findingContentSha256,
    edits,
    reason: reasonOf(parsed.reason),
  };
}
