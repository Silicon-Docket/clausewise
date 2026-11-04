import { describe, expect, it } from "vitest";
import { MATTER_ACTIONS, type MatterAction } from "../../src/auth/actions.js";
import { authorizeMatter, authorizeMatterDelete } from "../../src/auth/authorize.js";
import type { Principal } from "../../src/auth/types.js";
import type { MatterRole } from "../../src/contracts.js";
import { ForbiddenError } from "../../src/services/errors.js";
import { NotFoundError } from "../../src/store/errors.js";
import {
  EXPECTED_ROLES as ALLOWED,
  RELAXED_EXTRA,
  USERS,
  addUser,
  makeMatter,
  makeShell,
} from "../server/support-app.js";

const ROLES: MatterRole[] = ["associate", "reviewer", "viewer"];

function world() {
  const shell = makeShell();
  addUser(shell.repo, "usr_synthetic_outsider");
  const matterId = makeMatter(shell.repo, USERS.associate, {
    [USERS.reviewer]: "reviewer",
    [USERS.engineer]: "viewer",
  });
  const principal = (userId: string): Principal => {
    const user = shell.repo.getUser(userId)!;
    return { userId: user.id, displayName: user.displayName, globalRole: user.globalRole };
  };
  const holders: Record<MatterRole, Principal> = {
    associate: principal(USERS.associate),
    reviewer: principal(USERS.reviewer),
    viewer: principal(USERS.engineer),
  };
  return { shell, matterId, principal, holders, repo: shell.repo };
}

function outcome(run: () => unknown): "ok" | "forbidden" | "not_found" {
  try {
    run();
    return "ok";
  } catch (error) {
    if (error instanceof ForbiddenError) return "forbidden";
    if (error instanceof NotFoundError) return "not_found";
    throw error;
  }
}

describe("authorizeMatter across every role and action", () => {
  const actions = Object.keys(MATTER_ACTIONS) as MatterAction[];

  it("covers every action the table defines", () => {
    expect(new Set(actions)).toEqual(new Set(Object.keys(ALLOWED)));
  });

  for (const relaxed of [false, true]) {
    it(`allows exactly what the design allows (relaxed segregation ${relaxed ? "on" : "off"})`, () => {
      const { repo, matterId, holders } = world();
      for (const action of actions) {
        for (const role of ROLES) {
          const expected =
            ALLOWED[action].includes(role) || (relaxed && RELAXED_EXTRA[action]?.includes(role))
              ? "ok"
              : "forbidden";
          const got = outcome(() =>
            authorizeMatter(repo, holders[role], matterId, action, { relaxedSegregation: relaxed }),
          );
          expect(got, `${role} ${action}`).toBe(expected);
        }
      }
    });
  }

  it("returns the role the database holds and the stored matter id", () => {
    const { repo, matterId, holders } = world();
    for (const role of ROLES) {
      const am = authorizeMatter(repo, holders[role], matterId, "matter.read", {});
      expect(am.role).toBe(role);
      expect(am.matterId).toBe(matterId);
      expect(am.principal).toEqual(holders[role]);
    }
  });

  it("treats a missing relaxed flag as off", () => {
    const { repo, matterId, holders } = world();
    expect(outcome(() => authorizeMatter(repo, holders.associate, matterId, "review.decide"))).toBe(
      "forbidden",
    );
    expect(
      outcome(() =>
        authorizeMatter(repo, holders.associate, matterId, "review.decide", {
          relaxedSegregation: undefined,
        }),
      ),
    ).toBe("forbidden");
  });

  it("does not let relaxing segregation widen anyone else", () => {
    const { repo, matterId, holders } = world();
    for (const action of actions) {
      for (const role of ["reviewer", "viewer"] as const) {
        const strict = outcome(() => authorizeMatter(repo, holders[role], matterId, action, {}));
        const relaxed = outcome(() =>
          authorizeMatter(repo, holders[role], matterId, action, { relaxedSegregation: true }),
        );
        expect(relaxed, `${role} ${action}`).toBe(strict);
      }
    }
  });

  it("refuses an action the table does not list, to every member, as it would a forbidden one", () => {
    const { repo, matterId, holders, principal } = world();
    for (const action of ["matter.drop", "", "__proto__", "constructor", "toString"]) {
      for (const role of ROLES)
        expect(
          outcome(() =>
            authorizeMatter(repo, holders[role], matterId, action as MatterAction, {
              relaxedSegregation: true,
            }),
          ),
          `${role} ${action}`,
        ).toBe("forbidden");
      // And it still tells a stranger nothing.
      expect(
        outcome(() =>
          authorizeMatter(
            repo,
            principal("usr_synthetic_outsider"),
            matterId,
            action as MatterAction,
          ),
        ),
      ).toBe("not_found");
    }
  });

  it("never authorizes matter.delete through this function, for any member", () => {
    const { repo, matterId, holders } = world();
    for (const role of ROLES)
      for (const relaxed of [false, true])
        expect(
          outcome(() =>
            authorizeMatter(repo, holders[role], matterId, "matter.delete", {
              relaxedSegregation: relaxed,
            }),
          ),
        ).toBe("forbidden");
  });
});

