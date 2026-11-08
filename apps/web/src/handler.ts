import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ServiceError,
  type ResultKind,
  type ReviewRecord,
  type ReviewService,
  type User,
} from "@clausewise/service";

/** Who is asking, or undefined when the request carries no valid sign-in. */
export type Authenticator = (request: IncomingMessage) => Promise<User | undefined>;

export interface HandlerOptions {
  service: ReviewService;
  authenticate: Authenticator;
  /** Largest contract upload, in bytes. Should match the service's own limit. Default 50 MiB. */
  maxContractBytes?: number;
  /** Told about an unexpected error. Never given a request body. */
  onError?: (error: unknown) => void;
}

const MAX_JSON_BYTES = 16 * 1024;
const DEFAULT_MAX_CONTRACT_BYTES = 50 * 1024 * 1024;

// The API serves data, never pages, so nothing it returns may be rendered, framed, cached or
// sniffed into something else.
const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const STATUS: Record<ServiceError["code"], number> = {
  not_found: 404,
  invalid: 400,
  conflict: 409,
  too_large: 413,
};

const RESULTS: Record<ResultKind, { suffix: string; type: string }> = {
  redlined: {
    suffix: ".redlined.docx",
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  report: { suffix: ".report.json", type: "application/json" },
  summary: { suffix: ".summary.md", type: "text/markdown; charset=utf-8" },
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** What a client sees of a review. The owner id stays on the server. */
function shown(record: ReviewRecord) {
  return {
    id: record.id,
    status: record.status,
    playbookId: record.playbookId,
    fileName: record.fileName,
    client: record.client ?? null,
    author: record.author,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    error: record.error ?? null,
    open: record.open ?? null,
    unchecked: record.unchecked ?? null,
  };
}

async function readBody(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, "The request body is too large.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > limit) throw new HttpError(413, "The request body is too large.");
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const type = request.headers["content-type"] ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(type)) {
    throw new HttpError(415, "Send JSON with Content-Type: application/json.");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(await readBody(request, MAX_JSON_BYTES)));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "The request body is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "The request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function optionalString(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${name} must be a string.`);
  return value;
}

function requiredString(body: Record<string, unknown>, name: string): string {
  const value = optionalString(body, name);
  if (value === undefined) throw new HttpError(400, `${name} is required.`);
  return value;
}

/**
 * A download name built from the contract's name. The plain form keeps only safe ASCII, so a quote
 * or a non-Latin name cannot break the header, and the encoded form carries the real name.
 */
export function contentDisposition(fileName: string, suffix: string): string {
  const base = fileName.replace(/\.docx$/i, "");
  const ascii = base.replace(/[^A-Za-z0-9._ -]/g, "_") || "contract";
  // RFC 5987 leaves ' ( ) * out of the characters a value may hold as they are, and
  // encodeURIComponent keeps them, so they are encoded by hand.
  const encoded = encodeURIComponent(base + suffix).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}${suffix}"; filename*=UTF-8''${encoded}`;
}

function send(
  response: ServerResponse,
  status: number,
  body: Uint8Array | string,
  headers: Record<string, string>,
): void {
  response.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, JSON.stringify(value), {
    "content-type": "application/json; charset=utf-8",
  });
}

const REVIEW =
  /^\/api\/reviews\/([A-Za-z0-9-]{1,64})(\/contract|\/start|\/results\/(redlined|report|summary))?$/;

export function createHandler(options: HandlerOptions) {
  const { service } = options;
  const maxContract = options.maxContractBytes ?? DEFAULT_MAX_CONTRACT_BYTES;

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const path = new URL(request.url ?? "/", "http://localhost").pathname;

    if (path === "/api/health") {
      if (method !== "GET") throw new HttpError(405, "Use GET.");
      // Health says only that the process answers, so a probe needs no sign-in and learns nothing.
      return sendJson(response, 200, { status: "ok" });
    }

    const user = await options.authenticate(request);
    if (user === undefined) throw new HttpError(401, "Sign in to use Clausewise.");

    if (path === "/api/playbooks") {
      if (method !== "GET") throw new HttpError(405, "Use GET.");
      return sendJson(response, 200, { playbooks: await service.listPlaybooks() });
    }

    if (path === "/api/reviews") {
      if (method !== "POST") throw new HttpError(405, "Use POST.");
      const body = await readJson(request);
      const record = await service.createReview(user, {
        playbookId: requiredString(body, "playbookId"),
        fileName: requiredString(body, "fileName"),
        client: optionalString(body, "client"),
        author: optionalString(body, "author"),
      });
      return sendJson(response, 201, shown(record));
    }

    const match = REVIEW.exec(path);
    if (match === null) throw new HttpError(404, "There is nothing here.");
    const [, id = "", action, kind] = match;

    if (action === undefined) {
      if (method !== "GET") throw new HttpError(405, "Use GET.");
      return sendJson(response, 200, shown(await service.getReview(user, id)));
    }
    if (action === "/contract") {
      if (method !== "PUT") throw new HttpError(405, "Use PUT.");
      await service.uploadContract(user, id, await readBody(request, maxContract));
      return send(response, 204, "", {});
    }
    if (action === "/start") {
      if (method !== "POST") throw new HttpError(405, "Use POST.");
      return sendJson(response, 202, shown(await service.startReview(user, id)));
    }
    if (method !== "GET") throw new HttpError(405, "Use GET.");
    const resultKind = kind as ResultKind;
    const record = await service.getReview(user, id);
    const data = await service.getResult(user, id, resultKind);
    const { suffix, type } = RESULTS[resultKind];
    return send(response, 200, data, {
      "content-type": type,
      "content-disposition": contentDisposition(record.fileName, suffix),
    });
  }

  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      await route(request, response);
    } catch (error) {
      if (error instanceof HttpError)
        return sendJson(response, error.status, { error: error.message });
      if (error instanceof ServiceError) {
        return sendJson(response, STATUS[error.code], { error: error.message });
      }
      options.onError?.(error);
      if (!response.headersSent) {
        sendJson(response, 500, { error: "Something went wrong. Try again." });
      } else {
        response.destroy();
      }
    }
  };
}
