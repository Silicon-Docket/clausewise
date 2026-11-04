import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { urls } from "../../src/server/urls.js";
import type { FindingView } from "../../src/services/views.js";
import {
  IDS,
  OTHER_ASSOCIATE,
  cleanup,
  fingerprint,
  makeSite,
  multipart,
  prepareMatter,
  type Browser,
  type Prepared,
  type Site,
} from "./support.js";

/**
 * An id in the URL or the body is a claim, not a fact. A matter's routes look it up in that matter
 * only, so an id that belongs to another matter behaves exactly like one that does not exist: 404,
 * and the other matter is not touched. The person making the requests is a member of both matters,
 * so nothing but the id stands between the request and the other matter's data.
 *
 * Also here: a decision made on content that has changed (409), and the fields a request may not
 * set (mass assignment).
 */

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let site: Site;
/** The matter the requests go to, finished and exported. */
let own: Prepared;
/** The matter whose ids are borrowed, finished and exported. */
let other: Prepared;
/** A matter still open for review: the one the decisions are made on. */
let open: Prepared;
/** A matter for the mass-assignment requests. */
let mass: Prepared;
let associate: Browser;
let reviewer: Browser;

const NEW_TEXT = new TextEncoder().encode(
  "AMENDMENT NO. 2 TO MUTUAL NONDISCLOSURE AGREEMENT\n\n1. A paragraph of synthetic text that is long enough to be reviewed.\n",
);
const MISSING = {
  document: "doc_0000000000000000",
  version: "ver_0000000000000000",
  run: "run_0000000000000000",
  finding: "fnd_0000000000000000",
  memo: "memo_0000000000000000",
  evidence: "evd_0000000000000000",
};

beforeAll(async () => {
  site = makeSite();
  own = await prepareMatter(site, { name: "Own matter" });
  other = await prepareMatter(site, { name: "Another matter" });
  open = await prepareMatter(site, { name: "A matter still in review", exported: false });
  mass = await prepareMatter(site, { name: "A matter for mass assignment", exported: false });
  associate = await site.as(IDS.associate);
  reviewer = await site.as(IDS.reviewer);
});

const hashOf = (p: Prepared): string =>
  site.w.services.runs.finding(site.w.grant(site.w.reviewer, p.matterId), p.findingId)
    .contentSha256;

/** Everything the services would show of a matter, to compare before and after. */
function stateOf(matterId: string): string {
  const am = site.w.grant(site.w.associate, matterId);
  return JSON.stringify({
    view: site.w.services.matters.view(am),
    issues: site.w.services.runs.issues(am),
    rows: fingerprint(site, matterId),
  });
}

// ---------------------------------------------------------------------------------------------
// Another matter's ids
// ---------------------------------------------------------------------------------------------

/** What a forged request borrows: the ids of another matter, or ids that exist nowhere. */
interface Borrowed {
  document: string;
  version: string;
  run: string;
  finding: string;
  memo: string;
  evidence: string;
}

interface Forge {
  name: string;
  position: keyof Borrowed;
  as: () => Browser;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** The path of our matter, with the borrowed id in the one place under test. */
  path: (b: Borrowed) => string;
  body?: (b: Borrowed) => { form?: Record<string, string>; json?: unknown; upload?: boolean };
}

const m = (p: Prepared): string => `/matters/${p.matterId}`;
const a = (p: Prepared): string => `/api/matters/${p.matterId}`;

