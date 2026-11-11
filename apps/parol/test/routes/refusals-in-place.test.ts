import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { AuthorizedMatter } from "../../src/auth/types.js";
import type { AppDeps } from "../../src/server/deps.js";
import { answerRefusal, createPageRenderers } from "../../src/server/routes/page-renderers.js";
import { urls } from "../../src/server/urls.js";
import { ConflictError, ValidationError } from "../../src/store/errors.js";
import { MAX_RETAIN_DAYS } from "../../src/store/index.js";
import { all, attr, hasClass, parseHtml, readable, withClass } from "../pages/html.js";
import { MATTER_PROBES, initFor, pathFor, type Probe } from "./probes.js";
import {
  IDS,
  OUTSIDER,
  VIEWER,
  cleanup,
  fingerprint,
  makeSite,
  newMatter,
  prepareMatter,
  type Browser,
  type Prepared,
  type Site,
} from "./support.js";

/**
 * A matter form that is refused is answered on the matter's own page: the status the shell gives
 * the mistake, the page the person was on with one error notice added, and a store that is as it
 * was. Only where the refusal is shown is under test here. Which words and which status a mistake
 * gets is not changed by it, so the statuses are those of the probe table
 * (evals/src/parol/exposure/probes.ts, `reaches`, the same table the authorization matrix reads)
 * and the words are the fixed phrases of routes/notices.ts.
 *
 * What stays the shell's answer is tested too: the CSRF refusal, a refusal for a role that may not
 * do the thing, a matter the caller is not on, an error that is not the form's to explain, and the
 * deletion by an administrator who holds no role on the matter, who must not be shown its page.
 */

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const M = "/matters/:matterId";

/** The notice of a refusal, as the matter page draws it. */
const NOTICE = /<div class="notice notice-error"[^>]*>.*?<\/div>/s;

/** The phrases of routes/notices.ts for the codes these forms end in. */
const NOT_VALID = "That request was not valid. Check the form and try again.";
const CONFLICT =
  "That conflicts with the current state of the matter. Reload the page and try again.";
/** The retention form's refusal: its phrase, then the link to the field that the notice carries. */
const RETENTION_DAYS = `That is not a number of days a matter can be kept for. Enter a whole number of days from 1 to ${MAX_RETAIN_DAYS}. Go to the retention field`;

/**
 * The matter forms that answer in place. `template` is the route in the probe table; `words` is what
 * the notice says for the probe's mistake (a form with nothing in it, a run that has finished).
 */
const IN_PLACE: { name: string; template: string; words: string }[] = [
  { name: "the settings", template: `${M}/settings`, words: NOT_VALID },
  { name: "adding a person", template: `${M}/members`, words: NOT_VALID },
  { name: "changing the retention date", template: `${M}/retention`, words: RETENTION_DAYS },
  { name: "deleting the matter", template: `${M}/delete`, words: NOT_VALID },
  { name: "uploading a document", template: `${M}/documents`, words: NOT_VALID },
  {
    name: "uploading a new version",
    template: `${M}/documents/:documentId/versions`,
    words: "Choose a file to upload.",
  },
  {
    name: "choosing the operative version",
    template: `${M}/documents/:documentId/operative`,
    words: NOT_VALID,
  },
  {
    name: "setting a stated date",
    template: `${M}/versions/:versionId/stated-date`,
    words: "The stated date must be a real date.",
  },
  {
    name: "removing a document",
    template: `${M}/documents/:documentId/remove`,
    words: NOT_VALID,
  },
  { name: "starting a review", template: `${M}/runs`, words: NOT_VALID },
  { name: "resuming a review", template: `${M}/runs/:runId/resume`, words: CONFLICT },
  { name: "cancelling a review", template: `${M}/runs/:runId/cancel`, words: CONFLICT },
];

const probeOf = (template: string): Probe => {
  const found = MATTER_PROBES.find((p) => p.method === "POST" && p.template === template);
  if (found === undefined) throw new Error(`no probe for POST ${template}`);
  return found;
};

let site: Site;
let ids: Prepared;
let matterName: string;
let associate: Browser;
let viewer: Browser;
let outsider: Browser;
let admin: Browser;

