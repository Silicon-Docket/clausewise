import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CsrfError } from "../../src/auth/csrf.js";
import { UploadError } from "../../src/module-contracts.js";
import { defineRoute } from "../../src/server/matter-route.js";
import { ForbiddenError, RunNotReadyError } from "../../src/services/errors.js";
import {
  ActiveRunError,
  AuditDetailError,
  ConflictError,
  ContentMismatchError,
  ExportBlockedError,
  FileStoreError,
  InputsIncompleteError,
  InvalidTransitionError,
  MigrationError,
  NotFoundError,
  StaleFindingError,
  StaleRunError,
  StoreError,
  ValidationError,
  type ExportBlocker,
} from "../../src/store/errors.js";
import { makeShell } from "./support-app.js";

/** A string that must not come back out of the server in any response or log line. */
const MARKER = "MARKER_Zq83vT_do_not_repeat";

interface Case {
  name: string;
  throws: () => unknown;
  status: number;
  /** The JSON error body, apart from `message`, which is checked for the marker only. */
  body: Record<string, unknown>;
  /** The message, when it is meant to be specific. */
  message?: string;
  logged?: string;
}

class Rogue extends Error {
  override name = `Bad Name ${MARKER}`;
}

const blockers = [
  { findingId: "fnd_0001", ruleKey: "dur-1", reason: "no_review" },
  { findingId: null, ruleKey: null, reason: "run_not_current" },
  { findingId: `<b>${MARKER}`, ruleKey: "exc-1", reason: "not_a_reason" },
] as unknown as ExportBlocker[];

const zodFailure = (): unknown => {
  const result = z.object({ plan: z.enum(["a", "b"]) }).safeParse({ plan: MARKER });
  return result.error;
};

const CASES: Case[] = [
  {
    name: "NotFoundError",
    throws: () => new NotFoundError("run"),
    status: 404,
    body: { kind: "not_found" },
  },
  {
    name: "ForbiddenError",
    throws: () => new ForbiddenError("review.decide"),
    status: 403,
    body: { kind: "forbidden" },
  },
  { name: "CsrfError", throws: () => new CsrfError(), status: 403, body: { kind: "csrf" } },
  {
    name: "ValidationError",
    throws: () => new ValidationError("name_empty", `the name ${MARKER} is empty`),
    status: 400,
    body: { kind: "invalid_request", code: "name_empty" },
  },
  {
    name: "ValidationError with an unsafe code",
    throws: () => new ValidationError(`Bad Code ${MARKER}`, "x"),
    status: 400,
    body: { kind: "invalid_request", code: "invalid" },
  },
  {
    name: "ZodError",
    throws: zodFailure,
    status: 400,
    body: { kind: "invalid_request", code: "invalid" },
  },
  {
    name: "ConflictError",
    throws: () => new ConflictError("member_exists", `${MARKER} is already a member`),
    status: 409,
    body: { kind: "conflict", code: "member_exists" },
  },
  {
    name: "ActiveRunError",
    throws: () => new ActiveRunError("run_0a1b2c"),
    status: 409,
    body: { kind: "active_run", code: "active_run", activeRunId: "run_0a1b2c" },
  },
  {
    name: "ActiveRunError with an id that is not an id",
    throws: () => new ActiveRunError(`<script>${MARKER}</script>`),
    status: 409,
    body: { kind: "active_run", code: "active_run" },
  },
  {
    name: "StaleRunError",
    throws: () => new StaleRunError("inputs_changed"),
    status: 409,
    body: { kind: "stale_run", code: "stale_run", why: "inputs_changed" },
  },
  {
    name: "StaleFindingError",
    throws: () => new StaleFindingError(),
    status: 409,
    body: { kind: "conflict", code: "stale_finding" },
  },
  {
    name: "ContentMismatchError",
    throws: () => new ContentMismatchError(),
    status: 409,
    body: { kind: "conflict", code: "content_mismatch" },
  },
  {
    name: "InputsIncompleteError",
    throws: () => new InputsIncompleteError(),
    status: 409,
    body: { kind: "conflict", code: "inputs_incomplete" },
  },
  {
    name: "InvalidTransitionError",
    throws: () => new InvalidTransitionError("matter", "draft", MARKER),
    status: 409,
    body: { kind: "conflict", code: "invalid_transition" },
  },
  {
    name: "ExportBlockedError",
    throws: () => new ExportBlockedError(blockers),
    status: 409,
    body: {
      kind: "export_blocked",
      code: "export_blocked",
      blockers: [
        { findingId: "fnd_0001", reason: "no_review" },
        { findingId: null, reason: "run_not_current" },
        { findingId: null, reason: "unknown" },
      ],
    },
  },
  {
    name: "RunNotReadyError",
    throws: () =>
      new RunNotReadyError([
        "Choose which version of the NDA is operative",
        "Pick a playbook\nversion",
      ]),
    status: 409,
    body: {
      kind: "not_ready",
      code: "not_ready",
      reasons: ["Choose which version of the NDA is operative", "Pick a playbook version"],
    },
  },
  {
    name: "UploadError",
    throws: () =>
      new UploadError("This Word file is over the 10 MB limit. Check that it is the right file."),
    status: 422,
    body: { kind: "upload_rejected" },
    message: "This Word file is over the 10 MB limit. Check that it is the right file.",
  },
  {
    name: "HTTPException 413",
    throws: () => new HTTPException(413),
    status: 413,
    body: { kind: "too_large" },
  },
  {
    name: "HTTPException 401",
    throws: () => new HTTPException(401),
    status: 401,
    body: { kind: "unauthenticated" },
  },
  {
    name: "HTTPException 404",
    throws: () => new HTTPException(404),
    status: 404,
    body: { kind: "not_found" },
  },
  {
    name: "HTTPException 418",
    throws: () => new HTTPException(418, { message: MARKER }),
    status: 400,
    body: { kind: "invalid_request", code: "invalid" },
  },
  {
    name: "HTTPException 503",
    throws: () => new HTTPException(503, { message: MARKER }),
    status: 500,
    body: { kind: "internal" },
    logged: "HTTPException",
  },
  {
    name: "an unexpected TypeError",
    throws: () => new TypeError(`cannot read ${MARKER}`),
    status: 500,
    body: { kind: "internal" },
    logged: "TypeError",
  },
  {
    name: "a StoreError of no known kind",
    throws: () => new StoreError("odd", `odd ${MARKER}`),
    status: 500,
    body: { kind: "internal" },
    logged: "StoreError",
  },
  {
    name: "FileStoreError",
    throws: () => new FileStoreError("bad_path", MARKER),
    status: 500,
    body: { kind: "internal" },
    logged: "FileStoreError",
  },
  {
    name: "MigrationError",
    throws: () => new MigrationError("checksum", MARKER),
    status: 500,
    body: { kind: "internal" },
    logged: "MigrationError",
  },
  {
    name: "AuditDetailError, which is our defect and not the caller's",
    throws: () => new AuditDetailError(`detail ${MARKER}`),
    status: 500,
    body: { kind: "internal" },
    logged: "AuditDetailError",
  },
  {
    name: "an error whose name is hostile",
    throws: () => new Rogue(MARKER),
    status: 500,
    body: { kind: "internal" },
    logged: "Error",
  },
  {
    name: "a thrown string",
    throws: () => MARKER,
    status: 500,
    body: { kind: "internal" },
    logged: "NonError",
  },
  {
    name: "a thrown object",
    throws: () => ({ message: MARKER, name: MARKER }),
    status: 500,
    body: { kind: "internal" },
    logged: "NonError",
  },
  {
    name: "a thrown null",
    throws: () => null,
    status: 500,
    body: { kind: "internal" },
    logged: "NonError",
  },
  {
    name: "a thrown number",
    throws: () => 42,
    status: 500,
    body: { kind: "internal" },
    logged: "NonError",
  },
];

