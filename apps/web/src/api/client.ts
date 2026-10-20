import type {
  BulkDecisionRequest,
  BulkDecisionResponse,
  ConfigResponse,
  CreateReviewRequest,
  DocumentListResponse,
  DocumentSummary,
  ErrorCode,
  Finding,
  IncludeMode,
  PatchFindingRequest,
  PlaybookDetail,
  PlaybookListResponse,
  PlaybookSummary,
  PlaybookValidateResponse,
  ReportFormat,
  ReviewDetail,
  ReviewListResponse,
  ReviewSummary,
} from "@clausewise/api";

/**
 * The typed client for the Clausewise server. It takes the `fetch` function it should use, so that
 * a test can hand it a fake, and it never retries: a request that was sent once is sent once, so a
 * POST can not be repeated by accident. Screens that poll repeat their own GET.
 */

export type ClientErrorCode = ErrorCode | "network" | "unexpected_response";

/** What went wrong, with the server's own message when it gave one. The message is safe to show. */
export class ApiClientError extends Error {
  /** The HTTP status, or 0 when the server could not be reached. */
  readonly status: number;
  readonly code: ClientErrorCode;
  readonly requestId: string | undefined;

  constructor(args: {
    status: number;
    code: ClientErrorCode;
    message: string;
    requestId?: string | undefined;
  }) {
    super(args.message);
    this.name = "ApiClientError";
    this.status = args.status;
    this.code = args.code;
    this.requestId = args.requestId;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

/** The text to show for any thrown value. An error that is not ours is not quoted. */
export function errorMessage(error: unknown): string {
  return error instanceof ApiClientError
    ? error.message
    : "Something went wrong in the page. Reload it and try again.";
}

export interface ApiClientOptions {
  fetch: typeof globalThis.fetch;
  /** The bearer token to send, read at every request. */
  getToken?: () => string | null;
  /** Called when the server answers 401, before the error is thrown. */
  onUnauthorized?: () => void;
  /** Prefix for every path. Empty in production, where the app is served by the server itself. */
  baseUrl?: string;
}

export interface DownloadedFile {
  blob: Blob;
  /** The name the server suggested, if it sent a readable one. */
  fileName: string | null;
}

export interface ApiClient {
  getConfig(signal?: AbortSignal): Promise<ConfigResponse>;

  listPlaybooks(signal?: AbortSignal): Promise<PlaybookSummary[]>;
  getPlaybook(id: string, signal?: AbortSignal): Promise<PlaybookDetail>;
  validatePlaybook(yaml: string, signal?: AbortSignal): Promise<PlaybookValidateResponse>;
  createPlaybook(yaml: string): Promise<PlaybookDetail>;
  updatePlaybook(id: string, yaml: string): Promise<PlaybookDetail>;
  deletePlaybook(id: string): Promise<void>;

  uploadDocument(file: File): Promise<DocumentSummary>;
  listDocuments(signal?: AbortSignal): Promise<DocumentSummary[]>;
  deleteDocument(id: string): Promise<void>;

  createReview(request: CreateReviewRequest): Promise<ReviewSummary>;
  listReviews(signal?: AbortSignal): Promise<ReviewSummary[]>;
  getReview(id: string, signal?: AbortSignal): Promise<ReviewDetail>;
  cancelReview(id: string): Promise<ReviewSummary>;
  deleteReview(id: string): Promise<void>;

  patchFinding(reviewId: string, ruleId: string, body: PatchFindingRequest): Promise<Finding>;
  bulkDecision(reviewId: string, body: BulkDecisionRequest): Promise<BulkDecisionResponse>;

  /** Fetches a file the server offers for download, with the token. `path` comes from the path helpers. */
  fetchFile(path: string, signal?: AbortSignal): Promise<DownloadedFile>;
  /** Asks whether the server accepts this token, without touching the stored one. */
  checkToken(token: string, signal?: AbortSignal): Promise<boolean>;
}

// ---------------------------------------------------------------------------------------------
// Paths of the files the server offers. Plain anchors use them when no token is needed.
// ---------------------------------------------------------------------------------------------

const enc = encodeURIComponent;

export const paths = {
  docx: (reviewId: string, include: IncludeMode): string =>
    `/api/reviews/${enc(reviewId)}/docx?include=${include}`,
  report: (reviewId: string, format: ReportFormat): string =>
    `/api/reviews/${enc(reviewId)}/report?format=${format}`,
  document: (documentId: string): string => `/api/documents/${enc(documentId)}/file`,
};

// ---------------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------------

interface RequestOptions {
  json?: unknown;
  form?: FormData;
  signal?: AbortSignal | undefined;
  /** Overrides the stored token, for `checkToken`. */
  token?: string | null;
  /** Skip `onUnauthorized`, for `checkToken`. */
  quietUnauthorized?: boolean;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const doFetch = options.fetch;
  const base = options.baseUrl ?? "";

  async function send(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const token = opts.token === undefined ? (options.getToken?.() ?? null) : opts.token;
    if (token !== null) headers["Authorization"] = `Bearer ${token}`;
    const init: RequestInit = { method, headers, cache: "no-store", credentials: "omit" };
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.json);
    } else if (opts.form !== undefined) {
      // No Content-Type here: the browser adds the multipart boundary.
      init.body = opts.form;
    }
    if (opts.signal !== undefined) init.signal = opts.signal;

    let response: Response;
    try {
      response = await doFetch(base + path, init);
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ApiClientError({
        status: 0,
        code: "network",
        message:
          "The Clausewise server could not be reached. Check that it is still running, then try again.",
      });
    }
    if (response.ok) return response;

    const failure = await readFailure(response);
    if (response.status === 401 && opts.quietUnauthorized !== true) options.onUnauthorized?.();
    throw failure;
  }