const FORGES: Forge[] = [
  // --- document -------------------------------------------------------------------------------
  {
    name: "a new version of another matter's document (page)",
    position: "document",
    as: () => associate,
    method: "POST",
    path: (b) => `${m(own)}/documents/${b.document}/versions`,
    body: () => ({ upload: true, form: { statedDate: "2026-09-16" } }),
  },
  {
    name: "a new version of another matter's document (JSON)",
    position: "document",
    as: () => associate,
    method: "POST",
    path: (b) => `${a(own)}/documents/${b.document}/versions`,
    body: () => ({ upload: true }),
  },
  {
    name: "another matter's document made operative (page)",
    position: "document",
    as: () => associate,
    method: "POST",
    path: (b) => `${m(own)}/documents/${b.document}/operative`,
    body: () => ({ form: { versionId: own.versionId } }),
  },
  {
    name: "another matter's document removed (page)",
    position: "document",
    as: () => associate,
    method: "POST",
    path: (b) => `${m(own)}/documents/${b.document}/remove`,
    body: () => ({ form: { confirm: "yes" } }),
  },
  {
    name: "another matter's document removed (JSON)",
    position: "document",
    as: () => associate,
    method: "DELETE",
    path: (b) => `${a(own)}/documents/${b.document}`,
  },
  // --- version --------------------------------------------------------------------------------
  {
    name: "another matter's version made operative (page)",
    position: "version",
    as: () => associate,
    method: "POST",
    path: () => `${m(own)}/documents/${own.lastDocumentId}/operative`,
    body: (b) => ({ form: { versionId: b.version } }),
  },
  {
    name: "another matter's version made operative (JSON)",
    position: "version",
    as: () => associate,
    method: "PATCH",
    path: () => a(own),
    body: (b) => ({
      json: { operative: { documentId: own.lastDocumentId, versionId: b.version } },
    }),
  },
  {
    name: "a stated date on another matter's version (page)",
    position: "version",
    as: () => associate,
    method: "POST",
    path: (b) => `${m(own)}/versions/${b.version}/stated-date`,
    body: () => ({ form: { statedDate: "2026-01-01" } }),
  },
  {
    name: "a stated date on another matter's version (JSON)",
    position: "version",
    as: () => associate,
    method: "PATCH",
    path: () => a(own),
    body: (b) => ({ json: { statedDate: { versionId: b.version, statedDate: "2026-01-01" } } }),
  },
  // --- run ------------------------------------------------------------------------------------
  {
    name: "another matter's run (page)",
    position: "run",
    as: () => associate,
    method: "GET",
    path: (b) => `${m(own)}/runs/${b.run}`,
  },
  {
    name: "another matter's run status",
    position: "run",
    as: () => associate,
    method: "GET",
    path: (b) => `${m(own)}/runs/${b.run}/status`,
  },
  {
    name: "another matter's run (JSON)",
    position: "run",
    as: () => associate,
    method: "GET",
    path: (b) => `${a(own)}/runs/${b.run}`,
  },
  {
    name: "another matter's issue table (JSON)",
    position: "run",
    as: () => associate,
    method: "GET",
    path: (b) => `${a(own)}/runs/${b.run}/findings`,
  },
  {
    name: "another matter's run resumed (page)",
    position: "run",
    as: () => associate,
    method: "POST",
    path: (b) => `${m(own)}/runs/${b.run}/resume`,
    body: () => ({ form: {} }),
  },
  {
    name: "another matter's run resumed (JSON)",
    position: "run",
    as: () => associate,
    method: "POST",
    path: (b) => `${a(own)}/runs/${b.run}/resume`,
  },
  {
    name: "another matter's run cancelled (page)",
    position: "run",
    as: () => associate,
    method: "POST",
    path: (b) => `${m(own)}/runs/${b.run}/cancel`,
    body: () => ({ form: {} }),
  },
  {
    name: "another matter's run cancelled (JSON)",
    position: "run",
    as: () => associate,
    method: "POST",
    path: (b) => `${a(own)}/runs/${b.run}/cancel`,
  },
  // --- finding --------------------------------------------------------------------------------
  {
    name: "another matter's finding (page)",
    position: "finding",
    as: () => associate,
    method: "GET",
    path: (b) => `${m(own)}/findings/${b.finding}`,
  },
  {
    name: "another matter's finding (JSON)",
    position: "finding",
    as: () => associate,
    method: "GET",
    path: (b) => `${a(own)}/findings/${b.finding}`,
  },
  {
    name: "a decision on another matter's finding (page)",
    position: "finding",
    as: () => reviewer,
    method: "POST",
    path: (b) => `${m(own)}/findings/${b.finding}/reviews`,
    body: () => ({ form: { decision: "accept", findingContentSha256: hashOf(other) } }),
  },
  {
    name: "a decision on another matter's finding (JSON)",
    position: "finding",
    as: () => reviewer,
    method: "POST",
    path: (b) => `${a(own)}/findings/${b.finding}/reviews`,
    body: () => ({ json: { decision: "accept", findingContentSha256: hashOf(other) } }),
  },
  // --- memo -----------------------------------------------------------------------------------
  {
    name: "another matter's memo (page)",
    position: "memo",
    as: () => associate,
    method: "GET",
    path: (b) => `${m(own)}/memos/${b.memo}/file`,
  },
  {
    name: "another matter's memo (JSON)",
    position: "memo",
    as: () => associate,
    method: "GET",
    path: (b) => `${a(own)}/memos/${b.memo}/file`,
  },
  // --- evidence. The matter is the one still open for review, so a decision gets as far as its edits.
  {
    name: "another matter's evidence relabelled (page)",
    position: "evidence",
    as: () => reviewer,
    method: "POST",
    path: () => `${m(open)}/findings/${open.findingId}/reviews`,
    body: (b) => ({
      form: {
        decision: "edit",
        reason: "Relabelled.",
        findingContentSha256: hashOf(open),
        [`evidenceRole:${b.evidence}`]: "superseded",
      },
    }),
  },
  {
    name: "another matter's evidence relabelled (JSON)",
    position: "evidence",
    as: () => reviewer,
    method: "POST",
    path: () => `${a(open)}/findings/${open.findingId}/reviews`,
    body: (b) => ({
      json: {
        decision: "edit",
        reason: "Relabelled.",
        findingContentSha256: hashOf(open),
        edits: { evidenceRoles: [{ evidenceId: b.evidence, role: "superseded" }] },
      },
    }),
  },
];

