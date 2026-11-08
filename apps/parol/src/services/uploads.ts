import type { DocxParagraph } from "@clausewise/docx";
import { sha256Hex } from "../canonical.js";
import {
  DOC_LABELS,
  DOCUMENT_KINDS,
  type DocLabel,
  type DocumentKind,
  type IngestDocumentInput,
  type IngestOutput,
} from "../contracts.js";
import { annotateSpans } from "../ingest/annotate.js";
import { buildIngest } from "../ingest/ingest.js";
import { parseDocument } from "../ingest/parse.js";
import { documentTextSha256 } from "../ingest/text-hash.js";
import { UploadError, type ParsedDocument } from "../module-contracts.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type DocumentRow,
  type DocumentVersionRow,
  type NewIngestWarning,
} from "../store/index.js";
import type { ServiceDeps } from "./deps.js";
import { duplicateDetail, nearDuplicateDetail } from "./phrases.js";
import type { Presenter } from "./present.js";
import type { UploadWarningView } from "./views.js";

/** How many parsed documents are kept so that building the ingest of a matter does not parse a file twice. */
const PARSED_CACHE_SIZE = 24;
const MAX_FILE_NAME = 1000;

/** The result of an upload, in the shape `MatterService` returns it. */
export interface UploadResult {
  documentId: string;
  versionId: string;
  warnings: UploadWarningView[];
}

interface Slot {
  /** Null for a document that does not exist yet. */
  documentId: string | null;
  label: DocLabel;
  kind: DocumentKind;
  title: string;
  version: { id: string; versionNo: number; statedDate: string | null };
  parsed: ParsedDocument;
}

const PENDING_VERSION = "ver_pending";

/**
 * The upload pipeline: parse, hash, store the file, register the version, and build the spans that
 * the review will read. Parsing and file work are asynchronous or touch the disk, so none of it
 * sits inside a store transaction; the store's own methods are the transactions, and a file saved
 * before one that then fails is removed again.
 *
 * Nothing that came from an upload reaches a log, an audit detail, an error message or a file
 * name. The file's name is read for its extension and nowhere else; stored files get generated
 * names from the file store.
 */
