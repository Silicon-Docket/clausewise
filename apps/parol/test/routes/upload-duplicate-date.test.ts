import { afterAll, describe, expect, it, vi } from "vitest";
import { urls } from "../../src/server/urls.js";
import {
  IDS,
  baseWorld,
  cleanup,
  fingerprint,
  makeSite,
  prepareMatter,
  type Browser,
  type Prepared,
  type Site,
} from "./support.js";

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * The same file uploaded again with a stated date the stored version does not have. The file is not
 * stored a second time, so the date has nowhere to go, and it decides which amendment governs: it is
 * refused in words and not dropped under a notice about something else.
 */

const AMENDMENT = baseWorld.files.find((f) => f.label === "D2")!;
const STORED_DATE = baseWorld.documents.find((d) => d.label === "D2")!.statedDate as string;
const OTHER_DATE = STORED_DATE === "2026-01-01" ? "2026-01-02" : "2026-01-01";

async function reviewedMatter(): Promise<{ site: Site; ids: Prepared; associate: Browser }> {
  const site = makeSite();
  const ids = await prepareMatter(site, { exported: false });
  return { site, ids, associate: await site.as(IDS.associate) };
}

const versionsPath = (ids: Prepared): string =>
  `/api/matters/${ids.matterId}/documents/${ids.lastDocumentId}/versions`;

describe("the identical file again, with a date that differs from the one on record", () => {
  it("is refused through the API, and leaves the review, the date and the files as they were", async () => {
    const { site, ids, associate } = await reviewedMatter();
    const rows = fingerprint(site);
    const before = site.w.repo.listVersions(ids.matterId, ids.lastDocumentId);
    expect(before[0]!.statedDate).toBe(STORED_DATE);

    const refused = await associate.apiUpload(
      versionsPath(ids),
      { statedDate: OTHER_DATE },
      { name: "amendment.txt", bytes: AMENDMENT.bytes },
    );
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("duplicate_stated_date");
    // Fixed words: neither the date typed nor the file name is repeated.
    expect(body.error.message).not.toContain(OTHER_DATE);
    expect(body.error.message).not.toContain("amendment.txt");

    expect(fingerprint(site)).toEqual(rows);
    expect(site.w.repo.listVersions(ids.matterId, ids.lastDocumentId)).toEqual(before);
    expect(site.w.repo.getMatter(ids.matterId)?.status).toBe("in_review");
    expect(
      site.w.services.runs.get(site.w.grant(site.w.associate, ids.matterId), ids.runId),
    ).toMatchObject({ current: true });
  });

  it("is refused on the form's page with the reason in words", async () => {
    const { ids, associate } = await reviewedMatter();
    const page = await associate.page(urls.matter(ids.matterId));
    const response = await associate.upload(
      page,
      urls.versions(ids.matterId, ids.lastDocumentId),
      { name: "amendment.txt", bytes: AMENDMENT.bytes },
      { set: { statedDate: OTHER_DATE } },
    );
    expect(response.status).toBe(409);
    const html = await response.text();
    expect(html).toContain("the stated date you entered was not applied");
    expect(html).toContain("Change the date on the existing version.");
    expect(html).not.toContain("Reload the page and try again");
  });

  it("is refused as a new document, too", async () => {
    const { site, ids, associate } = await reviewedMatter();
    const rows = fingerprint(site);
    const refused = await associate.apiUpload(
      `/api/matters/${ids.matterId}/documents`,
      { title: "Amendment No. 1 again", kind: "amendment", statedDate: OTHER_DATE },
      { name: "amendment.txt", bytes: AMENDMENT.bytes },
    );
    expect(refused.status).toBe(409);
    expect(fingerprint(site)).toEqual(rows);
  });

  it("is still the duplicate notice when the date is the same or none was typed", async () => {
    const { associate, ids } = await reviewedMatter();
    for (const fields of [{ statedDate: STORED_DATE }, {}]) {
      const response = await associate.apiUpload(versionsPath(ids), fields, {
        name: "amendment.txt",
        bytes: AMENDMENT.bytes,
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as { warnings: { code: string }[] };
      expect(result.warnings.map((w) => w.code)).toEqual(["duplicate_document"]);
    }
  });
});
