import { z } from "zod";
import {
  DOCUMENT_KINDS,
  EVIDENCE_ROLES,
  MATTER_ROLES,
  REVIEW_DECISIONS,
  STATUSES,
} from "../../contracts.js";

/**
 * What each operation accepts, written once and used by the page routes (after they have read the
 * fields of a form) and by the JSON API (on the parsed body). The two faces therefore refuse the
 * same input.
 *
 * Every object is strict: a key that is not named is a refusal and not something to ignore, so a
 * client cannot set a field the operation does not offer (the creator of a matter, a role, a
 * status, a matter id). A refusal here is a `ZodError`, which the shell answers with 400 and a
 * fixed message; the error is never read for its text, because it would quote the input.
 *
 * The limits are the ones the store applies, repeated so that an oversized value is refused before
 * it is passed on, and they are the same for a form and for JSON.
 */

const id = z.string().min(1).max(200);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
/** The shape only. Whether it is a real calendar day is the store's to say. */
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A registered workflow label such as `v2`. A closed alphabet, so a label cannot carry markup. */
export const WORKFLOW_LABEL = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

export const MAX_NAME = 200;
export const MAX_CLIENT_NAME = 300;
export const MAX_REASON = 4000;
export const MAX_EDIT_TEXT = 8000;
/** Most evidence passages one finding has; a decision naming more is not one of ours. */
export const MAX_ROLE_EDITS = 64;

export const CreateMatterInput = z.strictObject({
  name: z.string().max(MAX_NAME),
  clientLegalName: z.string().max(MAX_CLIENT_NAME),
  playbookVersionId: id.nullable().optional(),
  reviewerUserId: id.nullable().optional(),
});
export type CreateMatterInput = z.infer<typeof CreateMatterInput>;

/** The client name and the playbook. At least one must be given, or there is nothing to do. */
export const SettingsInput = z
  .strictObject({
    clientLegalName: z.string().max(MAX_CLIENT_NAME).optional(),
    playbookVersionId: id.optional(),
  })
  .refine((value) => value.clientLegalName !== undefined || value.playbookVersionId !== undefined);
export type SettingsInput = z.infer<typeof SettingsInput>;

export const OperativeInput = z.strictObject({ documentId: id, versionId: id });
export const StatedDateInput = z.strictObject({ versionId: id, statedDate: date.nullable() });

/**
 * `PATCH /api/matters/:id`. One kind of change per request, so that a request that fails half way
 * has changed nothing: the settings, or the operative version of a document, or a stated date.
 */
export const PatchMatterBody = z.union([
  SettingsInput,
  z.strictObject({ operative: OperativeInput }),
  z.strictObject({ statedDate: StatedDateInput }),
]);

export const AddMemberInput = z.strictObject({
  userId: id,
  role: z.enum(MATTER_ROLES),
});

export const StartRunInput = z.strictObject({ workflow: WORKFLOW_LABEL.optional() });

export const UploadDocumentFields = z.strictObject({
  title: z.string().max(MAX_NAME),
  kind: z.enum(DOCUMENT_KINDS),
  statedDate: date.nullable().optional(),
});
export const UploadVersionFields = z.strictObject({ statedDate: date.nullable().optional() });

/** What a destructive form posts to say that the person meant it. */
export const ConfirmInput = z.strictObject({ confirm: z.literal("yes") });

const RoleEdit = z.strictObject({ evidenceId: id, role: z.enum(EVIDENCE_ROLES) });

export const EditsInput = z.strictObject({
  status: z.enum(STATUSES).optional(),
  discrepancy: z.string().max(MAX_EDIT_TEXT).optional(),
  fallbackLanguage: z.string().max(MAX_EDIT_TEXT).optional(),
  evidenceRoles: z.array(RoleEdit).max(MAX_ROLE_EDITS).optional(),
});

/** `POST /api/matters/:id/findings/:findingId/reviews` (docs/parol/03). */
export const DecisionBody = z.strictObject({
  decision: z.enum(REVIEW_DECISIONS),
  findingContentSha256: sha256,
  edits: EditsInput.nullable().optional(),
  reason: z.string().max(MAX_REASON).nullable().optional(),
});
export type DecisionBody = z.infer<typeof DecisionBody>;

export const FINDING_HASH = sha256;
