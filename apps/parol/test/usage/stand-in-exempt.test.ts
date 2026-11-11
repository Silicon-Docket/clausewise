import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { start, type RunningServer } from "../../src/main.js";
import { runSeed } from "../../src/seed.js";
import { FIELDS } from "../../src/server/pages/forms.js";
import { WORKFLOW_FIELD } from "../../src/server/pages/matter.js";
import { urls } from "../../src/server/urls.js";
import { DEMO_USER_IDS } from "../../src/store/index.js";

/**
 * The spend guard is for a reader that calls a model. A stand-in reader (the simulated one that
 * PAROL_SCRIPTED=1 starts, or any provider the application names as a stand-in) calls nothing, so
 * it costs nothing and nothing limits it: with limits that no review could keep to, a review runs,
 * is not refused, writes nothing to the ledger, and needs no price file.
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

const SECRET = "stand-in-exempt-secret-0123456789abcdef";

/** Just enough of a browser: cookies, the token, a sign-in and a form post. */
class Browser {
  private readonly jar = new Map<string, string>();
  constructor(private readonly base: string) {}

  async send(method: string, path: string, form?: Record<string, string>): Promise<Response> {
    const headers: Record<string, string> = {};
    const cookie = [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ");
    if (cookie !== "") headers["cookie"] = cookie;
    if (form !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers,
      redirect: "manual",
      ...(form === undefined ? {} : { body: new URLSearchParams(form).toString() }),
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (value === "" || /max-age=0/i.test(line)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return response;
  }

  async form(path: string, fields: Record<string, string>): Promise<Response> {
    const token = ((await (await this.send("GET", "/api/session")).json()) as { csrfToken: string })
      .csrfToken;
    return this.send("POST", path, { ...fields, _csrf: token });
  }
}

async function boot(env: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "parol-exempt-"));
  roots.push(root);
  const full = {
    PAROL_DEMO_IDENTITY: "1",
    PAROL_SCRIPTED: "1",
    PAROL_PORT: "0",
    PAROL_DATA_DIR: join(root, "data"),
    PAROL_COOKIE_SECRET: SECRET,
    ...env,
  };
  const seeded = await runSeed(full, [], () => {});
  const server = await start(full, { log: () => {}, notice: () => {} });
  servers.push(server);
  const matterId = seeded.matters.find((m) => m.key === "lanternfish")!.matterId;
  const browser = new Browser(`http://127.0.0.1:${server.port}`);
  const signedIn = await browser.form(urls.session(), {
    [FIELDS.intent]: "sign-in",
    [FIELDS.userId]: DEMO_USER_IDS.associate,
  });
  expect(signedIn.status).toBe(303);
  return { server, browser, matterId };
}

async function idle(server: RunningServer, matterId: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (server.repo.getActiveRun(matterId) === undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the review did not finish");
}

describe("a stand-in reader, with limits that no review could keep to", () => {
  const TINY = {
    PAROL_MAX_REVIEW_COST_USD: "0.0001",
    PAROL_MAX_DAILY_COST_USD: "0.0001",
  };

  it("reviews the documents: no refusal, a finished run, no ledger row, no price file", async () => {
    const { server, browser, matterId } = await boot(TINY);
    expect(server.spend).toBeUndefined();
    for (const workflow of ["v1", "v2"]) {
      const response = await browser.form(urls.runs(matterId), { [WORKFLOW_FIELD]: workflow });
      expect(response.status, workflow).toBe(303);
      await idle(server, matterId);
    }
    const runs = server.repo.listRunsForMatter(matterId);
    expect(runs).toHaveLength(2);
    // The second review replaced the first, which is how a re-run goes; neither failed.
    expect(runs.map((run) => run.status).sort()).toEqual(["succeeded", "superseded"]);
    for (const run of runs) expect(run.errorKind).toBeNull();
    expect(server.repo.db.prepare("SELECT COUNT(*) AS n FROM spend_ledger").get()).toEqual({
      n: 0,
    });
    expect(server.repo.spendToday().costUsd).toBe(0);
  });

  it("is judged the same with no spend variable at all", async () => {
    const { server, browser, matterId } = await boot({});
    const response = await browser.form(urls.runs(matterId), { [WORKFLOW_FIELD]: "v1" });
    expect(response.status).toBe(303);
    await idle(server, matterId);
    expect(server.repo.listRunsForMatter(matterId)[0]?.status).toBe("succeeded");
  });
});
