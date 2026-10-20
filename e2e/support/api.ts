import type { APIRequestContext } from "@playwright/test";
import type { DocumentSummary, ReviewDetail, ReviewSummary } from "../../packages/api/src/index.js";
import { expect } from "../fixtures.js";
import { fixturePath } from "../paths.js";
import { readFile } from "node:fs/promises";

/**
 * The server's API, called directly. A scenario that is about the screen builds the state it wants
 * to look at this way, which is quicker than clicking and does not repeat what flow.spec.ts checks.
 */

export const NDA_PLAYBOOK_ID = "builtin:nda-mutual";
export const SAAS_PLAYBOOK_ID = "builtin:saas-customer";

const auth = (token: string | undefined): Record<string, string> =>
  token === undefined ? {} : { Authorization: `Bearer ${token}` };

export async function uploadDocument(
  request: APIRequestContext,
  file: { name: string; bytes: Uint8Array },
  token?: string,
): Promise<DocumentSummary> {
  const response = await request.post("/api/documents", {
    headers: auth(token),
    multipart: {
      file: {
        name: file.name,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        buffer: Buffer.from(file.bytes),
      },
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as DocumentSummary;
}

export async function uploadFixture(
  request: APIRequestContext,
  fixture: string,
  token?: string,
): Promise<DocumentSummary> {
  return uploadDocument(
    request,
    { name: fixture, bytes: new Uint8Array(await readFile(fixturePath(fixture))) },
    token,
  );
}

export async function createReview(
  request: APIRequestContext,
  body: { documentId: string; playbookId: string; client?: string },
  token?: string,
): Promise<ReviewSummary> {
  const response = await request.post("/api/reviews", { headers: auth(token), data: body });
  expect(response.status(), await response.text()).toBe(202);
  return (await response.json()) as ReviewSummary;
}

export async function getReview(
  request: APIRequestContext,
  id: string,
  token?: string,
): Promise<ReviewDetail> {
  const response = await request.get(`/api/reviews/${id}`, { headers: auth(token) });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as ReviewDetail;
}

/** Waits until the review has left the queue and stopped running, whatever way it ended. */
export async function waitForEnd(
  request: APIRequestContext,
  id: string,
  token?: string,
): Promise<ReviewDetail> {
  let detail = await getReview(request, id, token);
  const started = Date.now();
  while (detail.status === "queued" || detail.status === "running") {
    if (Date.now() - started > 60_000) throw new Error(`The review ${id} did not end in a minute.`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    detail = await getReview(request, id, token);
  }
  return detail;
}

/** Uploads a fixture, reviews it, and waits for the end. */
export async function finishedReview(
  request: APIRequestContext,
  options: { fixture: string; playbookId: string; client?: string; token?: string },
): Promise<{ document: DocumentSummary; review: ReviewDetail }> {
  const document = await uploadFixture(request, options.fixture, options.token);
  const started = await createReview(
    request,
    {
      documentId: document.id,
      playbookId: options.playbookId,
      ...(options.client === undefined ? {} : { client: options.client }),
    },
    options.token,
  );
  return { document, review: await waitForEnd(request, started.id, options.token) };
}

export async function removeDocument(
  request: APIRequestContext,
  id: string,
  token?: string,
): Promise<void> {
  const response = await request.delete(`/api/documents/${id}`, { headers: auth(token) });
  expect([204, 404]).toContain(response.status());
}

export async function listDocuments(
  request: APIRequestContext,
  token?: string,
): Promise<DocumentSummary[]> {
  const response = await request.get("/api/documents", { headers: auth(token) });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { documents: DocumentSummary[] }).documents;
}

export async function listReviews(
  request: APIRequestContext,
  token?: string,
): Promise<ReviewSummary[]> {
  const response = await request.get("/api/reviews", { headers: auth(token) });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { reviews: ReviewSummary[] }).reviews;
}
