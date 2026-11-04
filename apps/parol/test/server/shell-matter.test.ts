import { describe, expect, it } from "vitest";
import type { MatterAction } from "../../src/auth/actions.js";
import type { MatterRole } from "../../src/contracts.js";
import { defineMatterRoute, defineRoute } from "../../src/server/matter-route.js";
import {
  ALL_ACTIONS,
  USERS,
  addUser,
  expectedStatus,
  makeMatter,
  makeShell,
  mountActionRoutes,
  snapshot,
} from "./support-app.js";

/** Four kinds of actor against every matter action: the authorization probe matrix of docs/parol/05. */
function probeWorld(options: { relaxedSegregation?: boolean } = {}) {
  const shell = makeShell(options);
  addUser(shell.repo, "usr_synthetic_outsider");
  const { calls } = mountActionRoutes(shell.app);
  defineMatterRoute(shell.app, {
    method: "GET",
    path: "/api/matters/:matterId/readme",
    action: "matter.read",
    handler: (c) => c.json({ ok: true }),
  });
  const matterId = makeMatter(shell.repo, USERS.associate, {
    [USERS.reviewer]: "reviewer",
    [USERS.engineer]: "viewer",
  });
  return { shell, calls, matterId };
}

const ACTORS: { name: string; user: string; role: MatterRole | null }[] = [
  { name: "associate", user: USERS.associate, role: "associate" },
  { name: "reviewer", user: USERS.reviewer, role: "reviewer" },
  { name: "viewer", user: USERS.engineer, role: "viewer" },
  { name: "non-member", user: "usr_synthetic_outsider", role: null },
];

