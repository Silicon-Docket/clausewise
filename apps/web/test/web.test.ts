import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOracleGenerator } from "@clausewise/review/testing";
import { createReviewService } from "@clausewise/service";
import { memoryBlobs, memoryQueue, memoryRecords } from "@clausewise/service/memory";
import { directoryPlaybooks } from "@clausewise/service/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadFixtures, type Fixture } from "../../../evals/src/fixtures.js";
import { oracleScripts } from "../../../evals/src/selftest.js";
import { contentDisposition, createHandler, startLocal } from "../src/index.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PLAYBOOKS = join(ROOT, "playbooks");

let fixture: Fixture;
beforeAll(async () => {
  [fixture] = (await loadFixtures(ROOT, ["nda-aggressive.docx"])) as [Fixture];
});

/** A raw request, so the Host header can be set, which fetch does not allow. */
function raw(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: Uint8Array | string } = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      { method: options.method ?? "GET", headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

describe("local mode, end to end", () => {
  let local: Awaited<ReturnType<typeof startLocal>>;

  beforeAll(async () => {
    local = await startLocal({
      playbooksDir: PLAYBOOKS,
      generator: createOracleGenerator(oracleScripts(fixture)),
      port: 0,
    });
  });

  afterAll(async () => {
    await local.close();
  });

  const json = (body: unknown) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  it("reviews a contract from upload to download", async () => {
    const created = await fetch(
      `${local.url}/api/reviews`,
      json({ playbookId: "nda-mutual", fileName: fixture.name, client: "Fabrikam Labs LLC" }),
    );
    expect(created.status).toBe(201);
    const review = (await created.json()) as { id: string; status: string };
    expect(review.status).toBe("awaiting_upload");
    expect(review).not.toHaveProperty("owner");

    const upload = await fetch(`${local.url}/api/reviews/${review.id}/contract`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      // A copy, because fetch takes only a view on an ArrayBuffer, not on a shared one.
      body: new Uint8Array(fixture.docx),
    });
    expect(upload.status).toBe(204);

    const started = await fetch(`${local.url}/api/reviews/${review.id}/start`, { method: "POST" });
    expect(started.status).toBe(202);

    let status = "queued";
    for (let tries = 0; tries < 100 && status !== "done" && status !== "failed"; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = (
        (await (await fetch(`${local.url}/api/reviews/${review.id}`)).json()) as {
          status: string;
        }
      ).status;
    }
    expect(status).toBe("done");

    const report = await fetch(`${local.url}/api/reviews/${review.id}/results/report`);
    expect(report.status).toBe(200);
    expect(report.headers.get("content-type")).toBe("application/json");
    expect(report.headers.get("content-disposition")).toBe(
      `attachment; filename="nda-aggressive.report.json"; filename*=UTF-8''nda-aggressive.report.json`,
    );
    expect(((await report.json()) as { results: unknown[] }).results).toHaveLength(10);

    const redlined = await fetch(`${local.url}/api/reviews/${review.id}/results/redlined`);
    expect(new Uint8Array(await redlined.arrayBuffer()).slice(0, 2)).toEqual(
      new Uint8Array([0x50, 0x4b]),
    );
    const summary = await fetch(`${local.url}/api/reviews/${review.id}/results/summary`);
    expect(summary.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  });

  it("marks every answer as data that must not be cached, framed or sniffed", async () => {
    const response = await fetch(`${local.url}/api/playbooks`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(
      ((await response.json()) as { playbooks: { id: string }[] }).playbooks.map((p) => p.id),
    ).toEqual(["nda-mutual", "saas-customer"]);
  });

  it("refuses a request that names the server by any other host, as DNS rebinding would", async () => {
    const port = new URL(local.url).port;
    const foreign = await raw(`${local.url}/api/playbooks`, {
      headers: { host: `attacker.example:${port}` },
    });
    expect(foreign.status).toBe(401);
    const named = await raw(`${local.url}/api/playbooks`, {
      headers: { host: `localhost:${port}` },
    });
    expect(named.status).toBe(200);
  });

  it("answers health without a sign-in, and says nothing but ok", async () => {
    const port = new URL(local.url).port;
    const health = await raw(`${local.url}/api/health`, { headers: { host: `elsewhere:${port}` } });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ status: "ok" });
  });
});

