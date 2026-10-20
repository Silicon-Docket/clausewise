import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chown, mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
import pg from "pg";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/client.js";
import { DataFolderInUseError } from "../src/lock.js";
import { startServer, type RunningServer } from "../src/start.js";
import { silentLogger } from "../src/log.js";
import { fixtureBytes, oracleFor, queryRows, sql, testConfig } from "./support.js";

// A real Postgres. It is the one test here that does not run on PGlite, because the two differ
// where it matters: drivers, how JSON and timestamps come back, and how the migrations are
// applied. Where the Postgres comes from, in this order:
//
//  1. The server named by CLAUSEWISE_TEST_DATABASE_URL, when that is set (CI gives it a Postgres
//     17 service container). The run makes a database of its own on that server and drops it
//     at the end, so nothing of an earlier run or of anyone else's is read or kept. A server that
//     is named and cannot be used fails the test: a silent skip would hide a broken CI setup.
//  2. A cluster started by the embedded-postgres package, in a folder of its own that is removed
//     at the end, with its process stopped. Postgres refuses to run as root, and the package then
//     runs it as a user called postgres, which has to be able to walk down to the folder.
//  3. Neither: the test is skipped, and the skip says why.

const SERVER_URL_VARIABLE = "CLAUSEWISE_TEST_DATABASE_URL";

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
  /** The address of a database that exists for this run only. */
  url: string;
  /** Throws if something of the run is still there afterwards. */
  stop(): Promise<void>;
}

/** The address of another database on the same server, with the same user and settings. */
function withDatabase(url: string, name: string): string {
  const address = new URL(url);
  address.pathname = `/${name}`;
  return address.toString();
}

/** A database of its own on a server that is already running, dropped again by `stop`. */
async function useServer(url: string): Promise<Cluster> {
  // A name from this process and a random part: two runs at once do not meet.
  const name = `clausewise_test_${process.pid}_${randomBytes(6).toString("hex")}`;
  const admin = async <T>(work: (client: pg.Client) => Promise<T>): Promise<T> => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  };
  // The name is made of letters, digits and underscores, so it needs no escaping.
  await admin((client) => client.query(`create database ${name}`));
  return {
    url: withDatabase(url, name),
    stop: async () => {
      await admin(async (client) => {
        await client.query(`drop database if exists ${name} with (force)`);
        const left = await client.query("select 1 from pg_database where datname = $1", [name]);
        if (left.rowCount !== 0) throw new Error(`The test database ${name} was not dropped.`);
      });
    },
  };
}

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
};

async function startCluster(): Promise<Cluster> {
  // As root the cluster belongs to the postgres user, which must be able to walk down to its
  // folder, so the folder is made in /tmp and not in a private temporary folder.
  const asRoot = process.getuid?.() === 0;
  const dir = await mkdtemp(join(asRoot ? "/tmp" : tmpdir(), "clausewise-pg-"));
  if (asRoot) {
    const uid = Number(execSync("id -u postgres", { encoding: "utf8" }).trim());
    const gid = Number(execSync("id -g postgres", { encoding: "utf8" }).trim());
    await chown(dir, uid, gid);
  }
  const port = await freePort();
  const password = "test-password";
  const databaseDir = join(dir, "db");
  const cluster = new EmbeddedPostgres({
    databaseDir,
    port,
    user: "clausewise",
    password,
    persistent: true,
    onLog: () => {},
    onError: () => {},
  });
  let pid: number | undefined;
  const stop = async (): Promise<void> => {
    try {
      await cluster.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    // Nothing is left: not the folder, and not the server process.
    if (
      await stat(dir).then(
        () => true,
        () => false,
      )
    ) {
      throw new Error("The folder of the test cluster is still there.");
    }
    if (pid !== undefined) {
      for (let attempt = 0; attempt < 50 && isRunning(pid); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (isRunning(pid)) {
        process.kill(pid, "SIGKILL");
        throw new Error("The test cluster's server process did not stop.");
      }
    }
  };
  // The package writes the password to a file in the temporary folder, for initdb to read. That
  // folder must be one the postgres user can read, and the file must go with the cluster.
  const previousTmp = process.env["TMPDIR"];
  process.env["TMPDIR"] = dir;
  try {
    await cluster.initialise();
    await cluster.start();
    pid = Number((await readFile(join(databaseDir, "postmaster.pid"), "utf8")).split("\n")[0]);
    await cluster.createDatabase("clausewise");
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  } finally {
    if (previousTmp === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = previousTmp;
  }
  return { url: `postgres://clausewise:${password}@localhost:${port}/clausewise`, stop };
}

const reason = (error: unknown): string =>
  error instanceof Error && error.message !== ""
    ? error.message.split("\n")[0]!
    : "no reason given";

describe("against a real Postgres", () => {
  it("runs the migrations and the main flows, and keeps its data across a restart", async (context) => {
    const named = process.env[SERVER_URL_VARIABLE]?.trim();
    let cluster: Cluster;
    if (named !== undefined && named !== "") {
      cluster = await useServer(named);
    } else {
      try {
        cluster = await startCluster();
      } catch (error) {
        context.skip(
          `embedded-postgres could not start a Postgres cluster in this environment (${reason(error)}), so the real Postgres integration test did not run. Set ${SERVER_URL_VARIABLE} to the address of a Postgres server to run it against that one.`,
        );
        return;
      }
    }

    const dataDir = await mkdtemp(join(tmpdir(), "clausewise-pgdata-"));
    const servers: RunningServer[] = [];
    let passed = false;
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
      // The files are in the folder even though the database is not: a second server on the same
      // folder is refused, as it is with the embedded database.
      await expect(open()).rejects.toBeInstanceOf(DataFolderInUseError);
      // The migration really ran on this database, and it is one made for this run.
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
      passed = true;
    } finally {
      for (const server of servers) await server.close().catch(() => {});
      await rm(dataDir, { recursive: true, force: true });
      // After a pass, a database or a process that is still there is a failure of its own.
      if (passed) await cluster.stop();
      else await cluster.stop().catch(() => {});
    }
  }, 120_000);
});
