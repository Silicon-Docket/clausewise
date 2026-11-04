import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../src/canonical.js";
import { CONTENT_SECURITY_POLICY } from "../../src/server/middleware/security-headers.js";
import { memoDownloadHeaders } from "../../src/server/routes/shared.js";
import { urls } from "../../src/server/urls.js";
import type { MemoSummary } from "../../src/services/views.js";
import {
  IDS,
  VIEWER,
  cleanup,
  makeSite,
  prepareMatter,
  type Browser,
  type Prepared,
  type Site,
} from "./support.js";

/**
 * The memo download. The file is the one the service stored, with the name the service made (the
 * matter's id and the day, nothing a person typed), sent as an attachment with a Word content type
 * and the headers the shell puts on every response.
 */

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

let site: Site;
let ids: Prepared;
let memo: MemoSummary;

beforeAll(async () => {
  site = makeSite();
  ids = await prepareMatter(site, { name: "A matter named Quokka Holdings" });
  memo = site.w.services.reviews.listMemos(site.w.grant(site.w.associate, ids.matterId))[0]!;
});

describe("the memo file, to each member", () => {
  const members: [string, string][] = [
    ["the associate", IDS.associate],
    ["the reviewer", IDS.reviewer],
    ["a viewer", VIEWER],
  ];

  for (const [who, userId] of members) {
    for (const [face, path] of [
      ["page", (): string => urls.memoFile(ids.matterId, ids.memoId!)],
      ["JSON API", (): string => `/api/matters/${ids.matterId}/memos/${ids.memoId!}/file`],
    ] as const) {
      it(`is sent to ${who} as an attachment, by the ${face}, with the right type and name`, async () => {
        const browser: Browser = await site.as(userId);
        const response = await browser.get(path());
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(DOCX);
        // The name is the service's: a prefix, the matter's id without its own prefix, the day.
        expect(response.headers.get("content-disposition")).toBe(
          `attachment; filename="${memo.fileName}"`,
        );
        expect(memo.fileName).toMatch(/^parol-memo-[0-9a-f]{16}-\d{8}\.docx$/);
        expect(memo.fileName).toContain(ids.matterId.slice(4));
        // Nothing a person typed is in a header.
        const seen: string[] = [];
        response.headers.forEach((value) => seen.push(value));
        const headers = seen.join("\n");
        expect(headers).not.toContain("Quokka");
        expect(headers).not.toContain("Lanternfish");
        // The headers every response has, added by the shell and not by the route.
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
        expect(response.headers.get("x-frame-options")).toBe("DENY");
        expect(response.headers.get("x-request-id")).toMatch(/^req_[0-9a-f]{16}$/);
        // The length is the length of the file, and the file is the stored one.
        const bytes = new Uint8Array(await response.arrayBuffer());
        expect(response.headers.get("content-length")).toBe(String(bytes.length));
        expect(sha256Hex(bytes)).toBe(memo.fileSha256);
        expect(bytes.slice(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]));
        const zip = await JSZip.loadAsync(bytes);
        expect(Object.keys(zip.files)).toContain("word/document.xml");
      });
    }
  }

  it("is never sent to be shown in the browser", async () => {
    const browser = await site.as(IDS.associate);
    const response = await browser.get(urls.memoFile(ids.matterId, ids.memoId!));
    expect(response.headers.get("content-disposition")).not.toMatch(/inline/i);
    expect(response.headers.get("content-type")).not.toMatch(/html|text|json/i);
  });

  it("is the same file whether it is fetched by the page or the API", async () => {
    const browser = await site.as(IDS.reviewer);
    const a = new Uint8Array(
      await (await browser.get(urls.memoFile(ids.matterId, ids.memoId!))).arrayBuffer(),
    );
    const b = new Uint8Array(
      await (
        await browser.get(`/api/matters/${ids.matterId}/memos/${ids.memoId!}/file`)
      ).arrayBuffer(),
    );
    expect(sha256Hex(a)).toBe(sha256Hex(b));
  });

  it("is refused when the stored file is no longer the one that was recorded", async () => {
    // A copy of the matter, so that the tampering does not touch the memo the tests above read.
    const other = await prepareMatter(site, { name: "Another" });
    const record = site.w.repo.getMemo(other.matterId, other.memoId!)!;
    const path = join(site.w.files.root, record.storagePath);
    const bytes = readFileSync(path);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    writeFileSync(path, bytes);
    const browser = await site.as(IDS.associate);
    const response = await browser.get(urls.memoFile(other.matterId, other.memoId!));
    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).not.toBe(DOCX);
    const api = await browser.get(`/api/matters/${other.matterId}/memos/${other.memoId!}/file`);
    expect(api.status).toBe(409);
    expect(((await api.json()) as { error: { code: string } }).error.code).toBe(
      "memo_file_changed",
    );
  });
});

describe("the header of a download", () => {
  it("carries a name of plain characters as it is", () => {
    expect(memoDownloadHeaders("parol-memo-0123456789abcdef-20261103.docx", 12)).toEqual({
      "content-type": DOCX,
      "content-disposition": 'attachment; filename="parol-memo-0123456789abcdef-20261103.docx"',
      "content-length": "12",
    });
  });

  it("falls back to a fixed name for anything else, so no character can reach the header", () => {
    for (const name of [
      'evil".docx',
      "a\r\nSet-Cookie: x=y.docx",
      "../../etc/passwd",
      "with space.docx",
      "ünï.docx",
      "",
      "a".repeat(200),
    ]) {
      expect(memoDownloadHeaders(name, 1)["content-disposition"], JSON.stringify(name)).toBe(
        'attachment; filename="parol-memo.docx"',
      );
    }
  });
});
