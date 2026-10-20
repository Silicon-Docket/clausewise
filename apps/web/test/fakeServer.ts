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
 * A stand-in for the Clausewise server that answers the way the real one does, close enough for
 * the screens: it holds the playbooks, documents and reviews in memory, answers the routes the
 * web app calls with the real status codes, messages and headers, and records every request. A
 * test changes the state to play out a review that runs, fails or finishes, and can make one
 * request fail on purpose.
 *
 * The messages below are copied from apps/server/src. Where one is a literal there, a test
 * (server-messages.test.ts) checks that it is still the server's, so that this file is not left
 * behind when the server's wording changes.
 */

export const MESSAGES = {
  unauthorized: "Sign in with the access token to use Clausewise.",
  nothingHere: "There is nothing at this address.",
  noReview: "There is no such review.",
  noDocument: "There is no such document.",
  noPlaybook: "There is no such playbook.",
  noFinding: "There is no such finding in this review.",
  noFile: "No file was sent. Choose a .docx file in a form field named file.",
  notZip: "Not a .docx file: it is not a valid zip archive",
  modelNotSet: "The model is not set up, so no review can run.",
  queueFull:
    "Too many reviews are waiting to run. Wait for some of them to finish, or cancel one, and try again.",
  cannotCancel: "Only a review that is waiting or running can be cancelled.",
  cannotDeleteRunning: "This review is running. Cancel it first, then delete it.",
  redlineNotFinished: "This review has not finished, so there is no redline to download yet.",
  reportNotFinished: "This review has not finished, so it has no report yet.",
  findingsNotFinished: "This review has not finished, so it has no findings to decide on yet.",
  includeMode: "include must be accepted or all.",
  reportFormat: "The format must be json or md.",
  nothingToSend: "Send a decision, wording of your own, or both.",
  commentOnly:
    "Wording of your own can replace only a suggested change to the contract. This finding is a comment only.",
  builtinChange: "The built-in playbooks cannot be changed. Copy it to edit your own.",
  builtinDelete: "The built-in playbooks cannot be deleted.",
  playbookTooLarge: "The playbook is larger than 256 KB.",
  uploadAdvice:
    "Make the document smaller, or ask whoever runs this server to raise CLAUSEWISE_MAX_UPLOAD_MB.",
} as const;

/** What a review that stopped without checking a rule says: one line per reason, as the server writes it. */
export const NOTHING_CHECKED_MESSAGE = [
  "No rule could be checked, so nothing was reviewed.",
  "3 rules: The model provider did not accept the API key. Check CLAUSEWISE_API_KEY.",
  "Check the model settings and the state of the provider, then start the review again.",
].join("\n");

export const RESTART_MESSAGE =
  "The server restarted while this review was running. Start it again.";

/** The wording the redline writer uses when the stored file is not the one that was reviewed. */
export const MISMATCH_MESSAGE =
  'The document does not match the report: the text at the recorded place is not what the review saw (rule "Duration of confidentiality obligations"). Check that this is the file that was reviewed and that it has not been changed since.';

export interface RecordedCall {
  method: string;
  path: string;
  search: string;
  authorization: string | null;
  accept: string | null;
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
  /** How the redline route answers. */
  redline: {
    /** Sent in the X-Clausewise-Warnings header, as the server sends the redline writer's. */
    warnings: string[];
    /** When set the stored file does not match the report, and the route answers 409 with this. */
    mismatch: string | null;
  };
  /** When false the files are sent without a Content-Disposition header. */
  fileNames: boolean;
  /** The server's queue of waiting reviews is full. */
  queueFull: boolean;
  /** The most reviews one document keeps. The server's is 200. */
  maxReviewsPerDocument: number;
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
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function problem(status: number, code: ErrorCode, message: string): Response {
  return json(status, { error: { code, message } });
}

/** "25 MB" for a large limit and "300 KB" for a small one, as the server writes it. */
export function sizeLimitText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** What the server says to an upload over its limit. */
export const tooLargeMessage = (maxUploadBytes: number): string =>
  `The file is larger than the limit of ${sizeLimitText(maxUploadBytes)}. ${MESSAGES.uploadAdvice}`;

export const tooManyReviewsMessage = (most: number): string =>
  `This document already has ${most} reviews, which is the most one document keeps. Delete some of them first.`;

// The same Content-Disposition the server builds: an ASCII filename for old clients and a
// filename* with the real name.
function attachment(name: string): string {
  const ascii = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\x20-\x7e]|["\\%]/g, "_")
    .trim();
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii === "" ? "contract.docx" : ascii}"; filename*=UTF-8''${encoded}`;
}

const stemOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};

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
    redline: { warnings: [], mismatch: null },
    fileNames: true,
    queueFull: false,
    maxReviewsPerDocument: 200,
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

  /** A review's file as the server sends it: the bytes, the type and the name for the download. */
  function file(
    bytes: string,
    type: string,
    name: string,
    extra: Record<string, string> = {},
  ): Response {
    return new Response(new TextEncoder().encode(bytes), {
      status: 200,
      headers: {
        "Content-Type": type,
        ...(state.fileNames ? { "Content-Disposition": attachment(name) } : {}),
        ...extra,
      },
    });
  }

  function redline(review: ReviewDetail, include: string): Response {
    if (include !== "accepted" && include !== "all") {
      return problem(400, "bad_request", MESSAGES.includeMode);
    }
    if (review.status !== "done") return problem(409, "conflict", MESSAGES.redlineNotFinished);
    if (state.redline.mismatch !== null) return problem(409, "conflict", state.redline.mismatch);
    // The body names what the real file would hold: the findings that went in, and the lawyer's
    // own wording where there is one. A test reads it back to see what the server was asked for.
    const chosen = review.findings.filter((finding) =>
      include === "accepted" ? finding.decision === "accepted" : finding.decision !== "rejected",
    );
    const entries = chosen.map((finding) =>
      finding.edit.kind === "applied" && finding.editedReplacement !== null
        ? `${finding.ruleId}=${finding.editedReplacement}`
        : finding.ruleId,
    );
    const warnings = state.redline.warnings;
    return file(
      `redline:${include}:${entries.join("|")}`,
      DOCX_TYPE,
      `${stemOf(review.documentName)}.redlined.docx`,
      warnings.length === 0
        ? {}
        : { "X-Clausewise-Warnings": encodeURIComponent(JSON.stringify(warnings)) },
    );
  }

  function patchFinding(
    review: ReviewDetail,
    ruleId: string,
    request: PatchFindingRequest,
  ): Response {
    if (request.decision === undefined && request.editedReplacement === undefined) {
      return problem(400, "bad_request", MESSAGES.nothingToSend);
    }
    if (review.status !== "done") return problem(409, "conflict", MESSAGES.findingsNotFinished);
    const finding = review.findings.find((f) => f.ruleId === ruleId);
    if (finding === undefined) return problem(404, "not_found", MESSAGES.noFinding);
    if (
      request.editedReplacement !== undefined &&
      request.editedReplacement !== null &&
      finding.edit.kind !== "applied"
    ) {
      return problem(400, "bad_request", MESSAGES.commentOnly);
    }
    const changed: Finding = {
      ...finding,
      ...(request.decision === undefined ? {} : { decision: request.decision }),
      ...(request.editedReplacement === undefined
        ? {}
        : { editedReplacement: request.editedReplacement }),
    };
    state.reviews.set(review.id, {
      ...review,
      findings: review.findings.map((f) => (f.ruleId === ruleId ? changed : f)),
    });
    return json(200, changed);
  }

  async function handle(call: RecordedCall, rawBody: unknown, zipped: boolean): Promise<Response> {
    const { method, path } = call;
    const body = rawBody;

    if (method === "GET" && path === "/api/config") return json(200, state.config);

    if (path.startsWith("/api/") && state.token !== null) {
      if (call.authorization !== `Bearer ${state.token}`) {
        return problem(401, "unauthorized", MESSAGES.unauthorized);
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
      const checked = state.validate(yaml);
      if (!checked.ok) return problem(400, "bad_request", checked.problems.join(" "));
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
      if (method === "GET") {
        return existing === undefined
          ? problem(404, "not_found", MESSAGES.noPlaybook)
          : json(200, existing);
      }
      if (method === "PUT" || method === "DELETE") {
        // The server refuses a built-in playbook before it looks for it.
        if (id.startsWith("builtin:")) {
          return problem(
            403,
            "forbidden",
            method === "PUT" ? MESSAGES.builtinChange : MESSAGES.builtinDelete,
          );
        }
        if (existing === undefined) return problem(404, "not_found", MESSAGES.noPlaybook);
      }
      if (method === "PUT" && existing !== undefined) {
        const yaml = (body as { yaml: string }).yaml;
        const checked = state.validate(yaml);
        if (!checked.ok) return problem(400, "bad_request", checked.problems.join(" "));
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
      if (call.upload === null) return problem(400, "bad_request", MESSAGES.noFile);
      if (call.upload.size > state.config.maxUploadBytes) {
        return problem(413, "payload_too_large", tooLargeMessage(state.config.maxUploadBytes));
      }
      if (!zipped) return problem(422, "invalid_document", MESSAGES.notZip);
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
      const id = decodeURIComponent(fileMatch[1] ?? "");
      const name =
        state.documents.find((document) => document.id === id)?.fileName ??
        [...state.reviews.values()].find((review) => review.documentId === id)?.documentName;
      if (name === undefined) return problem(404, "not_found", MESSAGES.noDocument);
      return file("original bytes", DOCX_TYPE, name);
    }

    // Reviews
    if (method === "POST" && path === "/api/reviews") {
      const request = body as CreateReviewRequest;
      // Before anything is looked up or created, as the server does it.
      if (!state.config.model.configured) {
        return problem(
          503,
          "model_not_configured",
          `${MESSAGES.modelNotSet} ${state.config.model.problem}`,
        );
      }
      const document = state.documents.find((d) => d.id === request.documentId);
      if (document === undefined) return problem(404, "not_found", MESSAGES.noDocument);
      const playbook = state.playbooks.get(request.playbookId);
      if (playbook === undefined) return problem(404, "not_found", MESSAGES.noPlaybook);
      const kept = [...state.reviews.values()].filter((r) => r.documentId === document.id).length;
      if (kept >= state.maxReviewsPerDocument) {
        return problem(
          429,
          "too_many_requests",
          tooManyReviewsMessage(state.maxReviewsPerDocument),
        );
      }
      if (state.queueFull) return problem(429, "too_many_requests", MESSAGES.queueFull);
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
      if (review === undefined) return problem(404, "not_found", MESSAGES.noReview);

      if (method === "GET" && rest === "") return json(200, review);
      if (method === "DELETE" && rest === "") {
        if (review.status === "running") {
          return problem(409, "conflict", MESSAGES.cannotDeleteRunning);
        }
        state.reviews.delete(id);
        return new Response(null, { status: 204 });
      }
      if (method === "POST" && rest === "cancel") {
        if (review.status !== "queued" && review.status !== "running") {
          return problem(409, "conflict", MESSAGES.cannotCancel);
        }
        // The server leaves the error empty for a review that was cancelled.
        const cancelled = {
          ...review,
          status: "cancelled" as const,
          finishedAt: "2026-10-20T09:02:00.000Z",
        };
        state.reviews.set(id, cancelled);
        return json(200, summaryOf(cancelled));
      }
      if (method === "GET" && rest === "docx") {
        return redline(review, new URLSearchParams(call.search).get("include") ?? "accepted");
      }
      if (method === "GET" && rest === "report") {
        const format = new URLSearchParams(call.search).get("format") ?? "json";
        if (format !== "json" && format !== "md") {
          return problem(400, "bad_request", MESSAGES.reportFormat);
        }
        if (review.status !== "done") return problem(409, "conflict", MESSAGES.reportNotFinished);
        const stem = stemOf(review.documentName);
        return format === "md"
          ? file("# Report", "text/markdown; charset=utf-8", `${stem}.summary.md`)
          : file("{}", "application/json; charset=utf-8", `${stem}.report.json`);
      }
      if (method === "PATCH" && rest === "findings") {
        const request = body as BulkDecisionRequest;
        if (review.status !== "done") return problem(409, "conflict", MESSAGES.findingsNotFinished);
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
        return patchFinding(
          review,
          decodeURIComponent(findingMatch[1] ?? ""),
          body as PatchFindingRequest,
        );
      }
    }

    return problem(404, "not_found", MESSAGES.nothingHere);
  }

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      "http://localhost",
    );
    const headers = new Headers(init?.headers);
    let body: unknown = undefined;
    let upload: RecordedCall["upload"] = null;
    let zipped = false;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body) as unknown;
    } else if (init?.body instanceof FormData) {
      const sent = init.body.get("file");
      if (sent instanceof File) {
        upload = { name: sent.name, size: sent.size };
        // The first bytes of a .docx are the zip signature, which is what the server checks.
        const head = new Uint8Array(await sent.slice(0, 4).arrayBuffer());
        zipped = [0x50, 0x4b, 0x03, 0x04].every((byte, index) => head[index] === byte);
      }
    }
    const call: RecordedCall = {
      method: (init?.method ?? "GET").toUpperCase(),
      path: url.pathname,
      search: url.search,
      authorization: headers.get("Authorization"),
      accept: headers.get("Accept"),
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
    return handle(call, body, zipped);
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