async function send(f: Forge, borrowed: Borrowed): Promise<Response> {
  const self = f.as();
  const path = f.path(borrowed);
  const body = f.body?.(borrowed);
  const api = path.startsWith("/api/");
  const token = f.method === "GET" ? null : await self.apiToken();
  const headers: Record<string, string> = {};
  if (api && token !== null) headers["x-csrf-token"] = token;
  if (body === undefined) return self.send(f.method, path, { headers });
  if (body.json !== undefined) {
    headers["content-type"] = "application/json";
    return self.send(f.method, path, { headers, body: JSON.stringify(body.json) });
  }
  const fields: [string, string][] = Object.entries(body.form ?? {});
  if (!api && token !== null) fields.push(["_csrf", token]);
  if (body.upload === true)
    return self.send(f.method, path, {
      headers,
      body: multipart(fields, { name: "amendment-2.txt", bytes: NEW_TEXT }),
    });
  headers["content-type"] = "application/x-www-form-urlencoded";
  return self.send(f.method, path, { headers, body: new URLSearchParams(fields).toString() });
}

describe("an id from another matter, in every place an id can go", () => {
  const borrowed = (): Borrowed => ({
    document: other.firstDocumentId,
    version: other.versionId,
    run: other.runId,
    finding: other.findingId,
    memo: other.memoId!,
    evidence: site.w.services.runs.finding(
      site.w.grant(site.w.reviewer, other.matterId),
      other.findingId,
    ).evidence[0]!.evidenceId,
  });

  for (const f of FORGES) {
    it(`answers 404 for ${f.name}, and no matter is touched`, async () => {
      const states = [own, other, open].map((p) => stateOf(p.matterId));
      const before = fingerprint(site);
      const response = await send(f, borrowed());
      expect(response.status).toBe(404);
      // The answer is the one for an id that exists nowhere.
      const nothing = await send(f, MISSING);
      expect(nothing.status).toBe(404);
      expect(await response.text()).toBe(await nothing.text());
      expect([own, other, open].map((p) => stateOf(p.matterId))).toEqual(states);
      expect(fingerprint(site)).toEqual(before);
    });
  }

  it("covers every kind of id the routes take", () => {
    expect(new Set(FORGES.map((f) => f.position))).toEqual(
      new Set(["document", "version", "run", "finding", "memo", "evidence"]),
    );
  });

  it("answers an id of the matter's own, where the same request would be let through", async () => {
    // The control for the forged requests above: the same shapes with our own ids are not 404.
    const own_: Borrowed = {
      document: own.firstDocumentId,
      version: own.versionId,
      run: own.runId,
      finding: own.findingId,
      memo: own.memoId!,
      evidence: site.w.services.runs.finding(
        site.w.grant(site.w.reviewer, own.matterId),
        own.findingId,
      ).evidence[0]!.evidenceId,
    };
    const reads = FORGES.filter((f) => f.method === "GET");
    expect(reads.length).toBeGreaterThanOrEqual(8);
    for (const f of reads) expect((await send(f, own_)).status, f.name).toBe(200);
  });

  it("does not select another matter's finding on the run page: the page shows no inspector", async () => {
    const page = await associate.get(
      `${urls.run(own.matterId, own.runId)}?finding=${other.findingId}`,
    );
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("That finding is not part of this review");
    expect(html).not.toContain(other.findingId);
    expect(html).not.toContain("finding-pane");
  });
});

