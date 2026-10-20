import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileStorage, createMemoryStorage } from "../src/storage.js";
import { tempDir } from "./support.js";

const KEY = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";

describe("file storage", () => {
  it("writes, reads and removes a file, with private permissions", async () => {
    const dir = join(await tempDir(), "documents");
    const storage = await createFileStorage(dir);
    await storage.write(KEY, new Uint8Array([1, 2, 3, 4]));

    expect(Array.from((await storage.read(KEY)) ?? [])).toEqual([1, 2, 3, 4]);
    expect((await stat(join(dir, KEY))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(await readdir(dir)).toEqual([KEY]);

    await storage.remove(KEY);
    expect(await storage.read(KEY)).toBeUndefined();
    // A file that is already gone is not an error.
    await expect(storage.remove(KEY)).resolves.toBeUndefined();
    await expect(storage.remove(OTHER)).resolves.toBeUndefined();
  });

  it("makes a folder that was too open private", async () => {
    const dir = join(await tempDir(), "documents");
    await mkdir(dir, { mode: 0o755 });
    await createFileStorage(dir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("replaces a file whole, and leaves the old one and no temporary file when the write fails", async () => {
    const dir = join(await tempDir(), "documents");
    const storage = await createFileStorage(dir);
    await storage.write(KEY, new Uint8Array([1, 1, 1]));
    await storage.write(KEY, new Uint8Array([2, 2]));
    expect(Array.from((await storage.read(KEY)) ?? [])).toEqual([2, 2]);

    // A directory in the place of the file makes the final rename fail, after the data was written.
    await mkdir(join(dir, OTHER));
    await writeFile(join(dir, OTHER, "keep"), "x");
    await expect(storage.write(OTHER, new Uint8Array([9]))).rejects.toThrow();
    expect((await readdir(dir)).sort()).toEqual([KEY, OTHER].sort());
    expect(await readFile(join(dir, OTHER, "keep"), "utf8")).toBe("x");
    expect(Array.from((await storage.read(KEY)) ?? [])).toEqual([2, 2]);
  });

  it("removes the temporary files a crash left behind when it starts, and nothing else", async () => {
    const dir = join(await tempDir(), "documents");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${KEY}.abcdef.tmp`), "half a contract");
    await writeFile(join(dir, OTHER), "a whole one");
    const storage = await createFileStorage(dir);
    expect(await readdir(dir)).toEqual([OTHER]);
    expect(Buffer.from((await storage.read(OTHER)) ?? []).toString()).toBe("a whole one");
  });

  it("refuses a key that is not one it made, so that no name can point outside the folder", async () => {
    const dir = join(await tempDir(), "documents");
    const storage = await createFileStorage(dir);
    for (const key of [
      "../outside",
      "/etc/passwd",
      "a",
      "",
      `${KEY}/..`,
      `${KEY}\u0000`,
      "AAAAAAAA-2222-4333-8444-555555555555",
    ]) {
      await expect(storage.write(key, new Uint8Array(1)), key).rejects.toThrow(
        "Invalid storage key",
      );
      await expect(storage.read(key), key).rejects.toThrow("Invalid storage key");
      await expect(storage.remove(key), key).rejects.toThrow("Invalid storage key");
    }
    expect(await readdir(dir)).toEqual([]);
  });

  it("is mirrored by the in-memory storage used by tests", async () => {
    const storage = createMemoryStorage();
    await storage.write(KEY, new Uint8Array([7]));
    expect(Array.from((await storage.read(KEY)) ?? [])).toEqual([7]);
    await storage.remove(KEY);
    expect(await storage.read(KEY)).toBeUndefined();
  });
});
