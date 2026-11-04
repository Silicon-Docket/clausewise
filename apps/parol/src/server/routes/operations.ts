import type { AuthorizedMatter, Principal } from "../../auth/types.js";
import type { Services } from "../../services/types.js";
import type {
  MatterSummary,
  MatterView,
  RunSummary,
  UploadWarningView,
} from "../../services/views.js";
import type { z } from "zod";
import type {
  CreateMatterInput,
  SettingsInput,
  StartRunInput,
  UploadDocumentFields,
  UploadVersionFields,
} from "./schemas.js";

/**
 * The operations that a page route and a JSON route both perform, each in one place. A route reads
 * its input in its own way (a form, a body), validates it with the schema in `schemas.ts`, and then
 * calls the function here, so the page and the API cannot drift into doing different things with
 * the same input. Authorization has been decided by the time any of these run, and the service
 * behind each checks the role again.
 */

export interface UploadedFile {
  fileName: string;
  bytes: Uint8Array;
}

export function createMatter(
  services: Services,
  principal: Principal,
  input: CreateMatterInput,
): MatterSummary {
  return services.matters.create(principal, {
    name: input.name,
    clientLegalName: input.clientLegalName,
    playbookVersionId: input.playbookVersionId ?? null,
    reviewerUserId: input.reviewerUserId ?? null,
  });
}

export function updateSettings(
  services: Services,
  am: AuthorizedMatter,
  input: SettingsInput,
): MatterView {
  return services.matters.update(am, {
    ...(input.clientLegalName === undefined ? {} : { clientLegalName: input.clientLegalName }),
    ...(input.playbookVersionId === undefined
      ? {}
      : { playbookVersionId: input.playbookVersionId }),
  });
}

export function startRun(
  services: Services,
  am: AuthorizedMatter,
  input: z.infer<typeof StartRunInput>,
): RunSummary {
  return services.runs.start(
    am,
    input.workflow === undefined ? {} : { workflowLabel: input.workflow },
  );
}

export function addDocument(
  services: Services,
  am: AuthorizedMatter,
  fields: z.infer<typeof UploadDocumentFields>,
  file: UploadedFile,
): Promise<{ documentId: string; versionId: string; warnings: UploadWarningView[] }> {
  return services.matters.addDocument(am, {
    title: fields.title,
    kind: fields.kind,
    fileName: file.fileName,
    bytes: file.bytes,
    statedDate: fields.statedDate ?? null,
  });
}

export function addVersion(
  services: Services,
  am: AuthorizedMatter,
  documentId: string,
  fields: z.infer<typeof UploadVersionFields>,
  file: UploadedFile,
): Promise<{ versionId: string; warnings: UploadWarningView[] }> {
  return services.matters.addVersion(am, documentId, {
    fileName: file.fileName,
    bytes: file.bytes,
    statedDate: fields.statedDate ?? null,
  });
}
