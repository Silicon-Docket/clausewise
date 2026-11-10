import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MATTER_ACTIONS } from "../../src/auth/actions.js";
import { defineRoute, describeRoutes } from "../../src/server/matter-route.js";
import {
  MATTER_PROBES,
  OTHER_PROBES,
  initFor,
  pathFor,
  type OtherProbe,
  type Probe,
} from "./probes.js";
import {
  IDS,
  OTHER_ASSOCIATE,
  addMember,
  cleanup,
  fingerprint,
  makeSite,
  prepareMatter,
  type Browser,
  type Prepared,
  type Site,
} from "./support.js";

/**
 * Cross-site request forgery. Every route that changes anything refuses a request whose token is
 * missing, empty, wrong, one that belongs to another session, or one made for a visitor who has no
 * session, and it refuses before it says anything about the matter (so the answer for a matter that
 * does not exist is the answer for one that does) and before it changes anything.
 *
 * The routes are not listed here: they are the unsafe routes of the application, found in its
 * router and matched to the probes of probes.ts, so a route added later is tested or this fails.
 */

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let site: Site;
let ids: Prepared;
let associate: Browser;
let reviewer: Browser;
let anonymousToken: string;

beforeAll(async () => {
  site = makeSite();
  ids = await prepareMatter(site);
  associate = await site.as(IDS.associate);
  reviewer = await site.as(IDS.reviewer);
  // A token made for a visitor who has not signed in.
  anonymousToken = await site.anonymous().apiToken();
});

const UNSAFE = (method: string): boolean => method !== "GET";

/** Who may do a probe's action, so that the control request (a good token) is let in. */
function memberFor(probe: Probe): Browser {
  if (probe.action === "matter.delete") return associate;
  const roles = MATTER_ACTIONS[probe.action] as readonly string[];
  return roles.includes("associate") ? associate : reviewer;
}

async function freshMatter(): Promise<string> {
  const summary = site.w.services.matters.create(site.w.associate, {
    name: "A matter made for one request",
    clientLegalName: "Lanternfish Software, Inc.",
    playbookVersionId: null,
    reviewerUserId: IDS.reviewer,
  });
  addMember(site, summary.id, OTHER_ASSOCIATE, "viewer");
  return summary.id;
}

type Variant = { name: string; token: (self: Browser) => Promise<string | null> };
const VARIANTS: Variant[] = [
  { name: "no token", token: async () => null },
  { name: "an empty token", token: async () => "" },
  { name: "a wrong token", token: async () => "not-a-token-0123456789abcdefghijklmnopqrstuv" },
  {
    name: "the token of another session",
    // Always a session of a different person, so the token cannot be this browser's own.
    token: async (self) => (self === reviewer ? associate.apiToken() : reviewer.apiToken()),
  },
  { name: "a token made for a visitor with no session", token: async () => anonymousToken },
];

describe("every route that changes something refuses a request without its own token", () => {
  for (const probe of MATTER_PROBES.filter((p) => UNSAFE(p.method))) {
    describe(`${probe.method} ${probe.template}`, () => {
      for (const variant of VARIANTS) {
        it(`refuses ${variant.name} with 403 before anything else`, async () => {
          const self = memberFor(probe);
          const matterId = probe.fresh === true ? await freshMatter() : ids.matterId;
          const before = fingerprint(site);
          const token = await variant.token(self);
          const response = await self.send(
            probe.method,
            pathFor(probe.template, ids, matterId),
            initFor(probe, token),
          );
          expect(response.status).toBe(403);
          if (probe.template.startsWith("/api/"))
            expect(((await response.json()) as { error: { kind: string } }).error.kind).toBe(
              "csrf",
            );
          // The guard refused before authorizing, so the log does not name the matter.
          expect(site.logs.at(-1)).toMatch(/ matter=-$/);
          expect(fingerprint(site)).toEqual(before);
          // And it did not say whether the matter exists: the same refusal for one that does not.
          const nothing = await self.send(
            probe.method,
            pathFor(probe.template, ids, "mat_0000000000000000"),
            initFor(probe, token),
          );
          expect(nothing.status).toBe(403);
        });
      }

      it("lets the same request in with the right token", async () => {
        const self = memberFor(probe);
        const matterId = probe.fresh === true ? await freshMatter() : ids.matterId;
        const response = await self.send(
          probe.method,
          pathFor(probe.template, ids, matterId),
          initFor(probe, await self.apiToken()),
        );
        expect(response.status).toBe(probe.reaches);
      });
    });
  }
});

