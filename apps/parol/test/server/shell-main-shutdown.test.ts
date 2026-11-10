import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * The orderly stop: stop accepting, let requests finish, wait for the runs that are still going,
 * then close the database. The runs are the real service's business, so here the services are a
 * stand-in whose `idle()` the test holds open.
 */
const control = vi.hoisted(() => ({
  release: undefined as (() => void) | undefined,
  idleCalls: 0,
  databaseOpenWhenIdleWaits: [] as boolean[],
  probe: undefined as (() => boolean) | undefined,
}));

vi.mock("../../src/services/index.js", () => ({
  createServices: () => {
    const refuse = (): never => {
      throw new Error("a stand-in service was called");
    };
    const unused = new Proxy({}, { get: () => refuse });
    return {
      matters: unused,
      reviews: unused,
      evaluations: unused,
      audit: unused,
      runs: {
        idle: () => {
          control.idleCalls += 1;
          control.databaseOpenWhenIdleWaits.push(control.probe?.() ?? false);
          return new Promise<void>((resolve) => {
            control.release = resolve;
          });
        },
      },
    };
  },
}));

const { start } = await import("../../src/main.js");

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function boot() {
  const root = mkdtempSync(join(tmpdir(), "parol-shutdown-"));
  roots.push(root);
  const server = await start(
    {
      PAROL_DEMO_IDENTITY: "1",
      PAROL_SCRIPTED: "1",
      PAROL_PORT: "0",
      PAROL_DATA_DIR: join(root, "data"),
      PAROL_COOKIE_SECRET: "shutdown-secret-shutdown-secret-0001",
    },
    { log: () => {}, notice: () => {} },
  );
  control.probe = () => {
    try {
      server.repo.listUsers();
      return true;
    } catch {
      return false;
    }
  };
  return server;
}

describe("stopping the server", () => {
  it("waits for the runs still working, and keeps the database open until they are done", async () => {
    control.idleCalls = 0;
    control.databaseOpenWhenIdleWaits.length = 0;
    const server = await boot();
    let closed = false;
    const stopping = server.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // It has stopped accepting and is now waiting on the runs.
    expect(control.idleCalls).toBe(1);
    expect(closed).toBe(false);
    expect(server.repo.listUsers().length).toBe(4);
    await expect(fetch(`http://127.0.0.1:${server.port}/healthz`)).rejects.toThrow();
    control.release?.();
    await stopping;
    expect(closed).toBe(true);
    expect(() => server.repo.listUsers()).toThrow();
    expect(control.databaseOpenWhenIdleWaits).toEqual([true]);
  });

  it("asks once however many times it is asked to stop", async () => {
    control.idleCalls = 0;
    const server = await boot();
    const first = server.close();
    const second = server.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    control.release?.();
    await Promise.all([first, second]);
    expect(control.idleCalls).toBe(1);
  });
});
