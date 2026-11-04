import { NotFoundError, type Repository } from "../store/index.js";
import { START_REASONS } from "./phrases.js";
import type { StartReadiness } from "./views.js";

/**
 * Whether a review can start, with the reasons it cannot as fixed phrases a person can act on. A
 * matter that already has results is ready too: starting again is a re-run.
 *
 * Everything is read from the database for the matter named, so a page cannot talk a service into
 * starting a review the matter is not ready for.
 */
export function startReadiness(repo: Repository, matterId: string): StartReadiness {
  const matter = repo.getMatter(matterId);
  if (matter === undefined) throw new NotFoundError("matter");

  const reasons: string[] = [];
  if (matter.playbookVersionId === null) reasons.push(START_REASONS.noPlaybook);

  const documents = repo.listDocuments(matterId);
  if (!documents.some((d) => d.kind === "nda")) {
    reasons.push(START_REASONS.noNda);
  } else {
    const operative = repo.listOperativeDocuments(matterId);
    if (operative.length < documents.length) {
      reasons.push(START_REASONS.noOperative);
    } else {
      const versionIds = operative.map((o) => o.version.id);
      const withoutText =
        versionIds.some((id) => !repo.hasSpans(matterId, id)) ||
        repo.listIngestWarnings(matterId, versionIds).some((w) => w.code === "no_reviewable_text");
      if (withoutText) reasons.push(START_REASONS.noReviewableText);
    }
  }

  if (repo.getActiveRun(matterId) !== undefined) reasons.push(START_REASONS.runInFlight);
  return { ready: reasons.length === 0, reasons };
}
