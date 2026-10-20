import type {
  BulkDecisionRequest,
  ConfigResponse,
  CreateReviewRequest,
  DocumentSummary,
  ErrorCode,
  Finding,
  PatchFindingRequest,
  PlaybookDetail,
  PlaybookSummary,
  PlaybookValidateResponse,
  ReviewDetail,
  ReviewSummary,
} from "@clausewise/api";
import { CONFIG, playbookDetail, reviewDetail } from "./fixtures.js";

/**
 * A stand-in for the Clausewise server that follows the contract in docs/m3-design.md closely
 * enough for the screens: it holds the playbooks, documents and reviews in memory, answers the
 * routes the web app calls, and records every request. A test changes the state to play out a
 * review that runs, fails or finishes, and can make one request fail on purpose.
 */

export interface RecordedCall {
  method: string;
  path: string;
  search: string;
  authorization: string | null;
  contentType: string | null;
  body: unknown;
  /** For an upload: the name and size of the file in the "file" field. */
  upload: { name: string; size: number } | null;
}

export interface FakeState {
  config: ConfigResponse;
  /** When set, every /api route except config needs this bearer token. */
  token: string | null;
  playbooks: Map<string, PlaybookDetail>;
  documents: DocumentSummary[];
  reviews: Map<string, ReviewDetail>;
  validate: (yaml: string) => PlaybookValidateResponse;
}

interface Failure {
  match: (call: RecordedCall) => boolean;
  status: number;
  code: ErrorCode;
  message: string;
  /** Answer this many times, then go back to normal. Default once. */
  times: number;
}