describe("authorization over HTTP", () => {
  for (const relaxed of [false, true]) {
    it(`gives each actor the status the design gives (relaxed segregation ${relaxed ? "on" : "off"})`, async () => {
      const { shell, calls, matterId } = probeWorld({ relaxedSegregation: relaxed });
      let expectedCalls = 0;
      for (const actor of ACTORS) {
        const client = await shell.signIn(actor.user);
        for (const action of ALL_ACTIONS as MatterAction[]) {
          const response = await client.post(`/api/matters/${matterId}/do/${action}`);
          // Deletion is decided apart from the role table: the creator, or an administrator.
          const expected =
            action === "matter.delete"
              ? actor.user === USERS.associate
                ? 200
                : actor.role === null
                  ? 404
                  : 403
              : actor.role === null
                ? 404
                : expectedStatus(actor.role, action, relaxed);
          expect(response.status, `${actor.name} ${action}`).toBe(expected);
          if (expected === 200) {
            expectedCalls += 1;
            expect(await response.json()).toEqual({ ok: true, role: actor.role, matterId });
          }
        }
      }
      // A handler runs only when the guard let the request through.
      expect(calls).toHaveLength(expectedCalls);
    });
  }

  it("answers 401 to everyone who is not signed in, and runs nothing", async () => {
    const { shell, calls, matterId } = probeWorld();
    const visitor = shell.anonymous();
    for (const action of ALL_ACTIONS) {
      const response = await visitor.post(`/api/matters/${matterId}/do/${action}`, {}, false);
      expect(response.status, action).toBe(401);
      expect(await response.json()).toEqual({
        error: { kind: "unauthenticated", message: "Sign in first." },
      });
    }
    expect(calls).toEqual([]);
  });

  it("sends a visitor to the page routes to the start page instead", async () => {
    const shell = makeShell();
    defineMatterRoute(shell.app, {
      method: "GET",
      path: "/matters/:matterId",
      action: "matter.read",
      handler: (c) => c.text("page"),
    });
    defineRoute(shell.app, {
      method: "GET",
      path: "/matters",
      access: "principal",
      handler: (c) => c.text("list"),
    });
    const matterId = makeMatter(shell.repo, USERS.associate);
    const visitor = shell.anonymous();
    for (const path of [`/matters/${matterId}`, "/matters", "/matters/mat_unknown"]) {
      const response = await visitor.get(path);
      expect(response.status, path).toBe(303);
      expect(response.headers.get("location")).toBe("/");
    }
    const api = await visitor.get("/api/matters");
    expect(api.status).toBe(404); // not a route here; the point is that it is not a redirect
  });

  it("passes the handler the matter the database confirmed", async () => {
    const shell = makeShell();
    const seen: { matterId: string; role: string; user: string }[] = [];
    defineMatterRoute(shell.app, {
      method: "GET",
      path: "/matters/:matterId/seen",
      action: "matter.read",
      handler: (c, am) => {
        seen.push({ matterId: am.matterId, role: am.role, user: am.principal.userId });
        return c.text("ok");
      },
    });
    const matterId = makeMatter(shell.repo, USERS.associate, { [USERS.reviewer]: "reviewer" });
    const reviewer = await shell.signIn(USERS.reviewer);
    expect((await reviewer.get(`/matters/${matterId}/seen`)).status).toBe(200);
    expect(seen).toEqual([{ matterId, role: "reviewer", user: USERS.reviewer }]);
  });

  it("decides the role from the database on every request", async () => {
    const { shell, matterId } = probeWorld();
    const reviewer = await shell.signIn(USERS.reviewer);
    const path = `/api/matters/${matterId}/do/review.decide`;
    expect((await reviewer.post(path)).status).toBe(200);
    shell.repo.db
      .prepare("UPDATE matter_members SET role = 'viewer' WHERE matter_id = ? AND user_id = ?")
      .run(matterId, USERS.reviewer);
    expect((await reviewer.post(path)).status).toBe(403);
    shell.repo.db
      .prepare("DELETE FROM matter_members WHERE matter_id = ? AND user_id = ?")
      .run(matterId, USERS.reviewer);
    expect((await reviewer.post(path)).status).toBe(404);
  });

  it("ignores a role, a matter id or a user id supplied in the request", async () => {
    const { shell, calls, matterId } = probeWorld();
    const viewer = await shell.signIn(USERS.engineer);
    const other = makeMatter(shell.repo, USERS.associate);
    const path = `/api/matters/${matterId}/do/document.write`;
    const response = await viewer.send(
      "POST",
      `${path}?role=associate&matterId=${other}&userId=${USERS.associate}`,
      {
        headers: {
          "content-type": "application/json",
          "x-csrf-token": await viewer.token(),
          "x-role": "associate",
          "x-user-id": USERS.associate,
          "x-matter-id": other,
        },
        body: JSON.stringify({ role: "associate", matterId: other, userId: USERS.associate }),
      },
    );
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("a matter that is not yours looks like a matter that is not there", () => {
  async function responses(method: string, build: (id: string) => string) {
    const { shell } = probeWorld();
    // A matter that exists and that the caller has no part in.
    const strangers = makeMatter(shell.repo, USERS.reviewer);
    const deleted = makeMatter(shell.repo, USERS.engineer);
    shell.repo.deleteMatter(deleted, { actorId: USERS.engineer });
    const softDeleted = makeMatter(shell.repo, USERS.engineer);
    shell.repo.db
      .prepare("UPDATE matters SET status = 'deleted', deleted_at = ? WHERE id = ?")
      .run("2026-11-04T09:00:00.000Z", softDeleted);
    const client = await shell.signIn(USERS.associate);
    const send = async (id: string) => {
      const token = await client.token();
      return snapshot(
        await client.send(method, build(id), {
          headers: { "x-csrf-token": token, "content-type": "application/json" },
          ...(method === "GET" ? {} : { body: "{}" }),
        }),
      );
    };
    return {
      nonMember: await send(strangers),
      missing: await send("mat_00000000000000000000"),
      hardDeleted: await send(deleted),
      softDeleted: await send(softDeleted),
      odd: await send("' OR 1=1 --"),
    };
  }

  const cases: [string, string, (id: string) => string][] = [
    ["GET", "the API", (id) => `/api/matters/${encodeURIComponent(id)}/readme`],
    ["POST", "the API", (id) => `/api/matters/${encodeURIComponent(id)}/do/run.start`],
  ];
  for (const [method, label, build] of cases) {
    it(`is byte for byte the same over ${label} with ${method}: status, headers and body`, async () => {
      const r = await responses(method, build);
      expect(r.nonMember.status).toBe(404);
      for (const other of [r.missing, r.hardDeleted, r.softDeleted, r.odd]) {
        expect(other.status).toBe(r.nonMember.status);
        expect(other.headers).toEqual(r.nonMember.headers);
        expect(other.body).toBe(r.nonMember.body);
      }
      // And the body says nothing: no id, no matter name, no role.
      expect(r.nonMember.body).not.toMatch(/mat_|Synthetic NDA|associate|member/i);
    });
  }

  it("is the same for a page as for the API's shape, within each: HTML pages match each other", async () => {
    const shell = makeShell();
    defineMatterRoute(shell.app, {
      method: "GET",
      path: "/matters/:matterId",
      action: "matter.read",
      handler: (c) => c.text("secret page"),
    });
    const strangers = makeMatter(shell.repo, USERS.reviewer);
    const client = await shell.signIn(USERS.associate);
    const a = await snapshot(await client.get(`/matters/${strangers}`));
    const b = await snapshot(await client.get("/matters/mat_nonexistent"));
    const c = await snapshot(await client.send("HEAD", `/matters/${strangers}`));
    expect(a.status).toBe(404);
    expect(b).toEqual(a);
    expect(c.status).toBe(404);
    expect(a.headers.find(([name]) => name === "content-type")?.[1]).toMatch(/text\/html/);
    expect(a.body).not.toContain("secret page");
  });

  it("is the same for the delete route, whether or not the matter exists", async () => {
    const shell = makeShell();
    addUser(shell.repo, "usr_synthetic_outsider");
    defineMatterRoute(shell.app, {
      method: "DELETE",
      path: "/api/matters/:matterId",
      action: "matter.delete",
      handler: (c) => c.json({ deleted: true }),
    });
    const strangers = makeMatter(shell.repo, USERS.reviewer);
    const client = await shell.signIn("usr_synthetic_outsider");
    const send = async (id: string) => snapshot(await client.json("DELETE", `/api/matters/${id}`));
    const real = await send(strangers);
    const none = await send("mat_nonexistent");
    expect(real.status).toBe(404);
    expect(none).toEqual(real);
  });

  it("does not let the token check reveal which of them exists", async () => {
    const { shell } = probeWorld();
    const strangers = makeMatter(shell.repo, USERS.reviewer);
    const client = await shell.signIn(USERS.associate);
    const a = await snapshot(
      await client.post(`/api/matters/${strangers}/do/matter.read`, {}, false),
    );
    const b = await snapshot(
      await client.post("/api/matters/mat_nonexistent/do/matter.read", {}, false),
    );
    expect(a.status).toBe(403);
    expect(b).toEqual(a);
  });
});

describe("deleting a matter", () => {
  function deleteWorld() {
    const shell = makeShell();
    addUser(shell.repo, "usr_synthetic_outsider");
    const deleted: string[] = [];
    defineMatterRoute(shell.app, {
      method: "DELETE",
      path: "/api/matters/:matterId",
      action: "matter.delete",
      handler: (c, am) => {
        deleted.push(am.matterId);
        return c.json({ deleted: true });
      },
    });
    const matterId = makeMatter(shell.repo, USERS.associate, {
      [USERS.reviewer]: "reviewer",
      [USERS.engineer]: "viewer",
    });
    return { shell, deleted, matterId };
  }

  it("is for the creator and an administrator, and for nobody else", async () => {
    const { shell, deleted, matterId } = deleteWorld();
    const expectations: [string, number][] = [
      [USERS.reviewer, 403],
      [USERS.engineer, 403],
      ["usr_synthetic_outsider", 404],
      [USERS.associate, 200],
      [USERS.admin, 200],
    ];
    for (const [user, status] of expectations) {
      const client = await shell.signIn(user);
      const response = await client.json("DELETE", `/api/matters/${matterId}`);
      expect(response.status, user).toBe(status);
    }
    expect(deleted).toEqual([matterId, matterId]);
  });
});

describe("a route that needs a person", () => {
  it("answers 401 for the API, redirects for pages, and passes the principal on", async () => {
    const shell = makeShell();
    defineRoute(shell.app, {
      method: "GET",
      path: "/api/mine",
      access: "principal",
      handler: (c) => c.json({ ok: true }),
    });
    defineRoute(shell.app, {
      method: "POST",
      path: "/mine",
      access: "principal",
      handler: (c) => c.text("done"),
    });
    const visitor = shell.anonymous();
    expect((await visitor.get("/api/mine")).status).toBe(401);
    const page = await visitor.post("/mine", {}, false);
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe("/");
    const person = await shell.signIn(USERS.reviewer);
    expect((await person.get("/api/mine")).status).toBe(200);
    expect((await person.post("/mine")).status).toBe(200);
  });
});