beforeAll(async () => {
  site = makeSite();
  // Not exported, so the run has finished and can be neither resumed nor cancelled, and the matter
  // can still be changed.
  ids = await prepareMatter(site, { exported: false });
  matterName = site.w.services.matters.view(site.w.grant(site.w.associate, ids.matterId)).matter
    .name;
  associate = await site.as(IDS.associate);
  viewer = await site.as(VIEWER);
  outsider = await site.as(OUTSIDER);
  admin = await site.as(IDS.admin);
});

const send = async (who: Browser, probe: Probe, token: string | null): Promise<Response> =>
  who.send(probe.method, pathFor(probe.template, ids), initFor(probe, token));

describe("a refused matter form", () => {
  for (const route of IN_PLACE) {
    describe(route.name, () => {
      const probe = probeOf(route.template);

      it(`is answered with ${probe.reaches}, the matter's page with one error notice, and changes nothing`, async () => {
        const asked = await associate.page(urls.matter(ids.matterId));
        const before = fingerprint(site);
        const response = await send(associate, probe, await associate.apiToken());
        expect(response.status).toBe(probe.reaches);
        expect(response.headers.get("content-type")).toMatch(/^text\/html/);
        const html = await response.text();
        const root = parseHtml(html);
        // The matter's page, and in it one notice that is an alert and says the fixed words.
        expect(readable(all(root, (el) => el.name === "h1")[0]!)).toBe(matterName);
        const alerts = all(root, (el) => attr(el, "role") === "alert");
        expect(alerts).toHaveLength(1);
        expect(hasClass(alerts[0]!, "notice-error")).toBe(true);
        expect(readable(alerts[0]!)).toBe(`Problem ${route.words}`);
        // The page that was asked from, byte for byte, with the notice added: the form's own
        // values are not put back into it and nothing of the request is in it.
        expect(html.replace(NOTICE, "")).toBe(asked.html);
        expect(fingerprint(site)).toEqual(before);
      });

      it("is the shell's 403 when the token is missing, and not the matter's page", async () => {
        const before = fingerprint(site);
        const response = await send(associate, probe, null);
        expect(response.status).toBe(403);
        const html = await response.text();
        expect(html).not.toContain(matterName);
        expect(withClass(parseHtml(html), "notice-error")).toHaveLength(0);
        expect(fingerprint(site)).toEqual(before);
      });

      it("is the shell's 403 for a viewer, and the 404 of any URL for a person who is not on the matter", async () => {
        const before = fingerprint(site);
        const forbidden = await send(viewer, probe, await viewer.apiToken());
        expect(forbidden.status).toBe(403);
        expect(await forbidden.text()).not.toContain(matterName);
        const missing = await send(outsider, probe, await outsider.apiToken());
        expect(missing.status).toBe(404);
        expect(await missing.text()).not.toContain(matterName);
        expect(fingerprint(site)).toEqual(before);
      });
    });
  }

  it("covers every matter form of the probe table that the page routes answer in place", () => {
    // A form added later that re-renders the matter page must be in the list above; a form in the
    // list must still be a probed route. The routes that are answered another way are named.
    const posts = MATTER_PROBES.filter(
      (p) => p.method === "POST" && p.template.startsWith("/matters/:matterId/"),
    ).map((p) => p.template);
    const elsewhere = [
      // A refused decision is answered on the finding's page, and the memo form never refuses.
      `${M}/findings/:findingId/reviews`,
      `${M}/memos`,
      // A refused report of a missed issue is answered on the review's page (package W2.6a,
      // routes/feedback-routes.ts; its refusals are tested in test/routes/feedback.test.ts).
      `${M}/runs/:runId/missed-issues`,
    ];
    expect([...posts].sort()).toEqual([...IN_PLACE.map((r) => r.template), ...elsewhere].sort());
  });
});

