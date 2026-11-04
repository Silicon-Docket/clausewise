import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStore, FileStoreError, MATTER_ID_PATTERN } from "../../src/store/index.js";

const MAT = "mat_0123456789abcdef";
const OTHER = "mat_fedcba9876543210";

let base: string;
let root: string;
let outside: string;
let store: FileStore;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "parol-files-"));
  root = join(base, "root");
  outside = join(base, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "OUTSIDE-SECRET");
  store = new FileStore(root);
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const bytes = (text: string) => new TextEncoder().encode(text);

describe("save and read", () => {
  it("returns a relative path with a generated name, and reads the same bytes back", () => {
    const path = store.save(MAT, bytes("synthetic contract text"));
    expect(path).toMatch(/^mat_0123456789abcdef\/f_[0-9a-f]{32}$/);
    expect(path.startsWith("/")).toBe(false);
    expect(store.read(path).toString("utf8")).toBe("synthetic contract text");
    expect(store.exists(path)).toBe(true);
  });

  it("never uses a name the caller chose, and never repeats one", () => {
    const names = new Set(Array.from({ length: 20 }, () => store.save(MAT, bytes("x"))));
    expect(names.size).toBe(20);
  });

  it("stores files with mode 0600 and folders with mode 0700", () => {
    const path = store.save(MAT, bytes("x"));
    expect(statSync(join(root, path)).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, MAT)).mode & 0o777).toBe(0o700);
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it("leaves no temporary file behind", () => {
    store.save(MAT, bytes("x"));
    store.save(MAT, bytes("y"));
    expect(readdirSync(join(root, MAT)).filter((n) => n.startsWith(".tmp"))).toEqual([]);
  });

  it("handles empty files and large files", () => {
    const empty = store.save(MAT, new Uint8Array());
    expect(store.read(empty).length).toBe(0);
    const big = new Uint8Array(3_000_000).fill(7);
    expect(store.read(store.save(MAT, big)).equals(Buffer.from(big))).toBe(true);
  });

  it("leaves nothing half written when the bytes cannot be written", () => {
    expect(() => store.save(MAT, { length: 5 } as unknown as Uint8Array)).toThrow();
    expect(readdirSync(join(root, MAT))).toEqual([]);
  });

  it("keeps matters in separate folders", () => {
    const a = store.save(MAT, bytes("a"));
    const b = store.save(OTHER, bytes("b"));
    expect(a.split("/")[0]).toBe(MAT);
    expect(b.split("/")[0]).toBe(OTHER);
  });

  it("removes one file", () => {
    const path = store.save(MAT, bytes("x"));
    store.remove(path);
    expect(store.exists(path)).toBe(false);
    expect(() => store.read(path)).toThrow(FileStoreError);
  });
});