function mount() {
  const shell = makeShell({
    app: {
      renderError: (status, title) => `<!doctype html><title>${title}</title><h1>${status}</h1>`,
    },
  });
  CASES.forEach((entry, index) => {
    for (const prefix of ["/api/t", "/t"]) {
      defineRoute(shell.app, {
        method: "GET",
        path: `${prefix}/${index}`,
        access: "public",
        handler: () => {
          throw entry.throws();
        },
      });
      defineRoute(shell.app, {
        method: "GET",
        path: `${prefix}/async/${index}`,
        access: "public",
        handler: async () => {
          await Promise.resolve();
          throw entry.throws();
        },
      });
    }
  });
  return shell;
}

describe("the error mapping", () => {
  const shell = mount();
  CASES.forEach((entry, index) => {
    it(`maps ${entry.name} to ${entry.status} as JSON under /api`, async () => {
      for (const path of [`/api/t/${index}`, `/api/t/async/${index}`]) {
        shell.logs.length = 0;
        const response = await shell.anonymous().get(path);
        const text = await response.text();
        expect(response.status).toBe(entry.status);
        expect(response.headers.get("content-type")).toMatch(/application\/json/);
        expect(text).not.toContain(MARKER);
        const { error } = JSON.parse(text) as { error: Record<string, unknown> };
        const { message, requestId, ...rest } = error;
        expect(rest).toEqual(entry.body);
        expect(typeof message).toBe("string");
        if (entry.message !== undefined) expect(message).toBe(entry.message);
        if (entry.status >= 500) expect(requestId).toBe(response.headers.get("x-request-id"));
        else expect(requestId).toBeUndefined();
        // One log line, with no trace of the message, and the class name only for a server fault.
        expect(shell.logs).toHaveLength(1);
        expect(shell.logs[0]).not.toContain(MARKER);
        if (entry.logged === undefined) expect(shell.logs[0]).not.toContain("error=");
        else expect(shell.logs[0]).toContain(` error=${entry.logged}`);
      }
    });

    it(`maps ${entry.name} to ${entry.status} as an HTML page elsewhere`, async () => {
      shell.logs.length = 0;
      const response = await shell.anonymous().get(`/t/${index}`);
      const text = await response.text();
      expect(response.status).toBe(entry.status);
      expect(response.headers.get("content-type")).toMatch(/text\/html/);
      expect(text).toContain(`<h1>${entry.status}</h1>`);
      expect(text).not.toContain(MARKER);
      expect(shell.logs.join("\n")).not.toContain(MARKER);
    });
  });
});

