import {
  DOC_LABELS,
  type DocLabel,
  type DocumentKind,
  type MatterRole,
  type MatterStatus,
  type SourceSpan,
  type SpanAnnotation,
} from "../contracts.js";
import { hashOf, sha256Hex } from "../canonical.js";
import { newId } from "../ids.js";
import {
  assertCount,
  assertSha256,
  assertShortCode,
  assertStoragePath,
  assertStoragePathFree,
  bool,
  cleanLabel,
  cleanStatedDate,
  flag,
  parseWith,
  type Ctx,
} from "./context.js";
import { ConflictError, InvalidTransitionError, NotFoundError, ValidationError } from "./errors.js";
import { tablesHoldingMatter } from "./residue.js";
import { AnnotationSchema, SpanSchema } from "./schemas.js";
import { canTransition } from "./states.js";
import type {
  DocumentRow,
  DocumentVersionRow,
  InputChangeResult,
  MatterRow,
  MatterWithRole,
  MemberRow,
  NewVersionInput,
  OperativeDocument,
  StoredSpan,
  TrainingKey,
  UserRow,
} from "./types.js";

// ---------------------------------------------------------------------------------------------
// Demo identities (docs/parol/06): this build has seeded users only.
// ---------------------------------------------------------------------------------------------

export const DEMO_USER_IDS = {
  associate: "usr_demo_associate",
  reviewer: "usr_demo_reviewer",
  legalEngineer: "usr_demo_engineer",
  admin: "usr_demo_admin",
} as const;

const DEMO_USERS: readonly UserRow[] = [
  {
    id: DEMO_USER_IDS.associate,
    displayName: "Alex Ruiz (associate)",
    globalRole: "member",
    demo: true,
  },
  {
    id: DEMO_USER_IDS.reviewer,
    displayName: "Dana Whitfield (reviewing attorney)",
    globalRole: "member",
    demo: true,
  },
  {
    id: DEMO_USER_IDS.legalEngineer,
    displayName: "Lee Okafor (legal engineer)",
    globalRole: "legal_engineer",
    demo: true,
  },
  { id: DEMO_USER_IDS.admin, displayName: "Sam Patel (admin)", globalRole: "admin", demo: true },
];

/** The default retention in the demo (docs/parol/06). */
export const DEFAULT_RETAIN_DAYS = 30;

/**
 * The most days a matter may be kept, at creation or by a later change. A ceiling chosen for the
 * demonstration so that the pilot of docs/parol/08 fits with room to export; it is not derived from
 * any records policy (docs/parol/01, question 17, is unanswered). It lives here and not in the
 * database, so the form, the request schema and the store all read the one number.
 */
export const MAX_RETAIN_DAYS = 90;

/** Whole days from 1 to `MAX_RETAIN_DAYS`; anything else (a fraction, NaN, text) is refused. */
function assertRetainDays(value: unknown): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_RETAIN_DAYS
  )
    throw new ValidationError(
      "retention_days",
      `retention must be a whole number of days from 1 to ${MAX_RETAIN_DAYS}`,
    );
}

/**
 * The condition that keeps training matters out of a count, for a query in which the matters table
 * is called `matters`. Every query that counts matters, runs, findings, decisions, memos or people
 * for a measure adds it with AND. A training matter is made by the person doing the exercise, so a
 * measure that counted it would count practice as use (docs/parol/08).
 */
export const NOT_TRAINING_SQL = "matters.training_key IS NULL";

/** The training keys that exist. The type says so too; this is for a caller that got around it. */
const TRAINING_KEYS: readonly TrainingKey[] = ["T01"];

/** Why the inputs changed. Stored as a finding's `stale_reason`, so it is a code and never text. */
export const INPUT_CHANGE_REASONS = {
  documentChanged: "document_changed",
  documentAdded: "document_added",
  documentRemoved: "document_removed",
  operativeChanged: "operative_changed",
  statedDateChanged: "stated_date_changed",
  clientNameChanged: "client_name_changed",
  playbookChanged: "playbook_changed",
  rerunRequested: "rerun_requested",
} as const;

// ---------------------------------------------------------------------------------------------
// Row shapes as SQLite returns them
// ---------------------------------------------------------------------------------------------

interface RawUser {
  id: string;
  display_name: string;
  global_role: UserRow["globalRole"];
}
interface RawMatter {
  id: string;
  name: string;
  client_legal_name: string;
  playbook_version_id: string | null;
  status: MatterStatus;
  current_inputs_sha256: string | null;
  synthetic: number;
  created_by: string;
  created_at: string;
  retain_until: string;
  deleted_at: string | null;
  training_key: TrainingKey | null;
}
interface RawMember {
  matter_id: string;
  user_id: string;
  role: MatterRole;
  granted_by: string;
  granted_at: string;
}
interface RawDocument {
  id: string;
  matter_id: string;
  kind: DocumentKind;
  title: string;
  ordinal: number;
}
interface RawVersion {
  id: string;
  document_id: string;
  matter_id: string;
  version_no: number;
  media_type: "docx" | "txt";
  file_sha256: string;
  text_sha256: string;
  byte_size: number;
  stated_date: string | null;
  operative: number;
  storage_path: string;
  uploaded_by: string;
  uploaded_at: string;
}
interface RawSpan {
  id: string;
  document_version_id: string;
  matter_id: string;
  paragraph_index: number;
  clause_id: string;
  clause_number: string | null;
  heading: string | null;
  text: string;
  text_sha256: string;
  document_id: string;
  document_title: string;
  document_kind: DocumentKind;
  ordinal: number;
  version_no: number;
}

