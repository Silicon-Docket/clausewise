import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FIELDS } from "../../src/server/pages/forms.js";
import { urls } from "../../src/server/urls.js";
import type { FindingView, IssueRow, MatterView } from "../../src/services/views.js";
import {
  IDS,
  VIEWER,
  checkPage,
  cleanup,
  makeSite,
  prepareMatter,
  type Browser,
  type Prepared,
  type Site,
} from "./support.js";

/**
 * A single-person demonstration (docs/parol/06): one person prepares the review and decides it, and
 * the memo says so. The shell and the services are set the same way, and the pages show the forms
 * the routes will accept. Without the setting none of this is offered (the matrix and the page
 * tests cover that).
 */

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let site: Site;
let ids: Prepared;
let associate: Browser;

beforeAll(async () => {
  site = makeSite({ relaxed: true });
  ids = await prepareMatter(site, { exported: false });
  associate = await site.as(IDS.associate);
});

describe("the associate who started the review", () => {
  it("is offered the decision form, and decides every finding through it", async () => {
    const table = (await (
      await associate.api("GET", `/api/matters/${ids.matterId}/runs/${ids.runId}/findings`)
    ).json()) as { findings: IssueRow[] };
    for (const row of table.findings) {
      const page = await associate.page(urls.finding(ids.matterId, row.findingId));
      checkPage(site, page);
      const view = (await (
        await associate.get(`/api/matters/${ids.matterId}/findings/${row.findingId}`)
      ).json()) as FindingView;
      expect(view.canDecide).toEqual({ allowed: true, reason: null });
      const ok =
        view.issue.verificationState === "verified" && view.issue.status !== "undetermined";
      const response = await associate.submit(page, urls.review(ids.matterId, row.findingId), {
        set: ok
          ? { [FIELDS.decision]: "accept" }
          : { [FIELDS.decision]: "escalate", [FIELDS.reason]: "Cannot settle this rule." },
      });
      expect(response.status).toBe(303);
    }
    const view = (await (
      await associate.api("GET", `/api/matters/${ids.matterId}`)
    ).json()) as MatterView;
    expect(view.matter.status).toBe("review_complete");
    expect(view.segregationRelaxed).toBe(true);
  });

  it("exports the memo, which says that the reviewer and the associate were the same person", async () => {
    const memos = await associate.page(urls.memos(ids.matterId));
    checkPage(site, memos);
    const response = await associate.submit(memos, urls.memos(ids.matterId));
    expect(response.status).toBe(303);
    const view = (await (
      await associate.api("GET", `/api/matters/${ids.matterId}`)
    ).json()) as MatterView;
    const file = await associate.get(urls.memoFile(ids.matterId, view.memos[0]!.memoId));
    const zip = await JSZip.loadAsync(new Uint8Array(await file.arrayBuffer()));
    const body = await zip.file("word/document.xml")!.async("string");
    expect(body).toContain("same person");
  });

  it("is still not a viewer's equal: a viewer decides and exports nothing", async () => {
    const viewer = await site.as(VIEWER);
    expect((await viewer.get(urls.memos(ids.matterId))).status).toBe(200);
    expect((await viewer.api("POST", `/api/matters/${ids.matterId}/memos`)).status).toBe(403);
    expect(
      (
        await viewer.api("POST", `/api/matters/${ids.matterId}/findings/${ids.findingId}/reviews`, {
          decision: "accept",
          findingContentSha256: "0".repeat(64),
        })
      ).status,
    ).toBe(403);
  });
});
