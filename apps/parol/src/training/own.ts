import type { Principal } from "../auth/types.js";
import type { Services } from "../services/types.js";
import type { MatterSummary } from "../services/views.js";
import type { Repository } from "../store/index.js";
import { T01 } from "./t01.js";

/**
 * The training matter T01 that this person made (package W2.8), if they have made one.
 *
 * "Their own" is tied to creation and not to their role. The database holds one T01 per creator,
 * and an associate can make another person an associate of a matter (`member.add`), so being the
 * associate of a T01 says nothing about whose it is. A person who was added to someone else's T01
 * still has none of their own, and the start form and the start must treat them so.
 *
 * The list is the services' own, so it holds only matters the person is a member of, and the
 * creator of a matter is always a member of it (as its associate), so this finds their matter.
 * Every later step on the matter is still authorized by the services as the person's own action.
 */
export function ownTrainingMatter(
  services: Pick<Services, "matters">,
  repo: Pick<Repository, "getMatter">,
  principal: Principal,
): MatterSummary | undefined {
  return services.matters
    .list(principal)
    .find(
      (matter) =>
        matter.training === T01.key && repo.getMatter(matter.id)?.createdBy === principal.userId,
    );
}
