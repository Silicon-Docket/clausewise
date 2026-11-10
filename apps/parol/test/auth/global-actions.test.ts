import { describe, expect, it } from "vitest";
import { GLOBAL_ACTIONS, globalRoleAllows, type GlobalAction } from "../../src/auth/actions.js";
import type { Principal } from "../../src/auth/types.js";
import { GLOBAL_ROLES, type GlobalRole } from "../../src/contracts.js";
import { requireGlobalRole } from "../../src/services/deps.js";
import { ForbiddenError } from "../../src/services/errors.js";

/**
 * Who may open the pages and routes that name no matter. The expected table is written out by hand
 * here and not computed from the table the code uses, so a wrong edit to either one shows up.
 */
const EXPECTED: Record<GlobalAction, readonly GlobalRole[]> = {
  "evaluation.read": ["legal_engineer", "admin"],
  "pilot.read": ["legal_engineer", "admin"],
  "pilot.manage": ["legal_engineer", "admin"],
  "audit.read": ["admin"],
  "training.key": ["legal_engineer", "admin"],
};

const ACTIONS = Object.keys(EXPECTED) as GlobalAction[];

const principal = (globalRole: GlobalRole, userId = "usr_synthetic"): Principal => ({
  userId,
  displayName: "Synthetic Person",
  globalRole,
});

describe("GLOBAL_ACTIONS", () => {
  it("names the five actions of the plan and no other", () => {
    expect(Object.keys(GLOBAL_ACTIONS).sort()).toEqual([...ACTIONS].sort());
  });

  it("lists, for each action, exactly the roles of the hand-written table", () => {
    for (const action of ACTIONS)
      expect([...GLOBAL_ACTIONS[action]].sort(), action).toEqual([...EXPECTED[action]].sort());
  });

  it("never lists the member role, which is what a person is until they are made something else", () => {
    for (const action of ACTIONS) expect(GLOBAL_ACTIONS[action], action).not.toContain("member");
  });

  it("lists the administrator for every action, which the CSRF test relies on to sign in as one", () => {
    for (const action of ACTIONS) expect(GLOBAL_ACTIONS[action], action).toContain("admin");
  });

  it("lists only roles that exist", () => {
    for (const action of ACTIONS)
      for (const role of GLOBAL_ACTIONS[action]) expect(GLOBAL_ROLES, action).toContain(role);
  });
});

describe("globalRoleAllows", () => {
  it("gives each of the three roles the answer of the hand-written table, for every action", () => {
    let cells = 0;
    for (const role of GLOBAL_ROLES)
      for (const action of ACTIONS) {
        expect(globalRoleAllows(role, action), `${role} ${action}`).toBe(
          EXPECTED[action].includes(role),
        );
        cells += 1;
      }
    expect(cells).toBe(3 * 5);
  });

  it("refuses a member everything, a legal engineer all but the audit log, and lets the administrator do all", () => {
    expect(ACTIONS.filter((a) => globalRoleAllows("member", a))).toEqual([]);
    expect(ACTIONS.filter((a) => !globalRoleAllows("legal_engineer", a))).toEqual(["audit.read"]);
    expect(ACTIONS.filter((a) => !globalRoleAllows("admin", a))).toEqual([]);
  });

  it("refuses an action that is not in the table and a role that does not exist, without throwing", () => {
    for (const action of ["", "constructor", "__proto__", "toString", "hasOwnProperty", "x.read"])
      for (const role of GLOBAL_ROLES)
        expect(globalRoleAllows(role, action as GlobalAction), `${role} ${action}`).toBe(false);
    for (const role of ["", "Admin", "ADMIN", "owner", "constructor", "__proto__"])
      for (const action of ACTIONS)
        expect(globalRoleAllows(role as GlobalRole, action), `${role} ${action}`).toBe(false);
  });
});

describe("requireGlobalRole", () => {
  it("lets through each role the table lists and throws ForbiddenError for every other", () => {
    for (const role of GLOBAL_ROLES)
      for (const action of ACTIONS) {
        const call = (): void => requireGlobalRole(principal(role), action);
        if (EXPECTED[action].includes(role)) expect(call, `${role} ${action}`).not.toThrow();
        else {
          expect(call, `${role} ${action}`).toThrow(ForbiddenError);
          try {
            call();
          } catch (error) {
            expect((error as ForbiddenError).action).toBe(action);
            // The message is fixed, and does not name the action or the role.
            expect((error as ForbiddenError).message).toBe("this role may not do that");
          }
        }
      }
  });

  it("decides on the role of the principal alone, whoever the person is", () => {
    for (const userId of ["usr_a", "usr_demo_admin", "", "usr_demo_engineer"]) {
      expect(() => requireGlobalRole(principal("member", userId), "evaluation.read")).toThrow(
        ForbiddenError,
      );
      expect(() =>
        requireGlobalRole(principal("legal_engineer", userId), "evaluation.read"),
      ).not.toThrow();
    }
  });

  it("takes the principal and the action and nothing else, so it cannot look a role up anywhere", () => {
    expect(requireGlobalRole.length).toBe(2);
  });

  it("refuses an action that is not in the table", () => {
    expect(() => requireGlobalRole(principal("admin"), "nothing.read" as GlobalAction)).toThrow(
      ForbiddenError,
    );
  });
});