describe("the API's answers to mistakes", () => {
  let server: Server;
  let url: string;
  let signedIn = true;
  const errors: unknown[] = [];

  beforeAll(async () => {
    const service = createReviewService({
      records: memoryRecords(),
      contracts: memoryBlobs(),
      results: memoryBlobs(),
      queue: memoryQueue(),
      playbooks: directoryPlaybooks(PLAYBOOKS),
    });
    const handler = createHandler({
      service,
      authenticate: async () => (signedIn ? { id: "alice" } : undefined),
      maxContractBytes: 1024,
      onError: (error) => errors.push(error),
    });
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    signedIn = true;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(errors).toEqual([]);
  });

  async function create(body: unknown) {
    return fetch(`${url}/api/reviews`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("asks for a sign-in on everything but health", async () => {
    signedIn = false;
    for (const path of ["/api/playbooks", "/api/reviews/abc", "/api/reviews/abc/results/report"]) {
      const response = await fetch(`${url}${path}`);
      expect(response.status).toBe(401);
    }
    expect((await fetch(`${url}/api/health`)).status).toBe(200);
  });

  it.each([
    [{ playbookId: "nda-mutual", fileName: "nda.pdf" }, 400, /Only Word .docx/],
    [{ playbookId: "nda-mutual" }, 400, /fileName is required/],
    [{ playbookId: "nda-mutual", fileName: 7 }, 400, /fileName must be a string/],
    [{ playbookId: "unknown", fileName: "nda.docx" }, 400, /no playbook/],
    [["not", "an", "object"], 400, /JSON object/],
  ])("refuses %j with %i", async (body, status, message) => {
    const response = await create(body);
    expect(response.status).toBe(status);
    expect(((await response.json()) as { error: string }).error).toMatch(message);
  });

  it("refuses a body that is not JSON, or too much of it", async () => {
    const text = await fetch(`${url}/api/reviews`, { method: "POST", body: "fileName=nda.docx" });
    expect(text.status).toBe(415);
    const broken = await fetch(`${url}/api/reviews`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(broken.status).toBe(400);
    const huge = await create({
      playbookId: "nda-mutual",
      fileName: "nda.docx",
      client: "x".repeat(20_000),
    });
    expect(huge.status).toBe(413);
  });

  it("refuses a contract over the upload limit", async () => {
    const review = (await (
      await create({ playbookId: "nda-mutual", fileName: "nda.docx" })
    ).json()) as {
      id: string;
    };
    const response = await fetch(`${url}/api/reviews/${review.id}/contract`, {
      method: "PUT",
      body: new Uint8Array(2048),
    });
    expect(response.status).toBe(413);
  });

  it("maps the service's refusals to HTTP statuses", async () => {
    const review = (await (
      await create({ playbookId: "nda-mutual", fileName: "nda.docx" })
    ).json()) as {
      id: string;
    };
    expect((await fetch(`${url}/api/reviews/no-such-review`)).status).toBe(404);
    expect((await fetch(`${url}/api/reviews/${review.id}/start`, { method: "POST" })).status).toBe(
      409,
    );
    expect((await fetch(`${url}/api/reviews/${review.id}/results/summary`)).status).toBe(409);
    expect((await fetch(`${url}/api/reviews/${review.id}`, { method: "DELETE" })).status).toBe(405);
    expect((await fetch(`${url}/api/reviews/${review.id}/results/other`)).status).toBe(404);
    expect((await fetch(`${url}/api/elsewhere`)).status).toBe(404);
  });
});

describe("contentDisposition", () => {
  it.each([
    ["nda.docx", "attachment; filename=\"nda.report.json\"; filename*=UTF-8''nda.report.json"],
    [
      'Accord "final" été.docx',
      "attachment; filename=\"Accord _final_ _t_.report.json\"; filename*=UTF-8''Accord%20%22final%22%20%C3%A9t%C3%A9.report.json",
    ],
    [
      "O'Brien (draft)*.docx",
      "attachment; filename=\"O_Brien _draft__.report.json\"; filename*=UTF-8''O%27Brien%20%28draft%29%2A.report.json",
    ],
    [
      "契約.docx",
      "attachment; filename=\"__.report.json\"; filename*=UTF-8''%E5%A5%91%E7%B4%84.report.json",
    ],
  ])("writes a safe header for %j", (fileName, expected) => {
    expect(contentDisposition(fileName, ".report.json")).toBe(expected);
  });
});
