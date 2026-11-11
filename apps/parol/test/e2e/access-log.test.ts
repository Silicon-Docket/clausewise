import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FIELDS } from "../../src/server/pages/forms.js";
import { REFUSAL_PHRASES } from "../../src/server/routes/notices.js";
import { urls } from "../../src/server/urls.js";
import type { FindingView, IssueRow, MatterView } from "../../src/services/views.js";
import { urlEncoded } from "../integration/layers-support.js";
import { all, attr, first, hasAttr, parseHtml, readable } from "../pages/html.js";
import {
  IDS,
  baseWorld,
  cleanup,
  makeSite,
  matterIdFrom,
  type Browser,
  type Site,
} from "../routes/support.js";

/**
 * Nothing a person typed or a document said reaches the access log, or any other log, or the audit
 * trail, or an error. Three marker strings are put where text comes from: one inside each of the
 * two documents, and one in everything a caller can type (names, titles, file names, a reason, the
 * path, the query string and the headers). The whole story of docs/parol/04 is then told over
 * HTTP, with errors on the way, and every line the server wrote is read.
 */

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const IN_NDA = "ZEBRA-CANARY-7731";
const IN_AMENDMENT = "OKAPI-CANARY-2290";
const TYPED = "QUOKKA-CANARY-5518";
const MARKERS = [IN_NDA, IN_AMENDMENT, TYPED];

const NDA = baseWorld.files.find((f) => f.label === "D1")!;
const AMENDMENT = baseWorld.files.find((f) => f.label === "D2")!;

/** The NDA with a marker added to the end of its first run of text. */
async function ndaWithMarker(): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(NDA.bytes);
  const xml = await zip.file("word/document.xml")!.async("string");
  expect(xml).toContain("</w:t>");
  zip.file("word/document.xml", xml.replace("</w:t>", ` ${IN_NDA}</w:t>`));
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

const amendmentWithMarker = (): Uint8Array =>
  new TextEncoder().encode(
    new TextDecoder()
      .decode(AMENDMENT.bytes)
      .replace(
        "TO MUTUAL NONDISCLOSURE AGREEMENT",
        `TO MUTUAL NONDISCLOSURE AGREEMENT ${IN_AMENDMENT}`,
      ),
  );

/** The one line of the access log: a closed set of fields, each of a closed alphabet. */
const LINE =
  /^req=req_[0-9a-f]{16} method=[A-Z]+ route=\S+ status=\d{3} ms=\d+ user=[A-Za-z0-9_-]+ matter=[A-Za-z0-9_-]+( error=[A-Za-z][A-Za-z0-9_]*)?$/;

