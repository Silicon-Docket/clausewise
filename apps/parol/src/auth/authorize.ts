import type { MatterRole } from "../contracts.js";
import { ForbiddenError } from "../services/errors.js";
import { NotFoundError } from "../store/errors.js";
import type { Repository } from "../store/index.js";
import type { MatterRow } from "../store/types.js";
import { MATTER_ACTIONS, roleAllows, type MatterAction } from "./actions.js";
import type { AuthorizedMatter, Principal } from "./types.js";

/**
 * Matter authorization (docs/parol/06). This is the only file that makes an `AuthorizedMatter`; a
 * test scans the source and fails if any other file does. Everything here is decided from the
 * database, in this order, and nothing in a request but the matter id is an input.
 *
 * A person who is not a member, a matter that does not exist and a matter that has been deleted all
 * throw the same `NotFoundError`, so the response cannot tell them apart and the existence of a
 * matter is not revealed. Only a member whose role may not do the thing gets `ForbiddenError`, and
 * a member already knows the matter exists.
 */

export interface AuthorizeConfig {
  relaxedSegregation?: boolean | undefined;
}

/** The one place the brand is made. The brand has no runtime form, so this is a typed claim. */
function grant(matterId: string, principal: Principal, role: MatterRole): AuthorizedMatter {
  return { matterId, principal, role } as AuthorizedMatter;
}

/** A matter a request may name: it exists and is not deleted. */
function liveMatter(repo: Repository, matterId: string): MatterRow {
  const matter = typeof matterId === "string" ? repo.getMatter(matterId) : undefined;
  if (matter === undefined || matter.status === "deleted" || matter.deletedAt !== null)
    throw new NotFoundError("matter");
  return matter;
}

export function authorizeMatter(
  repo: Repository,
  principal: Principal,
  matterId: string,
  action: MatterAction,
  config: AuthorizeConfig = {},
): AuthorizedMatter {
  const matter = liveMatter(repo, matterId);
  const member = repo.getMember(matter.id, principal.userId);
  if (member === undefined) throw new NotFoundError("matter");
  // An action the table does not list is refused to everyone, not looked up and trusted.
  if (
    !Object.hasOwn(MATTER_ACTIONS, action) ||
    !roleAllows(member.role, action, { relaxedSegregation: config.relaxedSegregation === true })
  )
    throw new ForbiddenError(action);
  // The id on the result is the stored one, not the string the request carried.
  return grant(matter.id, principal, member.role);
}

/**
 * Deleting a matter is the creator's act, or an administrator's. This is the one case where a
 * person who is not a member may act, so it is decided apart from the role table. The global role
 * is read again from the database and not taken from the `Principal` the caller holds.
 *
 * A member who is neither gets `ForbiddenError`. Anyone else gets `NotFoundError`, as everywhere.
 * The role on the result is the member's own, or `viewer` (the least) for a creator or an
 * administrator who holds none, so the value cannot be used for more than the deletion it is for.
 */
export function authorizeMatterDelete(
  repo: Repository,
  principal: Principal,
  matterId: string,
): AuthorizedMatter {
  const matter = liveMatter(repo, matterId);
  const user = repo.getUser(principal.userId);
  if (user === undefined) throw new NotFoundError("matter");
  const member = repo.getMember(matter.id, user.id);
  const mayDelete = matter.createdBy === user.id || user.globalRole === "admin";
  if (!mayDelete) {
    if (member === undefined) throw new NotFoundError("matter");
    throw new ForbiddenError("matter.delete");
  }
  const checked: Principal = {
    userId: user.id,
    displayName: user.displayName,
    globalRole: user.globalRole,
  };
  return grant(matter.id, checked, member?.role ?? "viewer");
}
