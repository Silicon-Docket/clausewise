import type { AuthorizedMatter } from "../auth/types.js";
import { ConflictError, NotFoundError } from "../store/index.js";
import { requireRole, type ServiceDeps } from "./deps.js";
import { ForbiddenError } from "./errors.js";
import type { RunEngine } from "./runner.js";
import type { Presenter } from "./present.js";
import { startReadiness } from "./readiness.js";
import type { Uploads } from "./uploads.js";
import type { MatterService } from "./types.js";
import type { MatterView, WorkflowOption } from "./views.js";

/**
 * Matters, their members and their documents. Every function that takes an `AuthorizedMatter`
 * checks the role first and then works on `am.matterId` only: no id from a request stands in for
 * the matter.
 */
export function createMatterService(
  deps: ServiceDeps,
  present: Presenter,
  uploads: Uploads,
  engine: RunEngine,
): MatterService {
  const { repo, files, config } = deps;

  /** After an input changed: the annotations follow the new set of documents, and a run in flight stops. */
  function afterInputChange(matterId: string): void {
    uploads.refreshAnnotations(matterId);
    engine.supersedeMatter(matterId);
  }

  function view(am: AuthorizedMatter): MatterView {
    requireRole(am, "matter.read", config);
    const matter = repo.getMatter(am.matterId);
    if (matter === undefined) throw new NotFoundError("matter");
    const active = repo.getActiveRun(matter.id);
    const current = repo.getCurrentRun(matter.id);
    return {
      matter: present.matterSummary(matter, am.role),
      members: present.members(matter.id),
      documents: present.documents(matter.id),
      warnings: present.warnings(matter.id),
      playbooks: present.playbookOptions(),
      start: startReadiness(repo, matter.id),
      activeRun: active === undefined ? null : present.runSummary(active),
      currentRun: current === undefined ? null : present.runSummary(current),
      runs: repo.listRunsForMatter(matter.id).map(present.runSummary),
      staleReason: present.staleReason(matter),
      destination: deps.generator.disclosure,
      memos: repo.listMemos(matter.id).map(present.memoSummary),
      segregationRelaxed: config.relaxedSegregation,
      workflows: workflowOptions(),
    };
  }

  /**
   * The workflow versions a review can start with, the default first. The default is the one
   * `RunService.start` picks when no label is given (the latest promoted pilot, else v1), so the
   * start form's preselected entry is the one a run would use anyway.
   */
  function workflowOptions(): WorkflowOption[] {
    const live = repo.listWorkflowVersions().filter((w) => w.status !== "retired");
    const promoted = live
      .filter((w) => w.status === "pilot")
      .sort((a, b) => (a.promotedAt ?? "").localeCompare(b.promotedAt ?? ""))
      .at(-1);
    const chosen = promoted ?? live.find((w) => w.label === "v1");
    const options = live.map((w) => ({
      label: w.label,
      status: w.status,
      isDefault: w === chosen,
    }));
    return [...options.filter((o) => o.isDefault), ...options.filter((o) => !o.isDefault)];
  }

  return {
    create(principal, input) {
      const matter = repo.transaction(() => {
        const created = repo.createMatter({
          name: input.name,
          clientLegalName: input.clientLegalName,
          createdBy: principal.userId,
        });
        if (input.playbookVersionId !== null)
          repo.setPlaybookVersion(created.id, input.playbookVersionId, {
            actorId: principal.userId,
          });
        // The creator is the associate. Naming themselves as the reviewer adds nothing, and in a
        // single-person demo it is how the relaxed mode is reached.
        if (input.reviewerUserId !== null && input.reviewerUserId !== principal.userId)
          repo.addMember(created.id, input.reviewerUserId, "reviewer", {
            actorId: principal.userId,
          });
        return repo.getMatter(created.id);
      });
      if (matter === undefined) throw new NotFoundError("matter");
      return present.matterSummary(matter, "associate");
    },

    list(principal) {
      return repo
        .listMattersForUser(principal.userId)
        .map((matter) => present.matterSummary(matter, matter.role));
    },

    view,

    update(am, patch) {
      requireRole(am, "matter.update", config);
      const actorId = am.principal.userId;
      repo.transaction(() => {
        if (patch.clientLegalName !== undefined)
          repo.updateClientName(am.matterId, patch.clientLegalName, { actorId });
        if (patch.playbookVersionId !== undefined)
          repo.setPlaybookVersion(am.matterId, patch.playbookVersionId, { actorId });
      });
      afterInputChange(am.matterId);
      return view(am);
    },

    addMember(am, input) {
      requireRole(am, "member.add", config);
      repo.addMember(am.matterId, input.userId, input.role, { actorId: am.principal.userId });
    },

    async addDocument(am, input) {
      requireRole(am, "document.write", config);
      const result = await uploads.addDocument(am.matterId, am.principal.userId, input);
      afterInputChange(am.matterId);
      return result;
    },

    async addVersion(am, documentId, input) {
      requireRole(am, "document.write", config);
      const result = await uploads.addVersion(am.matterId, am.principal.userId, documentId, input);
      afterInputChange(am.matterId);
      return result;
    },

    setOperative(am, documentId, versionId) {
      requireRole(am, "document.write", config);
      // The version must be a version of this document, in this matter: a version id of another
      // document would otherwise change which text governs there.
      const version = repo.getVersion(am.matterId, versionId);
      if (version === undefined || version.documentId !== documentId)
        throw new NotFoundError("document version");
      repo.setOperativeVersion(am.matterId, versionId, { actorId: am.principal.userId });
      afterInputChange(am.matterId);
    },

    setStatedDate(am, versionId, statedDate) {
      requireRole(am, "document.write", config);
      repo.setStatedDate(am.matterId, versionId, statedDate, { actorId: am.principal.userId });
      afterInputChange(am.matterId);
    },

    removeDocument(am, documentId) {
      requireRole(am, "document.write", config);
      const document = repo.getDocument(am.matterId, documentId);
      if (document === undefined) throw new NotFoundError("document");
      // The documents are D1, D2, D3 in order, and the model is told them by those labels. Taking
      // one out of the middle would leave a gap that no ingest can read, so the later ones go first.
      if (repo.listDocuments(am.matterId).some((d) => d.ordinal > document.ordinal))
        throw new ConflictError("remove_later_first", "remove the later documents first");
      const versionIds = repo.listVersions(am.matterId, documentId).map((v) => v.id);
      const paths = repo.removeDocument(am.matterId, documentId, { actorId: am.principal.userId });
      uploads.forget(versionIds);
      for (const path of paths) {
        try {
          files.remove(path);
        } catch {
          deps.log(`document removal: a stored file could not be removed (matter ${am.matterId})`);
        }
      }
      afterInputChange(am.matterId);
    },

    async delete(am) {
      const matter = repo.getMatter(am.matterId);
      if (matter === undefined) throw new NotFoundError("matter");
      // Decided from the database and the principal, not from the role: deletion is the creator's
      // or an administrator's, whatever role either holds on the matter.
      if (matter.createdBy !== am.principal.userId && am.principal.globalRole !== "admin")
        throw new ForbiddenError("matter.delete");
      const versionIds = repo.listVersions(matter.id).map((v) => v.id);
      // The store will not delete under a run that is still writing, so a run in flight is
      // cancelled first and its worker told to stop.
      const active = repo.getActiveRun(matter.id);
      if (active !== undefined) {
        repo.updateRunStatus(matter.id, active.id, "cancelled", { actorId: am.principal.userId });
        engine.stop(active.id, "cancelled");
      }
      repo.deleteMatter(matter.id, { actorId: am.principal.userId });
      files.deleteMatter(matter.id);
      uploads.forget(versionIds);
      // Outside any transaction, as the store requires: it rewrites the database file.
      repo.compact();
    },

    playbooks: () => present.playbookOptions(),

    users: () =>
      repo.listUsers().map((u) => ({
        userId: u.id,
        displayName: u.displayName,
        globalRole: u.globalRole,
      })),
  };
}