describe("matter ids", () => {
  it("matches what newId('mat') produces and nothing looser", () => {
    expect(MATTER_ID_PATTERN.test(MAT)).toBe(true);
    for (const bad of [
      "",
      "mat_",
      "mat_0123456789abcde",
      "mat_0123456789abcdef0",
      "mat_0123456789ABCDEF",
      "mat_0123456789abcdeg",
      "MAT_0123456789abcdef",
      "../mat_0123456789abcdef",
      "mat_0123456789abcdef/",
      "mat_0123456789abcdef/..",
      "mat_0123456789abcdef\n",
      " mat_0123456789abcdef",
      "mat_0123456789abcdef\0",
    ])
      expect(MATTER_ID_PATTERN.test(bad), JSON.stringify(bad)).toBe(false);
  });

  it("is refused on save and on delete", () => {
    for (const bad of ["../escape", "mat_../../x", "mat_0123456789ABCDEF", "", "mat_0123456789abcdef/../..", "/etc"]) {
      expect(() => store.save(bad, bytes("x")), bad).toThrow(FileStoreError);
      expect(() => store.deleteMatter(bad), bad).toThrow(FileStoreError);
    }
    expect(readdirSync(base).sort()).toEqual(["outside", "root"]);
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("traversal", () => {
  const good = `${MAT}/f_${"a".repeat(32)}`;
  it("refuses every path it could not have generated", () => {
    store.save(MAT, bytes("x"));
    const attempts = [
      "../outside/secret.txt",
      "../../../../etc/passwd",
      `${MAT}/../../outside/secret.txt`,
      `${MAT}/..`,
      `${MAT}/.`,
      `${MAT}//f_${"a".repeat(32)}`,
      `/${good}`,
      join(outside, "secret.txt"),
      `${MAT}\\f_${"a".repeat(32)}`,
      `${MAT}/f_${"a".repeat(32)}/extra`,
      `${MAT}/f_${"a".repeat(31)}`,
      `${MAT}/F_${"a".repeat(32)}`,
      `${MAT}/secret.txt`,
      `${MAT}/f_${"a".repeat(32)}\0.txt`,
      `${MAT}/%2e%2e/secret`,
      "",
      MAT,
    ];
    for (const attempt of attempts) {
      expect(() => store.read(attempt), JSON.stringify(attempt)).toThrow(FileStoreError);
      expect(() => store.remove(attempt), JSON.stringify(attempt)).toThrow(FileStoreError);
      expect(store.exists(attempt), JSON.stringify(attempt)).toBe(false);
    }
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("OUTSIDE-SECRET");
  });

  it("refuses a root that is not a path", () => {
    expect(() => new FileStore("")).toThrow(FileStoreError);
    expect(() => new FileStore("a\0b")).toThrow(FileStoreError);
  });

  it("does not create the matter folder for a path it will refuse", () => {
    expect(() => store.read(good)).toThrow(/not found/);
    expect(existsSync(join(root, MAT))).toBe(false);
  });
});

describe("symbolic links", () => {
  it("does not save into a matter folder that is a link to somewhere else", () => {
    symlinkSync(outside, join(root, MAT), "dir");
    expect(() => store.save(MAT, bytes("leak"))).toThrow(FileStoreError);
    expect(readdirSync(outside)).toEqual(["secret.txt"]);
  });

  it("does not read through a matter folder that is a link", () => {
    symlinkSync(outside, join(root, MAT), "dir");
    writeFileSync(join(outside, `f_${"b".repeat(32)}`), "OUTSIDE-FILE");
    expect(() => store.read(`${MAT}/f_${"b".repeat(32)}`)).toThrow(FileStoreError);
  });

  it("does not read a file that is a link", () => {
    const path = store.save(MAT, bytes("real"));
    const linked = `${MAT}/f_${"c".repeat(32)}`;
    symlinkSync(join(outside, "secret.txt"), join(root, linked));
    expect(() => store.read(linked)).toThrow(FileStoreError);
    expect(store.exists(linked)).toBe(false);
    expect(store.read(path).toString()).toBe("real");
  });

  it("does not delete through a file link, and removes only the link", () => {
    store.save(MAT, bytes("real"));
    const linked = `${MAT}/f_${"c".repeat(32)}`;
    symlinkSync(join(outside, "secret.txt"), join(root, linked));
    expect(() => store.remove(linked)).toThrow(FileStoreError);
    store.deleteMatter(MAT);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("OUTSIDE-SECRET");
    expect(existsSync(join(root, MAT))).toBe(false);
  });

  it("removes a matter folder that is itself a link without touching its target", () => {
    symlinkSync(outside, join(root, MAT), "dir");
    store.deleteMatter(MAT);
    expect(existsSync(join(root, MAT))).toBe(false);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("OUTSIDE-SECRET");
  });

  it("works when the root was given through a link, by resolving it once", () => {
    const alias = join(base, "alias");
    symlinkSync(root, alias, "dir");
    const viaAlias = new FileStore(alias);
    const path = viaAlias.save(MAT, bytes("x"));
    expect(viaAlias.read(path).toString()).toBe("x");
    expect(store.read(path).toString()).toBe("x");
  });
});

describe("deleteMatter", () => {
  it("removes the folder and everything in it, and counts the files", () => {
    store.save(MAT, bytes("1"));
    store.save(MAT, bytes("2"));
    const keep = store.save(OTHER, bytes("keep"));
    expect(store.deleteMatter(MAT)).toBe(2);
    expect(existsSync(join(root, MAT))).toBe(false);
    expect(store.read(keep).toString()).toBe("keep");
  });

  it("is quiet about a matter that has no folder", () => {
    expect(store.deleteMatter(MAT)).toBe(0);
  });
});
