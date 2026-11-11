import type { MatterRole } from "../../src/contracts.js";
import { roleAllows } from "../../src/auth/actions.js";
import { NewMatterForm, render } from "../../src/server/pages/index.js";
import { RetentionSection } from "../../src/server/pages/retention.js";
import type { RetentionView } from "../../src/services/views.js";
import { matterPage, mattersPage } from "./render.js";
import {
  IDS,
  buildChrome,
  buildMatterSummary,
  buildMatterViewFor,
  buildPlaybooks,
  buildUsers,
} from "./support.js";

/**
 * Fixtures of the retention section and the retention chip (package W2.7, slice B): a view the
 * matter service could have made, in each state that changes what the section shows. Everything
 * here is synthetic. `test/pages/support.ts` is not edited by this package, so the matter page is
 * built here from its builders with the two optional fields set.
 */

/** A retention date 30 days on, not yet passed, with the store's default and ceiling. */
export function buildRetention(overrides: Partial<RetentionView> = {}): RetentionView {
  return {
    retainUntil: "2026-12-03T09:00:00.000Z",
    daysLeft: 30,
    pastDate: false,
    defaultDays: 30,
    maxDays: 90,
    ...overrides,
  };
}

/** A date that has passed: nothing is left, and the sentence changes. */
export const PAST: RetentionView = buildRetention({
  retainUntil: "2026-11-03T12:00:00.000Z",
  daysLeft: 0,
  pastDate: true,
});

/**
 * The matter page for a role, with its retention view (none for `null`: a view the service did not
 * fill) and the chip of its summary matching it.
 */
export function retentionMatterPage(
  role: MatterRole,
  retention: RetentionView | null = buildRetention(),
): string {
  return matterPage(
    buildMatterViewFor(role, {
      matter: buildMatterSummary({
        role,
        ...(retention === null ? {} : { pastRetention: retention.pastDate }),
      }),
      ...(retention === null ? {} : { retention }),
    }),
    { canDelete: role === "associate" },
  );
}

/** The section alone, as a pane (no frame), for the rules that audit a pane. Empty when it renders nothing. */
export function retentionPane(
  role: MatterRole,
  retention: RetentionView | undefined = buildRetention(),
): string {
  const pane = RetentionSection({
    chrome: buildChrome(),
    matterId: IDS.matter,
    retention,
    canUpdate: roleAllows(role, "matter.update"),
  });
  return pane === null ? "" : render(pane);
}

/** The new-matter form alone, as a pane. */
export const newMatterPane = (): string =>
  render(
    NewMatterForm({ chrome: buildChrome(), playbooks: buildPlaybooks(), users: buildUsers() }),
  );

/** The list of matters with one past its date and one not, as the service would mark them. */
export const retentionListPage = (): string =>
  mattersPage([
    buildMatterSummary({ pastRetention: true, retainUntil: "2026-11-03T12:00:00.000Z" }),
    buildMatterSummary({
      id: "m_two",
      name: "Second matter",
      pastRetention: false,
      retainUntil: "2026-12-03T09:00:00.000Z",
    }),
  ]);