// ---------------------------------------------------------------------------------------------
// Decisions on content that moved
// ---------------------------------------------------------------------------------------------

describe("a decision on content that is not the content decided on", () => {
  const BAD_HASH = "0".repeat(64);
  const apiPath = (): string => `/api/matters/${open.matterId}/findings/${open.findingId}/reviews`;

  async function page(hash: string): Promise<Response> {
    return reviewer.send("POST", urls.review(open.matterId, open.findingId), {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: await reviewer.apiToken(),
        decision: "accept",
        findingContentSha256: hash,
      }).toString(),
    });
  }

  it("answers 409 for a hash that is not the finding's, on the page and in JSON", async () => {
    const before = fingerprint(site);
    expect((await page(BAD_HASH)).status).toBe(409);
    const api = await reviewer.api("POST", apiPath(), {
      decision: "accept",
      findingContentSha256: BAD_HASH,
    });
    expect(api.status).toBe(409);
    expect(((await api.json()) as { error: { kind: string; code: string } }).error).toMatchObject({
      kind: "conflict",
      code: "content_mismatch",
    });
    expect(fingerprint(site)).toEqual(before);
  });

  it("takes the same decision with the hash the reviewer saw", async () => {
    const response = await reviewer.api("POST", apiPath(), {
      decision: "accept",
      findingContentSha256: hashOf(open),
    });
    expect(response.status).toBe(201);
    const view = (await response.json()) as FindingView;
    expect(view.reviews[0]).toMatchObject({ decision: "accept", validity: "current" });
  });

  it("answers 409 for a finding that the documents have left behind", async () => {
    const hash = hashOf(open);
    // An input changes: the client's name. Every finding of the run is now out of date.
    const changed = await associate.api("PATCH", `/api/matters/${open.matterId}`, {
      clientLegalName: "Lanternfish Software, Incorporated",
    });
    expect(changed.status).toBe(200);
    const before = fingerprint(site);
    const api = await reviewer.api("POST", apiPath(), {
      decision: "accept",
      findingContentSha256: hash,
    });
    expect(api.status).toBe(409);
    expect(((await api.json()) as { error: { code: string } }).error.code).toBe("stale_finding");
    expect((await page(hash)).status).toBe(409);
    expect(fingerprint(site)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------------------------
// Fields a request may not set
// ---------------------------------------------------------------------------------------------

describe("fields a request may not set (mass assignment)", () => {
  /** Keys that name something the operation does not offer; each is a column or a state of its own. */
  const EXTRAS: Record<string, unknown> = {
    createdBy: IDS.admin,
    status: "exported",
    synthetic: false,
    retainUntil: "2099-01-01",
    id: "mat_0000000000000000",
    matterId: "mat_ffffffffffffffff",
    role: "associate",
    grantedBy: IDS.admin,
    validity: "current",
    reviewerId: IDS.admin,
    startedBy: IDS.admin,
    modelProvider: "somewhere-else",
    deletedAt: "2026-01-01T00:00:00Z",
  };

  /** A JSON request that must be refused with 400 and change nothing. */
  async function refuse(
    browser: Browser,
    method: string,
    path: string,
    body: unknown,
  ): Promise<void> {
    const before = fingerprint(site);
    const response = await browser.api(method, path, body);
    expect(response.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(400);
    expect(((await response.json()) as { error: { kind: string } }).error.kind).toBe(
      "invalid_request",
    );
    expect(fingerprint(site)).toEqual(before);
  }

  const apiPath = (suffix: string): string => `/api/matters/${mass.matterId}${suffix}`;

  /** Each operation with a body that is good, in the order its control may be run. */
  const operations: {
    name: string;
    method: string;
    path: () => string;
    body: () => Record<string, unknown>;
    as: () => Browser;
    accepted: number;
  }[] = [
    {
      name: "a new matter",
      method: "POST",
      path: () => "/api/matters",
      body: () => ({ name: "Mass", clientLegalName: "Mass, Inc." }),
      as: () => associate,
      accepted: 201,
    },
    {
      name: "a change of settings",
      method: "PATCH",
      path: () => apiPath(""),
      body: () => ({ clientLegalName: "Lanternfish Software, Inc." }),
      as: () => associate,
      accepted: 200,
    },
    {
      name: "a change of operative version",
      method: "PATCH",
      path: () => apiPath(""),
      body: () => ({ operative: { documentId: mass.lastDocumentId, versionId: mass.versionId } }),
      as: () => associate,
      accepted: 200,
    },
    {
      name: "a new member",
      method: "POST",
      path: () => apiPath("/members"),
      body: () => ({ userId: OTHER_ASSOCIATE, role: "viewer" }),
      as: () => associate,
      accepted: 201,
    },
    {
      name: "a decision",
      method: "POST",
      path: () => apiPath(`/findings/${mass.findingId}/reviews`),
      body: () => ({ decision: "accept", findingContentSha256: hashOf(mass) }),
      as: () => reviewer,
      accepted: 201,
    },
    {
      name: "a run",
      method: "POST",
      path: () => apiPath("/runs"),
      body: () => ({ workflow: "v2" }),
      as: () => associate,
      accepted: 202,
    },
  ];

  for (const op of operations) {
    it(`refuses every extra key on ${op.name}, and takes the body without it`, async () => {
      // A key the body already has is a change of value and not an extra key.
      const extras = Object.entries(EXTRAS).filter(([key]) => !(key in op.body()));
      expect(extras.length).toBeGreaterThan(10);
      for (const [key, value] of extras)
        await refuse(op.as(), op.method, op.path(), { ...op.body(), [key]: value });

      // The prototype key, which JSON.parse makes an own property of the parsed body.
      const before = fingerprint(site);
      const raw = JSON.stringify(op.body()).replace(/^\{/, '{"__proto__":{"admin":true},');
      const proto = await op.as().send(op.method, op.path(), {
        headers: { "content-type": "application/json", "x-csrf-token": await op.as().apiToken() },
        body: raw,
      });
      expect(proto.status).toBe(400);
      expect(fingerprint(site)).toEqual(before);

      // The control: the body itself is good, so the refusals were about the key.
      const accepted = await op.as().api(op.method, op.path(), op.body());
      expect(accepted.status).toBe(op.accepted);
      if (op.name === "a run") await site.w.services.runs.idle();
    });
  }

  it("refuses an extra key inside the nested objects too", async () => {
    await refuse(associate, "PATCH", apiPath(""), {
      operative: { documentId: mass.lastDocumentId, versionId: mass.versionId, operative: false },
    });
    // The matter has a new run now, so these decisions are refused for their bodies and not their state.
    const path = apiPath(`/findings/${mass.findingId}/reviews`);
    const hash = "1".repeat(64);
    await refuse(reviewer, "POST", path, {
      decision: "edit",
      reason: "x",
      findingContentSha256: hash,
      edits: { status: "compliant", findingId: other.findingId },
    });
    await refuse(reviewer, "POST", path, {
      decision: "edit",
      reason: "x",
      findingContentSha256: hash,
      edits: { evidenceRoles: [{ evidenceId: "x", role: "governing", quote: "new words" }] },
    });
  });

  it("refuses more than one kind of change in one PATCH, so a failure cannot leave half of it done", async () => {
    await refuse(associate, "PATCH", apiPath(""), {
      clientLegalName: "Another Name, Inc.",
      operative: { documentId: mass.lastDocumentId, versionId: mass.versionId },
    });
  });

  it("refuses extra fields on a JSON-API upload, and takes the upload without them", async () => {
    const path = `/api/matters/${mass.matterId}/documents/${mass.lastDocumentId}/versions`;
    for (const field of [
      "operative",
      "label",
      "storagePath",
      "matterId",
      "versionNo",
      "byteSize",
    ]) {
      const before = fingerprint(site);
      const response = await associate.apiUpload(
        path,
        { statedDate: "2026-09-16", [field]: "x" },
        { name: "amendment-2.txt", bytes: NEW_TEXT },
      );
      expect(response.status, field).toBe(400);
      expect(fingerprint(site)).toEqual(before);
    }
    const good = await associate.apiUpload(
      path,
      { statedDate: "2026-09-16" },
      { name: "amendment-2.txt", bytes: NEW_TEXT },
    );
    expect(good.status).toBe(201);
  });

  it("ignores extra fields on the page forms, which have no way to set them", async () => {
    const token = await associate.apiToken();
    const hostile = await associate.send("POST", "/matters", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: token,
        name: "Hostile form",
        clientLegalName: "Hostile, Inc.",
        createdBy: IDS.admin,
        status: "exported",
        synthetic: "false",
        retainUntil: "2099-01-01",
      }).toString(),
    });
    expect(hostile.status).toBe(303);
    const row = site.w.repo
      .listMattersForUser(IDS.associate)
      .find((x) => x.name === "Hostile form")!;
    expect(row).toMatchObject({ createdBy: IDS.associate, status: "draft", synthetic: true });
    expect(row.retainUntil < "2099").toBe(true);
  });

  it("makes a decision the signed-in reviewer's, whatever reviewer the form names", async () => {
    // A new matter in review, made apart so that nothing above has moved it.
    const fresh = await prepareMatter(site, { name: "A decision matter", exported: false });
    const response = await reviewer.send("POST", urls.review(fresh.matterId, fresh.findingId), {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: await reviewer.apiToken(),
        decision: "reject",
        reason: "The wording is not acceptable.",
        findingContentSha256: hashOf(fresh),
        reviewerId: IDS.admin,
        validity: "stale",
        matterId: other.matterId,
      }).toString(),
    });
    expect(response.status).toBe(303);
    const view = site.w.services.runs.finding(
      site.w.grant(site.w.reviewer, fresh.matterId),
      fresh.findingId,
    );
    expect(view.reviews).toHaveLength(1);
    expect(view.reviews[0]).toMatchObject({
      decision: "reject",
      reviewerName: "Dana Whitfield (reviewing attorney)",
      validity: "current",
    });
  });
});
