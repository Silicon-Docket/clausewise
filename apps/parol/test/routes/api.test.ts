import { ModelRequestError } from "@clausewise/llm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { urls } from "../../src/server/urls.js";
import type {
  FindingView,
  IssueRow,
  MatterSummary,
  MatterView,
  MemoSummary,
  PlaybookOption,
  RunSummary,
} from "../../src/services/views.js";
import { all, attr, byId, readable } from "../pages/html.js";
import {
  IDS,
  OTHER_ASSOCIATE,
  OUTSIDER,
  baseWorld,
  cleanup,
  gate,
  makeSite,
  newMatter,
  prepareMatter,
  uploadCase,
  type Browser,
  type Prepared,
  type Site,
} from "./support.js";

/**
 * The JSON API of docs/parol/03, operation by operation: what it takes, what it answers, and that
 * it does what the pages do through the same services. Refusals are the shell's, so each carries a
 * kind and a fixed message and never the request.
 */

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const NDA = baseWorld.files.find((f) => f.label === "D1")!;
const AMENDMENT = baseWorld.files.find((f) => f.label === "D2")!;

let site: Site;
let associate: Browser;
let reviewer: Browser;

beforeAll(async () => {
  site = makeSite();
  associate = await site.as(IDS.associate);
  reviewer = await site.as(IDS.reviewer);
});

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

