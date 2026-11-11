import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { SIMULATED_DISCLOSURE } from "../../src/demo/index.js";
import { start, type RunningServer } from "../../src/main.js";
import { runSeed } from "../../src/seed.js";
import { FIELDS } from "../../src/server/pages/forms.js";
import { WORKFLOW_FIELD } from "../../src/server/pages/matter.js";
import { urls } from "../../src/server/urls.js";
import { DEMO_USER_IDS } from "../../src/store/index.js";

/**
 * The demonstration as a person meets it: the seed, then the server with PAROL_SCRIPTED=1 (the
 * simulated reader), then sign-in, a review under each workflow version, the reviewing attorney's
 * decisions and the memo, all through the pages and the JSON API on a real socket. Every document,
 * party and name is synthetic, and the reader is the scripted simulation, so nothing here measures
 * a model.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const roots: string[] = [];
const servers: RunningServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SECRET = "demo-walkthrough-secret-0123456789abcdef";

/** The README with its line breaks folded, so that a sentence can be looked for across them. */
const README = readFileSync(join(import.meta.dirname, "..", "..", "README.md"), "utf8").replace(
  /\s+/g,
  " ",
);
/** What a page or a memo says to a reader, with the markup taken away. */
const spoken = (markup: string): string => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
/** Whether a text says that what reads the documents is a scripted simulation and not a language model. */
const saysItIsSimulated = (text: string): boolean =>
  /scripted/i.test(text) && /not a language model/i.test(text);

/** A browser, as far as the pages need one: cookies, and form posts that carry the token. */
class Browser {
  private readonly jar = new Map<string, string>();
  constructor(private readonly base: string) {}

  async send(
    method: string,
    path: string,
    init: { form?: Record<string, string>; json?: unknown } = {},
  ) {
    const headers: Record<string, string> = {};
    const cookie = [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ");
    if (cookie !== "") headers["cookie"] = cookie;
    let body: string | undefined;
    if (init.form !== undefined) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(init.form).toString();
    }
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      headers["x-csrf-token"] = await this.token();
      body = JSON.stringify(init.json);
    }
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers,
      redirect: "manual",
      ...(body === undefined ? {} : { body }),
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
      const at = pair.indexOf("=");
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      const gone = value === "" || attributes.some((a) => /^max-age=0$/i.test(a));
      if (gone) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return response;
  }

  async token(): Promise<string> {
    const response = await this.send("GET", "/api/session");
    return ((await response.json()) as { csrfToken: string }).csrfToken;
  }

  async form(path: string, fields: Record<string, string>): Promise<Response> {
    return this.send("POST", path, { form: { ...fields, _csrf: await this.token() } });
  }

  async signIn(userId: string): Promise<void> {
    const response = await this.form(urls.session(), {
      [FIELDS.intent]: "sign-in",
      [FIELDS.userId]: userId,
    });
    expect(response.status, "sign-in").toBe(303);
  }

  async json<T>(path: string): Promise<T> {
    const response = await this.send("GET", path);
    expect(response.status, path).toBe(200);
    return (await response.json()) as T;
  }
}

interface Demo {
  server: RunningServer;
  notices: string[];
  matters: { lanternfish: string; heronbridge: string };
  browser(): Browser;
}

async function boot(): Promise<Demo> {
  const root = mkdtempSync(join(tmpdir(), "parol-walk-"));
  roots.push(root);
  const dataDir = join(root, "data");
  const env = {
    PAROL_DEMO_IDENTITY: "1",
    PAROL_SCRIPTED: "1",
    PAROL_PORT: "0",
    PAROL_DATA_DIR: dataDir,
    PAROL_COOKIE_SECRET: SECRET,
  };
  const seeded = await runSeed(env, [], () => {});
  const notices: string[] = [];
  const server = await start(env, { log: () => {}, notice: (line) => notices.push(line) });
  servers.push(server);
  const ids = new Map(seeded.matters.map((m) => [m.key, m.matterId]));
  return {
    server,
    notices,
    matters: { lanternfish: ids.get("lanternfish")!, heronbridge: ids.get("heronbridge")! },
    browser: () => new Browser(`http://127.0.0.1:${server.port}`),
  };
}

