import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ConfigResponse,
  DocumentListResponse,
  DocumentSummary,
  ReviewDetail,
  ReviewSummary,
} from "@clausewise/api";
import type { ObjectGenerator } from "@clausewise/llm";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { DatabaseError, openDatabase } from "../src/db/client.js";
import { reviews } from "../src/db/schema.js";
import { serverUrl, startServer, type RunningServer } from "../src/start.js";
import {
  captureLog,
  controllable,
  fakeClock,
  fixtureBytes,
  later,
  oracleFor,
  tempDir,
  testConfig,
} from "./support.js";

async function server(
  options: {
    config?: Partial<ServerConfig>;
    env?: Record<string, string | undefined>;
    generator?: ObjectGenerator;
  } = {},
): Promise<{ server: RunningServer; lines: string[]; dataDir: string }> {
  const dataDir = await tempDir();
  const { log, lines } = captureLog(fakeClock());
  const generator =
    options.generator ??
    (options.env === undefined ? await oracleFor("nda-aggressive.docx") : undefined);
  const running = await startServer({
    config: testConfig(dataDir, options.config),
    // With an environment to read and no model passed, the model comes from the environment.
    ...(generator === undefined ? {} : { generator }),
    ...(options.env === undefined ? {} : { env: options.env }),
    log,
    database: { kind: "memory" },
  });
  later(() => running.close());
  return { server: running, lines, dataDir };
}

async function call<T>(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: (text === "" ? undefined : JSON.parse(text)) as T };
}