/**
 * The browser a probe is sent from: signed in for a route that needs a person, with a cookie only
 * otherwise. A route that names a global action is signed in as the administrator, who is in
 * every list (a member would be refused by the role before the request were let in, and the
 * check is of the token); any other route that needs a person is the associate's.
 */
async function browserFor(probe: OtherProbe, on: Site = site): Promise<Browser> {
  if (probe.access !== "principal") return on.anonymous();
  return on.as(probe.globalAction === undefined ? IDS.associate : IDS.admin);
}

/**
 * The checks of the routes that name no matter and change something, over the probes it is given
 * and the site they are on. The guard's order is the person, then the token, then the global role,
 * so a request with a bad token is refused with 403 whoever sends it, and one with the right token
 * is let in only by someone the role lets in.
 */
function otherRoutesBlock(title: string, unsafe: readonly OtherProbe[], siteOf: () => Site) {
  describe(title, () => {
    for (const probe of unsafe) {
      describe(`${probe.method} ${probe.template}`, () => {
        for (const variant of VARIANTS) {
          it(`refuses ${variant.name} with 403 and changes nothing`, async () => {
            const on = siteOf();
            const self = await browserFor(probe, on);
            // The browser needs its own cookie before another session's token can be said to differ.
            const own = await self.apiToken();
            const before = fingerprint(on);
            const token = await variant.token(self);
            expect(token).not.toBe(own);
            const response = await self.send(probe.method, probe.template, initFor(probe, token));
            expect(response.status).toBe(403);
            expect(fingerprint(on)).toEqual(before);
            // A refused sign-in did not sign anyone in.
            if (probe.template === "/session") {
              const session = (await (await self.get("/api/session")).json()) as { user: unknown };
              expect(session.user).toBeNull();
            }
          });
        }

        it("lets the same request in with the right token", async () => {
          const self = await browserFor(probe, siteOf());
          const response = await self.send(
            probe.method,
            probe.template,
            initFor(probe, await self.apiToken()),
          );
          expect([200, 201, 303]).toContain(response.status);
        });
      });
    }
  });
}

describe("the routes that name no matter refuse them too", () => {
  otherRoutesBlock(
    "on the application's own routes",
    OTHER_PROBES.filter((p) => UNSAFE(p.method)),
    () => site,
  );
});

/**
 * A write that exists for this test alone, on a site of its own, for the global action
 * `pilot.manage`, so that the browser of a route that names a global action is shown to be signed
 * in as someone the role lets in, and the token to be checked before the role. It is a JSON route,
 * because the answer to a script names the kind of refusal (`csrf` or `forbidden`), which is what
 * tells the two apart.
 */
const SYNTHETIC_WRITE: OtherProbe = {
  method: "POST",
  template: "/api/synthetic/calendar",
  access: "principal",
  body: { kind: "json", json: { startDate: "2026-11-09" } },
  globalAction: "pilot.manage",
};

const refusalKind = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { kind: string } }).error.kind;

