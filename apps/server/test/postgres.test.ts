import { execSync } from "node:child_process";
import { chown, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DocumentListResponse,
  DocumentSummary,
  Finding,
  ReviewDetail,
  ReviewSummary,
} from "@clausewise/api";
import EmbeddedPostgres from "embedded-postgres";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/client.js";
import { startServer, type RunningServer } from "../src/start.js";
import { silentLogger } from "../src/log.js";
import { fixtureBytes, oracleFor, queryRows, sql, testConfig } from "./support.js";

// A real Postgres, started by the embedded-postgres package. It is the one test here that does
// not run on PGlite, because the two differ where it matters: drivers, how JSON and timestamps
// come back, and how the migrations are applied. The test is skipped, with the reason, where
// Postgres cannot be started: it refuses to run as root, and the package then looks for a user
// called postgres to run it as.

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

interface Cluster {
  url: string;
  stop(): Promise<void>;
}

async function startCluster(): Promise<Cluster> {
  // When this runs as root the cluster is owned by the postgres user, which must be able to walk
  // down to its folder, so it is made in /tmp and not in a private temporary folder.
  const asRoot = process.getuid?.() === 0;
  const dir = await mkdtemp(join(asRoot ? "/tmp" : tmpdir(), "clausewise-pg-"));
  if (asRoot) {
    const uid = Number(execSync("id -u postgres", { encoding: "utf8" }).trim());
    const gid = Number(execSync("id -g postgres", { encoding: "utf8" }).trim());
    await chown(dir, uid, gid);
  }
  const port = await freePort();
  const password = "test-password";
  const cluster = new EmbeddedPostgres({
    databaseDir: join(dir, "db"),
    port,
    user: "clausewise",
    password,
    persistent: true,
    onLog: () => {},
    onError: () => {},
  });
  try {
    await cluster.initialise();
    await cluster.start();
    await cluster.createDatabase("clausewise");
  } catch (error) {
    await cluster.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    url: `postgres://clausewise:${password}@localhost:${port}/clausewise`,
    stop: async () => {
      await cluster.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const reason = (error: unknown): string =>
  error instanceof Error && error.message !== ""
    ? error.message.split("\n")[0]!
    : "no reason given";

describe("against a real Postgres", () => {
  it("runs the migrations and the main flows, and keeps its data across a restart", async (context) => {
    let cluster: Cluster;
    try {
      cluster = await startCluster();
    } catch (error) {
      context.skip(
        `embedded-postgres could not start a Postgres cluster in this environment (${reason(error)}), so the real Postgres integration test did not run.`,
      );
      return;
    }

    const dataDir = await mkdtemp(join(tmpdir(), "clausewise-pgdata-"));
    const servers: RunningServer[] = [];
    try {
      const open = async (): Promise<RunningServer> => {
        const server = await startServer({
          config: testConfig(dataDir, { databaseUrl: cluster.url }),
          generator: await oracleFor("nda-aggressive.docx"),
          log: silentLogger,
        });
        servers.push(server);
        return server;
      };
      const call = async <T>(server: RunningServer, path: string, init?: RequestInit) => {
        const response = await fetch(`${server.url}${path}`, init);
        const text = await response.text();
        return { status: response.status, body: (text === "" ? undefined : JSON.parse(text)) as T };
      };
      const post = <T>(server: RunningServer, path: string, body: unknown) =>
        call<T>(server, path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

      const first = await open();
      // The migration really ran on this database.
      const probe = await openDatabase({ kind: "postgres", url: cluster.url });
      const tables = await queryRows<{ table_name: string }>(
        probe,
        sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
      );
      expect(tables.map((row) => row.table_name)).toEqual([
        "documents",
        "findings",
        "playbooks",
        "reviews",
      ]);
      await probe.close();

      const form = new FormData();
      form.set("file", new File([await fixtureBytes("nda-aggressive.docx")], "nda.docx"));
      const upload = await call<DocumentSummary>(first, "/api/documents", {
        method: "POST",
        body: form,
      });
      expect(upload.status).toBe(201);

      const started = await post<ReviewSummary>(first, "/api/reviews", {
        documentId: upload.body.id,
        playbookId: "builtin:nda-mutual",
        client: "Fabrikam Labs LLC, the Recipient",
      });
      expect(started.status).toBe(202);

      let detail: ReviewDetail | undefined;
      for (let attempt = 0; attempt < 300 && detail?.status !== "done"; attempt += 1) {
        detail = (await call<ReviewDetail>(first, `/api/reviews/${started.body.id}`)).body;
        if (detail.status === "failed") throw new Error(`Review failed: ${detail.error}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(detail?.status).toBe("done");
      expect(detail?.findings).toHaveLength(10);
      // JSON and timestamps survive the round trip through this driver.
      expect(detail?.open).toEqual({
        high: expect.any(Number),
        medium: expect.any(Number),
        low: expect.any(Number),
      });
      expect(Date.parse(detail?.finishedAt ?? "")).not.toBeNaN();
      const term = detail?.findings.find((f) => f.ruleId === "term");
      expect(
        term?.edit.kind === "applied" && term.edit.paragraphText.includes(term.edit.original),
      ).toBe(true);

      const patched = await call<Finding>(first, `/api/reviews/${started.body.id}/findings/term`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "accepted", editedReplacement: "end after three years" }),
      });
      expect(patched.body).toMatchObject({
        decision: "accepted",
        editedReplacement: "end after three years",
      });
      const bulk = await call<{ updated: number }>(
        first,
        `/api/reviews/${started.body.id}/findings`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision: "rejected", severities: ["low"] }),
        },
      );
      expect(bulk.body.updated).toBeGreaterThan(0);

      // Restart on the same database: nothing is lost, and the decisions are still there.
      await first.close();
      const second = await open();
      const listed = await call<DocumentListResponse>(second, "/api/documents");
      expect(listed.body.documents).toEqual([
        expect.objectContaining({ id: upload.body.id, reviewCount: 1 }),
      ]);
      const again = await call<ReviewDetail>(second, `/api/reviews/${started.body.id}`);
      expect(again.body.findings.find((f) => f.ruleId === "term")).toMatchObject({
        decision: "accepted",
        editedReplacement: "end after three years",
      });

      // Deleting the document removes its reviews and findings.
      const removed = await call(second, `/api/documents/${upload.body.id}`, { method: "DELETE" });
      expect(removed.status).toBe(204);
      const gone = await openDatabase({ kind: "postgres", url: cluster.url });
      const counts = await queryRows(
        gone,
        sql`select (select count(*) from reviews) as reviews, (select count(*) from findings) as findings`,
      );
      expect(counts[0]).toEqual({ reviews: "0", findings: "0" });
      await gone.close();
    } finally {
      for (const server of servers) await server.close().catch(() => {});
      await cluster.stop().catch(() => {});
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 120_000);
});