describe("the session and the lists", () => {
  it("tells a script who it is and the token its writes carry", async () => {
    const anonymous = site.anonymous();
    const before = await json<{ user: unknown; csrfToken: string }>(
      await anonymous.get("/api/session"),
    );
    expect(before.user).toBeNull();
    expect(before.csrfToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const session = await json<{ user: Record<string, string>; csrfToken: string }>(
      await associate.get("/api/session"),
    );
    expect(session.user).toEqual({
      userId: IDS.associate,
      displayName: "Alex Ruiz (associate)",
      globalRole: "member",
    });
    // The token is for this session: the same on each ask, different for another person.
    expect((await json<{ csrfToken: string }>(await associate.get("/api/session"))).csrfToken).toBe(
      session.csrfToken,
    );
    expect(
      (await json<{ csrfToken: string }>(await reviewer.get("/api/session"))).csrfToken,
    ).not.toBe(session.csrfToken);
  });

  it("signs a script in and out with JSON, using the token from the session route", async () => {
    const script = site.anonymous();
    const { csrfToken } = await json<{ csrfToken: string }>(await script.get("/api/session"));
    const response = await script.send("POST", "/session", {
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
      // A person no other test signs in as: the clock of the tests stands still, so a session
      // issued to the same person in the same second would be the same cookie, and signing one
      // out would sign out the other.
      body: JSON.stringify({ intent: "sign-in", userId: IDS.legalEngineer }),
    });
    expect(response.status).toBe(200);
    expect(
      (await json<{ user: { userId: string } }>(await script.get("/api/session"))).user.userId,
    ).toBe(IDS.legalEngineer);
    const out = await script.api("POST", "/session/end", {});
    expect(out.status).toBe(200);
    expect((await json<{ user: unknown }>(await script.get("/api/session"))).user).toBeNull();
  });

  it("lists the approved playbook versions to any person, and nothing to a visitor", async () => {
    const list = await json<{ playbooks: PlaybookOption[] }>(await associate.get("/api/playbooks"));
    expect(list.playbooks).toEqual([
      expect.objectContaining({
        versionId: site.w.playbookVersionId,
        slug: "parol-nda-recipient",
        ruleCount: 8,
      }),
    ]);
    expect((await site.anonymous().get("/api/playbooks")).status).toBe(401);
  });
});

describe("a matter, from creation to deletion", () => {
  let matter: MatterSummary;
  let documentId = "";
  let versionId = "";

  it("is created by POST /api/matters, with its creator as the associate", async () => {
    const response = await associate.api("POST", "/api/matters", {
      name: "Matter by API",
      clientLegalName: baseWorld.manifest.clientLegalName,
      playbookVersionId: site.w.playbookVersionId,
      reviewerUserId: IDS.reviewer,
    });
    expect(response.status).toBe(201);
    matter = await json<MatterSummary>(response);
    expect(matter).toMatchObject({
      name: "Matter by API",
      status: "draft",
      role: "associate",
      synthetic: true,
      playbook: { slug: "parol-nda-recipient" },
    });
    const list = await json<{ matters: MatterSummary[] }>(await associate.get("/api/matters"));
    expect(list.matters.map((m) => m.id)).toContain(matter.id);
    // The reviewer is on it; a person who is not is not told.
    expect(
      (await json<{ matters: MatterSummary[] }>(await reviewer.get("/api/matters"))).matters.map(
        (m) => m.id,
      ),
    ).toContain(matter.id);
    const outsider = await site.as(OUTSIDER);
    expect(
      (await json<{ matters: MatterSummary[] }>(await outsider.get("/api/matters"))).matters,
    ).toEqual([]);
  });

  it("refuses a body that is not a matter, with a kind and a fixed message", async () => {
    for (const body of [{}, { name: "x" }, { name: 1, clientLegalName: "y" }, [], "text", null]) {
      const response = await associate.api("POST", "/api/matters", body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({
        error: { kind: "invalid_request", message: "The request was not valid.", code: "invalid" },
      });
    }
    const blank = await associate.api("POST", "/api/matters", {
      name: "  ",
      clientLegalName: "Client",
    });
    expect(blank.status).toBe(400);
    const unknownPlaybook = await associate.api("POST", "/api/matters", {
      name: "x",
      clientLegalName: "y",
      playbookVersionId: "pbv_nothing",
    });
    expect(unknownPlaybook.status).toBe(404);
    const longName = await associate.api("POST", "/api/matters", {
      name: "x".repeat(201),
      clientLegalName: "y",
    });
    expect(longName.status).toBe(400);
  });

  it("refuses a JSON body that is larger than any request of the API could need, before reading it as JSON", async () => {
    const huge = JSON.stringify({ clientLegalName: "x".repeat(200_000) });
    const response = await associate.send("PATCH", `/api/matters/${matter.id}`, {
      headers: { "content-type": "application/json", "x-csrf-token": await associate.apiToken() },
      body: huge,
    });
    expect(response.status).toBe(413);
    expect(await json(response)).toMatchObject({ error: { kind: "too_large" } });
  });

  it("takes the documents as multipart and says what it made of them", async () => {
    const nda = await associate.apiUpload(
      `/api/matters/${matter.id}/documents`,
      { title: "Mutual NDA", kind: "nda", statedDate: "2026-02-02" },
      { name: NDA.file, bytes: NDA.bytes },
    );
    expect(nda.status).toBe(201);
    const first_ = await json<{ documentId: string; versionId: string; warnings: unknown[] }>(nda);
    expect(first_.warnings).toEqual([]);
    documentId = first_.documentId;
    const amendment = await associate.apiUpload(
      `/api/matters/${matter.id}/documents`,
      { title: "Amendment No. 1", kind: "amendment", statedDate: "" },
      { name: AMENDMENT.file, bytes: AMENDMENT.bytes },
    );
    expect(amendment.status).toBe(201);
    versionId = (await json<{ versionId: string }>(amendment)).versionId;

    const view = await json<MatterView>(await associate.get(`/api/matters/${matter.id}`));
    expect(view.matter.status).toBe("ready");
    expect(view.documents.map((d) => [d.label, d.kind, d.versions[0]!.statedDate])).toEqual([
      ["D1", "nda", "2026-02-02"],
      ["D2", "amendment", null],
    ]);
    expect(view.start).toEqual({ ready: true, reasons: [] });
    expect(view.workflows?.map((w) => [w.label, w.isDefault])).toEqual([
      ["v1", true],
      ["v2", false],
    ]);
  });

  it("changes the settings, the operative version and a stated date, one kind of change to a request", async () => {
    const patch = async (body: unknown): Promise<Response> =>
      associate.api("PATCH", `/api/matters/${matter.id}`, body);
    const renamed = await patch({ clientLegalName: "Lanternfish Software, Incorporated" });
    expect(renamed.status).toBe(200);
    expect((await json<MatterView>(renamed)).matter.clientLegalName).toBe(
      "Lanternfish Software, Incorporated",
    );
    expect((await patch({ clientLegalName: baseWorld.manifest.clientLegalName })).status).toBe(200);

    const dated = await patch({ statedDate: { versionId, statedDate: "2026-09-15" } });
    expect(dated.status).toBe(200);
    expect((await json<MatterView>(dated)).documents[1]!.versions[0]!.statedDate).toBe(
      "2026-09-15",
    );
    const cleared = await patch({ statedDate: { versionId, statedDate: null } });
    expect((await json<MatterView>(cleared)).documents[1]!.versions[0]!.statedDate).toBeNull();
    expect((await patch({ statedDate: { versionId, statedDate: "2026-02-30" } })).status).toBe(400);

    const operative = await patch({
      operative: {
        documentId,
        versionId: (await json<MatterView>(await associate.get(`/api/matters/${matter.id}`)))
          .documents[0]!.versions[0]!.versionId,
      },
    });
    expect(operative.status).toBe(200);
    for (const body of [
      {},
      { operative: {} },
      { statedDate: { versionId } },
      { playbookVersionId: 7 },
    ])
      expect((await patch(body)).status, JSON.stringify(body)).toBe(400);
  });

  it("adds a member, and refuses a role that is not one, a person who is not one, and a second time", async () => {
    const add = async (body: unknown): Promise<Response> =>
      associate.api("POST", `/api/matters/${matter.id}/members`, body);
    const added = await add({ userId: OTHER_ASSOCIATE, role: "viewer" });
    expect(added.status).toBe(201);
    const { members } = await json<{ members: { userId: string; role: string }[] }>(added);
    expect(members.map((m) => [m.userId, m.role])).toEqual([
      [IDS.associate, "associate"],
      [IDS.reviewer, "reviewer"],
      [OTHER_ASSOCIATE, "viewer"],
    ]);
    expect((await add({ userId: OUTSIDER, role: "owner" })).status).toBe(400);
    expect((await add({ userId: "usr_nobody", role: "viewer" })).status).toBe(404);
    expect((await add({ userId: OTHER_ASSOCIATE, role: "viewer" })).status).toBe(409);
  });

  it("removes the last document, and not one with a document after it", async () => {
    const path = (id: string): string => `/api/matters/${matter.id}/documents/${id}`;
    expect((await associate.api("DELETE", path(documentId))).status).toBe(409);
    const gone = await associate.api(
      "DELETE",
      path(
        (await json<MatterView>(await associate.get(`/api/matters/${matter.id}`))).documents[1]!
          .documentId,
      ),
    );
    expect(gone.status).toBe(204);
    expect(
      (await json<MatterView>(await associate.get(`/api/matters/${matter.id}`))).documents,
    ).toHaveLength(1);
  });

  it("is deleted by its creator, and is then nothing to anyone", async () => {
    expect((await reviewer.api("DELETE", `/api/matters/${matter.id}`)).status).toBe(403);
    const response = await associate.api("DELETE", `/api/matters/${matter.id}`);
    expect(response.status).toBe(204);
    for (const browser of [associate, reviewer])
      expect((await browser.get(`/api/matters/${matter.id}`)).status).toBe(404);
  });
});

describe("a review, from the run to the memo", () => {
  let ids: Prepared;
  let run: RunSummary;

  beforeAll(async () => {
    ids = await prepareMatter(site, { exported: false });
  });

  it("starts a run, tells what it is, and lists it", async () => {
    const response = await associate.api("POST", `/api/matters/${ids.matterId}/runs`, {
      workflow: "v2",
    });
    expect(response.status).toBe(202);
    run = await json<RunSummary>(response);
    expect(run).toMatchObject({ status: "queued", workflowLabel: "v2", current: true });
    const again = await associate.api("POST", `/api/matters/${ids.matterId}/runs`, {
      workflow: "v2",
    });
    // One at a time, and the answer says which is in flight.
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({
      error: { kind: "active_run", activeRunId: run.id },
    });
    await site.w.services.runs.idle();
    const list = await json<{ runs: RunSummary[] }>(
      await associate.get(`/api/matters/${ids.matterId}/runs`),
    );
    expect(list.runs.map((r) => r.id)).toContain(run.id);
    expect(
      await json<RunSummary>(await associate.get(`/api/matters/${ids.matterId}/runs/${run.id}`)),
    ).toMatchObject({
      status: "succeeded",
      findingCount: 8,
    });
  });

  // docs/parol/03 lists one `IssueRow` for the issue table, with the evidence, the rule, the
  // discrepancy, the explanation and the fallback on every row. The implementation (the shared
  // contract in services/views.ts) splits it in two: the table has a summary row per finding, and
  // the finding resource carries the detail. A client written from the document alone would find
  // the table rows without these fields, so the test states the split, field by field, instead of
  // claiming the document's shape. The document is to be brought into line with it.
  it("gives the issue table as summary rows and the finding as the detail that docs/parol/03 lists on each row", async () => {
    const table = await json<{ runId: string; findings: IssueRow[] }>(
      await associate.get(`/api/matters/${ids.matterId}/runs/${run.id}/findings`),
    );
    expect(table.findings).toHaveLength(8);
    expect(Object.keys(table.findings[0]!).sort()).toEqual(
      [
        "findingId",
        "ruleKey",
        "ruleTitle",
        "category",
        "severity",
        "status",
        "validity",
        "verificationState",
        "escalations",
        "evidenceCount",
        "review",
      ].sort(),
    );
    const dur = table.findings.find((f) => f.ruleKey === "dur-1")!;
    const finding = await json<FindingView>(
      await associate.get(`/api/matters/${ids.matterId}/findings/${dur.findingId}`),
    );
    // The fields the document puts on the row are on the finding, and not on the row.
    for (const documented of [
      "evidence",
      "rule",
      "discrepancy",
      "explanation",
      "fallbackLanguage",
      "fallbackBasis",
    ]) {
      expect(dur, `${documented} is not on the table row`).not.toHaveProperty(documented);
      expect(finding, `${documented} is on the finding`).toHaveProperty(documented);
    }
    expect(finding.rule).toMatchObject({
      standard: expect.any(String),
      playbook: { slug: "parol-nda-recipient", version: expect.any(String) },
    });
    expect(finding.issue).toEqual(dur);
    expect(finding.evidence[0]).toMatchObject({
      role: "governing",
      location: "Amendment No. 1 (v1), Section 2, paragraph 3",
      quoteCheck: "verified",
    });
    expect(finding.canDecide).toEqual({
      allowed: false,
      reason: "Only the reviewing attorney can record a decision.",
    });
    expect(
      (
        await json<FindingView>(
          await reviewer.get(`/api/matters/${ids.matterId}/findings/${dur.findingId}`),
        )
      ).canDecide.allowed,
    ).toBe(true);
  });

  it("refuses an export until every finding is decided, and then makes the memo", async () => {
    const path = `/api/matters/${ids.matterId}/memos`;
    const blocked = await reviewer.api("POST", path);
    expect(blocked.status).toBe(409);
    const body = await json<{
      error: { kind: string; blockers: { findingId: string; reason: string }[] };
    }>(blocked);
    expect(body.error.kind).toBe("export_blocked");
    expect(body.error.blockers).toHaveLength(8);
    expect(new Set(body.error.blockers.map((b) => b.reason))).toEqual(new Set(["no_review"]));

    const table = await json<{ findings: IssueRow[] }>(
      await reviewer.get(`/api/matters/${ids.matterId}/runs/${run.id}/findings`),
    );
    for (const row of table.findings) {
      const view = await json<FindingView>(
        await reviewer.get(`/api/matters/${ids.matterId}/findings/${row.findingId}`),
      );
      const ok =
        view.issue.verificationState === "verified" && view.issue.status !== "undetermined";
      const decided = await reviewer.api(
        "POST",
        `${path.replace("memos", "")}findings/${row.findingId}/reviews`,
        {
          decision: ok ? "accept" : "escalate",
          findingContentSha256: view.contentSha256,
          reason: ok ? null : "Cannot settle this rule.",
        },
      );
      expect(decided.status).toBe(201);
    }
    const exported = await reviewer.api("POST", path);
    expect(exported.status).toBe(201);
    const memo = await json<MemoSummary>(exported);
    expect(memo).toMatchObject({
      status: "current",
      runId: run.id,
      exportedByName: "Dana Whitfield (reviewing attorney)",
    });
    const file = await associate.get(`${path}/${memo.memoId}/file`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toBe(`attachment; filename="${memo.fileName}"`);
  });
});

describe("a review that failed", () => {
  it("is resumed by the associate, from the page or the API, and then finishes", async () => {
    let broken = true;
    const failing = makeSite({
      model: {
        before: (call) => {
          if (broken && call.kind === "extract") throw new ModelRequestError("no key", 401);
        },
      },
    });
    const ids = await prepareMatterWithoutRun(failing);
    const browser = await failing.as(IDS.associate);
    const started = await json<RunSummary>(
      await browser.api("POST", `/api/matters/${ids.matterId}/runs`, { workflow: "v2" }),
    );
    await failing.w.services.runs.idle();
    const failed = await json<RunSummary>(
      await browser.get(`/api/matters/${ids.matterId}/runs/${started.id}`),
    );
    expect(failed).toMatchObject({ status: "failed", errorKind: "provider_auth" });

    // The page says what happened and offers the resume form; the reviewer is not offered it.
    const page = await browser.page(urls.matter(ids.matterId));
    expect(readable(byId(page.root, "runs")!)).toContain("Resume");
    const asReviewer = await (await failing.as(IDS.reviewer)).page(urls.matter(ids.matterId));
    expect(
      all(
        asReviewer.root,
        (el) =>
          el.name === "form" && attr(el, "action") === urls.runResume(ids.matterId, started.id),
      ),
    ).toEqual([]);
    const runPage = await browser.page(urls.run(ids.matterId, started.id));
    expect(runPage.html).toContain("This review did not finish");

    broken = false;
    const resumed = await browser.submit(page, urls.runResume(ids.matterId, started.id));
    expect(resumed.status).toBe(303);
    expect((await browser.page(resumed.headers.get("location")!)).html).toContain(
      "The review was started again where it stopped.",
    );
    await failing.w.services.runs.idle();
    expect(
      await json<RunSummary>(await browser.get(`/api/matters/${ids.matterId}/runs/${started.id}`)),
    ).toMatchObject({
      status: "succeeded",
      findingCount: 8,
    });
    // It cannot be resumed twice.
    expect(
      (await browser.api("POST", `/api/matters/${ids.matterId}/runs/${started.id}/resume`)).status,
    ).toBe(409);
  });
});

describe("a review in flight", () => {
  it("is cancelled by the associate through the API, and then another can be started", async () => {
    const hold = gate();
    const running = makeSite({
      model: { before: (call) => (call.kind === "extract" ? hold.pass() : undefined) },
    });
    const ids = await prepareMatterWithoutRun(running);
    const browser = await running.as(IDS.associate);
    const reviewerBrowser = await running.as(IDS.reviewer);
    const started = await json<RunSummary>(
      await browser.api("POST", `/api/matters/${ids.matterId}/runs`, { workflow: "v2" }),
    );
    await hold.reached(1);

    // Only the associate who may start a review may stop it.
    const refused = await reviewerBrowser.api(
      "POST",
      `/api/matters/${ids.matterId}/runs/${started.id}/cancel`,
    );
    expect(refused.status).toBe(403);
    const cancelled = await browser.api(
      "POST",
      `/api/matters/${ids.matterId}/runs/${started.id}/cancel`,
    );
    expect(cancelled.status).toBe(200);
    expect(await json<RunSummary>(cancelled)).toMatchObject({
      id: started.id,
      status: "cancelled",
    });
    hold.open();
    await running.w.services.runs.idle();
    expect(
      (await json<RunSummary>(await browser.get(`/api/matters/${ids.matterId}/runs/${started.id}`)))
        .status,
    ).toBe("cancelled");
    expect(
      (await json<MatterView>(await browser.get(`/api/matters/${ids.matterId}`))).matter.status,
    ).toBe("ready");
    // A cancelled review is over: it cannot be cancelled again.
    expect(
      (await browser.api("POST", `/api/matters/${ids.matterId}/runs/${started.id}/cancel`)).status,
    ).toBe(409);
    const again = await browser.api("POST", `/api/matters/${ids.matterId}/runs`, {
      workflow: "v2",
    });
    expect(again.status).toBe(202);
    await running.w.services.runs.idle();
  });
});

/** A matter with its documents and no run, made through the services. */
async function prepareMatterWithoutRun(on: Site): Promise<{ matterId: string }> {
  const { matterId } = newMatter(on.w);
  await uploadCase(on.w, matterId);
  return { matterId };
}

describe("the API and the pages do the same thing", () => {
  it("leave a matter in the same state for the same input", async () => {
    // The same story told once by a form and once by the API; the matters differ only in ids.
    const byForm = await associate.page(urls.matters());
    const form = await associate.submit(byForm, urls.matters(), {
      set: {
        name: "Same",
        clientLegalName: "Same Client, Inc.",
        reviewerUserId: IDS.reviewer,
        playbookVersionId: site.w.playbookVersionId,
      },
    });
    const formId = /mat_[0-9a-f]+/.exec(form.headers.get("location")!)![0];
    const api = await json<MatterSummary>(
      await associate.api("POST", "/api/matters", {
        name: "Same",
        clientLegalName: "Same Client, Inc.",
        reviewerUserId: IDS.reviewer,
        playbookVersionId: site.w.playbookVersionId,
      }),
    );
    const view = (id: string): MatterView =>
      site.w.services.matters.view(site.w.grant(site.w.associate, id));
    // The date differs by the seconds the two requests were apart; the days left (30 for a form
    // that offers the default and for a body that names none) and everything else must not.
    const strip = (v: MatterView): unknown => ({
      ...v,
      matter: { ...v.matter, id: "-", createdAt: "-", retainUntil: "-" },
      retention: { ...v.retention, retainUntil: "-" },
    });
    expect(strip(view(api.id))).toEqual(strip(view(formId)));
  });
});