async function idle(server: RunningServer, matterId: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (server.repo.getActiveRun(matterId) === undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the review did not finish");
}

interface IssueRow {
  findingId: string;
  ruleKey: string;
  status: string;
  verificationState: string;
  escalations: { code: string }[];
}

async function review(demo: Demo, associate: Browser, workflow: string) {
  const { lanternfish } = demo.matters;
  const known = new Set(demo.server.repo.listRunsForMatter(lanternfish).map((r) => r.id));
  const response = await associate.form(urls.runs(lanternfish), { [WORKFLOW_FIELD]: workflow });
  expect(response.status, `start ${workflow}`).toBe(303);
  await idle(demo.server, lanternfish);
  const added = demo.server.repo.listRunsForMatter(lanternfish).filter((r) => !known.has(r.id));
  expect(added).toHaveLength(1);
  const run = added[0]!;
  const { findings } = await associate.json<{ findings: IssueRow[] }>(
    `/api/matters/${lanternfish}/runs/${run.id}/findings`,
  );
  return { run, findings: new Map(findings.map((f) => [f.ruleKey, f])) };
}

describe("the demonstration, through the pages", () => {
  it("starts with the simulated reader and says so before it serves", async () => {
    const demo = await boot();
    const lines = demo.notices.join("\n");
    expect(lines).toContain(`Document text is sent to: ${SIMULATED_DISCLOSURE}`);
    expect(lines).toContain("simulated reader");
    expect(lines).toContain("not a language model");
    expect(lines).toContain("nothing is sent anywhere");
    expect(lines.indexOf("Document text is sent to")).toBeLessThan(lines.indexOf("listening"));
  });

  it("shows each person only their own matter, and a matter that is not theirs as not found", async () => {
    const demo = await boot();
    const alex = demo.browser();
    await alex.signIn(DEMO_USER_IDS.associate);
    const lee = demo.browser();
    await lee.signIn(DEMO_USER_IDS.legalEngineer);

    const names = async (b: Browser) =>
      (await b.json<{ matters: { name: string }[] }>("/api/matters")).matters.map((m) => m.name);
    expect(await names(alex)).toEqual(["Lanternfish / Corvane NDA"]);
    expect(await names(lee)).toEqual(["Heronbridge / Tamarind NDA"]);

    const { lanternfish, heronbridge } = demo.matters;
    for (const [browser, other] of [
      [alex, heronbridge],
      [lee, lanternfish],
    ] as const) {
      expect((await browser.send("GET", urls.matter(other))).status).toBe(404);
      expect((await browser.send("GET", `/api/matters/${other}`)).status).toBe(404);
      expect((await browser.send("GET", urls.runs(other))).status).not.toBe(200);
    }
    // And the page of their own says what will read the documents.
    const page = await (await alex.send("GET", urls.matter(lanternfish))).text();
    expect(page).toContain("Where document text is sent");
    expect(page).toContain("the scripted simulated reader");
    expect(page).toContain("not a language model");
  });

  it("shows the gap under workflow v1 and its fix under v2, on the same documents", async () => {
    const demo = await boot();
    const alex = demo.browser();
    await alex.signIn(DEMO_USER_IDS.associate);

    const baseline = await review(demo, alex, "v1");
    expect(baseline.run.manifest.workflow.label).toBe("v1");
    expect([baseline.run.modelProvider, baseline.run.modelRequested]).toEqual([
      "simulated",
      "parol-simulated-reader",
    ]);
    const dur1 = baseline.findings.get("dur-1")!;
    expect([dur1.status, dur1.verificationState, dur1.escalations]).toEqual([
      "compliant",
      "verified",
      [],
    ]);
    expect(baseline.findings.get("ret-1")!.status).toBe("deviation");

    const revision = await review(demo, alex, "v2");
    expect(revision.run.manifest.workflow.label).toBe("v2");
    const dur2 = revision.findings.get("dur-1")!;
    expect([dur2.status, dur2.verificationState, dur2.escalations]).toEqual([
      "deviation",
      "verified",
      [],
    ]);
    expect(revision.findings.get("ret-1")!.status).toBe("compliant");
    for (const f of revision.findings.values()) expect(f.verificationState).toBe("verified");
    // Eight rules each time.
    expect(baseline.findings.size).toBe(8);
    expect(revision.findings.size).toBe(8);
  });

  it("says what the README says it says: the simulation is named on the matter page, and the README owns up to the pages that do not say it", async () => {
    const demo = await boot();
    const alex = demo.browser();
    await alex.signIn(DEMO_USER_IDS.associate);
    const { lanternfish } = demo.matters;

    // The picker starts on v1 in the seeded data, which is where the walk-through starts.
    const before = await (await alex.send("GET", urls.matter(lanternfish))).text();
    expect(before).toMatch(/<option value="v1"[^>]*selected/);

    const { run, findings } = await review(demo, alex, "v1");
    const dur1 = findings.get("dur-1")!;
    const matterPage = spoken(await (await alex.send("GET", urls.matter(lanternfish))).text());
    const runPage = spoken(await (await alex.send("GET", urls.run(lanternfish, run.id))).text());
    const inspector = spoken(
      await (await alex.send("GET", urls.run(lanternfish, run.id, dur1.findingId))).text(),
    );

    // The matter page names the reader in the table of reviews and says what it is where the text goes.
    expect(matterPage).toContain("simulated, parol-simulated-reader");
    expect(saysItIsSimulated(matterPage)).toBe(true);

    // The review page and the inspector show the finding, which for DUR-1 under v1 is the verified,
    // wrong Compliant. The README says whether they say that a simulation produced it.
    const unlabelled = !saysItIsSimulated(runPage) || !saysItIsSimulated(inspector);
    const owned = README.includes(
      "the page of a review (the issue table and the finding inspector)",
    );
    expect(owned, "README owns up to the pages that do not say it").toBe(unlabelled);
    expect(README).not.toMatch(/everywhere it appears it is labelled/i);
  });

  it("lets the reviewing attorney decide every finding and export a memo that names the simulation", async () => {
    const demo = await boot();
    const alex = demo.browser();
    await alex.signIn(DEMO_USER_IDS.associate);
    const { run, findings } = await review(demo, alex, "v2");
    const { lanternfish } = demo.matters;

    const dana = demo.browser();
    await dana.signIn(DEMO_USER_IDS.reviewer);
    for (const issue of findings.values()) {
      const view = await dana.json<{ contentSha256: string }>(
        `/api/matters/${lanternfish}/findings/${issue.findingId}`,
      );
      const edited = issue.ruleKey === "dur-1";
      const response = await dana.send(
        "POST",
        `/api/matters/${lanternfish}/findings/${issue.findingId}/reviews`,
        {
          json: {
            decision: edited ? "edit" : "accept",
            reasonCode: edited ? "missed_context" : null,
            findingContentSha256: view.contentSha256,
            edits: edited
              ? { discrepancy: "Reviewed: the term was deleted by the amendment." }
              : null,
            reason: edited ? "The parties agreed two years in February." : null,
          },
        },
      );
      expect(response.status, issue.ruleKey).toBe(201);
    }
    const exported = await dana.send("POST", `/api/matters/${lanternfish}/memos`, { json: {} });
    expect(exported.status).toBe(201);
    const memo = (await exported.json()) as { memoId: string; runId: string };
    expect(memo.runId).toBe(run.id);

    const file = await dana.send("GET", `/api/matters/${lanternfish}/memos/${memo.memoId}/file`);
    expect(file.status).toBe(200);
    const zip = await JSZip.loadAsync(new Uint8Array(await file.arrayBuffer()));
    const xml = await zip.file("word/document.xml")!.async("string");
    const text = xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    // The memo says what read the documents, and that the documents are not real.
    expect(text).toContain("simulated");
    expect(text).toContain("parol-simulated-reader");
    expect(text).toMatch(/SYNTHETIC/i);
    // It does not say that the reader is a scripted program, and the README says that it does not.
    expect(
      README.includes("provenance line names the model but does not say that it is a program"),
    ).toBe(!saysItIsSimulated(text));

    // The associate may not decide, and the reviewer may not start: roles are the server's.
    const refused = await alex.send(
      "POST",
      `/api/matters/${lanternfish}/findings/${[...findings.values()][0]!.findingId}/reviews`,
      {
        json: {
          decision: "accept",
          findingContentSha256: "0".repeat(64),
          edits: null,
          reason: null,
        },
      },
    );
    expect(refused.status).toBe(403);
    const dana403 = await dana.form(urls.runs(lanternfish), { [WORKFLOW_FIELD]: "v1" });
    expect(dana403.status).toBe(403);
  });

  it("marks the results out of date when a stated date changes, as the walk-through says", async () => {
    const demo = await boot();
    const alex = demo.browser();
    await alex.signIn(DEMO_USER_IDS.associate);
    await review(demo, alex, "v2");
    const { lanternfish } = demo.matters;
    const view = await alex.json<{
      documents: { versions: { versionId: string; statedDate: string | null }[] }[];
    }>(`/api/matters/${lanternfish}`);
    const amendment = view.documents[1]!.versions[0]!;
    const changed = await alex.form(urls.statedDate(lanternfish, amendment.versionId), {
      [FIELDS.statedDate]: "2026-01-01",
    });
    expect(changed.status).toBe(303);
    const after = await alex.json<{ staleReason: string | null; currentRun: unknown }>(
      `/api/matters/${lanternfish}`,
    );
    expect(after.staleReason).toMatch(/stated date/i);
    expect(after.currentRun).toBeNull();

    // A review on the changed dates is read by the reader as the stated dates allow: an amendment
    // dated before the NDA does not govern, so the duration cannot be settled.
    const rerun = await review(demo, alex, "v2");
    const dur = rerun.findings.get("dur-1")!;
    expect(dur.status).toBe("undetermined");
    expect(dur.escalations.map((e) => e.code)).toContain("conflicting_sources");
  });
});