export function createUploads(deps: ServiceDeps, present: Presenter) {
  const { repo, files } = deps;

  const parsedCache = new Map<string, ParsedDocument>();
  function remember(versionId: string, parsed: ParsedDocument): void {
    parsedCache.delete(versionId);
    parsedCache.set(versionId, parsed);
    while (parsedCache.size > PARSED_CACHE_SIZE) {
      const oldest = parsedCache.keys().next().value;
      if (oldest === undefined) break;
      parsedCache.delete(oldest);
    }
  }
  const forget = (versionIds: readonly string[]): void => {
    for (const id of versionIds) parsedCache.delete(id);
  };

  async function loadParsed(version: DocumentVersionRow): Promise<ParsedDocument> {
    const cached = parsedCache.get(version.id);
    if (cached !== undefined) return cached;
    const parsed = await parseDocument({
      bytes: files.read(version.storagePath),
      mediaType: version.mediaType,
    });
    remember(version.id, parsed);
    return parsed;
  }

  // --- reading a request ----------------------------------------------------------------------

  function mediaTypeOf(fileName: unknown): "docx" | "txt" {
    if (typeof fileName !== "string" || fileName.length > MAX_FILE_NAME)
      throw new UploadError("Only .docx and .txt files can be uploaded.");
    const extension = /\.([A-Za-z0-9]{1,8})$/.exec(fileName.trim())?.[1]?.toLowerCase();
    if (extension === "docx" || extension === "txt") return extension;
    throw new UploadError("Only .docx and .txt files can be uploaded.");
  }

  function bytesOf(value: unknown): Uint8Array {
    if (!(value instanceof Uint8Array))
      throw new ValidationError("bad_bytes", "the file must be bytes");
    return value;
  }

  // --- the documents of a matter as ingest wants them ------------------------------------------

  /** The labels must run D1, D2, D3 with no gap and the NDA first, or `buildIngest` refuses. */
  function layoutIsValid(documents: readonly Pick<DocumentRow, "label" | "kind">[]): boolean {
    return documents.every(
      (d, index) => d.label === DOC_LABELS[index] && d.kind === (index === 0 ? "nda" : "amendment"),
    );
  }

  /** The version of a document that ingest reads: the operative one, else the newest. */
  function governingVersion(matterId: string, documentId: string): DocumentVersionRow | undefined {
    const versions = repo.listVersions(matterId, documentId);
    return versions.find((v) => v.operative) ?? versions[versions.length - 1];
  }

  /**
   * The parsed text of every version ingest would read for the matter, by version id. Parsing is
   * asynchronous and a store transaction is not, so whatever a transaction will need is loaded
   * first and handed to it. The document being given a new version is left out: the new version
   * stands in for it.
   */
  async function loadGoverning(
    matterId: string,
    replacing?: string,
  ): Promise<Map<string, ParsedDocument>> {
    const loaded = new Map<string, ParsedDocument>();
    for (const document of repo.listDocuments(matterId)) {
      if (document.id === replacing) continue;
      const version = governingVersion(matterId, document.id);
      if (version !== undefined) loaded.set(version.id, await loadParsed(version));
    }
    return loaded;
  }

  /**
   * What `buildIngest` makes of the matter's documents, each in its governing version, with
   * `pending` standing in for the version being added (a version not written yet, or one that was
   * just written and is not the governing one). Only the spans of that version are kept from this;
   * the others are already stored. Synchronous, so that it can run inside the transaction that
   * registers the version: `loaded` must hold what `loadGoverning` returned a moment ago.
   */
  function ingestOf(
    matterId: string,
    loaded: ReadonlyMap<string, ParsedDocument>,
    pending?: Slot,
  ): IngestOutput {
    const slots: Slot[] = [];
    for (const document of repo.listDocuments(matterId)) {
      if (pending !== undefined && pending.documentId === document.id) {
        slots.push(pending);
        continue;
      }
      const version = governingVersion(matterId, document.id);
      if (version === undefined) continue;
      // A document that another upload registered while this one was loading is in the cache.
      const parsed = loaded.get(version.id) ?? parsedCache.get(version.id);
      if (parsed === undefined)
        throw new ConflictError(
          "matter_changed",
          "the documents of the matter changed while the file was being read; upload it again",
        );
      slots.push({
        documentId: document.id,
        label: document.label,
        kind: document.kind,
        title: document.title,
        version: { id: version.id, versionNo: version.versionNo, statedDate: version.statedDate },
        parsed,
      });
    }
    if (pending !== undefined && pending.documentId === null) slots.push(pending);
    slots.sort((a, b) => a.label.localeCompare(b.label));
    if (!layoutIsValid(slots))
      throw new ConflictError(
        "document_layout",
        "the documents of the matter must be an NDA followed by its amendments",
      );
    const documents: IngestDocumentInput[] = slots.map((slot) => ({
      documentVersionId: slot.version.id,
      label: slot.label,
      kind: slot.kind,
      title: slot.title,
      versionNo: slot.version.versionNo,
      statedDate: slot.version.statedDate,
      paragraphs: slot.parsed.paragraphs as DocxParagraph[],
      inspection: slot.parsed.inspection,
    }));
    return buildIngest({ documents });
  }

  /**
   * Brings the annotations of the matter's operative versions in line with what `buildIngest` would
   * make of them now. Annotations link a term one document defines to a document that uses it, so
   * they change when the set of governing versions changes, and the spans (which do not) are left
   * alone. It reads stored spans only: `annotateSpans` is the function `buildIngest` calls, with
   * the same inputs, so a resumed run reads the annotations ingest would have produced.
   *
   * It does nothing while a document has no operative version or the layout is not an NDA followed
   * by amendments: the matter cannot start a review then, and the next change tries again.
   */
  function refreshAnnotations(matterId: string): void {
    const documents = repo.listDocuments(matterId);
    const operative = repo.listOperativeDocuments(matterId);
    if (documents.length === 0 || operative.length !== documents.length) return;
    if (!layoutIsValid(documents)) return;
    const versionIds = operative.map((o) => o.version.id);
    const spans = repo.listSpans(matterId, versionIds);
    if (spans.length === 0) return;
    const { annotations } = annotateSpans(
      spans.map((s) => ({ id: s.id, text: s.text, documentKind: s.documentKind })),
    );
    repo.replaceAnnotations(matterId, versionIds, annotations);
  }

  // --- one upload ----------------------------------------------------------------------------

  const labelOf = (matterId: string, documentId: string): DocLabel | null =>
    repo.getDocument(matterId, documentId)?.label ?? null;

  /** An identical file is not stored again; the person is told which version it matches. */
  function duplicateResult(matterId: string, existing: DocumentVersionRow): UploadResult {
    const label = labelOf(matterId, existing.documentId);
    return {
      documentId: existing.documentId,
      versionId: existing.id,
      warnings: [
        {
          code: "duplicate_document",
          documentLabel: label,
          spanLabel: null,
          detail:
            label === null
              ? "same file as an earlier upload"
              : duplicateDetail(label, existing.versionNo),
        },
      ],
    };
  }

  /**
   * `duplicateResult`, unless the upload carried a stated date that the stored version does not
   * have. An identical file is not stored again, so the date would be dropped without a word, and
   * the stated date decides which amendment governs. The person is told to change the date where it
   * is kept, which stales the review as any change of a date does.
   */
  function duplicateOf(
    matterId: string,
    existing: DocumentVersionRow,
    statedDate: string | null,
  ): UploadResult {
    if (statedDate !== null && statedDate !== existing.statedDate)
      throw new ConflictError(
        "duplicate_stated_date",
        "the file is already in the matter and was not stored again, so the stated date was not applied; change the date on the existing version",
      );
    return duplicateResult(matterId, existing);
  }

  function removeQuietly(storagePath: string, matterId: string): void {
    try {
      files.remove(storagePath);
    } catch {
      // The file is already gone, or cannot be removed; either way the row is not there, and a
      // folder with a stray file is swept when the matter is deleted. Say that it happened, by id.
      deps.log(`upload cleanup: a stored file could not be removed (matter ${matterId})`);
    }
  }

  /** Ingest's warnings for one version, with span ids shown as labels, and the near-duplicate notice. */
  function warningsFor(
    ingest: IngestOutput,
    versionId: string,
    label: DocLabel,
    nearDuplicateOf: { label: DocLabel; versionNo: number } | null,
  ): NewIngestWarning[] {
    const own: NewIngestWarning[] = ingest.warnings
      .filter((w) => w.documentVersionId === versionId)
      .map((w) => ({
        code: w.code,
        spanId: w.spanId ?? null,
        // The detail names a span by its id; people read labels.
        detail: w.detail.split(`${versionId}:p`).join(`${label}-p`),
      }));
    if (nearDuplicateOf !== null)
      own.push({
        code: "near_duplicate_version",
        detail: nearDuplicateDetail(nearDuplicateOf.label, nearDuplicateOf.versionNo),
      });
    return own;
  }

  /**
   * Stores the spans of the new version and its warnings, and refreshes the annotations of the
   * matter. Called inside the transaction that registers the version, so that a version is never
   * in the store without its spans: if this fails, the registration is rolled back with it, and a
   * process that stops half way leaves nothing behind either.
   */
  function indexVersion(
    matterId: string,
    version: DocumentVersionRow,
    document: DocumentRow,
    parsed: ParsedDocument,
    loaded: ReadonlyMap<string, ParsedDocument>,
    nearDuplicateOf: { label: DocLabel; versionNo: number } | null,
  ): UploadWarningView[] {
    // The new version stands in for its own document whether or not it is the one that governs:
    // a version that waits for the associate's choice still needs its spans.
    const ingest = ingestOf(matterId, loaded, {
      documentId: document.id,
      label: document.label,
      kind: document.kind,
      title: document.title,
      version: { id: version.id, versionNo: version.versionNo, statedDate: version.statedDate },
      parsed,
    });
    const spans = ingest.spans.filter((s) => s.documentVersionId === version.id);
    const spanIds = new Set(spans.map((s) => s.id));
    repo.insertSpans(
      matterId,
      spans,
      ingest.annotations.filter((a) => spanIds.has(a.spanId)),
    );
    const stored = repo.replaceIngestWarnings(
      matterId,
      version.id,
      warningsFor(ingest, version.id, document.label, nearDuplicateOf),
    );
    refreshAnnotations(matterId);
    return stored.map((w) => present.warningView(w, document.label));
  }

  function nearDuplicateOf(
    matterId: string,
    textSha256: string,
  ): { label: DocLabel; versionNo: number } | null {
    const twin = repo.findVersionByTextSha256(matterId, textSha256);
    if (twin === undefined) return null;
    const label = labelOf(matterId, twin.documentId);
    return label === null ? null : { label, versionNo: twin.versionNo };
  }

  /** A duplicate found at the door, or by the store when two uploads raced. */
  const isDuplicateConflict = (error: unknown): boolean =>
    error instanceof ConflictError &&
    (error.code === "duplicate_file" || error.code === "storage_path_in_use");

  /**
   * The NDA is D1, because the model reads the documents in order and the NDA is the base text.
   * An amendment without one would take D1 and the review could not read the matter at all.
   */
  function checkPlacement(matterId: string, kind: DocumentKind): void {
    // A matter deleted while its upload was being read has no documents, which would read as "upload
    // the NDA first". It is gone, as it is for every other request that names it.
    if (repo.getMatter(matterId) === undefined) throw new NotFoundError("matter");
    const existing = repo.listDocuments(matterId);
    if (kind === "amendment" && !existing.some((d) => d.kind === "nda"))
      throw new ValidationError("nda_first", "upload the NDA before an amendment");
    if (kind === "nda" && existing.some((d) => d.kind === "nda"))
      throw new ConflictError("nda_exists", "the matter already has an NDA");
  }

  /** The label the next document of the matter will have: the smallest that is free. */
  function nextLabel(matterId: string): DocLabel {
    const used = new Set(repo.listDocuments(matterId).map((d) => d.label));
    const label = DOC_LABELS.find((l) => !used.has(l));
    if (label === undefined)
      throw new ConflictError("document_limit", "the matter already has three documents");
    return label;
  }

  async function addDocument(
    matterId: string,
    actorId: string,
    input: {
      title: string;
      kind: DocumentKind;
      fileName: string;
      bytes: Uint8Array;
      statedDate: string | null;
    },
  ): Promise<UploadResult> {
    if (!(DOCUMENT_KINDS as readonly string[]).includes(input.kind))
      throw new ValidationError("bad_kind", "kind must be nda or amendment");
    const mediaType = mediaTypeOf(input.fileName);
    const bytes = bytesOf(input.bytes);
    checkPlacement(matterId, input.kind);

    const fileSha256 = sha256Hex(bytes);
    const known = repo.findVersionByFileSha256(matterId, fileSha256);
    if (known !== undefined) return duplicateOf(matterId, known, input.statedDate);

    const parsed = await parseDocument({ bytes, mediaType });
    const textSha256 = documentTextSha256(parsed.paragraphs);
    const loaded = await loadGoverning(matterId);

    // From here to the end of the transaction nothing waits, so what is read here is what is
    // written to. Another upload may have stored these bytes, or taken the label this one was
    // going to have, while this one was being parsed.
    const raced = repo.findVersionByFileSha256(matterId, fileSha256);
    if (raced !== undefined) return duplicateOf(matterId, raced, input.statedDate);
    checkPlacement(matterId, input.kind);

    // A dry run of ingest with the new document in place, before anything is written: a document
    // that ingest cannot read is refused with nothing to undo.
    const label = nextLabel(matterId);
    ingestOf(matterId, loaded, {
      documentId: null,
      label,
      kind: input.kind,
      title: input.title,
      version: { id: PENDING_VERSION, versionNo: 1, statedDate: input.statedDate },
      parsed,
    });

    // Nothing below waits: the document, its version, its spans and its warnings are written in
    // one transaction, so that the store never holds a document that a review cannot read, whether
    // indexing fails or the process stops half way.
    const near = nearDuplicateOf(matterId, textSha256);
    const storagePath = files.save(matterId, bytes);
    let added: { documentId: string; versionId: string; warnings: UploadWarningView[] };
    try {
      added = repo.transaction(() => {
        const registered = repo.addDocument(
          matterId,
          {
            kind: input.kind,
            title: input.title,
            version: {
              mediaType,
              fileSha256,
              textSha256,
              byteSize: bytes.byteLength,
              statedDate: input.statedDate,
              storagePath,
              operative: true,
            },
          },
          { actorId },
        );
        const warnings = indexVersion(
          matterId,
          registered.version,
          registered.document,
          parsed,
          loaded,
          near,
        );
        return {
          documentId: registered.document.id,
          versionId: registered.version.id,
          warnings,
        };
      });
    } catch (error) {
      removeQuietly(storagePath, matterId);
      if (isDuplicateConflict(error)) {
        const existing = repo.findVersionByFileSha256(matterId, fileSha256);
        if (existing !== undefined) return duplicateOf(matterId, existing, input.statedDate);
      }
      throw error;
    }
    remember(added.versionId, parsed);
    return added;
  }

  async function addVersion(
    matterId: string,
    actorId: string,
    documentId: string,
    input: { fileName: string; bytes: Uint8Array; statedDate: string | null },
  ): Promise<{ versionId: string; warnings: UploadWarningView[] }> {
    const document = repo.getDocument(matterId, documentId);
    // A document of another matter is refused as one that does not exist.
    if (document === undefined) throw new NotFoundError("document");
    const mediaType = mediaTypeOf(input.fileName);
    const bytes = bytesOf(input.bytes);

    const fileSha256 = sha256Hex(bytes);
    const known = repo.findVersionByFileSha256(matterId, fileSha256);
    if (known !== undefined) {
      const duplicate = duplicateOf(matterId, known, input.statedDate);
      return { versionId: duplicate.versionId, warnings: duplicate.warnings };
    }

    const parsed = await parseDocument({ bytes, mediaType });
    const textSha256 = documentTextSha256(parsed.paragraphs);
    const loaded = await loadGoverning(matterId, documentId);

    // From here to the end of the transaction nothing waits (see addDocument). The document, or its
    // matter, may have been deleted while the file was being read.
    if (repo.getDocument(matterId, documentId) === undefined) throw new NotFoundError("document");
    const raced = repo.findVersionByFileSha256(matterId, fileSha256);
    if (raced !== undefined) {
      const duplicate = duplicateOf(matterId, raced, input.statedDate);
      return { versionId: duplicate.versionId, warnings: duplicate.warnings };
    }

    const versions = repo.listVersions(matterId, documentId);
    ingestOf(matterId, loaded, {
      documentId,
      label: document.label,
      kind: document.kind,
      title: document.title,
      version: {
        id: PENDING_VERSION,
        versionNo: Math.max(0, ...versions.map((v) => v.versionNo)) + 1,
        statedDate: input.statedDate,
      },
      parsed,
    });

    // Nothing below waits: the version, its spans and its warnings are written in one transaction,
    // so that a version is never registered (and the old one never taken out of force) without
    // spans, whether indexing fails or the process stops half way.
    //
    // A re-saved file with the same text is stored, but it does not replace the governing version
    // by itself, so nothing goes stale: the associate chooses, because it may be the file they
    // meant to keep.
    const near = nearDuplicateOf(matterId, textSha256);
    const storagePath = files.save(matterId, bytes);
    let added: { versionId: string; warnings: UploadWarningView[] };
    try {
      added = repo.transaction(() => {
        const version = repo.addVersion(
          matterId,
          documentId,
          {
            mediaType,
            fileSha256,
            textSha256,
            byteSize: bytes.byteLength,
            statedDate: input.statedDate,
            storagePath,
            operative: near === null,
            // The old version keeps governing: the text is the same, so the review stands.
            ...(near === null ? {} : { keepOperative: true }),
          },
          { actorId },
        );
        const warnings = indexVersion(matterId, version, document, parsed, loaded, near);
        return { versionId: version.id, warnings };
      });
    } catch (error) {
      removeQuietly(storagePath, matterId);
      if (isDuplicateConflict(error)) {
        const existing = repo.findVersionByFileSha256(matterId, fileSha256);
        if (existing !== undefined) {
          const duplicate = duplicateOf(matterId, existing, input.statedDate);
          return { versionId: duplicate.versionId, warnings: duplicate.warnings };
        }
      }
      throw error;
    }
    remember(added.versionId, parsed);
    return added;
  }

  return { addDocument, addVersion, refreshAnnotations, forget };
}

export type Uploads = ReturnType<typeof createUploads>;