describe("starting the server", () => {
  it("listens on a free port and carries a whole review over real HTTP", async () => {
    const { server: running } = await server();
    expect(running.port).toBeGreaterThan(0);
    expect(running.url).toBe(`http://127.0.0.1:${running.port}`);

    expect((await call(running.url, "/healthz")).body).toEqual({ ok: true });

    const form = new FormData();
    form.set("file", new File([await fixtureBytes("nda-aggressive.docx")], "nda.docx"));
    const upload = await call<DocumentSummary>(running.url, "/api/documents", {
      method: "POST",
      body: form,
    });
    expect(upload.status).toBe(201);
    const started = await call<ReviewSummary>(running.url, "/api/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: upload.body.id, playbookId: "builtin:nda-mutual" }),
    });
    expect(started.status).toBe(202);
    let detail: ReviewDetail | undefined;
    for (let attempt = 0; attempt < 300 && detail?.status !== "done"; attempt += 1) {
      detail = (await call<ReviewDetail>(running.url, `/api/reviews/${started.body.id}`)).body;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(detail?.status).toBe("done");
    expect(detail?.findings).toHaveLength(10);

    const download = await fetch(`${running.url}/api/documents/${upload.body.id}/file`);
    expect(download.headers.get("content-disposition")).toBe(
      `attachment; filename="nda.docx"; filename*=UTF-8''nda.docx`,
    );
    expect(
      Buffer.compare(
        new Uint8Array(await download.arrayBuffer()),
        await fixtureBytes("nda-aggressive.docx"),
      ),
    ).toBe(0);
  });

  it("refuses a request addressed to another name, as a browser tricked by DNS rebinding would send", async () => {
    const { server: running } = await server();
    const { request } = await import("node:http");
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const outgoing = request(
        {
          host: "127.0.0.1",
          port: running.port,
          path: "/api/documents",
          headers: { Host: "attacker.example" },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
    expect(status).toBe(421);
  });

  it("logs where the text goes, and nothing about the key", async () => {
    const { lines } = await server();
    const text = lines.join("\n");
    expect(text).toContain("Clausewise is running");
    expect(text).toContain(
      "Reviews are sent to: a scripted test oracle (nothing is sent anywhere)",
    );
    expect(text).toContain('"provider":"oracle"');
    expect(text).not.toContain("without an access token");
  });

  it(
    "warns, once, when it listens beyond this machine with no token",
    { timeout: 30_000 },
    async () => {
      const open = await server({ config: { host: "0.0.0.0" } });
      expect(open.lines.filter((line) => line.includes("without an access token"))).toHaveLength(1);
      expect(open.lines.join("\n")).toContain('"level":"warn"');
      expect(open.server.url).toMatch(/^http:\/\/localhost:\d+$/);

      const guarded = await server({
        config: { host: "0.0.0.0", accessToken: "0123456789abcdef0123" },
      });
      expect(guarded.lines.join("\n")).not.toContain("without an access token");
      // A loopback address needs no warning.
      const local = await server();
      expect(local.lines.join("\n")).not.toContain("without an access token");
    },
  );

  it("writes the address a person can open, for every kind of host", () => {
    expect(serverUrl("127.0.0.1", 8787)).toBe("http://127.0.0.1:8787");
    expect(serverUrl("localhost", 80)).toBe("http://localhost:80");
    expect(serverUrl("0.0.0.0", 8787)).toBe("http://localhost:8787");
    expect(serverUrl("::", 8787)).toBe("http://localhost:8787");
    expect(serverUrl("::1", 8787)).toBe("http://[::1]:8787");
    expect(serverUrl("[::1]", 8787)).toBe("http://[::1]:8787");
    expect(serverUrl("clausewise.example.org", 443)).toBe("http://clausewise.example.org:443");
  });

  it(
    "takes its model from the environment when none is passed, and a missing key does not stop it",
    { timeout: 30_000 },
    async () => {
      const without = await server({ env: {} });
      const missing = await call<ConfigResponse>(without.server.url, "/api/config");
      expect(missing.body.model).toEqual({
        configured: false,
        problem:
          "ANTHROPIC_API_KEY is required when CLAUSEWISE_PROVIDER is anthropic. Set it to your Anthropic API key.",
      });
      expect(without.lines.join("\n")).toContain(
        "The model is not configured, so reviews cannot run.",
      );

      const secret = "sk-ant-api03-SECRET-0123456789";
      const withKey = await server({
        env: { ANTHROPIC_API_KEY: secret, CLAUSEWISE_MODEL: "claude-test-model" },
      });
      const configured = await call<ConfigResponse>(withKey.server.url, "/api/config");
      expect(configured.body.model).toEqual({
        configured: true,
        provider: "anthropic",
        model: "claude-test-model",
        disclosure: "Anthropic API (api.anthropic.com)",
      });
      expect(JSON.stringify(configured.body)).not.toContain(secret);
      expect(withKey.lines.join("\n")).not.toContain(secret);

      const wrong = await server({
        env: { CLAUSEWISE_PROVIDER: "carrier-pigeon", ANTHROPIC_API_KEY: secret },
      });
      const problem = await call<ConfigResponse>(wrong.server.url, "/api/config");
      expect(JSON.stringify(problem.body)).toContain("CLAUSEWISE_PROVIDER must be one of");
      expect(JSON.stringify(problem.body)).not.toContain(secret);
    },
  );
});

describe("stopping the server", () => {
  it("cancels the review that is running, closes the port, and may be asked twice", async () => {
    const control = controllable(await oracleFor("nda-aggressive.docx"));
    const { server: running } = await server({ generator: control.generator });
    const form = new FormData();
    form.set("file", new File([await fixtureBytes("nda-aggressive.docx")], "nda.docx"));
    const upload = await call<DocumentSummary>(running.url, "/api/documents", {
      method: "POST",
      body: form,
    });
    const started = await call<ReviewSummary>(running.url, "/api/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: upload.body.id, playbookId: "builtin:nda-mutual" }),
    });
    await control.calls(1);

    await Promise.all([running.close(), running.close()]);
    expect(control.signals.every((signal) => signal.aborted)).toBe(true);
    await expect(fetch(`${running.url}/healthz`)).rejects.toThrow();
    await running.close();
    expect(started.status).toBe(202);
  });
});

describe("the database across restarts", () => {
  it("keeps documents and reviews on disk, fails the review a crash interrupted, and runs the one it left waiting", async () => {
    const dataDir = await tempDir();
    const { log, lines } = captureLog(fakeClock());
    const open = async (
      generator:
        Awaited<ReturnType<typeof oracleFor>> | ReturnType<typeof controllable>["generator"],
    ) => {
      const running = await startServer({
        config: testConfig(dataDir),
        generator,
        log,
      });
      later(() => running.close());
      return running;
    };

    const control = controllable(await oracleFor("nda-aggressive.docx"), { open: true });
    const first = await open(control.generator);
    const form = new FormData();
    form.set("file", new File([await fixtureBytes("nda-aggressive.docx")], "nda.docx"));
    const upload = await call<DocumentSummary>(first.url, "/api/documents", {
      method: "POST",
      body: form,
    });
    const start = () =>
      call<ReviewSummary>(first.url, "/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: upload.body.id, playbookId: "builtin:nda-mutual" }),
      });
    const finished = await start();
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const { body } = await call<ReviewDetail>(first.url, `/api/reviews/${finished.body.id}`);
      if (body.status === "done") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await first.close();

    // What the files hold now: a review that was running when the process died, and one that waited.
    const database = await openDatabase({ kind: "pglite", dataDir });
    const [seed] = await database.db.select().from(reviews).where(eq(reviews.id, finished.body.id));
    if (seed === undefined) throw new Error("the finished review was not saved");
    const make = (id: string, status: "running" | "queued") =>
      database.db.insert(reviews).values({
        ...seed,
        id,
        status,
        report: null,
        context: null,
        error: null,
        startedAt: status === "running" ? new Date() : null,
        finishedAt: null,
      });
    await make("00000000-0000-4000-8000-00000000aaaa", "running");
    await make("00000000-0000-4000-8000-00000000bbbb", "queued");
    await database.close();

    const second = await open(control.generator);
    const documents = await call<DocumentListResponse>(second.url, "/api/documents");
    expect(documents.body.documents).toEqual([
      expect.objectContaining({ id: upload.body.id, reviewCount: 3 }),
    ]);
    const interrupted = await call<ReviewDetail>(
      second.url,
      "/api/reviews/00000000-0000-4000-8000-00000000aaaa",
    );
    expect(interrupted.body).toMatchObject({
      status: "failed",
      error: "The server restarted while this review was running. Start it again.",
    });
    let waiting: ReviewDetail | undefined;
    for (let attempt = 0; attempt < 300 && waiting?.status !== "done"; attempt += 1) {
      waiting = (
        await call<ReviewDetail>(second.url, "/api/reviews/00000000-0000-4000-8000-00000000bbbb")
      ).body;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(waiting?.status).toBe("done");
    // The review that had finished is still finished, with its findings.
    const kept = await call<ReviewDetail>(second.url, `/api/reviews/${finished.body.id}`);
    expect(kept.body.status).toBe("done");
    expect(kept.body.findings).toHaveLength(10);
    expect(lines.length).toBeGreaterThan(0);

    // The embedded database lives in a private folder inside the data directory.
    expect((await stat(join(dataDir, "pglite"))).isDirectory()).toBe(true);
    expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
  });
});

describe("a start that cannot succeed", () => {
  const dead = async (promise: Promise<unknown>): Promise<Error> => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof Error) return error;
    }
    throw new Error("expected the start to fail");
  };

  it("stops with a clear message when a migration fails, without the SQL", async () => {
    const folder = await tempDir("clausewise-migrations-");
    await mkdir(join(folder, "meta"), { recursive: true });
    await writeFile(
      join(folder, "meta", "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [{ idx: 0, version: "7", when: 1, tag: "0000_broken", breakpoints: true }],
      }),
    );
    await writeFile(join(folder, "0000_broken.sql"), 'CREATE TABLE "secret_table_name" (;');
    const error = await dead(
      startServer({
        config: testConfig(await tempDir()),
        generator: await oracleFor("nda-aggressive.docx"),
        log: captureLog(fakeClock()).log,
        database: { kind: "memory" },
        migrationsFolder: folder,
      }),
    );
    expect(error).toBeInstanceOf(DatabaseError);
    expect(error.message).toContain(
      "The database could not be set up, so the server did not start",
    );
    expect(error.message).not.toContain("secret_table_name");
    expect(error.message).not.toContain("CREATE TABLE");
  });

  it("stops when the migration files are missing", async () => {
    const empty = await tempDir("clausewise-migrations-");
    const error = await dead(
      startServer({
        config: testConfig(await tempDir()),
        generator: await oracleFor("nda-aggressive.docx"),
        log: captureLog(fakeClock()).log,
        database: { kind: "memory" },
        migrationsFolder: empty,
      }),
    );
    expect(error).toBeInstanceOf(DatabaseError);
  });

  it("finds the committed migrations next to the sources, and applies them twice without harm", async () => {
    const dataDir = await tempDir();
    const config = testConfig(dataDir);
    for (let run = 0; run < 2; run += 1) {
      const running = await startServer({
        config,
        generator: await oracleFor("nda-aggressive.docx"),
        log: captureLog(fakeClock()).log,
      });
      expect((await call(running.url, "/api/documents")).status).toBe(200);
      await running.close();
    }
  });

  it("stops when the database cannot be reached, without repeating the password", async () => {
    const error = await dead(
      startServer({
        config: testConfig(await tempDir(), {
          databaseUrl: "postgres://clausewise:pw-SECRET-123@127.0.0.1:1/clausewise",
        }),
        generator: await oracleFor("nda-aggressive.docx"),
        log: captureLog(fakeClock()).log,
      }),
    );
    expect(error).toBeInstanceOf(DatabaseError);
    expect(error.message).toContain("Cannot connect to the database");
    expect(error.message).not.toContain("pw-SECRET-123");
    expect(error.message).not.toContain("postgres://");
  });

  it("stops when the port is taken, and leaves the first server running", async () => {
    const { server: first } = await server();
    const error = await dead(
      startServer({
        config: testConfig(await tempDir(), { port: first.port }),
        generator: await oracleFor("nda-aggressive.docx"),
        log: captureLog(fakeClock()).log,
        database: { kind: "memory" },
      }),
    );
    expect(error.message).toContain("EADDRINUSE");
    expect((await call(first.url, "/healthz")).status).toBe(200);
  });
});