describe("a write that names a global action", () => {
  let synthetic: Site;
  beforeAll(() => {
    synthetic = makeSite();
    defineRoute(synthetic.app, {
      method: SYNTHETIC_WRITE.method,
      path: SYNTHETIC_WRITE.template,
      access: "principal",
      globalAction: "pilot.manage",
      handler: (c) => c.json({ saved: true }),
    });
  });

  otherRoutesBlock(
    "refuses the token variants and lets the right one in",
    [SYNTHETIC_WRITE],
    () => synthetic,
  );

  it("signs the browser of such a probe in as the administrator, the browser of any other that needs a person as the associate, and a public one in as nobody", async () => {
    type Who = { user: { userId: string; globalRole: string } | null };
    const whoIs = async (browser: Browser): Promise<Who> =>
      (await (await browser.get("/api/session")).json()) as Who;
    expect((await whoIs(await browserFor(SYNTHETIC_WRITE, synthetic))).user).toMatchObject({
      userId: IDS.admin,
      globalRole: "admin",
    });
    const plain = OTHER_PROBES.find(
      (p) => p.access === "principal" && p.globalAction === undefined,
    )!;
    expect((await whoIs(await browserFor(plain, synthetic))).user).toMatchObject({
      userId: IDS.associate,
      globalRole: "member",
    });
    expect(
      (await whoIs(await browserFor({ ...plain, access: "public" }, synthetic))).user,
    ).toBeNull();
  });

  it("is refused by the token before the role, and by the role after the token, for a member", async () => {
    const member = await synthetic.as(IDS.associate);
    const before = fingerprint(synthetic);
    const send = async (token: string | null): Promise<Response> =>
      member.send(
        SYNTHETIC_WRITE.method,
        SYNTHETIC_WRITE.template,
        initFor(SYNTHETIC_WRITE, token),
      );
    // No token, and a wrong one: the token is checked first, whoever the person is.
    for (const token of [null, "not-a-token-0123456789abcdefghijklmnopqrstuv"]) {
      const bad = await send(token);
      expect(bad.status).toBe(403);
      expect(await refusalKind(bad)).toBe("csrf");
    }
    // The right token: the role refuses, with the same status and another kind of refusal.
    const right = await send(await member.apiToken());
    expect(right.status).toBe(403);
    expect(await refusalKind(right)).toBe("forbidden");
    expect(fingerprint(synthetic)).toEqual(before);
    // And the same request, with the right token, from the administrator is let in.
    const admin = await synthetic.as(IDS.admin);
    const letIn = await admin.send(
      SYNTHETIC_WRITE.method,
      SYNTHETIC_WRITE.template,
      initFor(SYNTHETIC_WRITE, await admin.apiToken()),
    );
    expect(letIn.status).toBe(200);
  });
});

describe("the rest of the rule", () => {
  it("is tested for every route that changes something the application has", () => {
    const probed = new Set([
      ...MATTER_PROBES.map((p) => `${p.method} ${p.template}`),
      ...OTHER_PROBES.map((p) => `${p.method} ${p.template}`),
    ]);
    const unsafe = describeRoutes(site.app).filter(
      (route) => route.kind !== "unmanaged" && route.kind !== "middleware" && UNSAFE(route.method),
    );
    // Every unsafe probe is a route, so the count says nothing was left out of either list.
    expect(unsafe.length).toBe([...probed].filter((k) => !k.startsWith("GET ")).length);
    expect(
      unsafe.map((route) => `${route.method} ${route.path}`).filter((k) => !probed.has(k)),
    ).toEqual([]);
  });

  it("does not retry a wrong header against the form field", async () => {
    const good = await associate.apiToken();
    const response = await associate.send(
      "POST",
      `/matters/${ids.matterId}/runs/${ids.runId}/cancel`,
      {
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-csrf-token": "wrong",
        },
        body: new URLSearchParams({ _csrf: good }).toString(),
      },
    );
    expect(response.status).toBe(403);
  });

  it("refuses a matter route without a token before it says whether the matter exists, for a stranger too", async () => {
    const stranger = await site.as(OTHER_ASSOCIATE);
    const real = await stranger.send("POST", `/matters/${ids.matterId}/runs`, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    const missing = await stranger.send("POST", "/matters/mat_0000000000000000/runs", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect([real.status, missing.status]).toEqual([403, 403]);
    expect(await real.text()).toBe(await missing.text());
  });

  it("does not ask a read for a token", async () => {
    for (const path of [`/matters/${ids.matterId}`, `/api/matters/${ids.matterId}`]) {
      const response = await associate.get(path);
      expect(response.status).toBe(200);
    }
  });
});
