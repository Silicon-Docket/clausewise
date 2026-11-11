import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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
import { REFUSAL_PHRASES } from "../../src/server/routes/notices.js";
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
 * Every `ValidationError` and `ConflictError` that the source throws with a literal code, and what
 * becomes of it. A code a person can reach from a page has a sentence in `REFUSAL_PHRASES` (with
 * the part that says what to do, which the owner of the table adds). A code a person cannot reach
 * is listed below with the reason. A new code that is in neither place fails this test, so the
 * package that adds it must give it a sentence.
 *
 * `CODES_WITHOUT_A_PHRASE` is the list of findings: codes a person can reach from a page whose
 * refusal falls to the general sentence of its status today. It is written to shrink: a code that
 * gains a phrase must leave the list, and this test says so.
 */
const NOT_A_PAGE_CODE: Record<string, readonly string[]> = {
  "the shape of a JSON or wire request, which the forms of the pages do not send": [
    "bad_body",
    "bad_content_type",
    "bad_intent",
    "bad_target",
    "unknown_field",
  ],
  "the audit writer, whose failures are defects in our code and never a request": [
    "audit_action",
    "audit_actor_id",
    "audit_matter_id",
    "audit_target_id",
    "audit_target_type",
    "matter_required",
  ],
  "a check of the store on a value a service has already made or checked": [
    "bad_bytes",
    "bad_code",
    "bad_kind",
    "bad_media_type",
    "bad_number",
    "bad_reason",
    "bad_span_hash",
    "bad_span_id",
    "bad_spend",
    "bad_storage_path",
    "bad_warning_code",
    "bad_warning_detail",
    "compact_busy",
    "duplicate_file",
    "in_transaction",
    "invalid_input",
    "no_current_run",
    "no_memo",
    "not_fully_decided",
    "nul_character",
    "operative_conflict",
    "playbook_not_approved",
    "spans_differ",
    "storage_path_in_use",
    "text_required",
    "use_apply_input_change",
    "use_delete_matter",
  ],
  "the registration of a playbook, a prompt or a workflow, which no page does": [
    "already_approved",
    "already_promoted",
    "bad_prompt",
    "bad_prompt_id",
    "bad_slug",
    "bad_version",
    "bad_yaml",
    "duplicate_rule",
    "no_rules",
    "playbook_hash_mismatch",
    "playbook_version_exists",
    "prompt_hash_taken",
    "prompt_id_taken",
    "unknown_prompt",
    "workflow_hash_mismatch",
    "workflow_label_taken",
  ],
  "the evaluation runner, which writes its own slots and scores": [
    "bad_scores",
    "bad_split",
    "not_synthetic",
    "slot_exists",
  ],
  "a stage or the runner writing while a review runs, which a form cannot send": [
    "bad_offsets",
    "bad_purpose",
    "bad_reported_model",
    "bad_stage",
    "bad_unit",
    "content_hash_mismatch",
    "duplicate_check",
    "evidence_outside_manifest",
    "field_not_allowed",
    "finding_exists",
    "finding_not_allowed",
    "finding_required",
    "manifest_hash_mismatch",
    "manifest_matter",
    "manifest_mismatch",
    "matter_not_runnable",
    "model_status_mismatch",
    "model_status_not_settled",
    "model_status_same",
    "model_status_unexplained",
    "quote_mismatch",
    "reviews_changed",
    "rule_mismatch",
    "run_mismatch",
    "run_not_active",
    "run_not_writing",
    "run_required",
    "stage_closed",
    "status_must_be_undetermined",
    "undetermined_needs_escalation",
    "unverified_quote_not_escalated",
    "verification_state_mismatch",
    "workflow_retired",
  ],
};

const CODES_WITHOUT_A_PHRASE: Record<string, string> = {
  member_exists: "the add-a-member form",
  remove_later_first: "the remove-a-document form",
  no_active_run: "the cancel-a-review form",
  matter_running: "the delete-a-matter form",
  memo_file_changed: "the memo download and the export",
  memo_file_missing: "the memo download and the export",
  memo_quote_unverified: "the memo export",
};

/** Codes whose phrases are for errors that carry their code in a class and not in a literal. */
const THROWN_BY_CLASS = ["content_mismatch", "stale_finding"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The literal code of every `new ValidationError("code"` and `new ConflictError("code"`, line breaks allowed. */
function thrownCodes(): Set<string> {
  const found = new Set<string>();
  for (const path of sourceFiles(join(import.meta.dirname, "../../src"))) {
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(
      /new\s+(?:Validation|Conflict)Error\(\s*"([a-z][a-z0-9_]*)"/g,
    ))
      found.add(match[1]!);
  }
  return found;
}

describe("the codes a form can be refused with", () => {
  const thrown = thrownCodes();
  const unreachable = new Map(
    Object.entries(NOT_A_PAGE_CODE).flatMap(([why, codes]) =>
      codes.map((code) => [code, why] as const),
    ),
  );
  const phrases = new Set(Object.keys(REFUSAL_PHRASES));

  it("finds the codes the source throws", () => {
    expect(thrown.size).toBeGreaterThan(120);
    expect(thrown.has("reason_required")).toBe(true);
    expect(thrown.has("member_exists")).toBe(true);
  });

  it("gives every code a sentence, or a reason why no page shows it, or a place in the list of findings", () => {
    const unplaced = [...thrown]
      .filter(
        (code) =>
          !phrases.has(code) &&
          !unreachable.has(code) &&
          !Object.hasOwn(CODES_WITHOUT_A_PHRASE, code),
      )
      .sort();
    // A code a person can reach from a page needs a phrase in the table of the package that throws
    // it (routes/notices.ts and the refusals-*.ts fragments), with a todo. A code no page reaches
    // goes in NOT_A_PAGE_CODE with the reason.
    expect(unplaced, `codes thrown with no phrase and no reason: ${unplaced.join(", ")}`).toEqual(
      [],
    );
  });

  it("keeps no stale entry: every listed code is thrown, and none that has a phrase stays listed", () => {
    const stale = [...unreachable.keys(), ...Object.keys(CODES_WITHOUT_A_PHRASE)].filter(
      (code) => !thrown.has(code),
    );
    expect(stale, `listed codes the source no longer throws: ${stale.join(", ")}`).toEqual([]);
    const phrased = [...unreachable.keys(), ...Object.keys(CODES_WITHOUT_A_PHRASE)].filter((code) =>
      phrases.has(code),
    );
    expect(
      phrased,
      `codes that now have a phrase and leave the lists: ${phrased.join(", ")}`,
    ).toEqual([]);
    const both = Object.keys(CODES_WITHOUT_A_PHRASE).filter((code) => unreachable.has(code));
    expect(both).toEqual([]);
    // Every phrase is for a code the source can throw.
    const orphans = [...phrases].filter(
      (code) => !thrown.has(code) && !THROWN_BY_CLASS.includes(code),
    );
    expect(orphans, `phrases for codes nothing throws: ${orphans.join(", ")}`).toEqual([]);
  });

  it("lists each code once", () => {
    const all = Object.values(NOT_A_PAGE_CODE).flat();
    expect(new Set(all).size).toBe(all.length);
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
