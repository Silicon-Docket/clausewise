// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { warningsFromHeader } from "../src/api/client.js";
import {
  createFakeServer,
  MESSAGES,
  MISMATCH_MESSAGE,
  NOTHING_CHECKED_MESSAGE,
  RESTART_MESSAGE,
  sizeLimitText,
  tooLargeMessage,
  tooManyReviewsMessage,
} from "./fakeServer.js";
import {
  appliedFinding,
  commentOnlyFinding,
  docxFile,
  missingFinding,
  reviewDetail,
} from "./fixtures.js";

/**
 * The fake server is what every screen test talks to, so it has to answer as the real one does.
 * These tests pin down what the screens rely on, and compare the messages with the server's own
 * source, so that a change of wording there fails here and the fake is brought along.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? sourcesUnder(path)
      : path.endsWith(".ts")
        ? [readFileSync(path, "utf8")]
        : [];
  });
}

// Strings that are broken over lines or joined with + in the source are put back together.
const flatten = (code: string): string => code.replace(/"\s*\+\s*"/g, "").replace(/\s+/g, " ");
const serverCode = flatten(sourcesUnder(join(repo, "apps", "server", "src")).join("\n"));
const docxCode = flatten(sourcesUnder(join(repo, "packages", "docx", "src")).join("\n"));
const reviewCode = flatten(sourcesUnder(join(repo, "packages", "review", "src")).join("\n"));

describe("the fake server's messages are the server's", () => {
  const inServer: Array<[string, string]> = [
    ["unauthorized", MESSAGES.unauthorized],
    ["nothingHere", MESSAGES.nothingHere],
    ["noReview", MESSAGES.noReview],
    ["noDocument", MESSAGES.noDocument],
    ["noPlaybook", MESSAGES.noPlaybook],
    ["noFinding", MESSAGES.noFinding],
    ["noFile", MESSAGES.noFile],
    // The server adds the model's own problem after this sentence.
    ["modelNotSet", MESSAGES.modelNotSet],
    ["queueFull", MESSAGES.queueFull],
    ["cannotCancel", MESSAGES.cannotCancel],
    ["cannotDeleteRunning", MESSAGES.cannotDeleteRunning],
    ["redlineNotFinished", MESSAGES.redlineNotFinished],
    ["reportNotFinished", MESSAGES.reportNotFinished],
    ["findingsNotFinished", MESSAGES.findingsNotFinished],
    ["includeMode", MESSAGES.includeMode],
    ["reportFormat", MESSAGES.reportFormat],
    ["nothingToSend", MESSAGES.nothingToSend],
    ["commentOnly", MESSAGES.commentOnly],
    ["builtinChange", MESSAGES.builtinChange],
    ["builtinDelete", MESSAGES.builtinDelete],
    ["uploadAdvice", MESSAGES.uploadAdvice],
    ["upload limit", "The file is larger than the limit of"],
    ["document limit", "This document already has"],
    [
      "document limit, second half",
      "which is the most one document keeps. Delete some of them first.",
    ],
    ["restart", RESTART_MESSAGE],
    ["nothing checked, first line", NOTHING_CHECKED_MESSAGE.split("\n")[0] ?? ""],
    ["nothing checked, last line", NOTHING_CHECKED_MESSAGE.split("\n").at(-1) ?? ""],
    ["playbook size", "The playbook is larger than"],
  ];
  it.each(inServer)("%s", (_name, text) => {
    expect(text).not.toBe("");
    expect(serverCode).toContain(text);
  });

  it("the zip message is the document engine's", () => {
    expect(docxCode).toContain(MESSAGES.notZip);
  });

  it("the mismatch message ends as the redline writer's does", () => {
    const ending =
      "Check that this is the file that was reviewed and that it has not been changed since.";
    expect(MISMATCH_MESSAGE.endsWith(ending)).toBe(true);
    expect(MISMATCH_MESSAGE.startsWith("The document does not match the report")).toBe(true);
    expect(reviewCode).toContain(ending);
    expect(reviewCode).toContain("The document does not match the report");
  });

  it("the route and the header the redline is served from exist in the server", () => {
    expect(serverCode).toContain('"/api/reviews/:id/docx"');
    expect(serverCode).toContain('"X-Clausewise-Warnings"');
    expect(serverCode).toContain('"Content-Disposition"');
  });

  it("writes sizes as the server does", () => {
    expect(sizeLimitText(25 * 1024 * 1024)).toBe("25 MB");
    expect(sizeLimitText(1536 * 1024)).toBe("1.5 MB");
    expect(sizeLimitText(300 * 1024)).toBe("300 KB");
    expect(tooLargeMessage(25 * 1024 * 1024)).toBe(
      "The file is larger than the limit of 25 MB. Make the document smaller, or ask whoever runs this server to raise CLAUSEWISE_MAX_UPLOAD_MB.",
    );
    expect(tooManyReviewsMessage(200)).toContain("This document already has 200 reviews");
  });
});

async function call(
  server: ReturnType<typeof createFakeServer>,
  method: string,
  path: string,
  init: { json?: unknown; form?: FormData; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.json !== undefined) headers["Content-Type"] = "application/json";
  return server.fetch(path, {
    method,
    headers,
    ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
    ...(init.form === undefined ? {} : { body: init.form }),
  });
}

const messageOf = async (response: Response): Promise<{ code: string; message: string }> =>
  ((await response.json()) as { error: { code: string; message: string } }).error;

describe("the fake server's redline route", () => {
  const findings = [
    appliedFinding({ decision: "accepted" }),
    commentOnlyFinding({ decision: "rejected" }),
    missingFinding(),
  ];
  const make = () => createFakeServer({ reviews: [reviewDetail({ findings })] });

  it("sends the file, its name and type, and no header when there is nothing to say", async () => {
    const response = await call(make(), "GET", "/api/reviews/rev-1/docx?include=accepted");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("wordprocessingml");
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="Acme NDA.redlined.docx"; filename*=UTF-8''Acme%20NDA.redlined.docx`,
    );
    expect(response.headers.get("X-Clausewise-Warnings")).toBeNull();
    expect(await response.text()).toBe("redline:accepted:term");
  });

  it("holds the accepted findings by default, and everything not rejected for all", async () => {
    const server = make();
    expect(await (await call(server, "GET", "/api/reviews/rev-1/docx")).text()).toBe(
      "redline:accepted:term",
    );
    expect(await (await call(server, "GET", "/api/reviews/rev-1/docx?include=all")).text()).toBe(
      "redline:all:term|return-of-information",
    );
  });

  it("sends the warnings as a percent-encoded JSON list that the client reads back", async () => {
    const server = make();
    const notes = ["A change became a comment.", `Caf${String.fromCodePoint(0xe9)} & "quotes"`];
    server.state.redline.warnings = notes;
    const response = await call(server, "GET", "/api/reviews/rev-1/docx?include=all");
    const header = response.headers.get("X-Clausewise-Warnings");
    expect(header).toMatch(/^[\x20-\x7e]+$/);
    expect(warningsFromHeader(header)).toEqual(notes);
  });

  it("answers 400 for an include it does not know", async () => {
    const response = await call(make(), "GET", "/api/reviews/rev-1/docx?include=some");
    expect(response.status).toBe(400);
    expect(await messageOf(response)).toEqual({
      code: "bad_request",
      message: MESSAGES.includeMode,
    });
  });

  it("answers 409 while the review has not finished", async () => {
    const server = createFakeServer({
      reviews: [reviewDetail({ status: "running", findings: [] })],
    });
    const response = await call(server, "GET", "/api/reviews/rev-1/docx");
    expect(response.status).toBe(409);
    expect(await messageOf(response)).toEqual({
      code: "conflict",
      message: MESSAGES.redlineNotFinished,
    });
  });

  it("answers 409 with the redline writer's message when the file is not the one reviewed", async () => {
    const server = make();
    server.state.redline.mismatch = MISMATCH_MESSAGE;
    const response = await call(server, "GET", "/api/reviews/rev-1/docx");
    expect(response.status).toBe(409);
    expect(await messageOf(response)).toEqual({ code: "conflict", message: MISMATCH_MESSAGE });
  });

  it("answers 404 for a review that is not there", async () => {
    const response = await call(make(), "GET", "/api/reviews/nope/docx");
    expect(response.status).toBe(404);
    expect((await messageOf(response)).message).toBe(MESSAGES.noReview);
  });

  it("names the file as the server does for the original and the report", async () => {
    const server = make();
    const original = await call(server, "GET", "/api/documents/doc-1/file");
    expect(original.headers.get("Content-Disposition")).toContain(`filename="Acme NDA.docx"`);
    const report = await call(server, "GET", "/api/reviews/rev-1/report?format=md");
    expect(report.headers.get("Content-Disposition")).toContain(`filename="Acme NDA.summary.md"`);
    const json = await call(server, "GET", "/api/reviews/rev-1/report");
    expect(json.headers.get("Content-Disposition")).toContain(`filename="Acme NDA.report.json"`);
  });
});

describe("the fake server's other answers", () => {
  it("refuses an upload over the limit with 413 and the advice", async () => {
    const server = createFakeServer({ config: { maxUploadBytes: 1024 * 1024 } });
    const form = new FormData();
    form.append("file", docxFile("Big.docx", "x".repeat(1024 * 1024)));
    const response = await call(server, "POST", "/api/documents", { form });
    expect(response.status).toBe(413);
    expect(await messageOf(response)).toEqual({
      code: "payload_too_large",
      message: tooLargeMessage(1024 * 1024),
    });
  });

  it("refuses a file that is not a zip with 422, and a request without a file with 400", async () => {
    const server = createFakeServer();
    const form = new FormData();
    form.append("file", new File(["%PDF-1.7"], "scan.docx"));
    const refused = await call(server, "POST", "/api/documents", { form });
    expect(refused.status).toBe(422);
    expect(await messageOf(refused)).toEqual({
      code: "invalid_document",
      message: MESSAGES.notZip,
    });
    const empty = await call(server, "POST", "/api/documents", { form: new FormData() });
    expect(empty.status).toBe(400);
    expect((await messageOf(empty)).message).toBe(MESSAGES.noFile);
  });

  it("accepts a file that starts like a .docx", async () => {
    const server = createFakeServer();
    const form = new FormData();
    form.append("file", docxFile("Acme NDA.docx"));
    const accepted = await call(server, "POST", "/api/documents", { form });
    expect(accepted.status).toBe(201);
    expect(((await accepted.json()) as { fileName: string }).fileName).toBe("Acme NDA.docx");
  });

  it("refuses a new review with 503 before it looks at anything, and with 429 when it is full", async () => {
    const server = createFakeServer({
      config: { model: { configured: false, problem: "The key is missing." } },
    });
    const refused = await call(server, "POST", "/api/reviews", {
      json: { documentId: "nope", playbookId: "nope" },
    });
    expect(refused.status).toBe(503);
    expect(await messageOf(refused)).toEqual({
      code: "model_not_configured",
      message: `${MESSAGES.modelNotSet} The key is missing.`,
    });

    const busy = createFakeServer();
    const form = new FormData();
    form.append("file", docxFile("Acme NDA.docx"));
    await call(busy, "POST", "/api/documents", { form });
    busy.state.queueFull = true;
    const full = await call(busy, "POST", "/api/reviews", {
      json: { documentId: "doc-1", playbookId: "builtin:nda-mutual" },
    });
    expect(full.status).toBe(429);
    expect((await messageOf(full)).message).toBe(MESSAGES.queueFull);
  });

  it("refuses to cancel a review that has ended with 409, and to decide on one that has not", async () => {
    const server = createFakeServer({
      reviews: [
        reviewDetail({ id: "done" }),
        reviewDetail({ id: "busy", status: "running", findings: [] }),
      ],
    });
    const cancel = await call(server, "POST", "/api/reviews/done/cancel");
    expect(cancel.status).toBe(409);
    expect((await messageOf(cancel)).message).toBe(MESSAGES.cannotCancel);

    const decide = await call(server, "PATCH", "/api/reviews/busy/findings/term", {
      json: { decision: "accepted" },
    });
    expect(decide.status).toBe(409);
    expect((await messageOf(decide)).message).toBe(MESSAGES.findingsNotFinished);

    const remove = await call(server, "DELETE", "/api/reviews/busy");
    expect(remove.status).toBe(409);
    expect((await messageOf(remove)).message).toBe(MESSAGES.cannotDeleteRunning);
  });

  it("allows wording of your own only for an applied edit, and lets null clear it anywhere", async () => {
    const server = createFakeServer({
      reviews: [reviewDetail({ findings: [appliedFinding(), commentOnlyFinding()] })],
    });
    const refused = await call(server, "PATCH", "/api/reviews/rev-1/findings/governing-law", {
      json: { editedReplacement: "text" },
    });
    expect(refused.status).toBe(400);
    expect((await messageOf(refused)).message).toBe(MESSAGES.commentOnly);

    const cleared = await call(server, "PATCH", "/api/reviews/rev-1/findings/governing-law", {
      json: { editedReplacement: null },
    });
    expect(cleared.status).toBe(200);

    const nothing = await call(server, "PATCH", "/api/reviews/rev-1/findings/term", { json: {} });
    expect(nothing.status).toBe(400);
    expect((await messageOf(nothing)).message).toBe(MESSAGES.nothingToSend);

    const unknown = await call(server, "PATCH", "/api/reviews/rev-1/findings/nope", {
      json: { decision: "accepted" },
    });
    expect(unknown.status).toBe(404);
    expect((await messageOf(unknown)).message).toBe(MESSAGES.noFinding);
  });

  it("does not let a built-in playbook be changed or deleted, and asks for the token", async () => {
    const server = createFakeServer({ token: "a-long-enough-token" });
    const headers = { Authorization: "Bearer a-long-enough-token" };
    const change = await call(server, "PUT", "/api/playbooks/builtin:nda-mutual", {
      json: { yaml: "name: x" },
      headers,
    });
    expect(change.status).toBe(403);
    expect((await messageOf(change)).message).toBe(MESSAGES.builtinChange);
    const remove = await call(server, "DELETE", "/api/playbooks/builtin:nda-mutual", { headers });
    expect(remove.status).toBe(403);
    expect((await messageOf(remove)).message).toBe(MESSAGES.builtinDelete);

    const anonymous = await call(server, "GET", "/api/playbooks");
    expect(anonymous.status).toBe(401);
    expect((await messageOf(anonymous)).message).toBe(MESSAGES.unauthorized);
    expect((await call(server, "GET", "/api/config")).status).toBe(200);
  });
});