  async function json<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const response = await send(method, path, opts);
    try {
      return (await response.json()) as T;
    } catch {
      throw new ApiClientError({
        status: response.status,
        code: "unexpected_response",
        message: "The server's answer could not be read. Reload the page and try again.",
      });
    }
  }

  async function none(method: string, path: string, opts: RequestOptions = {}): Promise<void> {
    await send(method, path, opts);
  }

  return {
    getConfig: (signal) => json("GET", "/api/config", { signal }),

    listPlaybooks: async (signal) =>
      (await json<PlaybookListResponse>("GET", "/api/playbooks", { signal })).playbooks,
    getPlaybook: (id, signal) => json("GET", `/api/playbooks/${enc(id)}`, { signal }),
    validatePlaybook: (yaml, signal) =>
      json("POST", "/api/playbooks/validate", { json: { yaml }, signal }),
    createPlaybook: (yaml) => json("POST", "/api/playbooks", { json: { yaml } }),
    updatePlaybook: (id, yaml) => json("PUT", `/api/playbooks/${enc(id)}`, { json: { yaml } }),
    deletePlaybook: (id) => none("DELETE", `/api/playbooks/${enc(id)}`),

    uploadDocument: (file) => {
      const form = new FormData();
      form.append("file", file, file.name);
      return json("POST", "/api/documents", { form });
    },
    listDocuments: async (signal) =>
      (await json<DocumentListResponse>("GET", "/api/documents", { signal })).documents,
    deleteDocument: (id) => none("DELETE", `/api/documents/${enc(id)}`),

    createReview: (request) => json("POST", "/api/reviews", { json: request }),
    listReviews: async (signal) =>
      (await json<ReviewListResponse>("GET", "/api/reviews", { signal })).reviews,
    getReview: (id, signal) => json("GET", `/api/reviews/${enc(id)}`, { signal }),
    cancelReview: (id) => json("POST", `/api/reviews/${enc(id)}/cancel`),
    deleteReview: (id) => none("DELETE", `/api/reviews/${enc(id)}`),

    patchFinding: (reviewId, ruleId, body) =>
      json("PATCH", `/api/reviews/${enc(reviewId)}/findings/${enc(ruleId)}`, { json: body }),
    bulkDecision: (reviewId, body) =>
      json("PATCH", `/api/reviews/${enc(reviewId)}/findings`, { json: body }),

    fetchFile: async (path, signal) => {
      const response = await send("GET", path, { signal });
      let blob: Blob;
      try {
        blob = await response.blob();
      } catch {
        throw new ApiClientError({
          status: response.status,
          code: "unexpected_response",
          message: "The file could not be read from the server's answer. Try again.",
        });
      }
      return {
        blob,
        fileName: fileNameFromDisposition(response.headers.get("Content-Disposition")),
      };
    },

    checkToken: async (token, signal) => {
      try {
        await send("GET", "/api/playbooks", { token, quietUnauthorized: true, signal });
        return true;
      } catch (error) {
        if (error instanceof ApiClientError && error.status === 401) return false;
        throw error;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Reading what the server sent
// ---------------------------------------------------------------------------------------------

const KNOWN_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "payload_too_large",
  "unsupported_media_type",
  "invalid_document",
  "wrong_host",
  "too_many_requests",
  "model_not_configured",
  "internal_error",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readFailure(response: Response): Promise<ApiClientError> {
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    body = undefined;
  }
  const detail = isRecord(body) && isRecord(body["error"]) ? body["error"] : undefined;
  const message = typeof detail?.["message"] === "string" ? detail["message"].trim() : "";
  const code = typeof detail?.["code"] === "string" ? detail["code"] : "";
  const requestId = typeof detail?.["requestId"] === "string" ? detail["requestId"] : undefined;

  return new ApiClientError({
    status: response.status,
    code: KNOWN_CODES.has(code) ? (code as ErrorCode) : codeFromStatus(response.status),
    message: message !== "" ? message : messageFromStatus(response.status),
    requestId,
  });
}

function codeFromStatus(status: number): ClientErrorCode {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 413:
      return "payload_too_large";
    case 415:
      return "unsupported_media_type";
    case 421:
      return "wrong_host";
    case 429:
      return "too_many_requests";
    case 503:
      return "model_not_configured";
    default:
      return status >= 500 ? "internal_error" : "unexpected_response";
  }
}

// Used only when the answer was not the server's own error body, for instance a proxy's page.
function messageFromStatus(status: number): string {
  if (status === 401) return "The access token was not accepted.";
  if (status === 404) return "The server has nothing at this address.";
  if (status === 413) return "The file is larger than the server accepts.";
  if (status === 429) return "The server is busy. Wait a moment and try again.";
  if (status >= 500) {
    return `The server had a problem (status ${status}). Try again, and look at the server's log if it keeps happening.`;
  }
  return `The server did not accept the request (status ${status}).`;
}

/** The file name from a Content-Disposition header, or null. Control characters and slashes are dropped. */
export function fileNameFromDisposition(header: string | null): string | null {
  if (header === null) return null;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  let name: string | null = null;
  if (star?.[1] !== undefined) {
    try {
      name = decodeURIComponent(star[1].trim());
    } catch {
      name = null;
    }
  }
  if (name === null) {
    const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(header);
    name = plain?.[1] ?? plain?.[2]?.trim() ?? null;
  }
  if (name === null) return null;
  // A name from the server is data: it only ever becomes the name of a downloaded file.
  const cleaned = [...name]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f && ch !== "/" && ch !== "\\";
    })
    .join("")
    .trim();
  return cleaned === "" ? null : cleaned.slice(0, 200);
}