describe("who is not a member, or what is not there", () => {
  it("is not found for a non-member on every action, with one error and one message", () => {
    const { repo, matterId, principal } = world();
    const outsider = principal("usr_synthetic_outsider");
    const admin = principal(USERS.admin); // a global role gives no membership
    const messages = new Set<string>();
    for (const action of Object.keys(MATTER_ACTIONS) as MatterAction[]) {
      for (const who of [outsider, admin]) {
        try {
          authorizeMatter(repo, who, matterId, action, { relaxedSegregation: true });
          expect.unreachable("a non-member was authorized");
        } catch (error) {
          expect(error).toBeInstanceOf(NotFoundError);
          messages.add((error as Error).message);
        }
      }
    }
    expect(messages.size).toBe(1);
  });

  it("makes a missing matter, a non-member and a deleted matter indistinguishable", () => {
    const { repo, matterId, principal, holders } = world();
    const outsider = principal("usr_synthetic_outsider");
    const softDeleted = makeMatter(repo, USERS.associate);
    repo.db
      .prepare("UPDATE matters SET status = 'deleted', deleted_at = ? WHERE id = ?")
      .run("2026-11-04T09:00:00.000Z", softDeleted);
    const hardDeleted = makeMatter(repo, USERS.associate);
    repo.deleteMatter(hardDeleted, { actorId: USERS.associate });

    const errors = [
      () => authorizeMatter(repo, outsider, matterId, "matter.read", {}),
      () => authorizeMatter(repo, holders.associate, "mat_does_not_exist", "matter.read", {}),
      () => authorizeMatter(repo, holders.associate, softDeleted, "matter.read", {}),
      () => authorizeMatter(repo, holders.associate, hardDeleted, "matter.read", {}),
      () => authorizeMatter(repo, holders.associate, "", "matter.read", {}),
      () => authorizeMatter(repo, holders.associate, "' OR 1=1 --", "matter.read", {}),
      () => authorizeMatter(repo, holders.associate, "mat_\0x", "matter.read", {}),
    ].map((run) => {
      try {
        run();
        return null;
      } catch (error) {
        return error as Error;
      }
    });
    for (const error of errors) {
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error!.message).toBe(errors[0]!.message);
      expect(error!.name).toBe(errors[0]!.name);
      expect((error as NotFoundError).entity).toBe("matter");
    }
  });

  it("stops authorizing a member the moment the matter is deleted", () => {
    const { repo, holders } = world();
    const id = makeMatter(repo, USERS.associate);
    expect(outcome(() => authorizeMatter(repo, holders.associate, id, "matter.read", {}))).toBe(
      "ok",
    );
    repo.deleteMatter(id, { actorId: USERS.associate });
    expect(outcome(() => authorizeMatter(repo, holders.associate, id, "matter.read", {}))).toBe(
      "not_found",
    );
  });

  it("decides from the database and not from the principal it is handed", () => {
    const { repo, matterId, holders } = world();
    // A principal object claiming to be an administrator changes nothing for a non-member.
    const claimed: Principal = {
      ...holders.viewer,
      userId: "usr_synthetic_outsider",
      globalRole: "admin",
    };
    expect(outcome(() => authorizeMatter(repo, claimed, matterId, "matter.read", {}))).toBe(
      "not_found",
    );
    // A viewer who claims a different display name or role is still a viewer.
    const dressed: Principal = {
      ...holders.viewer,
      globalRole: "admin",
      displayName: "Alex Ruiz (associate)",
    };
    expect(outcome(() => authorizeMatter(repo, dressed, matterId, "document.write", {}))).toBe(
      "forbidden",
    );
  });
});