describe("the story of the worked example, with a marker in everything", () => {
  let site: Site;
  let associate: Browser;
  let reviewer: Browser;
  /** The body of every response that was an error, to see that none repeats the request. */
  const errors: string[] = [];

  /** Sends a request and keeps the body of an error answer. */
  async function note(response: Response): Promise<Response> {
    if (response.status >= 400) errors.push(await response.clone().text());
    return response;
  }

  beforeAll(async () => {
    site = makeSite();
    associate = await site.as(IDS.associate);
    reviewer = await site.as(IDS.reviewer);
  });

  it("tells the story, with the errors a careless person meets on the way", async () => {
    // A matter, created with the form, named with the marker.
    const matters = await associate.page(urls.matters());
    const created = await associate.submit(matters, urls.matters(), {
      set: {
        [FIELDS.name]: `Matter ${TYPED}`,
        [FIELDS.clientLegalName]: baseWorld.manifest.clientLegalName,
        [FIELDS.reviewerUserId]: IDS.reviewer,
        [FIELDS.playbookVersionId]: site.w.playbookVersionId,
      },
    });
    const matterId = matterIdFrom(created);

    // The documents, with a marker in their text, their titles and their file names.
    const page = await associate.page(urls.matter(matterId));
    const nda = await associate.upload(
      page,
      urls.documents(matterId),
      { name: `nda-${TYPED}.docx`, bytes: await ndaWithMarker() },
      {
        set: {
          [FIELDS.title]: `Mutual NDA ${TYPED}`,
          [FIELDS.kind]: "nda",
          [FIELDS.statedDate]: "2026-02-02",
        },
      },
    );
    expect(nda.status).toBe(303);
    const amendment = await associate.upload(
      await associate.page(urls.matter(matterId)),
      urls.documents(matterId),
      { name: `amendment-${TYPED}.txt`, bytes: amendmentWithMarker() },
      {
        set: {
          [FIELDS.title]: `Amendment ${TYPED}`,
          [FIELDS.kind]: "amendment",
          [FIELDS.statedDate]: "2026-09-15",
        },
      },
    );
    expect(amendment.status).toBe(303);

    // A file of the wrong type, sent with the form. The answer is the matter's page again with one
    // fixed problem notice added: byte for byte the page that was asked from, so none of what the
    // request carried (the title, the file name, the file) has been put into it.
    const beforeRefusal = await associate.page(urls.matter(matterId));
    const refused = await associate.upload(
      beforeRefusal,
      urls.documents(matterId),
      { name: `${TYPED}.pdf`, bytes: new TextEncoder().encode(TYPED) },
      { set: { [FIELDS.title]: TYPED, [FIELDS.kind]: "amendment" } },
    );
    expect(refused.status).toBe(422);
    const refusedHtml = await refused.text();
    const problem = /<div class="notice notice-error"[^>]*>.*?<\/div>/s;
    expect(refusedHtml).toMatch(problem);
    expect(refusedHtml).toContain("Only .docx and .txt files can be uploaded.");
    expect(refusedHtml.replace(problem, "")).toBe(beforeRefusal.html);

    // Mistakes: a file past the limit (the shell's page, since the form's body is never read), a
    // form with nothing in it, a name that is not a document.
    for (const response of [
      await associate.upload(
        await associate.page(urls.matter(matterId)),
        urls.documents(matterId),
        { name: `${TYPED}.txt`, bytes: new Uint8Array(1_100_000).fill(0x61) },
        { set: { [FIELDS.title]: TYPED, [FIELDS.kind]: "amendment" } },
      ),
      await associate.api("POST", `/api/matters/${matterId}/members`, {
        userId: TYPED,
        role: "viewer",
      }),
      await associate.api("POST", `/api/matters/${matterId}/members`, {
        userId: IDS.admin,
        role: TYPED,
      }),
      await associate.api("POST", `/api/matters/${matterId}/runs`, { workflow: TYPED }),
      await associate.api("PATCH", `/api/matters/${matterId}`, { [TYPED]: TYPED }),
      await associate.api("POST", "/api/matters", { name: TYPED }),
      await associate.send("POST", `/api/matters/${matterId}/runs`, {
        headers: { "content-type": "application/json", "x-csrf-token": await associate.apiToken() },
        body: `{"workflow": "${TYPED}`,
      }),
    ])
      await note(response);

    // A form with a blank client name, which the store refuses. Like the refused file above it is
    // answered on the matter's page, so the answer cannot go through the check on error bodies
    // below (the page holds the matter's own name, which carries the marker): it is held to the
    // stricter one. It is the page that was asked from, byte for byte, with the one fixed notice
    // added, so nothing of the request is in it.
    const beforeSettings = await associate.page(urls.matter(matterId));
    const blank = await associate.submit(beforeSettings, urls.matterSettings(matterId), {
      set: { [FIELDS.clientLegalName]: "" },
    });
    expect(blank.status).toBe(400);
    const blankHtml = await blank.text();
    // The store refuses a blank text with the code bad_text, which has a fixed sentence of its own
    // (it names no field and repeats nothing that was typed).
    expect(readable(parseHtml(problem.exec(blankHtml)?.[0] ?? ""))).toBe(
      `Problem ${REFUSAL_PHRASES["bad_text"]}`,
    );
    expect(blankHtml.replace(problem, "")).toBe(beforeSettings.html);
    // The shell's own page for a refused form, which no matter is behind: an identity that does not
    // exist, named with the marker.
    await note(
      await site.anonymous().send("POST", urls.session(), {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: urlEncoded([
          [FIELDS.intent, "sign-in"],
          [FIELDS.userId, TYPED],
        ]),
      }),
    );

    // The run.
    const ready = await associate.page(urls.matter(matterId));
    const started = await associate.submit(ready, urls.runs(matterId), { set: { workflow: "v2" } });
    expect(started.status).toBe(303);
    await site.w.services.runs.idle();
    const view = (await (
      await associate.api("GET", `/api/matters/${matterId}`)
    ).json()) as MatterView;
    const runId = view.currentRun!.id;
    const issues = (await (
      await associate.api("GET", `/api/matters/${matterId}/runs/${runId}/findings`)
    ).json()) as { findings: IssueRow[] };

    // Reading, with the marker in every place a request carries text.
    const noise = {
      "user-agent": TYPED,
      referer: `http://localhost/${TYPED}`,
      "x-request-id": TYPED,
    };
    await associate.get(`${urls.matter(matterId)}?notice=${TYPED}&${TYPED}=${TYPED}`, noise);
    await associate.get(`${urls.run(matterId, runId)}?finding=${TYPED}&filter=${TYPED}`, noise);
    await associate.get(
      `${urls.run(matterId, runId)}?finding=${issues.findings[0]!.findingId}&filter=${TYPED}`,
    );
    for (const response of [
      await associate.get(`/matters/${TYPED}`),
      await associate.get(`/api/matters/${TYPED}/findings/${TYPED}`),
      await associate.get(`${urls.matter(matterId)}/${TYPED}`),
      await associate.get(`/${TYPED}/${TYPED}`),
      await associate.get(`/matters/${matterId}/findings/${TYPED}`),
      await associate.get(`/assets/${TYPED}`),
      await site.anonymous().get(`/matters/${matterId}?${TYPED}=${TYPED}`),
      await site
        .anonymous()
        .send("GET", `/api/matters`, { headers: { cookie: `parol_session=${TYPED}` } }),
    ])
      await note(response);

    // The reviewer decides every finding, with a reason that carries the marker where one is needed.
    for (const row of issues.findings) {
      const findingPage = await reviewer.page(urls.run(matterId, runId, row.findingId));
      const finding = (await (
        await reviewer.api("GET", `/api/matters/${matterId}/findings/${row.findingId}`)
      ).json()) as FindingView;
      const form = all(
        findingPage.root,
        (el) => el.name === "form" && /\/reviews$/.test(attr(el, "action") ?? ""),
      )[0]!;
      const verified =
        finding.issue.verificationState === "verified" && finding.issue.status !== "undetermined";
      const response = await reviewer.submit(findingPage, attr(form, "action")!, {
        set: verified
          ? { [FIELDS.decision]: "accept" }
          : { [FIELDS.decision]: "escalate", [FIELDS.reason]: `Cannot settle this: ${TYPED}` },
      });
      expect(response.status).toBe(303);
    }
    // A decision without its reason, and one on content that has moved: errors that carry the marker.
    const dur = issues.findings.find((f) => f.ruleKey === "dur-1")!;
    await note(
      await reviewer.api("POST", `/api/matters/${matterId}/findings/${dur.findingId}/reviews`, {
        decision: "reject",
        reason: "",
        findingContentSha256: "0".repeat(64),
      }),
    );
    await note(
      await reviewer.api("POST", `/api/matters/${matterId}/findings/${dur.findingId}/reviews`, {
        decision: "reject",
        reason: TYPED,
        findingContentSha256: "0".repeat(64),
      }),
    );

    // The memo, and the download.
    const memos = await reviewer.page(urls.memos(matterId));
    expect((await reviewer.submit(memos, urls.memos(matterId))).status).toBe(303);
    const list = (await (
      await reviewer.api("GET", `/api/matters/${matterId}`)
    ).json()) as MatterView;
    const memoId = list.memos[0]!.memoId;
    const file = await reviewer.get(urls.memoFile(matterId, memoId));
    expect(file.status).toBe(200);
    await file.arrayBuffer();
    await note(await reviewer.get(urls.memoFile(matterId, TYPED)));

    // A new version makes it all stale, and the export is refused.
    const again = await associate.page(urls.matter(matterId));
    const version = await associate.upload(
      again,
      urls.versions(matterId, view.documents[1]!.documentId),
      {
        name: `corrected-${TYPED}.txt`,
        bytes: new TextEncoder().encode(
          `AMENDMENT NO. 1\n\n2. A corrected paragraph of synthetic text. ${TYPED}\n`,
        ),
      },
      { set: { [FIELDS.statedDate]: "2026-09-16" } },
    );
    expect(version.status).toBe(303);
    await note(await reviewer.api("POST", `/api/matters/${matterId}/memos`));
    // The page's export is refused in place, like the upload above: the memos page again, byte for
    // byte as it was asked from, with one fixed problem notice added. It names the matter as the
    // page always does and repeats nothing the request carried (it carried nothing).
    const beforeExport = await reviewer.page(urls.memos(matterId));
    const blocked = await reviewer.submit(beforeExport, urls.memos(matterId));
    expect(blocked.status).toBe(409);
    const blockedHtml = await blocked.text();
    expect(blockedHtml).toMatch(problem);
    expect(blockedHtml).toContain(
      "The memo cannot be exported yet: a finding has no current decision, or the review is out of date.",
    );
    expect(blockedHtml.replace(problem, "")).toBe(beforeExport.html);
    // A review asked for on a matter with nothing in it is not a mistake in the form, so it is the
    // shell's page for a conflict, and that page repeats nothing: not the name of the matter either.
    const emptyId = matterIdFrom(
      await associate.submit(await associate.page(urls.matters()), urls.matters(), {
        set: {
          [FIELDS.name]: `Empty matter ${TYPED}`,
          [FIELDS.clientLegalName]: baseWorld.manifest.clientLegalName,
          [FIELDS.reviewerUserId]: IDS.reviewer,
          [FIELDS.playbookVersionId]: site.w.playbookVersionId,
        },
      }),
    );
    await note(
      await associate.send("POST", urls.runs(emptyId), {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _csrf: await associate.apiToken(), workflow: "v2" }).toString(),
      }),
    );

    // The matter is deleted by its creator, with a form that carries the marker.
    const last = await associate.page(urls.matter(matterId));
    const del = first(
      last.root,
      (el) => el.name === "input" && attr(el, "name") === FIELDS.confirm,
    );
    expect(hasAttr(del, "required")).toBe(true);
    const deleted = await associate.submit(last, urls.matterDelete(matterId), {
      set: { [FIELDS.confirm]: "yes" },
    });
    expect(deleted.status).toBe(303);
    await note(await associate.get(urls.matter(matterId)));
  });

  it("wrote nothing of any of it to the access log", () => {
    expect(site.logs.length).toBeGreaterThan(60);
    for (const line of site.logs) {
      expect(line, line).toMatch(LINE);
      for (const marker of MARKERS) expect(line).not.toContain(marker);
    }
    // And nothing a caller typed: not a path, a query, a header or a user agent.
    const text = site.logs.join("\n");
    expect(text).not.toMatch(/CANARY|Quokka|Zebra|notice=|finding=|filter=/i);
    expect(text).not.toContain("parol_session");
  });

  it("logged the route template and not the path, and the matter only once it was confirmed", () => {
    const routes = new Set(site.logs.map((line) => /route=(\S+)/.exec(line)![1]));
    expect(routes.has("/matters/:matterId")).toBe(true);
    expect(routes.has("/matters/:matterId/findings/:findingId/reviews")).toBe(true);
    expect([...routes].some((r) => /mat_[0-9a-f]{16}|req_|run_|fnd_/.test(r!))).toBe(false);
    const mattersNamed = site.logs.filter((line) => /matter=mat_[0-9a-f]{16}/.test(line));
    expect(mattersNamed.length).toBeGreaterThan(20);
  });

  it("wrote nothing of it to the log of the services either", () => {
    expect(site.w.logs.length).toBeGreaterThan(0);
    for (const line of site.w.logs)
      for (const marker of MARKERS) expect(line).not.toContain(marker);
  });

  it("stored nothing of it in the audit trail, where only ids, hashes and counts belong", () => {
    const rows = site.w.repo.db
      .prepare("SELECT action, target_id, detail_json FROM audit_events")
      .all() as { action: string; target_id: string; detail_json: string }[];
    expect(rows.length).toBeGreaterThan(20);
    for (const row of rows)
      for (const marker of MARKERS)
        expect(`${row.action} ${row.target_id} ${row.detail_json}`).not.toContain(marker);
  });

  it("answered every error with a fixed message that repeats nothing of the request", () => {
    expect(errors.length).toBeGreaterThan(12);
    for (const body of errors) for (const marker of MARKERS) expect(body).not.toContain(marker);
    // The pages that show them name only a kind of problem.
    const titles = errors
      .filter((body) => body.startsWith("<!doctype html>"))
      .map((body) => readable(first(parseHtml(body), (el) => el.name === "h1")));
    expect(new Set(titles).size).toBeGreaterThanOrEqual(4);
    for (const title of titles)
      expect([
        "That request was not valid",
        "You may not do that",
        "Page not found",
        "That conflicts with the current state",
        "That file could not be accepted",
        "That upload is too large",
        "Sign in first",
        "Something went wrong",
      ]).toContain(title);
  });
});