describe("the error page", () => {
  it("is built in when the application gives none, and is safe to show", async () => {
    const shell = makeShell();
    defineRoute(shell.app, {
      method: "GET",
      path: "/fail",
      access: "public",
      handler: () => {
        throw new TypeError(MARKER);
      },
    });
    const response = await shell.anonymous().get("/fail");
    const html = await response.text();
    expect(response.status).toBe(500);
    expect(html).toContain("Something went wrong");
    expect(html).toContain("Error 500");
    expect(html).not.toContain(MARKER);
    // Nothing the content security policy would refuse to run.
    expect(html).not.toMatch(/<script|<style|\sstyle=|\sonclick=|javascript:/i);
  });

  it("shows the request id on a server fault, the one in the header and the log, so it can be quoted", async () => {
    const shell = makeShell();
    defineRoute(shell.app, {
      method: "GET",
      path: "/fail",
      access: "public",
      handler: () => {
        throw new TypeError(MARKER);
      },
    });
    const response = await shell.anonymous().get("/fail");
    const id = response.headers.get("x-request-id")!;
    expect(id).toMatch(/^req_[0-9a-f]{16}$/);
    const html = await response.text();
    expect(response.status).toBe(500);
    expect(html).toContain(id);
    expect(shell.logs.at(-1)).toContain(`req=${id}`);
    expect(html).not.toContain(MARKER);
  });

  it("does not show a request id on any other error page, so those pages stay identical", async () => {
    const shell = makeShell();
    const a = await shell.anonymous().get("/nothing/here");
    const b = await shell.anonymous().get("/nothing/here");
    const text = await a.text();
    expect(text).not.toContain(a.headers.get("x-request-id")!);
    expect(text).not.toContain("req_");
    expect(await b.text()).toBe(text);
  });

  it("gives the application's renderer the request id for a server fault, and only then", async () => {
    const calls: [number, string, string | undefined][] = [];
    const shell = makeShell({
      app: {
        renderError: (status, title, requestId) => {
          calls.push([status, title, requestId]);
          return `<p>${status} ${title} ${requestId ?? ""}</p>`;
        },
      },
    });
    defineRoute(shell.app, {
      method: "GET",
      path: "/fail",
      access: "public",
      handler: () => {
        throw new TypeError(MARKER);
      },
    });
    const missing = await shell.anonymous().get("/no/such/page");
    const failed = await shell.anonymous().get("/fail");
    expect(calls).toEqual([
      [404, "Page not found", undefined],
      [500, "Something went wrong", failed.headers.get("x-request-id")],
    ]);
    expect(await missing.text()).not.toContain("req_");
    expect(await failed.text()).toContain(failed.headers.get("x-request-id")!);
  });

  it("falls back to the built-in page when the application's renderer throws", async () => {
    const shell = makeShell({
      app: {
        renderError: () => {
          throw new Error(MARKER);
        },
      },
    });
    const response = await shell.anonymous().get("/no/such/page");
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain("Page not found");
    expect(html).not.toContain(MARKER);
  });

  it("is given the status and a fixed title, and nothing from the request", async () => {
    const calls: [number, string][] = [];
    const shell = makeShell({
      app: {
        renderError: (status, title) => {
          calls.push([status, title]);
          return `<p>${status} ${title}</p>`;
        },
      },
    });
    await shell.anonymous().get(`/matters/${MARKER}?q=${MARKER}`, { "x-note": MARKER });
    expect(calls).toEqual([[404, "Page not found"]]);
  });

  it("is the same page for an unknown path whatever the path is", async () => {
    const shell = makeShell();
    const a = await (await shell.anonymous().get("/nothing/here")).text();
    const b = await (await shell.anonymous().get(`/nothing/${MARKER}`)).text();
    expect(b).toBe(a);
  });
});

describe("an unknown route", () => {
  it("answers 404 as JSON under /api and as a page elsewhere, never repeating the path", async () => {
    const shell = makeShell();
    const api = await shell.anonymous().get(`/api/${MARKER}`);
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: { kind: "not_found", message: "Not found." } });
    const page = await shell.anonymous().get(`/${MARKER}`);
    expect(page.status).toBe(404);
    expect(await page.text()).not.toContain(MARKER);
  });

  it("answers a wrong method on a known route like any other unknown route", async () => {
    const shell = makeShell();
    const response = await shell.anonymous().send("DELETE", "/healthz");
    expect(response.status).toBe(404);
  });
});
