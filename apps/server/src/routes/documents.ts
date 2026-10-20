import { createHash } from "node:crypto";
import type { DocumentListResponse, DocumentSummary } from "@clausewise/api";
import { DocxError, parseDocx } from "@clausewise/docx";
import { desc, eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { readBody, sizeLimitText } from "../body.js";
import { documents, reviews } from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import type { AppEnv } from "../env.js";
import { HttpError, badRequest, notFound, tooLarge } from "../errors.js";
import { DOCX_TYPE, attachmentDisposition, cleanFileName } from "../filename.js";
import { mediaType } from "../security.js";
import { createSlots } from "../slots.js";
import { uuidParam } from "./ids.js";
import { limitParam } from "./limit.js";

// The boundary lines and headers of the form around the file.
const MULTIPART_OVERHEAD = 64 * 1024;
/** Uploads read at the same time. The next one is told to try again. */
export const MAX_UPLOADS_IN_FLIGHT = 4;
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

const hasZipSignature = (bytes: Uint8Array): boolean =>
  ZIP_SIGNATURE.every((byte, i) => bytes[i] === byte);

const invalidDocument = (message: string): HttpError =>
  new HttpError(422, "invalid_document", message);

/**
 * Opens the upload as the review will, with the docx package's limits, and refuses it in the
 * Word engine's own words if it does not open: the engine knows an old .doc or a password
 * protected file by their first bytes and says which of them it is. A file that opens but does not
 * begin with the zip signature (a zip with something in front of it) is refused as well, because
 * Word does not open it either.
 */
async function openUpload(bytes: Uint8Array): Promise<{ paragraphs: number }> {
  try {
    const parsed = await parseDocx(bytes);
    if (!hasZipSignature(bytes)) {
      throw new DocxError("Not a .docx file: it is not a valid zip archive");
    }
    return { paragraphs: parsed.paragraphs.length };
  } catch (error) {
    if (error instanceof DocxError) throw invalidDocument(error.message);
    throw error;
  }
}

const CAP_ADVICE =
  "Make the document smaller, or ask whoever runs this server to raise CLAUSEWISE_MAX_UPLOAD_MB.";

export function documentRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { db, storage, config, clock, ids, runner } = deps;
  const tooBig = `The file is larger than the limit of ${sizeLimitText(config.maxUploadBytes)}. ${CAP_ADVICE}`;

  const summary = (row: {
    id: string;
    fileName: string;
    size: number;
    paragraphs: number;
    createdAt: Date;
    reviewCount: number;
  }): DocumentSummary => ({
    id: row.id,
    fileName: row.fileName,
    size: row.size,
    paragraphs: row.paragraphs,
    createdAt: row.createdAt.toISOString(),
    reviewCount: row.reviewCount,
  });

  // An upload is held in memory several times over while it is read, parsed and checked, so the
  // number in flight is bounded: with the upload cap that bounds the memory they can take.
  const uploads = createSlots(MAX_UPLOADS_IN_FLIGHT);

  async function receive(c: Context<AppEnv>, contentType: string): Promise<Response> {
    // The cap is applied to the bytes as they arrive, so a larger body is not held in memory.
    const body = await readBody(c.req.raw, config.maxUploadBytes + MULTIPART_OVERHEAD, tooBig);

    let file: FormDataEntryValue | null;
    try {
      const form = await new Response(body, {
        headers: { "content-type": contentType },
      }).formData();
      file = form.get("file");
    } catch {
      throw badRequest("The upload could not be read. Send one file in a form field named file.");
    }
    if (!(file instanceof File)) {
      throw badRequest("No file was sent. Choose a .docx file in a form field named file.");
    }
    if (file.size > config.maxUploadBytes) throw tooLarge(tooBig);

    const bytes = new Uint8Array(await file.arrayBuffer());
    const { paragraphs } = await openUpload(bytes);

    const id = ids.uuid();
    const storageKey = ids.uuid();
    const createdAt = clock.now();
    const fileName = cleanFileName(file.name);
    await storage.write(storageKey, bytes);
    try {
      await db.insert(documents).values({
        id,
        fileName,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        storageKey,
        paragraphs,
        createdAt,
      });
    } catch (error) {
      // No row, so nothing would ever name the file again.
      await storage.remove(storageKey).catch(() => {});
      throw error;
    }
    return c.json(
      summary({ id, fileName, size: bytes.byteLength, paragraphs, createdAt, reviewCount: 0 }),
      201,
    );
  }

  app.post("/api/documents", async (c) => {
    const contentType = c.req.header("content-type");
    if (mediaType(contentType) !== "multipart/form-data" || contentType === undefined) {
      throw new HttpError(
        415,
        "unsupported_media_type",
        "Upload the document as a form with one file field named file (multipart/form-data).",
      );
    }
    const release = uploads.tryTake();
    if (release === undefined) {
      c.header("Retry-After", "5");
      // The body of this request is not read, so the connection is not kept for it.
      c.header("Connection", "close");
      throw new HttpError(
        429,
        "too_many_requests",
        `${MAX_UPLOADS_IN_FLIGHT} documents are being uploaded already, which is the most this server takes at once. Wait a few seconds and try again.`,
      );
    }
    // Whatever happens next, the place is given back: an answer, an error, or a client that went
    // away in the middle of the upload (its body then fails to read, which ends here too).
    try {
      return await receive(c, contentType);
    } finally {
      release();
    }
  });

  app.get("/api/documents", async (c) => {
    const limit = limitParam(c);
    const rows = await db
      .select({
        id: documents.id,
        fileName: documents.fileName,
        size: documents.size,
        paragraphs: documents.paragraphs,
        createdAt: documents.createdAt,
        reviewCount: sql<number>`count(${reviews.id})`.mapWith(Number),
      })
      .from(documents)
      .leftJoin(reviews, eq(reviews.documentId, documents.id))
      .groupBy(documents.id)
      .orderBy(desc(documents.createdAt), desc(documents.id))
      .limit(limit);
    const response: DocumentListResponse = { documents: rows.map(summary) };
    return c.json(response);
  });

  app.get("/api/documents/:id/file", async (c) => {
    const id = uuidParam(c, "id", "document");
    const [row] = await db
      .select({ fileName: documents.fileName, storageKey: documents.storageKey })
      .from(documents)
      .where(eq(documents.id, id));
    if (row === undefined) throw notFound("There is no such document.");
    const bytes = await storage.read(row.storageKey);
    if (bytes === undefined) {
      throw notFound("The stored file for this document is missing. Upload the document again.");
    }
    return c.body(bytes, 200, {
      "Content-Type": DOCX_TYPE,
      "Content-Disposition": attachmentDisposition(row.fileName),
      "Content-Length": String(bytes.byteLength),
    });
  });

  app.delete("/api/documents/:id", async (c) => {
    const id = uuidParam(c, "id", "document");
    const [row] = await db
      .select({ storageKey: documents.storageKey })
      .from(documents)
      .where(eq(documents.id, id));
    if (row === undefined) throw notFound("There is no such document.");

    // Reviews of this document that are waiting or running stop first: they would otherwise go
    // on spending the model's time on a file that is being deleted.
    const owned = await db
      .select({ id: reviews.id })
      .from(reviews)
      .where(eq(reviews.documentId, id));
    for (const review of owned) runner.abort(review.id);

    // The file first. If it cannot be removed the row stays, and the delete can be tried again;
    // the other order could leave a contract on disk that nothing in the database names.
    await storage.remove(row.storageKey);
    await db.delete(documents).where(eq(documents.id, id));
    return c.body(null, 204);
  });

  return app;
}
