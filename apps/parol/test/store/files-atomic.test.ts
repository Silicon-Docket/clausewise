import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The file store imports `renameSync` from node:fs by name, so the only way to watch the moment of
// the rename is to replace that export. The wrapper records what the disk looked like just before it.
const spy = vi.hoisted(() => ({
  calls: [] as { from: string; to: string; tempSize: number; finalExisted: boolean }[],
  failNext: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      spy.calls.push({
        from,
        to,
        tempSize: actual.statSync(from).size,
        finalExisted: actual.existsSync(to),
      });
      if (spy.failNext) {
        spy.failNext = false;
        throw new Error("rename failed");
      }
      return actual.renameSync(from, to);
    },
  };
});

const { FileStore } = await import("../../src/store/files.js");

const MAT = "mat_0123456789abcdef";
let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "parol-atomic-"));
  spy.calls.length = 0;
  spy.failNext = false;
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("FileStore atomicity", () => {
  it("writes the whole file to a temporary name in the same folder and renames it into place", () => {
    const store = new FileStore(join(base, "root"));
    const data = new Uint8Array(100_000).fill(3);
    const path = store.save(MAT, data);

    expect(spy.calls).toHaveLength(1);
    const call = spy.calls[0];
    expect(call?.to).toBe(join(store.root, path));
    // Complete before the rename, under a different name, and nothing at the final name yet.
    expect(call?.tempSize).toBe(100_000);
    expect(call?.from).not.toBe(call?.to);
    expect(call?.finalExisted).toBe(false);
    // Same folder, so the rename cannot cross a file system and is atomic.
    expect(call?.from.startsWith(join(store.root, MAT))).toBe(true);
    expect(statSync(join(store.root, path)).size).toBe(100_000);
  });

  it("leaves neither the temporary file nor the final file when the rename fails", () => {
    const store = new FileStore(join(base, "root"));
    spy.failNext = true;
    expect(() => store.save(MAT, new Uint8Array([1, 2, 3]))).toThrow("rename failed");
    expect(readdirSync(join(store.root, MAT))).toEqual([]);
  });

  it("keeps an earlier file intact when a later save fails", () => {
    const store = new FileStore(join(base, "root"));
    const first = store.save(MAT, new Uint8Array([1, 2, 3]));
    spy.failNext = true;
    expect(() => store.save(MAT, new Uint8Array([9, 9, 9]))).toThrow();
    expect([...store.read(first)]).toEqual([1, 2, 3]);
    expect(readdirSync(join(store.root, MAT))).toHaveLength(1);
  });
});