describe("a refused form to make a matter", () => {
  const post = (who: Browser, token: string | null): Promise<Response> =>
    who.send("POST", urls.matters(), {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(token === null ? [] : [["_csrf", token]]).toString(),
    });

  it("is answered with 400 on the list of matters, with one error notice, and makes nothing", async () => {
    const asked = await associate.page(urls.matters());
    const before = fingerprint(site);
    const response = await post(associate, await associate.apiToken());
    expect(response.status).toBe(400);
    const html = await response.text();
    const alerts = all(parseHtml(html), (el) => attr(el, "role") === "alert");
    expect(alerts).toHaveLength(1);
    expect(readable(alerts[0]!)).toBe(`Problem ${NOT_VALID}`);
    expect(html.replace(NOTICE, "")).toBe(asked.html);
    expect(html).toContain(matterName);
    expect(fingerprint(site)).toEqual(before);
  });

  it("is the shell's 403 when the token is missing, and not the list", async () => {
    const before = fingerprint(site);
    const response = await post(associate, null);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(matterName);
    expect(fingerprint(site)).toEqual(before);
  });
});

describe("what the shell still answers", () => {
  it("answers an error that is not a refusal of the form with its own page, not the matter's", async () => {
    // A matter with no documents is not ready for a review. That is the shell's 409, not a mistake
    // in the form, so the start form (which has nothing wrong with it) is not answered in place.
    const { matterId } = newMatter(site.w, "A matter with nothing in it");
    const before = fingerprint(site);
    const start = new URLSearchParams([
      ["_csrf", await associate.apiToken()],
      ["workflow", "v2"],
    ]);
    const response = await associate.send("POST", urls.runs(matterId), {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: start.toString(),
    });
    expect(response.status).toBe(409);
    const html = await response.text();
    expect(html).toContain("That conflicts with the current state");
    expect(html).not.toContain("A matter with nothing in it");
    expect(withClass(parseHtml(html), "notice-error")).toHaveLength(0);
    expect(fingerprint(site)).toEqual(before);
  });

  it("answers an administrator who is not on the matter, refused a deletion, with its own page and not the matter's", async () => {
    // Deleting is the one act a person with no role on the matter may do. The matter's page is not
    // theirs to read, so a refusal is not an occasion to show it.
    const probe = probeOf(`${M}/delete`);
    const before = fingerprint(site);
    const response = await send(admin, probe, await admin.apiToken());
    expect(response.status).toBe(probe.reaches);
    const html = await response.text();
    expect(html).not.toContain(matterName);
    expect(withClass(parseHtml(html), "notice-error")).toHaveLength(0);
    expect(readable(all(parseHtml(html), (el) => el.name === "h1")[0]!)).toBe(
      "That request was not valid",
    );
    expect(fingerprint(site)).toEqual(before);
  });
});

describe("answerRefusal and answerInPlace", () => {
  const refusal = (error: unknown) => async (): Promise<Response> => {
    throw error;
  };
  const rendered = (text: string) => () => new Response(text);

  it("returns what the work returns when nothing was refused", async () => {
    const answer = await answerRefusal(
      () => new Response("done"),
      () => new Response("shown"),
    );
    expect(await answer.text()).toBe("done");
  });

  it("shows a refusal the person can fix, whichever way it was thrown", async () => {
    const given = [
      new ValidationError("bad_date", "x"),
      new ConflictError("nda_exists", "x"),
      new ZodError([]),
    ];
    for (const error of given) {
      const answer = await answerRefusal(refusal(error), rendered("shown"));
      expect(await answer.text(), error.constructor.name).toBe("shown");
    }
  });

  it("throws every other error again, unchanged, and shows nothing", async () => {
    let shown = 0;
    for (const error of [new Error("a fault"), new TypeError("another"), "a string"]) {
      await expect(
        answerRefusal(refusal(error), () => {
          shown += 1;
          return new Response("shown");
        }),
      ).rejects.toBe(error);
    }
    expect(shown).toBe(0);
  });

  it("throws the refusal itself again when the page declines to answer it", async () => {
    const error = new ValidationError("bad_date", "x");
    await expect(answerRefusal(refusal(error), () => null)).rejects.toBe(error);
  });

  it("does not show the matter's page to a person who holds no role on the matter", async () => {
    const error = new ValidationError("bad_date", "x");
    const am = { matterId: "mat_1", principal: { userId: "usr_admin" }, role: "viewer" };
    const deps = {
      repo: { getMember: () => undefined },
      services: { matters: {}, runs: {}, reviews: {} },
    } as unknown as AppDeps;
    const { answerInPlace } = createPageRenderers(deps);
    await expect(
      answerInPlace({} as never, am as unknown as AuthorizedMatter, refusal(error)),
    ).rejects.toBe(error);
  });
});
