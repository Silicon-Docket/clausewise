import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { acquireInstanceLock } from "../../src/boot/instance-lock.js";
import { StartupError, start, type RunningServer } from "../../src/main.js";
import { addMatter, startRun, type World } from "../store/fixtures.js";

/**
 * Two servers must not share a data folder. Starting marks the runs it finds in flight as
 * interrupted, which is right after a crash and destroys the live runs of a server that is up.
 */

const roots: string[] = [];
const running: RunningServer[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) await server.close();
});
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const env = (dataDir: string, port = "0"): Record<string, string> => ({
  PAROL_DEMO_IDENTITY: "1",
  PAROL_SCRIPTED: "1",
  PAROL_PORT: port,
  PAROL_DATA_DIR: dataDir,
  PAROL_COOKIE_SECRET: "single-instance-secret-single-instance-01",
});

const folder = (): string => {
  const root = mkdtempSync(join(tmpdir(), "parol-single-"));
  roots.push(root);
  return join(root, "data");
};

describe("a second server on the same data folder", () => {
  it("is refused before it touches anything, and leaves the first server's live run alone", async () => {
    const dataDir = folder();
    const first = await start(env(dataDir), { log: () => {}, notice: () => {} });
    running.push(first);

    // A run in flight in the first server, as a slow provider call would leave it.
    const repo = first.repo;
    const world = {
      repo,
      playbook: repo.listPlaybookVersions()[0],
      workflow: repo.getWorkflowVersionByLabel("v1"),
    } as unknown as World;
    const matter = addMatter(world);
    const live = startRun(world, matter, "analyzing");

    const logs: string[] = [];
    const error = await start(env(dataDir, "0"), {
      log: (line) => logs.push(line),
      notice: () => {},
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StartupError);
    expect((error as Error).message).toMatch(
      /another Parol server is already using this data folder/,
    );
    // The folder's path is not repeated: a mistyped variable can hold anything.
    expect((error as Error).message).not.toContain(dataDir);
    expect(logs.join("\n")).not.toContain("interrupted by a restart");
    expect(repo.getRun(matter.id, live.id)?.status).toBe("analyzing");
    expect(repo.getMatter(matter.id)?.status).toBe("running");
  });

  it("can start once the first has stopped, and finds its unfinished run interrupted", async () => {
    const dataDir = folder();
    const first = await start(env(dataDir), { log: () => {}, notice: () => {} });
    const repo = first.repo;
    const world = {
      repo,
      playbook: repo.listPlaybookVersions()[0],
      workflow: repo.getWorkflowVersionByLabel("v1"),
    } as unknown as World;
    const matter = addMatter(world);
    const live = startRun(world, matter, "analyzing");
    await first.close();

    const logs: string[] = [];
    const second = await start(env(dataDir), { log: (l) => logs.push(l), notice: () => {} });
    running.push(second);
    expect(logs.some((l) => l.includes(live.id) && l.includes("interrupted by a restart"))).toBe(
      true,
    );
    expect(second.repo.getRun(matter.id, live.id)).toMatchObject({
      status: "failed",
      errorKind: "interrupted",
    });
  });

  it("gives the folder back when the start fails, so that the next try can have it", async () => {
    const dataDir = folder();
    const first = await start(env(dataDir), { log: () => {}, notice: () => {} });
    running.push(first);
    // Another folder, the first one's port: the listen fails after the folder was taken.
    const other = folder();
    await expect(
      start(env(other, String(first.port)), { log: () => {}, notice: () => {} }),
    ).rejects.toThrow();
    const again = acquireInstanceLock(other);
    expect(again).not.toBeNull();
    again?.release();
  });
});
