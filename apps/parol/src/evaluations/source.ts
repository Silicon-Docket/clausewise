import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import {
  MAX_PAGE_BYTES,
  isPageId,
  pageFileName,
  parseComparisonPage,
  type ComparisonPage,
  type PageProblem,
} from "./document.js";

/**
 * Where the comparison pages come from: a folder of files that the evaluation tooling publishes
 * and the application only reads. This is the seam between the two. The service layer is given a
 * `ComparisonSource` and never a path or a repository, so it can be tested with a list in memory.
 *
 * The source reads the folder on each request, so a file published while the server runs is listed
 * at once, and keeps what it parsed by file name, size and modification time, so an unchanged file
 * is not parsed again. It reads nothing but files named for a page id, opens each without
 * following a link, and never touches the disk for an id that is not shaped like one. It imports
 * nothing from `store/`: the folder holds no matter data and the page cannot reach any.
 */

export type SourceEntry =
  | { ok: true; id: string; publishedAt: string; page: ComparisonPage }
  | { ok: false; name: string; problem: PageProblem };

export interface ComparisonSource {
  /** Newest first (file modification time, then id), at most `maxFiles` entries. */
  list(): { entries: SourceEntry[]; truncated: boolean };
  /** Null for an id that is malformed, unknown or whose file is unreadable. Never touches the disk for a malformed id. */
  get(id: string): { page: ComparisonPage; publishedAt: string } | null;
}

/** A source with nothing in it: the default when none is given, and what a missing folder reads as. */
export const EMPTY_SOURCE: ComparisonSource = Object.freeze({
  list: () => ({ entries: [], truncated: false }),
  get: () => null,
});

export interface ComparisonSourceOptions {
  /** Largest file read. Default: the largest page the builder writes. */
  maxBytes?: number;
  /** Most files listed. Default 200. */
  maxFiles?: number;
}

export const DEFAULT_MAX_FILES = 200;

/** The only names read: a page id and `.json`. */
const PAGE_FILE = /^cmp_[0-9a-f]{16}\.json$/;

/** What the cache may hold, in bytes of file. A file that would pass it is parsed on each read. */
const CACHE_BYTES = 64 * 1024 * 1024;

interface Read {
  size: number;
  mtimeMs: number;
  entry: SourceEntry;
  /**
   * True when the file could not be opened or read, which says nothing about what it holds. Such a
   * result is returned and never cached: the file is tried again on the next request.
   */
  transient?: true;
}

const publishedAtOf = (mtimeMs: number): string => {
  const at = new Date(mtimeMs);
  return Number.isNaN(at.getTime()) ? new Date(0).toISOString() : at.toISOString();
};

/**
 * The source over the folder `dir`. A folder that does not exist reads as an empty list. A file
 * that cannot be used is an entry with a fixed problem code and never with a word of its content.
 */
export function createComparisonSource(
  dir: string,
  options: ComparisonSourceOptions = {},
): ComparisonSource {
  const maxBytes = options.maxBytes ?? MAX_PAGE_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const cache = new Map<string, Read>();
  let cachedBytes = 0;

  const unusable = (name: string, problem: PageProblem, size: number, mtimeMs: number): Read => ({
    size,
    mtimeMs,
    entry: { ok: false, name, problem },
  });

  /** A file that could not be opened or read this time. What it holds is not known. */
  const failed = (name: string, size: number, mtimeMs: number): Read => ({
    ...unusable(name, "unreadable", size, mtimeMs),
    transient: true,
  });

  /** The state of one file without following a link; null when it is gone, and "unreadable" otherwise. */
  function statOf(name: string): Stats | "unreadable" | null {
    try {
      return lstatSync(join(dir, name));
    } catch (error) {
      // A file that vanished between the listing and now is not there. Anything else is a file
      // that cannot be read, and is listed as such.
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
    }
  }

  /** Reads one file, or returns what the cache holds when the file has not changed. */
  function load(name: string, stat: Stats | "unreadable"): Read {
    if (stat === "unreadable") {
      forget(name);
      return unusable(name, "unreadable", 0, 0);
    }
    const kept = cache.get(name);
    if (kept !== undefined && kept.size === stat.size && kept.mtimeMs === stat.mtimeMs) return kept;
    forget(name);
    if (!stat.isFile()) return unusable(name, "unreadable", stat.size, stat.mtimeMs);
    if (stat.size > maxBytes) return unusable(name, "too_large", stat.size, stat.mtimeMs);
    const result = parseFile(name, stat.size, stat.mtimeMs);
    // Only a page that parsed and a problem that the content decides are kept.
    if (result.transient === undefined && cachedBytes + result.size <= CACHE_BYTES) {
      cache.set(name, result);
      cachedBytes += result.size;
    }
    return result;
  }

  function parseFile(name: string, size: number, mtimeMs: number): Read {
    let fd: number | null = null;
    try {
      // No link is followed, and nothing blocks on a file that has been swapped for a pipe since
      // the check above: the descriptor is checked again before a byte is read.
      fd = openSync(
        join(dir, name),
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      const opened = fstatSync(fd);
      if (!opened.isFile()) return failed(name, size, mtimeMs);
      if (opened.size > maxBytes) return unusable(name, "too_large", size, mtimeMs);
      const bytes = readFileSync(fd);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return unusable(name, "not_json", size, mtimeMs);
      }
      const parsed = parseComparisonPage(text, name);
      if (!parsed.ok) return unusable(name, parsed.problem, size, mtimeMs);
      return {
        size,
        mtimeMs,
        entry: {
          ok: true,
          id: parsed.page.id,
          publishedAt: publishedAtOf(mtimeMs),
          page: parsed.page,
        },
      };
    } catch {
      // No code, no message and nothing of the file: the entry carries a fixed problem only.
      return failed(name, size, mtimeMs);
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }

  function forget(name: string): void {
    const held = cache.get(name);
    if (held === undefined) return;
    cache.delete(name);
    cachedBytes -= held.size;
  }

  return {
    list() {
      let names: string[];
      try {
        names = readdirSync(dir).filter((name) => PAGE_FILE.test(name));
      } catch {
        // No folder, or one that cannot be listed: nothing has been published to this application.
        for (const name of [...cache.keys()]) forget(name);
        return { entries: [], truncated: false };
      }
      for (const name of [...cache.keys()]) if (!names.includes(name)) forget(name);
      // The state of every file is read first and only the newest `maxFiles` are opened.
      const found = names.flatMap((name) => {
        const stat = statOf(name);
        return stat === null ? [] : [{ name, stat }];
      });
      const mtimeOf = (stat: Stats | "unreadable"): number =>
        stat === "unreadable" ? 0 : stat.mtimeMs;
      // Newest first. The file name is the page id, so the second key is the id.
      found.sort(
        (a, b) =>
          mtimeOf(b.stat) - mtimeOf(a.stat) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      );
      return {
        entries: found.slice(0, maxFiles).map((item) => load(item.name, item.stat).entry),
        truncated: found.length > maxFiles,
      };
    },

    get(id) {
      if (!isPageId(id)) return null;
      const name = pageFileName(id);
      const stat = statOf(name);
      if (stat === null) {
        forget(name);
        return null;
      }
      const result = load(name, stat);
      return result.entry.ok
        ? { page: result.entry.page, publishedAt: result.entry.publishedAt }
        : null;
    },
  };
}