const toUser = (r: RawUser): UserRow => ({
  id: r.id,
  displayName: r.display_name,
  globalRole: r.global_role,
  demo: true,
});
const toMatter = (r: RawMatter): MatterRow => ({
  id: r.id,
  name: r.name,
  clientLegalName: r.client_legal_name,
  playbookVersionId: r.playbook_version_id,
  status: r.status,
  currentInputsSha256: r.current_inputs_sha256,
  synthetic: bool(r.synthetic),
  createdBy: r.created_by,
  createdAt: r.created_at,
  retainUntil: r.retain_until,
  deletedAt: r.deleted_at,
  // A row of a database that has not got the column yet reads as an ordinary matter.
  trainingKey: r.training_key ?? null,
});
const toMember = (r: RawMember): MemberRow => ({
  matterId: r.matter_id,
  userId: r.user_id,
  role: r.role,
  grantedBy: r.granted_by,
  grantedAt: r.granted_at,
});
const labelOf = (ordinal: number): DocLabel => DOC_LABELS[ordinal - 1] as DocLabel;
const toDocument = (r: RawDocument): DocumentRow => ({
  id: r.id,
  matterId: r.matter_id,
  kind: r.kind,
  title: r.title,
  ordinal: r.ordinal,
  label: labelOf(r.ordinal),
});
const toVersion = (r: RawVersion): DocumentVersionRow => ({
  id: r.id,
  documentId: r.document_id,
  matterId: r.matter_id,
  versionNo: r.version_no,
  mediaType: r.media_type,
  fileSha256: r.file_sha256,
  textSha256: r.text_sha256,
  byteSize: r.byte_size,
  statedDate: r.stated_date,
  operative: bool(r.operative),
  storagePath: r.storage_path,
  uploadedBy: r.uploaded_by,
  uploadedAt: r.uploaded_at,
});
const toSpan = (r: RawSpan): StoredSpan => {
  const docLabel = labelOf(r.ordinal);
  return {
    id: r.id,
    label: `${docLabel}-p${r.paragraph_index}`,
    documentVersionId: r.document_version_id,
    docLabel,
    paragraphIndex: r.paragraph_index,
    clauseId: r.clause_id,
    clauseNumber: r.clause_number,
    heading: r.heading,
    text: r.text,
    textSha256: r.text_sha256,
    matterId: r.matter_id,
    documentId: r.document_id,
    documentTitle: r.document_title,
    documentKind: r.document_kind,
    versionNo: r.version_no,
  };
};

// ---------------------------------------------------------------------------------------------
// The inputs digest
// ---------------------------------------------------------------------------------------------

export interface InputsParts {
  clientLegalName: string;
  playbookSha256: string;
  /** In ordinal order. */
  documents: {
    versionId: string;
    textSha256: string;
    statedDate: string | null;
    kind: DocumentKind;
  }[];
}

/**
 * The inputs digest: client legal name, playbook version hash and, for each document in ordinal
 * order, the operative version id, its text hash, stated date and kind. It leaves out workflow and
 * model on purpose; those belong to `input_manifest_sha256`. A matter can therefore say whether its
 * results are still current before anyone has picked a workflow, and a new workflow version does
 * not make old findings stale (docs/parol/03, "Workflow version promoted to pilot").
 *
 * Exported so the run manifest can be checked against it with the same function.
 */
export function inputsDigestOf(parts: InputsParts): string {
  return hashOf({
    clientLegalName: parts.clientLegalName,
    playbookSha256: parts.playbookSha256,
    documents: parts.documents.map((d) => ({
      versionId: d.versionId,
      textSha256: d.textSha256,
      statedDate: d.statedDate,
      kind: d.kind,
    })),
  });
}

// ---------------------------------------------------------------------------------------------

export interface Actor {
  actorId: string | null;
}

