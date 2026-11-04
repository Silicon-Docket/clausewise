import type { MatterRole } from "../contracts.js";

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