describe("authorizeMatterDelete", () => {
  it("allows the creator, whatever role they hold", () => {
    const { repo, matterId, holders } = world();
    const am = authorizeMatterDelete(repo, holders.associate, matterId);
    expect(am.matterId).toBe(matterId);
    expect(am.role).toBe("associate");
  });

  it("allows a creator who is no longer a member", () => {
    const { repo, matterId, holders } = world();
    repo.db
      .prepare("DELETE FROM matter_members WHERE matter_id = ? AND user_id = ?")
      .run(matterId, USERS.associate);
    const am = authorizeMatterDelete(repo, holders.associate, matterId);
    expect(am.matterId).toBe(matterId);
    // Holding no role, the result carries the least one, so it is good for the deletion only.
    expect(am.role).toBe("viewer");
  });

  it("allows an administrator who is not a member: the one case where a non-member may act", () => {
    const { repo, matterId, principal } = world();
    expect(repo.getMember(matterId, USERS.admin)).toBeUndefined();
    const am = authorizeMatterDelete(repo, principal(USERS.admin), matterId);
    expect(am.matterId).toBe(matterId);
    expect(am.principal.userId).toBe(USERS.admin);
    expect(am.role).toBe("viewer");
  });

  it("does not give that administrator more than deletion", () => {
    const { repo, matterId, principal } = world();
    const am = authorizeMatterDelete(repo, principal(USERS.admin), matterId);
    expect(am.role).toBe("viewer");
    // The same person is still a stranger to every other action.
    expect(
      outcome(() => authorizeMatter(repo, principal(USERS.admin), matterId, "matter.read", {})),
    ).toBe("not_found");
  });

  it("refuses a member who is neither the creator nor an administrator, with 403", () => {
    const { repo, matterId, holders } = world();
    expect(outcome(() => authorizeMatterDelete(repo, holders.reviewer, matterId))).toBe(
      "forbidden",
    );
    expect(outcome(() => authorizeMatterDelete(repo, holders.viewer, matterId))).toBe("forbidden");
    // Even another associate: the role is not what decides.
    addUser(repo, "usr_synthetic_second_associate");
    repo.addMember(matterId, "usr_synthetic_second_associate", "associate", {
      actorId: USERS.associate,
    });
    const second = repo.getUser("usr_synthetic_second_associate")!;
    expect(
      outcome(() =>
        authorizeMatterDelete(
          repo,
          { userId: second.id, displayName: second.displayName, globalRole: second.globalRole },
          matterId,
        ),
      ),
    ).toBe("forbidden");
  });

  it("does not reveal the matter to a stranger who is not an administrator", () => {
    const { repo, matterId, principal } = world();
    const stranger = principal("usr_synthetic_outsider");
    expect(outcome(() => authorizeMatterDelete(repo, stranger, matterId))).toBe("not_found");
    expect(
      outcome(() => authorizeMatterDelete(repo, principal(USERS.engineer), "mat_missing")),
    ).toBe("not_found");
  });

  it("reads the administrator role from the database, not from the principal", () => {
    const { repo, matterId, principal } = world();
    const stranger = principal("usr_synthetic_outsider");
    const claimsAdmin: Principal = { ...stranger, globalRole: "admin" };
    expect(outcome(() => authorizeMatterDelete(repo, claimsAdmin, matterId))).toBe("not_found");
    // And the other way: a demoted administrator loses the right at once.
    const admin = principal(USERS.admin);
    repo.db.prepare("UPDATE users SET global_role = 'member' WHERE id = ?").run(USERS.admin);
    expect(outcome(() => authorizeMatterDelete(repo, admin, matterId))).toBe("not_found");
  });

  it("is not found for a deleted matter, even for its creator or an administrator", () => {
    const { repo, principal } = world();
    const id = makeMatter(repo, USERS.associate);
    repo.db
      .prepare("UPDATE matters SET status = 'deleted', deleted_at = ? WHERE id = ?")
      .run("2026-11-04T09:00:00.000Z", id);
    expect(outcome(() => authorizeMatterDelete(repo, principal(USERS.associate), id))).toBe(
      "not_found",
    );
    expect(outcome(() => authorizeMatterDelete(repo, principal(USERS.admin), id))).toBe(
      "not_found",
    );
  });
});
