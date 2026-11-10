import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_SOURCE,
  createComparisonSource,
  pageFileName,
  type ComparisonPage,
} from "../../src/evaluations/index.js";
import { comparisonPage } from "./fixtures.js";

/**
 * The spies pass every call through to the real module. They exist so that a test can say that the
 * disk was not touched for an id that is not shaped like one, and that an unchanged file is not
 * read twice.
 */
const spies = vi.hoisted(() => ({
  calls: [] as string[],
  /** Answers `lstatSync` for a path in place of the real one: a file that changed after the check. */
  lstat: undefined as undefined | ((path: string) => unknown),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const spy =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      spies.calls.push(name);
      return fn(...args);
    };
  return {
    ...actual,
    lstatSync: spy("lstatSync", (...args: Parameters<typeof actual.lstatSync>) => {
      const answer = spies.lstat?.(String(args[0]));
      return answer === undefined ? actual.lstatSync(...args) : answer;
    }) as typeof actual.lstatSync,
    openSync: spy("openSync", actual.openSync),
    readdirSync: spy("readdirSync", actual.readdirSync),
    readFileSync: spy("readFileSync", actual.readFileSync),
  };
});

let dir: string;
let outside: string;

beforeEach(() => {
  outside = mkdtempSync(join(tmpdir(), "parol-eval-source-"));
  dir = join(outside, "evaluations");
  mkdirSync(dir);
  spies.calls.length = 0;
  spies.lstat = undefined;
});

afterEach(() => {
  rmSync(outside, { recursive: true, force: true });
});

/** Writes a page into the folder under its own name, dated `seconds` after the epoch. */
function publish(page: ComparisonPage, seconds?: number): string {
  const path = join(dir, pageFileName(page.id));
  writeFileSync(path, JSON.stringify(page));
  if (seconds !== undefined) utimesSync(path, seconds, seconds);
  return path;
}

const reads = (): number => spies.calls.filter((c) => c === "readFileSync").length;

describe("the empty source", () => {
  it("lists nothing and finds nothing", () => {
    expect(EMPTY_SOURCE.list()).toEqual({ entries: [], truncated: false });
    expect(EMPTY_SOURCE.get("cmp_0123456789abcdef")).toBeNull();
  });
});

