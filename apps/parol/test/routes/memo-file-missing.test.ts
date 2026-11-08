import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { urls } from "../../src/server/urls.js";
import { IDS, cleanup, makeSite, prepareMatter, type Site } from "./support.js";

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * A memo whose stored file is gone (someone cleaned the data folder, a disk was restored from an
 * older copy) is a conflict between the record and the disk, as one whose file was changed is. It
 * is not a server fault, and it names no path.
 */

let site: Site;

beforeAll(() => {
  site = makeSite();
});

describe("a memo whose file is missing", () => {
  it("is answered with a conflict that says the file is missing, by the page and by the API", async () => {
    const ids = await prepareMatter(site, { name: "Another" });
    const record = site.w.repo.getMemo(ids.matterId, ids.memoId!)!;
    rmSync(join(site.w.files.root, record.storagePath));

    const browser = await site.as(IDS.associate);
    const page = await browser.get(urls.memoFile(ids.matterId, ids.memoId!));
    expect(page.status).toBe(409);
    const api = await browser.get(`/api/matters/${ids.matterId}/memos/${ids.memoId!}/file`);
    expect(api.status).toBe(409);
    const body = (await api.json()) as { error: { kind: string; code: string; message: string } };
    expect(body.error.code).toBe("memo_file_missing");
    expect(JSON.stringify(body)).not.toContain(record.storagePath);
    expect(JSON.stringify(body)).not.toContain(site.w.files.root);

    // The record is still listed, so that the person can see which memo it is.
    const listed = site.w.services.reviews.listMemos(site.w.grant(site.w.associate, ids.matterId));
    expect(listed.map((m) => m.memoId)).toEqual([ids.memoId]);
  });
});