export function createMattersApi(ctx: Ctx) {
  const { get, all, run, tx } = ctx;

  // --- users --------------------------------------------------------------------------------

  const getUser = (userId: string): UserRow | undefined => {
    const row = get<RawUser>(
      "SELECT id, display_name, global_role FROM users WHERE id = ?",
      userId,
    );
    return row ? toUser(row) : undefined;
  };
  const requireUser = (userId: string): UserRow => {
    const user = getUser(userId);
    if (!user) throw new NotFoundError("user");
    return user;
  };

  function seedDemoUsers(): UserRow[] {
    return tx(() => {
      for (const user of DEMO_USERS) {
        // Insert only what is missing: the seed is safe to run at every boot and never rewrites a row.
        run(
          `INSERT INTO users (id, display_name, global_role, demo)
           SELECT ?, ?, ?, 1 WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = ?)`,
          user.id,
          user.displayName,
          user.globalRole,
          user.id,
        );
      }
      return DEMO_USERS.map((user) => requireUser(user.id));
    });
  }

  const listUsers = (): UserRow[] =>
    all<RawUser>("SELECT id, display_name, global_role FROM users ORDER BY id").map(toUser);

  // --- matters ------------------------------------------------------------------------------

  const getMatter = (matterId: string): MatterRow | undefined => {
    const row = get<RawMatter>("SELECT * FROM matters WHERE id = ?", matterId);
    return row ? toMatter(row) : undefined;
  };
  const requireMatter = (matterId: string): MatterRow => {
    const matter = getMatter(matterId);
    if (!matter) throw new NotFoundError("matter");
    return matter;
  };

  function createMatter(input: {
    name: string;
    clientLegalName: string;
    createdBy: string;
    synthetic?: boolean;
    retainDays?: number;
    /** Makes this the person's training matter. Set at creation and never changed. */
    trainingKey?: TrainingKey;
  }): MatterRow {
    const name = cleanLabel("matter name", input.name);
    const clientLegalName = cleanLabel("client legal name", input.clientLegalName);
    const retainDays = input.retainDays ?? DEFAULT_RETAIN_DAYS;
    assertRetainDays(retainDays);
    const trainingKey = input.trainingKey ?? null;
    // A programming error and not a refusal: no request can carry a key, so there is no phrase for it.
    if (trainingKey !== null && !TRAINING_KEYS.includes(trainingKey))
      throw new TypeError("the training key is not one that exists");
    return tx(() => {
      requireUser(input.createdBy);
      const id = newId("mat");
      const now = ctx.now();
      const retainUntil = new Date(Date.parse(now) + retainDays * 86_400_000).toISOString();
      // An ordinary matter is written by the statement it always was, without the column that
      // migration 7 added, so it is made the same way on a database that has not got it yet. Only
      // a training matter names the column.
      const fields = [
        id,
        name,
        clientLegalName,
        flag(input.synthetic ?? true),
        input.createdBy,
        now,
        retainUntil,
      ] as const;
      if (trainingKey === null)
        run(
          `INSERT INTO matters
             (id, name, client_legal_name, playbook_version_id, status, current_inputs_sha256,
              synthetic, created_by, created_at, retain_until, deleted_at)
           VALUES (?, ?, ?, NULL, 'draft', NULL, ?, ?, ?, ?, NULL)`,
          ...fields,
        );
      else
        run(
          `INSERT INTO matters
             (id, name, client_legal_name, playbook_version_id, status, current_inputs_sha256,
              synthetic, created_by, created_at, retain_until, deleted_at, training_key)
           VALUES (?, ?, ?, NULL, 'draft', NULL, ?, ?, ?, ?, NULL, ?)`,
          ...fields,
          trainingKey,
        );
      run(
        `INSERT INTO matter_members (matter_id, user_id, role, granted_by, granted_at)
         VALUES (?, ?, 'associate', ?, ?)`,
        id,
        input.createdBy,
        input.createdBy,
        now,
      );
      ctx.audit({
        actorId: input.createdBy,
        matterId: id,
        action: "matter.create",
        targetType: "matter",
        targetId: id,
        detail: {
          synthetic: input.synthetic ?? true,
          retainUntil,
          ...(trainingKey === null ? {} : { training: trainingKey }),
        },
      });
      ctx.audit({
        actorId: input.createdBy,
        matterId: id,
        action: "member.add",
        targetType: "user",
        targetId: input.createdBy,
        detail: { role: "associate" },
      });
      return requireMatter(id);
    });
  }

  /**
   * Every matter id that has a row. Not scoped to a matter or a user, so it is for the boot sweep
   * (`FileStore.sweepOrphans`) and for operations, never for a request.
   */
  const listMatterIds = (): string[] =>
    all<{ id: string }>("SELECT id FROM matters ORDER BY id").map((r) => r.id);

  const listMattersForUser = (userId: string): MatterWithRole[] =>
    all<RawMatter & { role: MatterRole }>(
      `SELECT m.*, mm.role AS role
       FROM matters m JOIN matter_members mm ON mm.matter_id = m.id
       WHERE mm.user_id = ?
       ORDER BY m.created_at DESC, m.id`,
      userId,
    ).map((row) => ({ ...toMatter(row), role: row.role }));

  // --- members ------------------------------------------------------------------------------

  const getMember = (matterId: string, userId: string): MemberRow | undefined => {
    const row = get<RawMember>(
      "SELECT * FROM matter_members WHERE matter_id = ? AND user_id = ?",
      matterId,
      userId,
    );
    return row ? toMember(row) : undefined;
  };
  const listMembers = (matterId: string): MemberRow[] =>
    all<RawMember>(
      "SELECT * FROM matter_members WHERE matter_id = ? ORDER BY granted_at, user_id",
      matterId,
    ).map(toMember);

  function addMember(
    matterId: string,
    userId: string,
    role: MatterRole,
    opts: { actorId: string },
  ): MemberRow {
    return tx(() => {
      requireMatter(matterId);
      requireUser(userId);
      requireUser(opts.actorId);
      if (!["associate", "reviewer", "viewer"].includes(role))
        throw new ValidationError("bad_role", "role must be associate, reviewer or viewer");
      if (getMember(matterId, userId))
        throw new ConflictError("member_exists", "the user is already a member of the matter");
      run(
        `INSERT INTO matter_members (matter_id, user_id, role, granted_by, granted_at)
         VALUES (?, ?, ?, ?, ?)`,
        matterId,
        userId,
        role,
        opts.actorId,
        ctx.now(),
      );
      ctx.audit({
        actorId: opts.actorId,
        matterId,
        action: "member.add",
        targetType: "user",
        targetId: userId,
        detail: { role },
      });
      return getMember(matterId, userId) as MemberRow;
    });
  }

  // --- matter status ------------------------------------------------------------------------

  /**
   * Moves a matter along the state machine. The edges are checked with `canTransition`; callers
   * that need a precondition beyond the edge (readiness for `exported`) check it themselves or go
   * through `Repository.setMatterStatus`, which does, and which leaves `stale`, `draft` and `ready`
   * to `applyInputChange`.
   */
  function transitionMatter(matterId: string, to: MatterStatus): MatterRow {
    const matter = requireMatter(matterId);
    if (matter.status === to) return matter;
    if (!canTransition(matter.status, to))
      throw new InvalidTransitionError("matter", matter.status, to);
    run("UPDATE matters SET status = ? WHERE id = ?", to, matterId);
    return requireMatter(matterId);
  }

  // --- inputs digest and invalidation -------------------------------------------------------

  function computeInputsDigest(matterId: string): string | null {
    const head = get<{ client_legal_name: string; playbook_sha256: string | null }>(
      `SELECT m.client_legal_name AS client_legal_name, p.sha256 AS playbook_sha256
       FROM matters m LEFT JOIN playbook_versions p ON p.id = m.playbook_version_id
       WHERE m.id = ?`,
      matterId,
    );
    if (!head || head.playbook_sha256 === null) return null;
    const docs = all<{
      kind: DocumentKind;
      version_id: string | null;
      text_sha256: string | null;
      stated_date: string | null;
    }>(
      `SELECT d.kind AS kind, v.id AS version_id, v.text_sha256 AS text_sha256,
              v.stated_date AS stated_date
       FROM documents d
       LEFT JOIN document_versions v ON v.document_id = d.id AND v.operative = 1
       WHERE d.matter_id = ?
       ORDER BY d.ordinal`,
      matterId,
    );
    if (docs.length === 0) return null;
    if (!docs.some((d) => d.kind === "nda")) return null;
    const parts: InputsParts["documents"] = [];
    for (const d of docs) {
      if (d.version_id === null || d.text_sha256 === null) return null;
      parts.push({
        versionId: d.version_id,
        textSha256: d.text_sha256,
        statedDate: d.stated_date,
        kind: d.kind,
      });
    }
    return inputsDigestOf({
      clientLegalName: head.client_legal_name,
      playbookSha256: head.playbook_sha256,
      documents: parts,
    });
  }

  /**
   * Everything that follows from an input having changed, in one transaction: the stored digest is
   * recomputed, current findings and decisions go stale with the reason, the current memo is
   * superseded, runs that produced or were producing results are superseded, and the matter moves to
   * `stale` (when a run had produced anything) or to `draft` / `ready` by completeness.
   *
   * Every method that changes an input calls this itself, so no caller can forget.
   */
  function applyInputChange(
    matterId: string,
    opts: { reason: string; actorId: string | null },
  ): InputChangeResult {
    assertShortCode("reason", opts.reason);
    return tx(() => {
      const before = requireMatter(matterId);
      const digest = computeInputsDigest(matterId);
      const now = ctx.now();

      run("UPDATE matters SET current_inputs_sha256 = ? WHERE id = ?", digest, matterId);
      const findingsMarkedStale = run(
        `UPDATE findings SET validity = 'stale', stale_reason = ?
         WHERE matter_id = ? AND validity = 'current'`,
        opts.reason,
        matterId,
      );
      const reviewsMarkedStale = run(
        "UPDATE reviews SET validity = 'stale' WHERE matter_id = ? AND validity = 'current'",
        matterId,
      );
      // A re-run on unchanged inputs leaves the exported memo as it is (docs/parol/03, "Re-run with
      // unchanged inputs"): the file is a record of what was exported, and the new run's own memo
      // supersedes it when that one is exported. Anything that moved the inputs supersedes it now.
      const unchangedRerun =
        opts.reason === INPUT_CHANGE_REASONS.rerunRequested &&
        digest !== null &&
        digest === before.currentInputsSha256;
      const memosSuperseded = unchangedRerun
        ? 0
        : run(
            "UPDATE memos SET status = 'superseded' WHERE matter_id = ? AND status = 'current'",
            matterId,
          );
      // A stage still writing for a run that is being superseded is told so by its next write
      // failing with StaleRunError; its half-finished stage rows are closed here.
      run(
        `UPDATE run_stages SET status = 'failed', error_kind = 'superseded', finished_at = ?
         WHERE status = 'running' AND run_id IN (
           SELECT id FROM runs WHERE matter_id = ?
             AND status IN ('queued','ingesting','extracting','retrieving','analyzing','verifying'))`,
        now,
        matterId,
      );
      const runsSuperseded = run(
        `UPDATE runs SET status = 'superseded', finished_at = COALESCE(finished_at, ?)
         WHERE matter_id = ?
           AND status IN ('succeeded','queued','ingesting','extracting','retrieving','analyzing','verifying')`,
        now,
        matterId,
      );

      let status: MatterStatus;
      if (before.status === "draft" || before.status === "ready")
        status = digest === null ? "draft" : "ready";
      else status = "stale";
      transitionMatter(matterId, status);

      ctx.audit({
        actorId: opts.actorId,
        matterId,
        action: "inputs.changed",
        targetType: "matter",
        targetId: matterId,
        detail: {
          reason: opts.reason,
          previousInputsSha256: before.currentInputsSha256,
          inputsSha256: digest,
          status,
          findingsMarkedStale,
          reviewsMarkedStale,
          memosSuperseded,
          runsSuperseded,
        },
      });
      return {
        matterId,
        reason: opts.reason,
        previousInputsSha256: before.currentInputsSha256,
        inputsSha256: digest,
        status,
        findingsMarkedStale,
        reviewsMarkedStale,
        memosSuperseded,
        runsSuperseded,
      };
    });
  }

  /**
   * For the methods that change an input: invalidates when the digest really moved, or when the
   * caller knows an input changed even though the digest might not show it (`forced`).
   */
  function invalidateIfChanged(
    matterId: string,
    digestBefore: string | null,
    reason: string,
    actorId: string | null,
    forced = false,
  ): InputChangeResult | null {
    if (!forced && computeInputsDigest(matterId) === digestBefore) return null;
    return applyInputChange(matterId, { reason, actorId });
  }

  function updateClientName(
    matterId: string,
    clientLegalName: string,
    opts: { actorId: string },
  ): MatterRow {
    const name = cleanLabel("client legal name", clientLegalName);
    return tx(() => {
      const matter = requireMatter(matterId);
      if (matter.clientLegalName === name) return matter;
      const before = computeInputsDigest(matterId);
      run("UPDATE matters SET client_legal_name = ? WHERE id = ?", name, matterId);
      ctx.audit({
        actorId: opts.actorId,
        matterId,
        action: "matter.update",
        targetType: "matter",
        targetId: matterId,
        detail: { field: "client_legal_name" },
      });
      invalidateIfChanged(
        matterId,
        before,
        INPUT_CHANGE_REASONS.clientNameChanged,
        opts.actorId,
        true,
      );
      return requireMatter(matterId);
    });
  }

  function setPlaybookVersion(
    matterId: string,
    playbookVersionId: string,
    opts: { actorId: string },
  ): MatterRow {
    return tx(() => {
      const matter = requireMatter(matterId);
      const playbook = get<{ status: string }>(
        "SELECT status FROM playbook_versions WHERE id = ?",
        playbookVersionId,
      );
      if (!playbook) throw new NotFoundError("playbook version");
      if (playbook.status !== "approved")
        throw new ValidationError(
          "playbook_not_approved",
          "only an approved playbook version can be selected",
        );
      if (matter.playbookVersionId === playbookVersionId) return matter;
      const before = computeInputsDigest(matterId);
      run("UPDATE matters SET playbook_version_id = ? WHERE id = ?", playbookVersionId, matterId);
      ctx.audit({
        actorId: opts.actorId,
        matterId,
        action: "matter.update",
        targetType: "matter",
        targetId: matterId,
        detail: { field: "playbook_version_id", playbookVersionId },
      });
      // Forced: a different version pins different rules even if two versions share their YAML.
      invalidateIfChanged(
        matterId,
        before,
        INPUT_CHANGE_REASONS.playbookChanged,
        opts.actorId,
        true,
      );
      return requireMatter(matterId);
    });
  }

  // --- documents and versions ---------------------------------------------------------------

  const getDocument = (matterId: string, documentId: string): DocumentRow | undefined => {
    const row = get<RawDocument>(
      "SELECT * FROM documents WHERE id = ? AND matter_id = ?",
      documentId,
      matterId,
    );
    return row ? toDocument(row) : undefined;
  };
  const listDocuments = (matterId: string): DocumentRow[] =>
    all<RawDocument>("SELECT * FROM documents WHERE matter_id = ? ORDER BY ordinal", matterId).map(
      toDocument,
    );
  const getVersion = (matterId: string, versionId: string): DocumentVersionRow | undefined => {
    const row = get<RawVersion>(
      "SELECT * FROM document_versions WHERE id = ? AND matter_id = ?",
      versionId,
      matterId,
    );
    return row ? toVersion(row) : undefined;
  };
  /** Versions of one document, or of the whole matter when no document is named. Oldest first. */
  const listVersions = (matterId: string, documentId?: string): DocumentVersionRow[] =>
    all<RawVersion>(
      `SELECT v.* FROM document_versions v JOIN documents d ON d.id = v.document_id
       WHERE v.matter_id = ?1 AND (?2 IS NULL OR v.document_id = ?2)
       ORDER BY d.ordinal, v.version_no`,
      matterId,
      documentId ?? null,
    ).map(toVersion);

  const findVersionByFileSha256 = (
    matterId: string,
    fileSha256: string,
  ): DocumentVersionRow | undefined => {
    const row = get<RawVersion>(
      "SELECT * FROM document_versions WHERE matter_id = ? AND file_sha256 = ? ORDER BY uploaded_at, version_no LIMIT 1",
      matterId,
      fileSha256,
    );
    return row ? toVersion(row) : undefined;
  };
  /** Finds a re-saved file: different bytes, same extracted text (`near_duplicate_version`). */
  const findVersionByTextSha256 = (
    matterId: string,
    textSha256: string,
  ): DocumentVersionRow | undefined => {
    const row = get<RawVersion>(
      "SELECT * FROM document_versions WHERE matter_id = ? AND text_sha256 = ? ORDER BY uploaded_at, version_no LIMIT 1",
      matterId,
      textSha256,
    );
    return row ? toVersion(row) : undefined;
  };

  const listOperativeDocuments = (matterId: string): OperativeDocument[] =>
    all<RawDocument & { v: string }>(
      "SELECT d.*, v.id AS v FROM documents d JOIN document_versions v ON v.document_id = d.id AND v.operative = 1 WHERE d.matter_id = ? ORDER BY d.ordinal",
      matterId,
    ).map((row) => ({
      document: toDocument(row),
      version: getVersion(matterId, row.v) as DocumentVersionRow,
    }));

  function cleanVersionInput(matterId: string, input: NewVersionInput): void {
    if (input.mediaType !== "docx" && input.mediaType !== "txt")
      throw new ValidationError("bad_media_type", "media type must be docx or txt");
    assertSha256("fileSha256", input.fileSha256);
    assertSha256("textSha256", input.textSha256);
    assertCount("byteSize", input.byteSize, 0);
    cleanStatedDate(input.statedDate);
    assertStoragePath(matterId, input.storagePath);
    if (input.operative === true && input.keepOperative === true)
      throw new ValidationError(
        "operative_conflict",
        "a version cannot both become operative and leave the operative version in place",
      );
  }

  /**
   * An upload is new only if the matter does not already hold the same bytes and the stored file is
   * not already some other row's (docs/parol/03: an identical file is "not stored again" and
   * changes nothing). Refusing here, before anything is written, is what keeps it a no-change.
   */
  function assertNewUpload(matterId: string, input: NewVersionInput): void {
    if (findVersionByFileSha256(matterId, input.fileSha256) !== undefined)
      throw new ConflictError(
        "duplicate_file",
        "the matter already holds a version with this file",
      );
    assertStoragePathFree({ get }, input.storagePath);
  }

  function insertVersion(
    matterId: string,
    documentId: string,
    versionNo: number,
    input: NewVersionInput,
    uploadedBy: string,
  ): string {
    const versionId = newId("ver");
    run(
      `INSERT INTO document_versions
         (id, document_id, matter_id, version_no, media_type, file_sha256, text_sha256, byte_size,
          stated_date, operative, storage_path, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      versionId,
      documentId,
      matterId,
      versionNo,
      input.mediaType,
      input.fileSha256,
      input.textSha256,
      input.byteSize,
      cleanStatedDate(input.statedDate),
      input.storagePath,
      uploadedBy,
      ctx.now(),
    );
    return versionId;
  }

  function makeOperative(documentId: string, versionId: string): void {
    // Clear first: the unique index (and a trigger in front of it) allows one operative version.
    run(
      "UPDATE document_versions SET operative = 0 WHERE document_id = ? AND operative = 1 AND id <> ?",
      documentId,
      versionId,
    );
    run(
      "UPDATE document_versions SET operative = 1 WHERE id = ? AND document_id = ?",
      versionId,
      documentId,
    );
  }

  function addDocument(
    matterId: string,
    input: { kind: DocumentKind; title: string; version: NewVersionInput },
    opts: { actorId: string },
  ): { document: DocumentRow; version: DocumentVersionRow } {
    const title = cleanLabel("document title", input.title);
    if (input.kind !== "nda" && input.kind !== "amendment")
      throw new ValidationError("bad_kind", "kind must be nda or amendment");
    cleanVersionInput(matterId, input.version);
    return tx(() => {
      requireMatter(matterId);
      requireUser(opts.actorId);
      const existing = listDocuments(matterId);
      if (input.kind === "nda" && existing.some((d) => d.kind === "nda"))
        throw new ConflictError("nda_exists", "the matter already has an NDA");
      if (input.kind === "amendment" && existing.filter((d) => d.kind === "amendment").length >= 2)
        throw new ConflictError("amendment_limit", "the matter already has two amendments");
      const used = new Set(existing.map((d) => d.ordinal));
      const ordinal = [1, 2, 3].find((n) => !used.has(n));
      if (ordinal === undefined)
        throw new ConflictError("document_limit", "the matter already has three documents");
      assertNewUpload(matterId, input.version);

      const before = computeInputsDigest(matterId);
      const documentId = newId("doc");
      run(
        "INSERT INTO documents (id, matter_id, kind, title, ordinal) VALUES (?, ?, ?, ?, ?)",
        documentId,
        matterId,
        input.kind,
        title,
        ordinal,
      );
      const versionId = insertVersion(matterId, documentId, 1, input.version, opts.actorId);
      if (input.version.operative) makeOperative(documentId, versionId);
      const version = getVersion(matterId, versionId) as DocumentVersionRow;
      ctx.audit({
        actorId: opts.actorId,
        matterId,
        action: "document.add",
        targetType: "document",
        targetId: documentId,
        detail: {
          versionId,
          label: labelOf(ordinal),
          kind: input.kind,
          fileSha256: version.fileSha256,
          textSha256: version.textSha256,
          byteSize: version.byteSize,
          operative: version.operative,
        },
      });
      invalidateIfChanged(matterId, before, INPUT_CHANGE_REASONS.documentAdded, opts.actorId);
      return { document: getDocument(matterId, documentId) as DocumentRow, version };
    });
  }

  /**
   * Adds a version of a document. A document's operative flag is cleared when a new version
   * arrives, so the old text stops governing at once and the attorney chooses the new one on
   * purpose (or passes `operative: true` to choose it in the same breath).
   */
  function addVersion(
    matterId: string,
    documentId: string,
    input: NewVersionInput,
    opts: { actorId: string },
  ): DocumentVersionRow {
    cleanVersionInput(matterId, input);
    return tx(() => {
      requireMatter(matterId);
      requireUser(opts.actorId);
      if (!getDocument(matterId, documentId)) throw new NotFoundError("document");
      assertNewUpload(matterId, input);
      const before = computeInputsDigest(matterId);
      const last = get<{ n: number | null }>(
        "SELECT MAX(version_no) AS n FROM document_versions WHERE document_id = ?",
        documentId,
      );
      const versionId = insertVersion(
        matterId,
        documentId,
        (last?.n ?? 0) + 1,
        input,
        opts.actorId,
      );
      // A new version takes the flag from the old one unless it was asked not to: a re-saved copy
      // of text already held changes nothing that governs.
      if (input.keepOperative !== true)
        run(
          "UPDATE document_versions SET operative = 0 WHERE document_id = ? AND operative = 1",
          documentId,
        );
      if (input.operative) makeOperative(documentId, versionId);
      const version = getVersion(matterId, versionId) as DocumentVersionRow;
      ctx.audit({
        actorId: opts.actorId,
        matterId,
        action: "version.add",
        targetType: "document_version",
        targetId: versionId,
        detail: {
          documentId,
          versionNo: version.versionNo,
          fileSha256: version.fileSha256,
          textSha256: version.textSha256,
          byteSize: version.byteSize,
          operative: version.operative,
        },
      });
      invalidateIfChanged(matterId, before, INPUT_CHANGE_REASONS.documentChanged, opts.actorId);
      return version;
    });
  }

  function setOperativeVersion(
    matterId: string,
    documentVersionId: string,
    opts: { actorId: string },
  ): DocumentVersionRow {
    return tx(() => {
      const version = getVersion(matterId, documentVersionId);
      if (!version) throw new NotFoundError("document version");
      if (version.operative) return version;
      const before = computeInputsDigest(matterId);
      const previous = get<{ id: string }>(
        "SELECT id FROM document_versions WHERE document_id = ? AND operative = 1",
        version.documentId,
      );
      makeOperative(version.documentId, version.id);
      ctx.audit({
        actorId: opts.actorId,
        matterId,
        action: "version.operative",
        targetType: "document_version",
        targetId: version.id,
        detail: { documentId: version.documentId, previousVersionId: previous?.id ?? null },
      });
      invalidateIfChanged(matterId, before, INPUT_CHANGE_REASONS.operativeChanged, opts.actorId);
      return getVersion(matterId, version.id) as DocumentVersionRow;
    });
  }

  function setStatedDate(
    matterId: string,
    documentVersionId: string,
    statedDate: string | null,
    opts: { actorId: string },
  ): DocumentVersionRow {
    const date = cleanStatedDate(statedDate);
    return tx(() => {
      const version = getVersion(matterId, documentVersionId);
      if (!version) throw new NotFoundError("document version");
      if (version.statedDate === date) return version;
      const before = computeInputsDigest(matterId);
      run("UPDATE document_versions SET stated_date = ? WHERE id = ?", date, version.id);
      ctx.audit({
        actorId: opts.actorId,
        matterId,
        action: "version.stated_date",
        targetType: "document_version",
        targetId: version.id,
        detail: { documentId: version.documentId, operative: version.operative },
      });
      // Only an operative version's date is an input; a date on a superseded draft changes nothing.
      invalidateIfChanged(matterId, before, INPUT_CHANGE_REASONS.statedDateChanged, opts.actorId);
      return getVersion(matterId, version.id) as DocumentVersionRow;
    });
  }

  /**
   * Removes a document and everything derived from it. Returns the storage paths of its versions so
   * the caller can delete the files with `FileStore.remove`.
   */
  function removeDocument(
    matterId: string,
    documentId: string,
    opts: { actorId: string },
  ): string[] {
    return tx(() => {
      requireMatter(matterId);
      if (!getDocument(matterId, documentId)) throw new NotFoundError("document");
      const before = computeInputsDigest(matterId);
      const versions = listVersions(matterId, documentId);
      run("DELETE FROM documents WHERE id = ? AND matter_id = ?", documentId, matterId);
      ctx.audit({
        actorId: opts.actorId,
        matterId,
        action: "document.remove",
        targetType: "document",
        targetId: documentId,
        detail: { versions: versions.length },
      });
      invalidateIfChanged(matterId, before, INPUT_CHANGE_REASONS.documentRemoved, opts.actorId);
      return versions.map((v) => v.storagePath);
    });
  }

  // --- spans and annotations ----------------------------------------------------------------

  function getSpan(matterId: string, spanId: string): StoredSpan | undefined {
    const row = get<RawSpan>(
      `SELECT s.*, d.id AS document_id, d.title AS document_title, d.kind AS document_kind,
              d.ordinal AS ordinal, v.version_no AS version_no
       FROM source_spans s
       JOIN document_versions v ON v.id = s.document_version_id
       JOIN documents d ON d.id = v.document_id
       WHERE s.id = ? AND s.matter_id = ?`,
      spanId,
      matterId,
    );
    return row ? toSpan(row) : undefined;
  }

  /** Spans of the named document versions, in document, then paragraph order. */
  function listSpans(matterId: string, documentVersionIds: readonly string[]): StoredSpan[] {
    return all<RawSpan>(
      `SELECT s.*, d.id AS document_id, d.title AS document_title, d.kind AS document_kind,
              d.ordinal AS ordinal, v.version_no AS version_no
       FROM source_spans s
       JOIN document_versions v ON v.id = s.document_version_id
       JOIN documents d ON d.id = v.document_id
       WHERE s.matter_id = ? AND s.document_version_id IN (SELECT value FROM json_each(?))
       ORDER BY d.ordinal, v.version_no, s.paragraph_index`,
      matterId,
      JSON.stringify(documentVersionIds),
    ).map(toSpan);
  }

  const hasSpans = (matterId: string, documentVersionId: string): boolean =>
    get<{ n: number }>(
      "SELECT 1 AS n FROM source_spans WHERE matter_id = ? AND document_version_id = ? LIMIT 1",
      matterId,
      documentVersionId,
    ) !== undefined;

  /**
   * Stores the spans and annotations `buildIngest` produced. Ingest is deterministic, so a resumed
   * run produces the same spans again: a version that already has them is left alone when they
   * match and refused when they do not. Spans are immutable once written.
   */
  function insertSpans(
    matterId: string,
    spans: readonly SourceSpan[],
    annotations: readonly SpanAnnotation[] = [],
  ): { inserted: number; skipped: number } {
    const parsed = spans.map((span) => ({ ...parseWith(SpanSchema, span, "span"), source: span }));
    const notes = annotations.map((a) => parseWith(AnnotationSchema, a, "annotation"));
    for (const span of parsed) {
      if (span.id !== `${span.documentVersionId}:p${span.paragraphIndex}`)
        throw new ValidationError(
          "bad_span_id",
          "span id must be <documentVersionId>:p<paragraphIndex>",
        );
      if (span.textSha256 !== sha256Hex(span.text))
        throw new ValidationError("bad_span_hash", "span text hash does not match its text");
    }
    return tx(() => {
      requireMatter(matterId);
      const versionIds = [...new Set(parsed.map((s) => s.documentVersionId))];
      for (const versionId of versionIds)
        if (!getVersion(matterId, versionId)) throw new NotFoundError("document version");

      let inserted = 0;
      let skipped = 0;
      const known = new Set<string>();
      for (const versionId of versionIds) {
        const mine = parsed.filter((s) => s.documentVersionId === versionId);
        if (hasSpans(matterId, versionId)) {
          const stored = new Map(
            all<{
              id: string;
              text_sha256: string;
              clause_id: string;
              clause_number: string | null;
              heading: string | null;
            }>(
              "SELECT id, text_sha256, clause_id, clause_number, heading FROM source_spans WHERE matter_id = ? AND document_version_id = ?",
              matterId,
              versionId,
            ).map((r) => [r.id, r]),
          );
          const same =
            stored.size === mine.length &&
            mine.every((s) => {
              const r = stored.get(s.id);
              return (
                r !== undefined &&
                r.text_sha256 === s.textSha256 &&
                r.clause_id === s.clauseId &&
                r.clause_number === s.clauseNumber &&
                r.heading === s.heading
              );
            });
          if (!same)
            throw new ConflictError(
              "spans_differ",
              "the document version already has different spans",
            );
          skipped += mine.length;
          for (const s of mine) known.add(s.id);
          continue;
        }
        for (const s of mine) {
          run(
            `INSERT INTO source_spans
               (id, document_version_id, matter_id, paragraph_index, clause_id, clause_number, heading, text, text_sha256)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            s.id,
            s.documentVersionId,
            matterId,
            s.paragraphIndex,
            s.clauseId,
            s.clauseNumber,
            s.heading,
            s.text,
            s.textSha256,
          );
          known.add(s.id);
          inserted += 1;
        }
        for (const note of notes.filter((n) => mine.some((s) => s.id === n.spanId))) {
          const { kind, spanId, ...value } = note;
          run(
            "INSERT INTO span_annotations (span_id, kind, value) VALUES (?, ?, ?)",
            spanId,
            kind,
            JSON.stringify(value),
          );
        }
      }
      for (const note of notes) if (!known.has(note.spanId)) throw new NotFoundError("span");
      return { inserted, skipped };
    });
  }

  function listAnnotations(
    matterId: string,
    documentVersionIds: readonly string[],
  ): SpanAnnotation[] {
    return all<{ span_id: string; kind: SpanAnnotation["kind"]; value: string }>(
      `SELECT a.span_id, a.kind, a.value
       FROM span_annotations a JOIN source_spans s ON s.id = a.span_id
       WHERE s.matter_id = ? AND s.document_version_id IN (SELECT value FROM json_each(?))
       ORDER BY a.rowid`,
      matterId,
      JSON.stringify(documentVersionIds),
    ).map(
      (row) =>
        ({
          kind: row.kind,
          spanId: row.span_id,
          ...(JSON.parse(row.value) as object),
        }) as SpanAnnotation,
    );
  }

  // --- retention ----------------------------------------------------------------------------

  /**
   * Moves the matter's retention date to `retainDays` whole days from now, earlier or later than
   * the date it had. It touches the date and nothing else: a retention change is not an input of
   * the review, so the findings, decisions, memo and runs keep their state, and it does not go
   * through `applyInputChange`. The event holds the two dates and the number of days.
   */
  function setRetention(
    matterId: string,
    retainDays: number,
    opts: { actorId: string | null },
  ): MatterRow {
    assertRetainDays(retainDays);
    return tx(() => {
      const matter = requireMatter(matterId);
      const to = new Date(Date.parse(ctx.now()) + retainDays * 86_400_000).toISOString();
      run("UPDATE matters SET retain_until = ? WHERE id = ?", to, matterId);
      ctx.audit({
        actorId: opts.actorId,
        matterId,
        action: "matter.retention",
        targetType: "matter",
        targetId: matterId,
        detail: { from: matter.retainUntil, to, days: retainDays },
      });
      return requireMatter(matterId);
    });
  }

  const listExpiredMatters = (now?: Date | string): MatterRow[] => {
    const at = now === undefined ? ctx.now() : new Date(now).toISOString();
    return all<RawMatter>(
      "SELECT * FROM matters WHERE retain_until <= ? ORDER BY retain_until, id",
      at,
    ).map(toMatter);
  };

  /**
   * Removes every row that belongs to the matter, the matters row included, in one transaction,
   * and leaves only the audit events (which hold ids, hashes and counts). Returns the storage paths
   * of its documents and memos; the caller deletes the files, then compacts the database. A stop
   * between the transaction and the file deletion leaves a folder that no row names: the boot sweep
   * `FileStore.sweepOrphans(repo.listMatterIds())` finds and removes it.
   *
   * It refuses while a run is in flight: the run is still writing, so it is cancelled first.
   *
   * The deletion event records why (`reason`: `requested` by the creator or an administrator,
   * `retention` by the retention command) and the retention date that was in force. Neither is
   * text: one is a closed word and the other an ISO time.
   *
   * Every table that holds matter rows is deleted from by a statement of its own, in this order.
   * That includes the pilot measures' two (migration 8): the timers, and the reference list, which
   * goes after the runs because a trigger closes it against a delete while a review exists.
   * Whoever adds a table with a `matter_id` column adds its delete here, before the parent it
   * references. The check at the end is what makes a forgotten one loud: it looks, inside the same
   * transaction, for any table with a `matter_id` column that still holds a row of this matter, and
   * rolls the whole deletion back (`matter_residue`) if one does. The matter stays whole and the
   * caller is told; nothing is quietly kept.
   */
  function deleteMatter(
    matterId: string,
    opts: { actorId: string | null; reason?: "requested" | "retention" },
  ): string[] {
    const reason = opts.reason ?? "requested";
    // A closed word, because it is written into the log: a value from anywhere else must not be.
    if (reason !== "requested" && reason !== "retention")
      throw new ValidationError("bad_reason", "the reason for a deletion is not recognised");
    return tx(() => {
      const matter = requireMatter(matterId);
      if (matter.status === "running" || hasActiveRun(matterId))
        throw new ConflictError(
          "matter_running",
          "the matter has a run in flight; cancel it first",
        );

      const paths = [
        ...all<{ storage_path: string }>(
          "SELECT storage_path FROM document_versions WHERE matter_id = ? ORDER BY storage_path",
          matterId,
        ),
        ...all<{ storage_path: string }>(
          "SELECT storage_path FROM memos WHERE matter_id = ? ORDER BY storage_path",
          matterId,
        ),
      ].map((r) => r.storage_path);

      // Children before parents. The foreign keys cascade as well, but deleting in order keeps the
      // counts exact and does not depend on the order SQLite happens to cascade in.
      const counts = {
        evalSlotResults: run(
          "DELETE FROM eval_slot_results WHERE run_id IN (SELECT id FROM runs WHERE matter_id = ?)",
          matterId,
        ),
        reviews: run("DELETE FROM reviews WHERE matter_id = ?", matterId),
        feedback: run("DELETE FROM feedback WHERE matter_id = ?", matterId),
        memos: run("DELETE FROM memos WHERE matter_id = ?", matterId),
        // Timers hold a role and two timestamps; they are deleted with the matter they timed.
        timeEntries: run("DELETE FROM time_entries WHERE matter_id = ?", matterId),
        verificationResults: run(
          "DELETE FROM verification_results WHERE finding_id IN (SELECT id FROM findings WHERE matter_id = ?)",
          matterId,
        ),
        evidence: run(
          "DELETE FROM finding_evidence WHERE finding_id IN (SELECT id FROM findings WHERE matter_id = ?)",
          matterId,
        ),
        findings: run("DELETE FROM findings WHERE matter_id = ?", matterId),
        modelCalls: run(
          "DELETE FROM model_calls WHERE run_id IN (SELECT id FROM runs WHERE matter_id = ?)",
          matterId,
        ),
        runStages: run(
          "DELETE FROM run_stages WHERE run_id IN (SELECT id FROM runs WHERE matter_id = ?)",
          matterId,
        ),
        runs: run("DELETE FROM runs WHERE matter_id = ?", matterId),
        // After the runs, on purpose: the reference list is closed by a trigger while a review of the
        // matter exists (migration 8), and it is the runs' going that opens it to a delete.
        referenceIssues: run("DELETE FROM reference_issues WHERE matter_id = ?", matterId),
        annotations: run(
          "DELETE FROM span_annotations WHERE span_id IN (SELECT id FROM source_spans WHERE matter_id = ?)",
          matterId,
        ),
        // Their keys cascade from the spans and the versions, but a deletion that depends on the
        // cascade having run (and on the connection having foreign keys on) is not one to count on.
        ingestWarnings: run("DELETE FROM ingest_warnings WHERE matter_id = ?", matterId),
        spans: run("DELETE FROM source_spans WHERE matter_id = ?", matterId),
        versions: run("DELETE FROM document_versions WHERE matter_id = ?", matterId),
        documents: run("DELETE FROM documents WHERE matter_id = ?", matterId),
        members: run("DELETE FROM matter_members WHERE matter_id = ?", matterId),
      };
      run("DELETE FROM matters WHERE id = ?", matterId);

      // Still inside the transaction: a table this function does not know about, and that holds a
      // row of the matter, undoes the whole deletion. The message names tables of the schema only.
      const left = tablesHoldingMatter(ctx.db, matterId);
      if (left.length > 0)
        throw new ConflictError(
          "matter_residue",
          `a table still holds rows of the matter: ${left.join(", ")}`,
        );

      ctx.audit({
        actorId: opts.actorId,
        matterId,
        action: "matter.delete",
        targetType: "matter",
        targetId: matterId,
        detail: {
          ...counts,
          files: paths.length,
          reason,
          retainUntil: matter.retainUntil,
        },
      });
      return paths;
    });
  }

  function hasActiveRun(matterId: string): boolean {
    return (
      get<{ n: number }>(
        `SELECT 1 AS n FROM runs
         WHERE matter_id = ? AND status IN ('queued','ingesting','extracting','retrieving','analyzing','verifying')
         LIMIT 1`,
        matterId,
      ) !== undefined
    );
  }

  return {
    // users
    seedDemoUsers,
    getUser,
    listUsers,
    // matters
    createMatter,
    getMatter,
    listMatterIds,
    listMattersForUser,
    updateClientName,
    setPlaybookVersion,
    // members
    addMember,
    getMember,
    listMembers,
    // documents
    addDocument,
    addVersion,
    setOperativeVersion,
    setStatedDate,
    removeDocument,
    getDocument,
    listDocuments,
    getVersion,
    listVersions,
    listOperativeDocuments,
    findVersionByFileSha256,
    findVersionByTextSha256,
    // spans
    insertSpans,
    hasSpans,
    getSpan,
    listSpans,
    listAnnotations,
    // inputs
    computeInputsDigest,
    applyInputChange,
    // retention
    listExpiredMatters,
    setRetention,
    deleteMatter,
    // internal, shared with the other repository modules
    internal: { requireMatter, requireUser, transitionMatter, invalidateIfChanged },
  };
}

export type MattersApi = ReturnType<typeof createMattersApi>;