describe("a source over a folder", () => {
  it("reads a missing folder as an empty list", () => {
    const source = createComparisonSource(join(outside, "nothing-here"));
    expect(source.list()).toEqual({ entries: [], truncated: false });
    expect(source.get("cmp_0123456789abcdef")).toBeNull();
  });

  it("lists a published page, with the time of its file, and finds it by its id", () => {
    const page = comparisonPage();
    publish(page, 1_762_333_200);
    const source = createComparisonSource(dir);
    const listed = source.list();
    expect(listed.truncated).toBe(false);
    expect(listed.entries).toEqual([
      { ok: true, id: page.id, publishedAt: "2025-11-05T09:00:00.000Z", page },
    ]);
    expect(source.get(page.id)).toEqual({ page, publishedAt: "2025-11-05T09:00:00.000Z" });
  });

  it("sees a page published after it was made, without being made again", () => {
    const source = createComparisonSource(dir);
    expect(source.list().entries).toHaveLength(0);
    publish(comparisonPage());
    expect(source.list().entries).toHaveLength(1);
  });

  it("lists only files named for a page id", () => {
    const page = comparisonPage();
    publish(page);
    const text = JSON.stringify(page);
    for (const name of [
      "notes.txt",
      "cmp_short.json",
      "cmp_0123456789abcdef.json.bak",
      "cmp_0123456789ABCDEF.json",
      "xcmp_0123456789abcdef.json",
      "cmp_0123456789abcdef.JSON",
    ])
      writeFileSync(join(dir, name), text);
    const entries = createComparisonSource(dir).list().entries;
    expect(entries.map((e) => (e.ok ? e.id : e.name))).toEqual([page.id]);
  });

  it("lists a file that cannot be used as an entry with a fixed problem, and never with its content", () => {
    const good = comparisonPage();
    const tampered = comparisonPage({}, "tampered");
    const wrongName = comparisonPage({}, "wrong name");
    publish(good, 100);
    const secret = "SECRET-MARKER-91c4";
    writeFileSync(
      join(dir, pageFileName(tampered.id)),
      JSON.stringify(tampered).replace("sim-v1.json", `sim-${secret}.json`),
    );
    writeFileSync(join(dir, "cmp_1111111111111111.json"), JSON.stringify(wrongName));
    writeFileSync(join(dir, "cmp_2222222222222222.json"), `not json ${secret}`);
    writeFileSync(join(dir, "cmp_3333333333333333.json"), JSON.stringify({ kind: secret }));
    const { entries } = createComparisonSource(dir).list();
    const problems = Object.fromEntries(
      entries.flatMap((e) => (e.ok ? [] : [[e.name, e.problem]])),
    );
    expect(problems).toEqual({
      [pageFileName(tampered.id)]: "fingerprint_mismatch",
      "cmp_1111111111111111.json": "name_mismatch",
      "cmp_2222222222222222.json": "not_json",
      "cmp_3333333333333333.json": "not_a_comparison",
    });
    expect(entries.filter((e) => e.ok).map((e) => (e.ok ? e.id : ""))).toEqual([good.id]);
    expect(JSON.stringify(entries)).not.toContain(secret);
  });

  it("does not read a file over the size cap", () => {
    const page = comparisonPage();
    publish(page);
    const source = createComparisonSource(dir, { maxBytes: 1000 });
    expect(source.list().entries).toEqual([
      { ok: false, name: pageFileName(page.id), problem: "too_large" },
    ]);
    expect(reads()).toBe(0);
    expect(source.get(page.id)).toBeNull();
    expect(reads()).toBe(0);
  });

  it("does not follow a link, and does not take a directory for a page", () => {
    const page = comparisonPage();
    // A valid page that sits outside the folder, and a link inside the folder that leads to it.
    const target = join(outside, pageFileName(page.id));
    writeFileSync(target, JSON.stringify(page));
    symlinkSync(target, join(dir, pageFileName(page.id)));
    mkdirSync(join(dir, "cmp_4444444444444444.json"));
    const source = createComparisonSource(dir);
    const { entries } = source.list();
    expect(entries.map((e) => (e.ok ? "page" : `${e.name} ${e.problem}`)).sort()).toEqual(
      [`${pageFileName(page.id)} unreadable`, "cmp_4444444444444444.json unreadable"].sort(),
    );
    expect(source.get(page.id)).toBeNull();
    expect(reads()).toBe(0);
  });

  it("checks the file it opened, not only the file it looked at: a link or a directory swapped in after the check", () => {
    const page = comparisonPage();
    const target = join(outside, "real.json");
    writeFileSync(target, JSON.stringify(page));
    const swapped = join(dir, pageFileName(page.id));
    symlinkSync(target, swapped);
    const directory = join(dir, "cmp_5555555555555555.json");
    mkdirSync(directory);
    // The check sees a plain file in both places; what is opened is a link and a directory.
    spies.lstat = (path) =>
      path === swapped || path === directory ? fs.statSync(target) : undefined;
    const { entries } = createComparisonSource(dir).list();
    expect(entries.map((e) => (e.ok ? "page" : `${e.name} ${e.problem}`)).sort()).toEqual(
      [`${pageFileName(page.id)} unreadable`, "cmp_5555555555555555.json unreadable"].sort(),
    );
    expect(reads()).toBe(0);
  });

  it("lists the newest first, then by id, and stops at the most it is asked for", () => {
    const [a, b, c] = [
      comparisonPage({}, "a"),
      comparisonPage({}, "b"),
      comparisonPage({}, "c"),
    ] as [ComparisonPage, ComparisonPage, ComparisonPage];
    publish(a, 1000);
    publish(b, 3000);
    publish(c, 2000);
    const all = createComparisonSource(dir).list();
    expect(all.entries.map((e) => (e.ok ? e.id : ""))).toEqual([b.id, c.id, a.id]);
    expect(all.truncated).toBe(false);

    spies.calls.length = 0;
    const two = createComparisonSource(dir, { maxFiles: 2 }).list();
    expect(two.entries.map((e) => (e.ok ? e.id : ""))).toEqual([b.id, c.id]);
    expect(two.truncated).toBe(true);
    // Only the files that are listed are opened.
    expect(reads()).toBe(2);

    // The same time on two files: the smaller id first.
    const dir2 = join(outside, "tied");
    mkdirSync(dir2);
    for (const page of [a, b]) {
      const path = join(dir2, pageFileName(page.id));
      writeFileSync(path, JSON.stringify(page));
      utimesSync(path, 5000, 5000);
    }
    const ids = createComparisonSource(dir2)
      .list()
      .entries.map((e) => (e.ok ? e.id : ""));
    expect(ids).toEqual([a.id, b.id].sort());
  });

  it("does not touch the disk for an id that is not shaped like one", () => {
    const page = comparisonPage();
    publish(page);
    const source = createComparisonSource(dir);
    spies.calls.length = 0;
    for (const bad of [
      "",
      "../cmp_0123456789abcdef",
      `${page.id}/../${page.id}`,
      `${page.id}.json`,
      "cmp_0123456789abcde",
      "cmp_0123456789ABCDEF",
      "x".repeat(65),
      "cmp_0123456789abcdef\u0000",
    ])
      expect(source.get(bad), JSON.stringify(bad)).toBeNull();
    expect(spies.calls).toEqual([]);
  });

  it("finds nothing for an id that is well formed and not published, and reads no decoy outside the folder", () => {
    const page = comparisonPage();
    const decoy = join(outside, pageFileName(page.id));
    writeFileSync(decoy, JSON.stringify(page));
    const source = createComparisonSource(dir);
    expect(source.get(page.id)).toBeNull();
    expect(source.get("cmp_ffffffffffffffff")).toBeNull();
    expect(reads()).toBe(0);
  });

  it("does not parse an unchanged file again, and does when its time changes", () => {
    const page = comparisonPage();
    const path = publish(page, 1000);
    const source = createComparisonSource(dir);
    source.list();
    expect(reads()).toBe(1);
    source.list();
    source.get(page.id);
    expect(reads()).toBe(1);
    utimesSync(path, 2000, 2000);
    expect(source.get(page.id)?.publishedAt).toBe("1970-01-01T00:33:20.000Z");
    expect(reads()).toBe(2);
  });

  it("reads a file again when its size changes, and refuses it when it no longer holds", () => {
    const page = comparisonPage();
    const path = publish(page, 1000);
    const source = createComparisonSource(dir);
    expect(source.get(page.id)).not.toBeNull();
    writeFileSync(path, `${JSON.stringify(page)} `);
    utimesSync(path, 1000, 1000);
    // Larger by one byte and still the same JSON: it is read again and is still the page.
    expect(source.get(page.id)).not.toBeNull();
    expect(reads()).toBe(2);
    writeFileSync(path, "not json");
    utimesSync(path, 1000, 1000);
    expect(source.get(page.id)).toBeNull();
    expect(source.list().entries).toEqual([
      { ok: false, name: pageFileName(page.id), problem: "not_json" },
    ]);
  });

  it("forgets a file that was removed", () => {
    const page = comparisonPage();
    const path = publish(page);
    const source = createComparisonSource(dir);
    expect(source.list().entries).toHaveLength(1);
    rmSync(path);
    expect(source.list().entries).toHaveLength(0);
    expect(source.get(page.id)).toBeNull();
  });
});

describe("what the tests above rely on", () => {
  it("spies on the real module", () => {
    expect(typeof fs.lstatSync).toBe("function");
    spies.calls.length = 0;
    fs.readdirSync(outside);
    expect(spies.calls).toEqual(["readdirSync"]);
  });
});
