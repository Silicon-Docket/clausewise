import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULTS, isLoopbackHost, readConfig } from "../src/config.js";

describe("readConfig", () => {
  it("uses the defaults of the design when nothing is set", () => {
    expect(readConfig({})).toEqual({
      host: "127.0.0.1",
      port: 8787,
      databaseUrl: undefined,
      dataDir: "./data",
      playbooksDir: "./playbooks",
      webDir: "./apps/web/dist",
      accessToken: undefined,
      allowedHosts: [],
      maxUploadBytes: 25 * 1024 * 1024,
      reviewConcurrency: 1,
      maxQueued: 20,
      maxReviewsPerDocument: 200,
      progressIntervalMs: 500,
    });
    expect(DEFAULTS.port).toBe(8787);
  });

  it("reads every variable, and trims what was pasted with a newline", () => {
    const config = readConfig({
      HOST: "0.0.0.0\n",
      PORT: "9000",
      DATABASE_URL: "postgres://user:pw@db:5432/clausewise",
      CLAUSEWISE_DATA_DIR: "/data",
      CLAUSEWISE_PLAYBOOKS_DIR: "/app/playbooks",
      CLAUSEWISE_WEB_DIR: "/app/web",
      CLAUSEWISE_ACCESS_TOKEN: "0123456789abcdef\n",
      CLAUSEWISE_ALLOWED_HOSTS: " Clausewise.Example.org , internal:9000 ,, ",
      CLAUSEWISE_MAX_UPLOAD_MB: "10",
      CLAUSEWISE_REVIEW_CONCURRENCY: "3",
      CLAUSEWISE_MAX_QUEUED: "0",
    });
    expect(config).toMatchObject({
      host: "0.0.0.0",
      port: 9000,
      databaseUrl: "postgres://user:pw@db:5432/clausewise",
      dataDir: "/data",
      playbooksDir: "/app/playbooks",
      webDir: "/app/web",
      accessToken: "0123456789abcdef",
      allowedHosts: ["clausewise.example.org", "internal:9000"],
      maxUploadBytes: 10 * 1024 * 1024,
      reviewConcurrency: 3,
      maxQueued: 0,
    });
    expect(readConfig({ DATABASE_URL: "postgresql://x/y" }).databaseUrl).toBe("postgresql://x/y");
    expect(readConfig({ PORT: "0" }).port).toBe(0);
  });

  it("treats a blank variable as unset", () => {
    expect(
      readConfig({ PORT: "  ", DATABASE_URL: "", CLAUSEWISE_ACCESS_TOKEN: " " }),
    ).toMatchObject({
      port: 8787,
      databaseUrl: undefined,
      accessToken: undefined,
    });
  });

  const bad: [Record<string, string>, RegExp][] = [
    [{ PORT: "abc" }, /PORT must be a whole number from 0 to 65535/],
    [{ PORT: "70000" }, /PORT must be/],
    [{ PORT: "-1" }, /PORT must be/],
    [{ PORT: "80.5" }, /PORT must be/],
    [
      { CLAUSEWISE_MAX_UPLOAD_MB: "0" },
      /CLAUSEWISE_MAX_UPLOAD_MB must be a whole number from 1 to 1024/,
    ],
    [{ CLAUSEWISE_MAX_UPLOAD_MB: "2000" }, /CLAUSEWISE_MAX_UPLOAD_MB/],
    [{ CLAUSEWISE_REVIEW_CONCURRENCY: "0" }, /CLAUSEWISE_REVIEW_CONCURRENCY/],
    [{ CLAUSEWISE_REVIEW_CONCURRENCY: "99" }, /CLAUSEWISE_REVIEW_CONCURRENCY/],
    [{ CLAUSEWISE_MAX_QUEUED: "many" }, /CLAUSEWISE_MAX_QUEUED/],
    [
      { CLAUSEWISE_ACCESS_TOKEN: "short" },
      /CLAUSEWISE_ACCESS_TOKEN must be at least 16 characters/,
    ],
    [{ DATABASE_URL: "mysql://root:hunter2@db/x" }, /DATABASE_URL must be a PostgreSQL address/],
  ];
  for (const [env, message] of bad) {
    it(`refuses ${JSON.stringify(Object.keys(env))} with a value that does not fit`, () => {
      expect(() => readConfig(env)).toThrow(ConfigError);
      expect(() => readConfig(env)).toThrow(message);
    });
  }

  it("never repeats a value in its messages, because a mistyped variable can hold a secret", () => {
    for (const env of [
      { CLAUSEWISE_ACCESS_TOKEN: "hunter2-short" },
      { DATABASE_URL: "mysql://root:hunter2@db/x" },
      { PORT: "hunter2" },
    ]) {
      try {
        readConfig(env);
        throw new Error("expected a ConfigError");
      } catch (error) {
        expect((error as Error).message).not.toContain("hunter2");
      }
    }
  });
});

describe("isLoopbackHost", () => {
  it("is true only for addresses that this machine alone can reach", () => {
    for (const host of [
      "127.0.0.1",
      "127.1.2.3",
      "localhost",
      "LOCALHOST",
      "::1",
      "[::1]",
      "0:0:0:0:0:0:0:1",
    ]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of [
      "0.0.0.0",
      "::",
      "192.168.1.5",
      "10.0.0.1",
      "example.org",
      "127.example.org",
      "128.0.0.1",
      "",
    ]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});
