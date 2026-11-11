import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Writable, type Duplex } from "node:stream";
import { RequestError } from "@hono/node-server";
import { HTTPException } from "hono/http-exception";
import { beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { GLOBAL_ACTIONS, MATTER_ACTIONS } from "../../src/auth/actions.js";
import { CsrfError } from "../../src/auth/csrf.js";
import { UploadError } from "../../src/module-contracts.js";
import {
  GUIDANCE,
  GUIDANCE_BY_STATUS,
  GUIDANCE_KEYS,
  guidanceFor,
} from "../../src/server/guidance.js";
import { defineRoute } from "../../src/server/matter-route.js";
import { TITLES, builtinErrorPage, toSafeError } from "../../src/server/middleware/errors.js";
import { rejectedRequestHandler, wireErrorHandler } from "../../src/server/middleware/rejected.js";
import { REFUSAL_JUMP, REFUSAL_PHRASES, REFUSAL_TODO } from "../../src/server/routes/notices.js";
import { urls } from "../../src/server/urls.js";
import { ForbiddenError, RunNotReadyError } from "../../src/services/errors.js";
import { CANNOT_DECIDE } from "../../src/services/phrases.js";
import {
  ActiveRunError,
  AuditDetailError,
  ConflictError,
  ExportBlockedError,
  NotFoundError,
  StaleRunError,
  ValidationError,
} from "../../src/store/errors.js";
import { SpendRefusedError } from "../../src/usage/errors.js";
import { all, first, hasClass, parseHtml, readable, type El } from "../pages/html.js";
import { checkInvariants } from "../pages/invariants.js";
import {
  IDS,
  OUTSIDER,
  VIEWER,
  makeSite,
  prepareMatter,
  type Prepared,
  type Site,
} from "../routes/support.js";
import { expectAccessible, tabStops } from "./rules.js";

/**
 * The error pages say what happened and what to do, and they say it by the kind of failure.
 *
 * What these tests can show: the sentence a page gives is the one in the table for the kind of
 * failure, the part that says what to do is marked, the sentence for a request that never reached
 * the application is there too, and the 404 for a matter that is not yours is the same page, byte
 * for byte, as the 404 for one that does not exist. What they cannot show: that a person reading
 * the sentence does what it asks.
 */

const NO_DASH = /[\u2013\u2014]/;

// ---------------------------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------------------------

describe("the guidance table", () => {
  it("has an entry for every key and nothing else", () => {
    expect(Object.keys(GUIDANCE).sort()).toEqual([...GUIDANCE_KEYS].sort());
    expect(new Set(GUIDANCE_KEYS).size).toBe(GUIDANCE_KEYS.length);
  });

  it.each(GUIDANCE_KEYS)(
    "%s: a sentence that says what to do, which ends the text and occurs in it",
    (key) => {
      const { text, todo } = GUIDANCE[key];
      expect(text.trim()).not.toBe("");
      expect(todo.trim()).not.toBe("");
      expect(text.includes(todo)).toBe(true);
      // The part that says what to do comes last, so a reader who stops there has it.
      expect(text.endsWith(todo)).toBe(true);
      expect(todo).toMatch(/^[A-Z].*\.$/);
      expect(text).toMatch(/\.$/);
      expect(text).not.toMatch(NO_DASH);
      // Fixed words: nothing in them is a slot for the request to fill.
      expect(text).not.toMatch(/[{}<>$]/);
    },
  );

  it("gives every key its own words, so that no two causes read alike", () => {
    const texts = GUIDANCE_KEYS.map((key) => GUIDANCE[key].text);
    expect(new Set(texts).size).toBe(texts.length);
    const todos = GUIDANCE_KEYS.map((key) => GUIDANCE[key].todo);
    // Reloading the page is the right advice for three causes, so those may share their todo; no
    // other two may.
    const shared = todos.filter((todo, index) => todos.indexOf(todo) !== index);
    expect(new Set(shared)).toEqual(new Set(["Reload the page and try again."]));
  });

  it("says, for a global role, which people the page is for and that the person can go back", () => {
    expect(GUIDANCE.global_role.text).toBe(
      "This page is for the legal engineer or an administrator. Ask one of them, or go back to your matters.",
    );
    expect(GUIDANCE.global_role.todo).toBe("Ask one of them, or go back to your matters.");
  });

  it("keeps the first sentence of the 404, 409 and 422 pages as they were", () => {
    expect(
      GUIDANCE.not_found.text.startsWith(
        "There is nothing here, or you are not a member of the matter.",
      ),
    ).toBe(true);
    expect(GUIDANCE.conflict.text).toBe(
      "The matter changed, or the request does not fit its state. Reload the page and try again.",
    );
    expect(
      GUIDANCE.bad_file.text.startsWith(
        "That file could not be accepted. Parol reads .docx and .txt files.",
      ),
    ).toBe(true);
    expect(GUIDANCE.other.text.startsWith("The request could not be completed.")).toBe(true);
  });

  it("maps every status the shell sends a title for to a key, and every key it maps to exists", () => {
    const statuses = Object.keys(TITLES).map(Number);
    for (const status of statuses) {
      expect(Object.hasOwn(GUIDANCE_BY_STATUS, status), String(status)).toBe(true);
    }
    for (const [status, key] of Object.entries(GUIDANCE_BY_STATUS)) {
      expect(Object.hasOwn(TITLES, status), status).toBe(true);
      expect(GUIDANCE_KEYS).toContain(key);
    }
  });

  it("lets a key win over the status, and a status over nothing, and falls back to the general sentence", () => {
    expect(guidanceFor(403)).toBe(GUIDANCE.role);
    expect(guidanceFor(403, "csrf")).toBe(GUIDANCE.csrf);
    expect(guidanceFor(403, "host")).toBe(GUIDANCE.host);
    expect(guidanceFor(403, "global_role")).toBe(GUIDANCE.global_role);
    expect(guidanceFor(404)).toBe(GUIDANCE.not_found);
    for (const status of [0, 200, 418, 502, 503, -1, Number.NaN])
      expect(guidanceFor(status), String(status)).toBe(GUIDANCE.other);
    // A value that is not a key (a table's own property names included) is ignored.
    for (const bad of ["__proto__", "constructor", "toString", "hasOwnProperty", "", "ROLE"])
      expect(guidanceFor(409, bad as never), bad).toBe(GUIDANCE.conflict);
  });

  it("is pure data: the file imports nothing, so a page may use it without reaching anything else", () => {
    const source = readFileSync(join(import.meta.dirname, "../../src/server/guidance.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(|\bimport\(/);
    expect(source).not.toMatch(NO_DASH);
  });
});

// ---------------------------------------------------------------------------------------------
// Which sentence each failure gets
// ---------------------------------------------------------------------------------------------

describe("the sentence each kind of failure gets", () => {
  const spend = new SpendRefusedError("spend_over_review_limit", {
    boundUsd: 3,
    limitUsd: 2,
    usedUsd: 0,
    heldUsd: 0,
  });
  const cases: [string, unknown, number, string][] = [
    ["a missing or wrong form token", new CsrfError(), 403, "csrf"],
    ["a foreign Host header", new ForbiddenError("host"), 403, "host"],
    ["a role that may not do it on the matter", new ForbiddenError("run.start"), 403, "role"],
    ["segregation of duties", new ForbiddenError("review.segregation"), 403, "role"],
    ["deleting a matter one did not create", new ForbiddenError("matter.delete"), 403, "role"],
    ["a matter that does not exist or is not yours", new NotFoundError("matter"), 404, "not_found"],
    ["a field that is not valid", new ValidationError("bad_text", "x"), 400, "bad_request"],
    ["a request body the validator refused", new ZodError([]), 400, "bad_request"],
    ["a conflict", new ConflictError("member_exists", "x"), 409, "conflict"],
    ["a run already going", new ActiveRunError("run_1"), 409, "conflict"],
    ["a run that no longer fits", new StaleRunError("inputs_changed"), 409, "conflict"],
    ["a memo that cannot be exported yet", new ExportBlockedError([]), 409, "conflict"],
    [
      "a matter not ready for a review",
      new RunNotReadyError(["Choose a playbook"]),
      409,
      "conflict",
    ],
    ["a review the spend limit refused", spend, 409, "conflict"],
    ["a file that cannot be accepted", new UploadError("This file is empty."), 422, "bad_file"],
    ["an HTTP error 413", new HTTPException(413), 413, "too_large"],
    ["an HTTP error 401", new HTTPException(401), 401, "sign_in"],
    ["an HTTP error 403", new HTTPException(403), 403, "role"],
    ["an HTTP error 404", new HTTPException(404), 404, "not_found"],
    ["an HTTP error 422", new HTTPException(422), 422, "bad_file"],
    ["any other HTTP error of the 400s", new HTTPException(418), 400, "bad_request"],
    ["an HTTP error of the 500s", new HTTPException(503), 500, "server"],
    ["a defect in the audit detail", new AuditDetailError("x"), 500, "server"],
    ["an unexpected error", new TypeError("x"), 500, "server"],
    ["something that is not an error", "x", 500, "server"],
  ];

  it.each(cases)("%s", (_name, thrown, status, key) => {
    const safe = toSafeError(thrown);
    expect(safe.status).toBe(status);
    expect(safe.guidance).toBe(key);
  });

  it("tells a global action from a matter action by the table of global actions", () => {
    for (const action of Object.keys(GLOBAL_ACTIONS))
      expect(toSafeError(new ForbiddenError(action)).guidance, action).toBe("global_role");
    for (const action of Object.keys(MATTER_ACTIONS))
      expect(toSafeError(new ForbiddenError(action)).guidance, action).toBe("role");
    // A name that only looks like one of the table's property names is not a global action.
    for (const action of ["", "__proto__", "constructor", "toString", "hasOwnProperty"])
      expect(toSafeError(new ForbiddenError(action)).guidance, action).toBe("role");
  });

  it("leaves the JSON fields as they were: the key is not part of the body", () => {
    for (const [, thrown] of cases) {
      const safe = toSafeError(thrown);
      expect(Object.keys(safe.extra)).not.toContain("guidance");
      expect(safe.message).not.toBe(GUIDANCE[safe.guidance].text);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The real responses
// ---------------------------------------------------------------------------------------------

interface Seen {
  status: number;
  html: string;
  root: El;
  page: El;
  marked: string[];
}

async function seen(response: Response): Promise<Seen> {
  const html = await response.text();
  const root = parseHtml(html);
  const page = first(root, (el) => hasClass(el, "error-page"), "the error page");
  const marked = all(page, (el) => hasClass(el, "todo")).map(readable);
  return { status: response.status, html, root, page, marked };
}

const FORM = { "content-type": "application/x-www-form-urlencoded" };

describe("the real responses of the application", () => {
  let site: Site;
  let ids: Prepared;

  beforeAll(async () => {
    site = makeSite({ maxUploadBytes: 4096 });
    ids = await prepareMatter(site, { exported: false });
    // Routes are added before the first request: the router does not take one after it.
    defineRoute(site.app, {
      method: "GET",
      path: "/test/fault",
      access: "public",
      handler: () => {
        throw new TypeError("a defect with a marker MARKER_fault");
      },
    });
    defineRoute(site.app, {
      method: "GET",
      path: "/test/signed-out",
      access: "public",
      handler: () => {
        throw new HTTPException(401);
      },
    });
    defineRoute(site.app, {
      method: "GET",
      path: "/test/bad-file",
      access: "public",
      handler: () => {
        throw new UploadError("This file is empty.");
      },
    });
  });

  const post = async (
    who: Awaited<ReturnType<Site["as"]>>,
    path: string,
    fields: Record<string, string>,
    token = true,
  ): Promise<Response> =>
    who.send("POST", path, {
      headers: FORM,
      body: new URLSearchParams({
        ...(token ? { _csrf: await who.apiToken() } : {}),
        ...fields,
      }).toString(),
    });

  /** Every case: how to ask, the status, the key, and whether the page carries a reference. */
  const requests: [string, () => Promise<Response>, number, (typeof GUIDANCE_KEYS)[number]][] = [
    [
      "an address that does not exist",
      async () => site.anonymous().get("/no/such/page"),
      404,
      "not_found",
    ],
    [
      "a form posted without its token",
      async () => post(await site.as(IDS.associate), urls.runs(ids.matterId), {}, false),
      403,
      "csrf",
    ],
    [
      "a form that the person's role may not send",
      async () => post(await site.as(VIEWER), urls.runs(ids.matterId), { workflow: "v2" }),
      403,
      "role",
    ],
    [
      "a request for a foreign address",
      async () => site.app.request("http://localhost/", { headers: { host: "machine.example" } }),
      403,
      "host",
    ],
    [
      "a page for the legal engineer, asked for by a member (the evaluation comparison)",
      async () => (await site.as(IDS.associate)).get(urls.evaluations()),
      403,
      "global_role",
    ],
    [
      "a page for an administrator, asked for by a member (the audit check)",
      async () => (await site.as(IDS.reviewer)).get(urls.audit()),
      403,
      "global_role",
    ],
    [
      "a memo asked for before every finding is decided",
      async () => post(await site.as(IDS.reviewer), urls.memos(ids.matterId), {}),
      409,
      "conflict",
    ],
    [
      "an upload larger than the server accepts",
      async () => {
        const who = await site.as(IDS.associate);
        const page = await who.page(urls.matter(ids.matterId));
        return who.upload(page, urls.versions(ids.matterId, ids.lastDocumentId), {
          name: "huge.txt",
          bytes: new Uint8Array(200_000).fill(0x61),
        });
      },
      413,
      "too_large",
    ],
    [
      "a sign-in form that says nothing it can act on",
      async () => {
        const visitor = site.anonymous();
        return post(visitor, urls.session(), { intent: "nothing" }, true);
      },
      400,
      "bad_request",
    ],
    [
      "a visitor with no session on a route that needs one",
      async () => site.anonymous().get("/test/signed-out"),
      401,
      "sign_in",
    ],
    [
      "a file that no route caught",
      async () => site.anonymous().get("/test/bad-file"),
      422,
      "bad_file",
    ],
    ["a defect on the server", async () => site.anonymous().get("/test/fault"), 500, "server"],
  ];

  it.each(requests)("%s", async (_name, ask, status, key) => {
    const response = await ask();
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    const { html, root, page, marked } = await seen(response);
    // One heading, the status, the title of the status, the sentence of the kind, and the part
    // that says what to do, marked once and equal to the one in the table.
    expect(all(root, (el) => el.name === "h1")).toHaveLength(1);
    expect(readable(first(root, (el) => el.name === "h1"))).toBe(TITLES[status]);
    expect(readable(page)).toContain(`Error ${status}`);
    expect(readable(page)).toContain(GUIDANCE[key].text);
    expect(marked).toEqual([GUIDANCE[key].todo]);
    // A way to go on, reachable from the keyboard as the last stop of the page.
    const stops = tabStops(root);
    expect(stops.length).toBeGreaterThan(1);
    expect(hasClass(stops.at(-1)!, "button")).toBe(true);
    checkInvariants(html, { csrf: "" });
    expectAccessible(html);
    // The page names a kind of problem and never what was sent.
    expect(html).not.toContain("MARKER_fault");
    expect(html).not.toContain("machine.example");
    if (status === 500) {
      expect(html).toMatch(/Reference: <code>req_[0-9a-f]{16}<\/code>/);
    } else {
      expect(html).not.toContain("req_");
    }
  });

  it("reads differently for each cause of a 403, and none of the new ones says 'Your role'", async () => {
    const forbidden = requests.filter(([, , status]) => status === 403);
    const pages = await Promise.all(forbidden.map(async ([, ask]) => seen(await ask())));
    const sentences = pages.map((p) => readable(p.page));
    expect(forbidden.map(([, , , key]) => key).sort()).toEqual(
      ["csrf", "global_role", "global_role", "host", "role"].sort(),
    );
    // Four causes, four different pages (the two pages for a global role are the same page).
    expect(new Set(sentences).size).toBe(4);
    for (const [index, [, , , key]] of forbidden.entries()) {
      if (key !== "role") expect(sentences[index], key).not.toContain("Your role");
    }
  });

  it("lets an administrator and a member who is allowed in through the same addresses", async () => {
    const admin = await site.as(IDS.admin);
    expect((await admin.get(urls.evaluations())).status).toBe(200);
    expect((await admin.get(urls.audit())).status).toBe(200);
  });

  it("answers the same 404 page, byte for byte, whatever the reason there is nothing to show", async () => {
    const missing = "mat_00000000deadbeef";
    const pages = new Map<string, string>();
    const record = async (name: string, response: Response): Promise<void> => {
      expect(response.status, name).toBe(404);
      pages.set(name, await response.text());
    };
    const outsider = await site.as(OUTSIDER);
    const associate = await site.as(IDS.associate);
    await record("an unknown address", await site.anonymous().get("/no/such/page"));
    await record(
      "a matter the outsider has no part in",
      await outsider.get(urls.matter(ids.matterId)),
    );
    await record(
      "a matter that does not exist (the outsider)",
      await outsider.get(urls.matter(missing)),
    );
    await record(
      "a matter that does not exist (a member of another)",
      await associate.get(urls.matter(missing)),
    );
    await record(
      "a finding that is not in the matter (a member)",
      await associate.get(urls.finding(ids.matterId, "fnd_00000000deadbeef")),
    );
    await record(
      "a form posted to a matter the outsider has no part in",
      await post(outsider, urls.runs(ids.matterId), { workflow: "v2" }),
    );
    await record(
      "a form posted to a matter that does not exist",
      await post(outsider, urls.runs(missing), { workflow: "v2" }),
    );
    const bytes = [...pages.values()];
    expect(pages.size).toBe(7);
    for (const [name, html] of pages) {
      expect(html, name).toBe(bytes[0]);
      expect(html, name).not.toContain("req_");
      expect(html, name).not.toContain(ids.matterId);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Pages that never reached the application
// ---------------------------------------------------------------------------------------------

describe("the built-in page and the pages below the application", () => {
  const STATUSES = [400, 403, 404, 408, 431, 500] as const;

  it.each(STATUSES)(
    "%i: says what happened and what to do, and carries nothing of a request",
    (status) => {
      const html = builtinErrorPage(
        status,
        TITLES[status]!,
        status === 500 ? "req_0123456789abcdef" : undefined,
      );
      const root = parseHtml(html);
      const key = GUIDANCE_BY_STATUS[status]!;
      expect(readable(first(root, (el) => el.name === "main"))).toContain(GUIDANCE[key].text);
      expect(readable(first(root, (el) => el.name === "h1"))).toBe(TITLES[status]);
      expect(html).not.toMatch(/<script|<style|\sstyle=|\son[a-z]+=/i);
      expect(html).toContain(`href="${urls.home()}"`);
      expect(html.includes("Reference:")).toBe(status === 500);
    },
  );

  it("takes the key of the failure when it is given, and the status otherwise", () => {
    const withKey = builtinErrorPage(403, TITLES[403]!, undefined, "csrf");
    expect(readable(parseHtml(withKey))).toContain(GUIDANCE.csrf.text);
    expect(readable(parseHtml(withKey))).not.toContain(GUIDANCE.role.text);
    expect(readable(parseHtml(builtinErrorPage(403, TITLES[403]!)))).toContain(GUIDANCE.role.text);
    expect(readable(parseHtml(builtinErrorPage(418, "Teapot")))).toContain(GUIDANCE.other.text);
  });

  it("escapes what it prints, though it is only ever given fixed words", () => {
    const html = builtinErrorPage(500, "<b>x</b>", "<i>id</i>");
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain("<i>id</i>");
  });

  it("is what the adapter's refusal of a request it cannot read answers with", async () => {
    const lines: string[] = [];
    const handle = rejectedRequestHandler({ log: (line) => lines.push(line), https: false });
    const unreadable = handle(new RequestError("a message with a marker MARKER_wire"));
    expect(unreadable.status).toBe(400);
    const bad = await unreadable.text();
    expect(bad).toContain(GUIDANCE.bad_request.text);
    expect(bad).not.toContain("MARKER_wire");
    expect(bad).not.toContain("Reference:");
    const fault = handle(new TypeError("MARKER_wire"));
    expect(fault.status).toBe(500);
    const faultHtml = await fault.text();
    expect(faultHtml).toContain(GUIDANCE.server.text);
    expect(faultHtml).toMatch(/Reference: <code>req_[0-9a-f]{16}<\/code>/);
    expect(faultHtml).not.toContain("MARKER_wire");
    expect(lines.join("\n")).not.toContain("MARKER_wire");
  });

  it.each([
    ["HPE_HEADER_OVERFLOW", 431, "headers_large"],
    ["ERR_HTTP_REQUEST_TIMEOUT", 408, "timeout"],
    ["HPE_INVALID_METHOD", 400, "bad_request"],
  ] as const)("is what the parser's refusal %s answers with (%i)", async (code, status, key) => {
    const chunks: Buffer[] = [];
    const socket = new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk);
        done();
      },
    });
    const finished = new Promise<void>((resolve) => socket.once("finish", () => resolve()));
    const error = Object.assign(new Error("a message with a marker MARKER_wire"), { code });
    wireErrorHandler({ log: () => undefined, https: false })(error, socket as unknown as Duplex);
    await finished;
    const answer = Buffer.concat(chunks).toString("utf8");
    expect(answer.startsWith(`HTTP/1.1 ${status} `)).toBe(true);
    // The page is HTML, so an apostrophe in the sentence is written as its character reference.
    expect(answer.replaceAll("&#39;", "'")).toContain(GUIDANCE[key].text);
    expect(answer).not.toContain("MARKER_wire");
  });
});

// ---------------------------------------------------------------------------------------------
// Every code a form can be refused with
// ---------------------------------------------------------------------------------------------

/**
 * The source scan. It reads every file under `src` and finds each `ValidationError` and
 * `ConflictError` the code can throw: those made with `new ValidationError("code"` or
 * `new ConflictError("code"` (line breaks allowed), and those made by a class that extends one of
 * the two and passes its own code to `super("code"` (the store's `ActiveRunError`,
 * `InvalidTransitionError` and the rest). It insists that the code of every throw is a literal, so
 * that no throw can hide from the scan behind a variable.
 *
 * Every code it finds is placed in exactly one of three places:
 *
 *  - It has a phrase in `REFUSAL_PHRASES` (the core fragment in `routes/notices.ts` or the fragment
 *    of the package that throws it). That is where a code a person can reach from a form belongs.
 *  - It is in `NOT_REACHED` with a one-line reason why no person gets to see it, such as a check
 *    in the store on a value that a service has just made. The list is written to be argued with: a
 *    code that a person can in fact reach belongs in the first place.
 *  - It is in `ON_THE_SHELL_PAGE`: a person can reach it, but the route is not answered in place,
 *    so the person sees the shell's page for the status and not a notice, and a phrase would not
 *    be shown. Each entry names the route. The list is written to shrink: when the route is
 *    answered in place, the code gets its phrase and leaves the list, and this test says so.
 *
 * A code a later package adds is in none of the three until its author places it, so the scan fails
 * for it, and says which.
 */
const NOT_REACHED: Record<string, string> = {
  already_approved:
    "a playbook is approved when it is registered at start-up, and no page approves one",
  already_promoted: "a workflow is promoted by the evaluation tooling, and no page promotes one",
  audit_action: "the audit writer checks its own arguments, so a failure is a defect in our code",
  audit_actor_id: "the audit writer checks its own arguments, so a failure is a defect in our code",
  audit_detail:
    "an audit detail that breaks the rules is a defect in our code, and the shell answers it with a 500",
  audit_matter_id:
    "the audit writer checks its own arguments, so a failure is a defect in our code",
  audit_target_id:
    "the audit writer checks its own arguments, so a failure is a defect in our code",
  audit_target_type:
    "the audit writer checks its own arguments, so a failure is a defect in our code",
  bad_body:
    "the body of a request that could not be read at all, which a browser form does not send",
  bad_bytes: "the upload service reads the file into bytes before it calls the store",
  bad_code: "a short code that a service wrote, checked once more by the store",
  bad_content_type:
    "a JSON route given another content type, and the forms of the pages post forms",
  bad_intent: "the sign-in form always names its intent",
  bad_kind:
    "the kind of a document comes from a list on the upload form, and that of a feedback entry from its service",
  bad_media_type: "the upload service takes the media type from the name of a file it has accepted",
  bad_number: "a count that a service worked out, checked once more by the store",
  bad_offsets: "a stage saves a finding with offsets it has just verified against the document",
  bad_prompt: "a prompt is registered at start-up from the files of the application",
  bad_prompt_id: "a prompt is registered at start-up from the files of the application",
  bad_purpose:
    "the purpose of a run is set by the service that starts it, and the start form has no field for it",
  bad_reason:
    "the reason for a deletion is a closed word set by the delete form or the retention job",
  bad_reported_model:
    "the model name a run reports is read from the provider's answer by the runner",
  bad_scores: "the evaluation runner writes its own scores, and no page does",
  bad_slug: "a playbook is registered at start-up from the files of the application",
  bad_span_hash: "the passages of a document are made from its text by the ingest",
  bad_span_id: "the passages of a document are made from its text by the ingest",
  bad_spend:
    "the numbers of a model call's usage are worked out by the meter, and no page sends them",
  bad_split: "the evaluation runner names the split of its own run, and no page does",
  bad_stage: "a stage name is written by the runner, and that of a prompt by its registration",
  bad_storage_path: "storage paths are made by the file store",
  bad_target:
    "an address that does not parse is refused by the host check before any page is chosen",
  bad_unit: "a stage unit is written by the runner",
  bad_version: "a playbook is registered at start-up from the files of the application",
  bad_warning_code: "ingest warnings are written by the ingest with its own closed list of codes",
  bad_warning_detail:
    "ingest warnings are written by the ingest with a detail it has cut to length",
  bad_yaml: "a playbook is registered at start-up from the files of the application",
  compact_busy:
    "the compaction of the database is run by the operator's commands, and no page runs it",
  content_hash_mismatch: "a stage saves a finding with the hash it has just computed",
  duplicate_check:
    "a stage saves a finding with one result for each check, and the stage writes no other",
  duplicate_file: "the upload service finds a file already in the matter first and keeps one copy",
  duplicate_rule:
    "a stage writes one finding for each rule, and a playbook is registered with unique rule keys",
  evidence_outside_manifest: "a stage cites passages of the documents the run was started on",
  field_not_allowed:
    "the feedback service passes only the fields its kind takes, so the store's guard cannot be reached",
  finding_exists:
    "a stage writes one finding for each rule and repeats a write only with the same content",
  finding_not_allowed: "the feedback service names a finding only for the kinds that take one",
  finding_required: "the feedback service names a finding for the kind that needs one",
  in_transaction:
    "the compaction of the database is run by the operator's commands, and no page runs it",
  inputs_incomplete:
    "the start form is answered with the reasons a review cannot start, from the same check, before the store is asked",
  invalid_input: "the store's own check of a value that a service has already built",
  manifest_hash_mismatch: "the manifest of a run is built by the store for the run it then creates",
  manifest_matter: "the manifest of a run is built by the store for the run it then creates",
  manifest_mismatch: "the manifest of a run is built by the store for the run it then creates",
  matter_not_runnable:
    "a start applies the change that a re-run makes to the matter's status and checks readiness before the store is asked",
  matter_required: "the audit page of a matter is read by the commands, which give the matter",
  model_status_mismatch: "a stage saves a finding whose status the settlement has just worked out",
  model_status_not_settled:
    "a stage saves a finding whose status the settlement has just worked out",
  model_status_same: "a stage saves a finding whose status the settlement has just worked out",
  model_status_unexplained:
    "a stage saves a finding whose status the settlement has just worked out",
  matter_running:
    "the service cancels a run in flight before the store is asked, so the code is a race and the retention job's skip",
  no_active_run: "the matter moves to running only when the runner starts the run it has just made",
  no_current_run:
    "the matter moves to in review only after the run it belongs to has been made current",
  no_memo: "the matter moves to exported only after the memo has been recorded",
  no_rules: "a playbook is registered at start-up from the files of the application",
  not_fully_decided:
    "the matter moves to review complete only after the export readiness check has passed",
  not_synthetic:
    "the evaluation runner refuses a matter that is not synthetic, and no page runs it",
  nul_character:
    "the text of a form is checked for control characters (bad_text) before it reaches a statement",
  operative_conflict:
    "the upload service never asks for a version to be operative and kept operative at once",
  playbook_hash_mismatch: "a playbook is registered at start-up from the files of the application",
  playbook_not_approved:
    "the settings form lists approved playbooks only, and the store is asked for one of them",
  playbook_version_exists: "a playbook is registered at start-up from the files of the application",
  prompt_hash_taken: "a prompt is registered at start-up from the files of the application",
  prompt_id_taken: "a prompt is registered at start-up from the files of the application",
  quote_mismatch: "a stage cites a quote it has just found in the document",
  rule_mismatch: "a stage saves a finding for a rule it has read from the playbook of the run",
  run_mismatch: "a note names a finding, and the service gives the run of that finding",
  run_not_active:
    "the runner writes the stages of a run while it is in flight, and the pages write none",
  run_not_writing:
    "the runner writes the findings of a run while it analyses and verifies, and the pages write none",
  run_required: "the feedback service gives the run of the path for the kinds that need one",
  slot_exists: "the evaluation runner writes each slot once, and no page writes one",
  spans_differ:
    "the ingest writes the passages of a version once and repeats a write only with the same text",
  stage_closed: "the runner closes each stage attempt once",
  status_must_be_undetermined:
    "a stage saves a finding whose status the settlement has just worked out",
  storage_path_in_use: "storage paths are made new for each file by the file store",
  text_required:
    "the feedback service refuses an empty text with its own code before the store is asked",
  undetermined_needs_escalation: "a stage saves a finding whose escalations it has just worked out",
  unknown_field:
    "a JSON body with a field the route does not know, which the forms of the pages do not send",
  unknown_prompt:
    "a workflow is registered at start-up with the prompts that were registered first",
  unverified_quote_not_escalated:
    "a stage saves a finding whose escalations it has just worked out",
  use_apply_input_change:
    "the services move the status of a matter for a change of inputs by the one function that does it",
  use_delete_matter: "the services delete a matter by the one function that does it",
  verification_state_mismatch:
    "a stage saves a finding whose verification state it has just worked out",
  workflow_hash_mismatch: "a workflow is registered at start-up from the files of the application",
  workflow_label_taken: "a workflow is registered at start-up from the files of the application",
  workflow_retired: "the start form lists workflows that are not retired",
};

const ON_THE_SHELL_PAGE: Record<string, string> = {
  export_blocked:
    "POST /matters/:matterId/memos is not answered in place, so a person sees the shell's 409 page",
  memo_file_changed: "GET of the memo file is a download, so a person sees the shell's 409 page",
  memo_file_missing: "GET of the memo file is a download, so a person sees the shell's 409 page",
  memo_quote_unverified:
    "POST /matters/:matterId/memos is not answered in place, so a person sees the shell's 409 page",
  reviews_changed:
    "POST /matters/:matterId/memos is not answered in place, so a person sees the shell's 409 page",
};

/**
 * Phrases written before the sentence that says what to do (`todo`) was required of every code.
 * The list is written to shrink: a code that gains a todo must leave it, and a phrase added now
 * without a todo is not on it and fails.
 */
const PHRASES_WITHOUT_A_TODO = [
  "amendment_limit",
  "bad_date",
  "bad_decision",
  "bad_hash",
  "bad_role",
  "bad_status",
  "content_mismatch",
  "decision_conflict",
  "document_layout",
  "document_limit",
  "duplicate_stated_date",
  "edit_changes_nothing",
  "edits_not_allowed",
  "edits_required",
  "matter_changed",
  "matter_exported",
  "matter_not_in_review",
  "nda_exists",
  "nda_first",
  "no_file",
  "reason_required",
  "run_model_changed",
  "run_not_succeeded",
  "stale_finding",
  "too_many_roles",
] as const;

interface ThrowSite {
  code: string;
  file: string;
  line: number;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const SRC = join(import.meta.dirname, "../../src");
const lineOf = (text: string, index: number): number => text.slice(0, index).split("\n").length;

/**
 * Every throw with a literal code: `new ValidationError("code"`, `new ConflictError("code"` and the
 * `super("code"` of a class that extends one of the two. `unreadable` lists the throws whose code
 * is not a literal, which the scan cannot read.
 */
function scanThrows(): { sites: ThrowSite[]; unreadable: string[] } {
  const sites: ThrowSite[] = [];
  const unreadable: string[] = [];
  for (const path of sourceFiles(SRC)) {
    const file = relative(SRC, path);
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(
      /new\s+(?:Validation|Conflict)Error\(\s*("[a-z][a-z0-9_]*")?/g,
    )) {
      const line = lineOf(text, match.index);
      if (match[1] !== undefined) sites.push({ code: match[1].slice(1, -1), file, line });
      else unreadable.push(`${file}:${line}`);
    }
    for (const klass of text.matchAll(
      /class\s+\w+\s+extends\s+(?:Validation|Conflict)Error\s*\{([\s\S]*?)\n\}/g,
    )) {
      const line = lineOf(text, klass.index);
      const code = /super\(\s*"([a-z][a-z0-9_]*)"/.exec(klass[1] ?? "")?.[1];
      if (code === undefined) unreadable.push(`${file}:${line} (a class)`);
      else sites.push({ code, file, line });
    }
  }
  return { sites, unreadable };
}

describe("the codes a form can be refused with", () => {
  const { sites, unreadable } = scanThrows();
  const thrown = new Set(sites.map((site) => site.code));
  const phrases = new Set(Object.keys(REFUSAL_PHRASES));
  const lists = { NOT_REACHED, ON_THE_SHELL_PAGE };

  it("reads every throw: the code of each is a literal the scan can see", () => {
    expect(unreadable, `throws the scan cannot read: ${unreadable.join(", ")}`).toEqual([]);
  });

  it("finds the codes of every part of the source that throws them", () => {
    expect(thrown.size).toBeGreaterThan(150);
    const folders = new Set(sites.map((site) => site.file.split("/")[0]));
    // The store, the services, the pages' routes and the training matter all throw codes of their own.
    for (const folder of ["store", "services", "server", "training"])
      expect(folders).toContain(folder);
    // A code a class carries and not a call (the store's subclasses) is found too.
    for (const code of [
      "active_run",
      "stale_run",
      "stale_finding",
      "content_mismatch",
      "inputs_incomplete",
      "invalid_transition",
      "export_blocked",
      "audit_detail",
    ])
      expect(thrown.has(code), code).toBe(true);
    // And the codes of the feedback, retention and training fragments, which other packages wrote.
    for (const code of ["reason_code_required", "retention_days", "reviewer_required"])
      expect(thrown.has(code), code).toBe(true);
  });

  it("places every code: a phrase, a reason why no person reaches it, or the shell's page", () => {
    const unplaced = [...thrown]
      .filter(
        (code) =>
          !phrases.has(code) &&
          !Object.hasOwn(NOT_REACHED, code) &&
          !Object.hasOwn(ON_THE_SHELL_PAGE, code),
      )
      .sort()
      .map((code) => {
        const where = sites.find((site) => site.code === code)!;
        return `${code} (${where.file}:${where.line})`;
      });
    // A code a person can reach from a form needs a phrase, with a todo, in the fragment of the
    // package that throws it (routes/notices.ts and the refusals-*.ts files). A code no person
    // reaches goes in NOT_REACHED with the reason.
    expect(unplaced, `codes thrown with no phrase and no reason: ${unplaced.join(", ")}`).toEqual(
      [],
    );
  });

  it("keeps no stale entry: every listed code is thrown, and none that has a phrase stays listed", () => {
    for (const [name, list] of Object.entries(lists)) {
      const stale = Object.keys(list).filter((code) => !thrown.has(code));
      expect(stale, `${name} lists codes the source no longer throws: ${stale.join(", ")}`).toEqual(
        [],
      );
      const phrased = Object.keys(list).filter((code) => phrases.has(code));
      expect(
        phrased,
        `${name} lists codes that now have a phrase and leave it: ${phrased.join(", ")}`,
      ).toEqual([]);
    }
    const both = Object.keys(NOT_REACHED).filter((code) => Object.hasOwn(ON_THE_SHELL_PAGE, code));
    expect(both).toEqual([]);
    // Every phrase is for a code the source can throw.
    const orphans = [...phrases].filter((code) => !thrown.has(code));
    expect(orphans, `phrases for codes nothing throws: ${orphans.join(", ")}`).toEqual([]);
  });

  it("gives every listed code a reason of one line, in plain words", () => {
    for (const [name, list] of Object.entries(lists)) {
      for (const [code, reason] of Object.entries(list)) {
        const where = `${name}.${code}`;
        expect(reason.trim(), where).not.toBe("");
        expect(reason, where).not.toMatch(/[\n\r]/);
        expect(reason.length, where).toBeLessThanOrEqual(200);
        expect(reason, where).not.toMatch(NO_DASH);
      }
    }
  });

  it("gives every phrase a todo that occurs in it, apart from the older ones the list names", () => {
    const without = [...phrases].filter((code) => !Object.hasOwn(REFUSAL_TODO, code)).sort();
    expect(
      without,
      "phrases with no todo that are not on PHRASES_WITHOUT_A_TODO: " +
        without.filter((code) => !(PHRASES_WITHOUT_A_TODO as readonly string[]).includes(code)),
    ).toEqual([...PHRASES_WITHOUT_A_TODO].sort());
    for (const [code, todo] of Object.entries(REFUSAL_TODO)) {
      expect(phrases.has(code), `a todo for ${code} with no phrase`).toBe(true);
      expect(
        REFUSAL_PHRASES[code]!.includes(todo),
        `the todo of ${code} is not in its phrase`,
      ).toBe(true);
    }
    for (const [code, jump] of Object.entries(REFUSAL_JUMP)) {
      expect(phrases.has(code), `a jump for ${code} with no phrase`).toBe(true);
      expect(jump.href.startsWith("#"), code).toBe(true);
      // A jump is for a refusal that tells the person what to do; one without a todo has no jump.
      expect(Object.hasOwn(REFUSAL_TODO, code), `${code} has a jump and no todo`).toBe(true);
    }
  });

  it("holds no dash in a sentence of the table that the pages print", () => {
    for (const [code, text] of Object.entries(REFUSAL_PHRASES)) {
      expect(text, code).not.toMatch(NO_DASH);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The reasons printed inside a page when a decision is refused
// ---------------------------------------------------------------------------------------------

describe("the reasons a decision cannot be recorded", () => {
  it("tell the reader what to do where the reader can do something", () => {
    expect(CANNOT_DECIDE.segregation).toBe(
      "A reviewer cannot decide findings of a review they started. Ask another reviewing attorney to decide them.",
    );
    expect(CANNOT_DECIDE.notOpen).toBe(
      "The matter is not open for review. Open the matter to see its state.",
    );
    expect(CANNOT_DECIDE.runNotCurrent).toBe(
      "This finding belongs to a review that is no longer current. Open the current review from the matter page.",
    );
  });

  it("hold no dash, and each is a fixed sentence that ends in a full stop", () => {
    for (const [name, text] of Object.entries(CANNOT_DECIDE)) {
      expect(text, name).not.toMatch(NO_DASH);
      expect(text, name).toMatch(/\.$/);
    }
  });
});