export interface FakeServer {
  fetch: typeof globalThis.fetch;
  state: FakeState;
  calls: RecordedCall[];
  /** The calls whose method and path match. */
  callsTo: (method: string, path: RegExp | string) => RecordedCall[];
  failNext: (
    match: (call: RecordedCall) => boolean,
    failure: { status: number; code: ErrorCode; message: string; times?: number },
  ) => void;
  /** Changes a stored review, as the server would while it works. */
  updateReview: (id: string, change: Partial<ReviewDetail>) => void;
  /** Makes the next requests that match wait until the returned function is called. */
  hold: (match: (call: RecordedCall) => boolean) => () => void;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function problem(status: number, code: ErrorCode, message: string): Response {
  return json(status, { error: { code, message } });
}

function summaryOf(detail: ReviewDetail): ReviewSummary {
  return {
    id: detail.id,
    status: detail.status,
    documentId: detail.documentId,
    documentName: detail.documentName,
    playbookName: detail.playbookName,
    client: detail.client,
    progress: detail.progress,
    error: detail.error,
    open: detail.open,
    createdAt: detail.createdAt,
    startedAt: detail.startedAt,
    finishedAt: detail.finishedAt,
  };
}

function playbookSummary(detail: PlaybookDetail): PlaybookSummary {
  return {
    id: detail.id,
    source: detail.source,
    name: detail.name,
    contractTypes: detail.contractTypes,
    ruleCount: detail.ruleCount,
    updatedAt: detail.updatedAt,
  };
}

function nameOf(yaml: string): string {
  return /^name:\s*(.+)$/m.exec(yaml)?.[1]?.trim() ?? "Untitled playbook";
}

export interface FakeOptions {
  config?: Partial<ConfigResponse>;
  token?: string;
  reviews?: ReviewDetail[];
  playbooks?: PlaybookDetail[];
}

export function createFakeServer(options: FakeOptions = {}): FakeServer {
  const state: FakeState = {
    config: { ...CONFIG, ...options.config },
    token: options.token ?? null,
    playbooks: new Map(),
    documents: [],
    reviews: new Map(),
    validate: (yaml) =>
      yaml.includes("name:")
        ? { ok: true, name: nameOf(yaml), ruleCount: 2, contractTypes: ["nda"] }
        : { ok: false, problems: ["The playbook needs a name."] },
  };
  for (const detail of options.playbooks ?? [
    playbookDetail(),
    playbookDetail({
      id: "builtin:saas-customer",
      name: "SaaS agreement (customer)",
      contractTypes: ["saas"],
      ruleCount: 8,
      yaml: "name: SaaS agreement (customer)\ncontractTypes: [saas]\nrules: []\n",
    }),
  ]) {
    state.playbooks.set(detail.id, detail);
  }
  for (const review of options.reviews ?? []) state.reviews.set(review.id, review);

  const calls: RecordedCall[] = [];
  const failures: Failure[] = [];
  const holds: Array<{ match: (call: RecordedCall) => boolean; gate: Promise<void> }> = [];
  let counter = 0;
  const nextId = (prefix: string): string => `${prefix}-${++counter}`;

  async function handle(call: RecordedCall, rawBody: unknown): Promise<Response> {
    const { method, path } = call;
    const body = rawBody;

    if (method === "GET" && path === "/api/config") return json(200, state.config);

    if (path.startsWith("/api/") && state.token !== null) {
      if (call.authorization !== `Bearer ${state.token}`) {
        return problem(401, "unauthorized", "Sign in with the access token to use this server.");
      }
    }

    // Playbooks
    if (method === "GET" && path === "/api/playbooks") {
      return json(200, { playbooks: [...state.playbooks.values()].map(playbookSummary) });
    }
    if (method === "POST" && path === "/api/playbooks/validate") {
      return json(200, state.validate((body as { yaml: string }).yaml));
    }
    if (method === "POST" && path === "/api/playbooks") {
      const yaml = (body as { yaml: string }).yaml;
      const detail = playbookDetail({
        id: nextId("pb"),
        source: "custom",
        name: nameOf(yaml),
        yaml,
        editable: true,
        updatedAt: "2026-10-20T10:00:00.000Z",
      });
      state.playbooks.set(detail.id, detail);
      return json(201, detail);
    }
    const playbookMatch = /^\/api\/playbooks\/([^/]+)$/.exec(path);
    if (playbookMatch !== null) {
      const id = decodeURIComponent(playbookMatch[1] ?? "");
      const existing = state.playbooks.get(id);
      if (existing === undefined) return problem(404, "not_found", "There is no such playbook.");
      if (method === "GET") return json(200, existing);
      if (existing.source === "builtin") {
        return problem(403, "forbidden", "Built-in playbooks cannot be changed.");
      }
      if (method === "PUT") {
        const yaml = (body as { yaml: string }).yaml;
        const detail = {
          ...existing,
          yaml,
          name: nameOf(yaml),
          updatedAt: "2026-10-20T11:00:00.000Z",
        };
        state.playbooks.set(id, detail);
        return json(200, detail);
      }
      if (method === "DELETE") {
        state.playbooks.delete(id);
        return new Response(null, { status: 204 });
      }
    }

    // Documents
    if (method === "POST" && path === "/api/documents") {
      if (call.upload === null)
        return problem(400, "bad_request", "Send the file in a field named file.");
      const document: DocumentSummary = {
        id: nextId("doc"),
        fileName: call.upload.name,
        size: call.upload.size,
        paragraphs: 40,
        createdAt: "2026-10-20T09:00:00.000Z",
        reviewCount: 0,
      };
      state.documents.push(document);
      return json(201, document);
    }
    if (method === "GET" && path === "/api/documents") {
      return json(200, { documents: state.documents });
    }
    const documentMatch = /^\/api\/documents\/([^/]+)$/.exec(path);
    if (method === "DELETE" && documentMatch !== null) {
      // Like the server: the document goes, and so does every review of it.
      const id = decodeURIComponent(documentMatch[1] ?? "");
      state.documents = state.documents.filter((document) => document.id !== id);
      for (const [reviewId, review] of state.reviews) {
        if (review.documentId === id) state.reviews.delete(reviewId);
      }
      return new Response(null, { status: 204 });
    }
    const fileMatch = /^\/api\/documents\/([^/]+)\/file$/.exec(path);
    if (method === "GET" && fileMatch !== null) {
      return new Response("original bytes", {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="original.docx"`,
        },
      });
    }

    // Reviews
    if (method === "POST" && path === "/api/reviews") {
      const request = body as CreateReviewRequest;
      const document = state.documents.find((d) => d.id === request.documentId);
      if (document === undefined)
        return problem(404, "not_found", "That document is not on the server.");
      const playbook = state.playbooks.get(request.playbookId);
      if (playbook === undefined)
        return problem(404, "not_found", "That playbook is not on the server.");
      const detail = reviewDetail({
        id: nextId("rev"),
        status: "queued",
        documentId: document.id,
        documentName: document.fileName,
        playbookName: playbook.name,
        client: request.client ?? null,
        progress: { done: 0, total: 0 },
        open: null,
        model: null,
        counts: null,
        stats: null,
        findings: [],
        results: [],
        startedAt: null,
        finishedAt: null,
      });
      state.reviews.set(detail.id, detail);
      return json(202, summaryOf(detail));
    }
    if (method === "GET" && path === "/api/reviews") {
      return json(200, { reviews: [...state.reviews.values()].map(summaryOf) });
    }
    const reviewMatch = /^\/api\/reviews\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (reviewMatch !== null) {
      const id = decodeURIComponent(reviewMatch[1] ?? "");
      const rest = reviewMatch[2] ?? "";
      const review = state.reviews.get(id);
      if (review === undefined) return problem(404, "not_found", "There is no such review.");

      if (method === "GET" && rest === "") return json(200, review);
      if (method === "POST" && rest === "cancel") {
        if (review.status !== "queued" && review.status !== "running") {
          return problem(409, "conflict", "The review has already ended.");
        }
        const cancelled = {
          ...review,
          status: "cancelled" as const,
          finishedAt: "2026-10-20T09:02:00.000Z",
        };
        state.reviews.set(id, cancelled);
        return json(200, summaryOf(cancelled));
      }
      if (method === "GET" && rest === "docx") {
        const include = new URLSearchParams(call.search).get("include") ?? "accepted";
        return new Response(`redline:${include}`, {
          status: 200,
          headers: {
            "Content-Type":
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "Content-Disposition": `attachment; filename="Acme NDA (redline).docx"`,
          },
        });
      }
      if (method === "GET" && rest === "report") {
        return new Response("# Report", {
          status: 200,
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        });
      }
      if (method === "PATCH" && rest === "findings") {
        const request = body as BulkDecisionRequest;
        let updated = 0;
        const findings = review.findings.map((finding) => {
          const inScope =
            (request.ruleIds === undefined || request.ruleIds.includes(finding.ruleId)) &&
            (request.severities === undefined || request.severities.includes(finding.severity));
          if (!inScope) return finding;
          updated += 1;
          return { ...finding, decision: request.decision };
        });
        state.reviews.set(id, { ...review, findings });
        return json(200, { updated });
      }
      const findingMatch = /^findings\/([^/]+)$/.exec(rest);
      if (method === "PATCH" && findingMatch !== null) {
        const ruleId = decodeURIComponent(findingMatch[1] ?? "");
        const finding = review.findings.find((f) => f.ruleId === ruleId);
        if (finding === undefined) return problem(404, "not_found", "There is no such finding.");
        const request = body as PatchFindingRequest;
        if (request.editedReplacement !== undefined && finding.edit.kind !== "applied") {
          return problem(
            400,
            "bad_request",
            "Only a suggested change can be given your own wording.",
          );
        }
        const changed: Finding = {
          ...finding,
          ...(request.decision === undefined ? {} : { decision: request.decision }),
          ...(request.editedReplacement === undefined
            ? {}
            : { editedReplacement: request.editedReplacement }),
        };
        state.reviews.set(id, {
          ...review,
          findings: review.findings.map((f) => (f.ruleId === ruleId ? changed : f)),
        });
        return json(200, changed);
      }
    }

    return problem(404, "not_found", "The server has nothing at this address.");
  }

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      "http://localhost",
    );
    const headers = new Headers(init?.headers);
    let body: unknown = undefined;
    let upload: RecordedCall["upload"] = null;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body) as unknown;
    } else if (init?.body instanceof FormData) {
      const file = init.body.get("file");
      if (file instanceof File) upload = { name: file.name, size: file.size };
    }
    const call: RecordedCall = {
      method: (init?.method ?? "GET").toUpperCase(),
      path: url.pathname,
      search: url.search,
      authorization: headers.get("Authorization"),
      contentType: headers.get("Content-Type"),
      body,
      upload,
    };
    calls.push(call);

    const gates = holds.filter((h) => h.match(call)).map((h) => h.gate);
    if (gates.length > 0) await Promise.all(gates);

    const index = failures.findIndex((f) => f.match(call));
    const failure = failures[index];
    if (failure !== undefined) {
      failure.times -= 1;
      if (failure.times <= 0) failures.splice(index, 1);
      return problem(failure.status, failure.code, failure.message);
    }
    return handle(call, body);
  };

  return {
    fetch: fakeFetch as typeof globalThis.fetch,
    state,
    calls,
    callsTo: (method, path) =>
      calls.filter(
        (call) =>
          call.method === method &&
          (typeof path === "string" ? call.path === path : path.test(call.path)),
      ),
    failNext: (match, failure) => {
      failures.push({ match, times: 1, ...failure });
    },
    updateReview: (id, change) => {
      const existing = state.reviews.get(id);
      if (existing !== undefined) state.reviews.set(id, { ...existing, ...change });
    },
    hold: (match) => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      holds.push({ match, gate });
      return release;
    },
  };
}
