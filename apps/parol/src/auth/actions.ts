import type { GlobalRole, MatterRole } from "../contracts.js";

/**
 * What each matter role may do, from the API table in docs/parol/03 and the authorization table in
 * docs/parol/06. One table, used by the middleware and again by the services, so a route cannot be
 * more permissive than the code behind it.
 */
const ALL: readonly MatterRole[] = ["associate", "reviewer", "viewer"];

export const MATTER_ACTIONS = {
  "matter.read": ALL,
  "matter.update": ["associate"],
  "member.add": ["associate"],
  "document.write": ["associate"],
  "run.start": ["associate"],
  "run.resume": ["associate"],
  "run.read": ALL,
  "finding.read": ALL,
  "review.decide": ["reviewer"],
  "memo.export": ["reviewer"],
  "memo.read": ALL,
  "feedback.add": ALL,
  /** Deletion is a creator or admin act and is decided apart from this table. */
  "matter.delete": [],
} as const satisfies Record<string, readonly MatterRole[]>;

export type MatterAction = keyof typeof MATTER_ACTIONS;

/**
 * Whether a role may perform an action. With `relaxedSegregation` (a single-person demo) an
 * associate may also decide findings and export, and the memo says so. Without it a reviewer must be
 * a different person from the associate.
 */
export function roleAllows(
  role: MatterRole,
  action: MatterAction,
  options: { relaxedSegregation?: boolean } = {},
): boolean {
  if ((MATTER_ACTIONS[action] as readonly MatterRole[]).includes(role)) return true;
  return (
    options.relaxedSegregation === true &&
    role === "associate" &&
    (action === "review.decide" || action === "memo.export")
  );
}

/**
 * What each global role may do on a page or a route that names no matter (the evaluation
 * comparison, the pilot measures, the audit log, the trainer's key). One table, used by the route
 * guard (`defineRoute`), by the services behind the routes (`requireGlobalRole`) and by the
 * navigation, so a link is shown to the people who will be let through and to no one else. A
 * matter role says nothing here: a global role belongs to the person and not to a matter.
 */
export const GLOBAL_ACTIONS = {
  "evaluation.read": ["legal_engineer", "admin"],
  "pilot.read": ["legal_engineer", "admin"],
  "pilot.manage": ["legal_engineer", "admin"],
  "audit.read": ["admin"],
  "training.key": ["legal_engineer", "admin"],
} as const satisfies Record<string, readonly GlobalRole[]>;

export type GlobalAction = keyof typeof GLOBAL_ACTIONS;

/**
 * Whether a global role may perform an action. An action that is not in the table, or a role that
 * is not listed for it, is refused: nothing is allowed by default.
 */
export const globalRoleAllows = (role: GlobalRole, action: GlobalAction): boolean =>
  Object.hasOwn(GLOBAL_ACTIONS, action) &&
  (GLOBAL_ACTIONS[action] as readonly GlobalRole[]).includes(role);
