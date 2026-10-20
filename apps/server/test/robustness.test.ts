import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { stopOnUncaught } from "../src/crash.js";
import type { Db } from "../src/db/client.js";
import { createJobRunner } from "../src/jobs.js";
import { createLogger, type Logger } from "../src/log.js";
import { startServer } from "../src/start.js";
import {
  captureLog,
  createHarness,
  fakeClock,
  later,
  oracleFor,
  tempDir,
  testConfig,
} from "./support.js";

// The servers that the HTTP adapter makes, so that a test can make one of them report an error.
const made = vi.hoisted(() => ({ servers: [] as Server[] }));
vi.mock("@hono/node-server", async (importOriginal) => {
  const original = await importOriginal<typeof import("@hono/node-server")>();
  return {
    ...original,
    createAdaptorServer: (...args: Parameters<typeof original.createAdaptorServer>) => {
      const server = original.createAdaptorServer(...args);
      made.servers.push(server as Server);
      return server;
    },
  };
});

const SECRET = "the Recipient shall pay a penalty of one million dollars";

describe("an error nobody caught, in the runner", () => {
  it("does not end the process when a review fails and the log cannot be written either", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", record);
    later(async () => {
      process.off("unhandledRejection", record);
    });

    const t = await createHarness({ generator: await oracleFor("nda-aggressive.docx") });
    // A database that works until the runner has started, and then goes away.
    let down = false;
    const flaky = new Proxy(t.database.db, {
      get(target, property, receiver) {
        if (property === "update" && down) {
          return () => {
            throw new Error(SECRET);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    }) as Db;
    // A log that fails as well.
    const brokenLog: Logger = {
      ...captureLog(fakeClock()).log,
      error: () => {
        throw new Error(SECRET);
      },
    };
    const runner = createJobRunner({
      db: flaky,
      storage: t.storage,
      model: { generator: await oracleFor("nda-aggressive.docx"), limits: {} },
      config: t.config,
      clock: t.clock,
      log: brokenLog,
    });
    await runner.start();
    later(() => runner.stop());

    down = true;
    runner.enqueue("00000000-0000-4000-8000-0000000000bb");
    await runner.idle();
    // The rejection, if there was one, is reported on the next turn of the event loop.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(unhandled).toEqual([]);

    // And the runner is not left stuck: it takes the next review.
    down = false;
    runner.enqueue("00000000-0000-4000-8000-0000000000cc");
    await runner.idle();
    expect(runner.waiting()).toBe(0);
  });
});

describe("an error nobody caught, in the process", () => {
  it("is logged by its kind and where it came from, never by what it said, and the process stops", () => {
    const target = new EventEmitter();
    const { log, lines } = captureLog(fakeClock());
    const exits: number[] = [];
    stopOnUncaught({ target, log, exit: (code) => exits.push(code) });

    class ContractError extends Error {
      override name = "ContractError";
    }
    target.emit("unhandledRejection", new ContractError(SECRET));
    target.emit("uncaughtException", new TypeError(SECRET));
    // Something that is not an error at all, as a rejection can be.
    target.emit("unhandledRejection", SECRET);

    expect(exits).toEqual([1, 1, 1]);
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toEqual([
      expect.objectContaining({
        level: "error",
        msg: "an unhandled promise rejection",
        name: "ContractError",
      }),
      expect.objectContaining({ level: "error", msg: "an uncaught exception", name: "TypeError" }),
      expect.objectContaining({
        level: "error",
        msg: "an unhandled promise rejection",
        name: "Error",
        frames: [],
      }),
    ]);
    expect(lines.join("\n")).not.toContain("penalty");
  });

  it("stops the process even when the log cannot be written", () => {
    const target = new EventEmitter();
    const exits: number[] = [];
    const log: Logger = {
      ...captureLog(fakeClock()).log,
      error: () => {
        throw new Error("the log is closed");
      },
    };
    stopOnUncaught({ target, log, exit: (code) => exits.push(code) });
    expect(() => target.emit("uncaughtException", new Error("x"))).toThrow("the log is closed");
    expect(exits).toEqual([1]);
  });
});

describe("the HTTP server after it is listening", () => {
  it("logs an error it reports instead of ending the process with it, and goes on serving", async () => {
    const dataDir = await tempDir();
    const clock = fakeClock();
    const { log, lines } = captureLog(clock);
    const before = made.servers.length;
    const running = await startServer({
      config: testConfig(dataDir),
      generator: await oracleFor("nda-aggressive.docx"),
      log,
      database: { kind: "memory" },
    });
    later(() => running.close());
    const server = made.servers[before];
    if (server === undefined) throw new Error("the adapter made no server");

    // With no listener, emitting an error event throws it.
    expect(() => server.emit("error", new Error(SECRET))).not.toThrow();
    const entry = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((item) => item["msg"] === "the HTTP server reported an error");
    expect(entry).toMatchObject({ level: "error", name: "Error" });
    expect(lines.join("\n")).not.toContain("penalty");
    expect((await fetch(`${running.url}/healthz`)).status).toBe(200);
  });
});
