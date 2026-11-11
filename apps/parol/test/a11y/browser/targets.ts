import type { Ids, RoleName } from "./world.js";

/**
 * Every page a person of each role can be shown, or is refused with, in the world of `world.ts`.
 * A refusal page is a page: it is audited like any other, and its status is part of the target.
 * The list follows the role tables (a matter page is shown to its three roles and is "not found"
 * to everyone else; the pages that name no matter go by global role), and `expect` is checked, so
 * a page that answers otherwise fails before anything is measured on it.
 */

export interface Target {
  role: RoleName;
  /** Words for a report: what the page is. */
  name: string;
  path: string;
  /** The status the page answers with. */
  expect: 200 | 403 | 404;
}

const page = (
  role: RoleName,
  name: string,
  path: string,
  expect: Target["expect"] = 200,
): Target => ({
  role,
  name,
  path,
  expect,
});

/** The pages of a matter, as someone with a part in it sees them. */
function matterPages(
  role: RoleName,
  label: string,
  ids: { matterId: string; runId?: string; findingId?: string },
): Target[] {
  const m = `/matters/${ids.matterId}`;
  const out = [page(role, `${label}: matter`, m), page(role, `${label}: memos`, `${m}/memos`)];
  if (ids.runId !== undefined) {
    out.push(page(role, `${label}: review`, `${m}/runs/${ids.runId}`));
    if (ids.findingId !== undefined) {
      out.push(
        page(
          role,
          `${label}: review with a finding open`,
          `${m}/runs/${ids.runId}?finding=${ids.findingId}`,
        ),
      );
      out.push(page(role, `${label}: finding`, `${m}/findings/${ids.findingId}`));
    }
  }
  return out;
}

export function targets(ids: Ids): Target[] {
  const L = ids.lanternfish;
  const X = ids.exported;
  const globals = (
    role: RoleName,
    who: "member" | "legal engineer" | "administrator",
  ): Target[] => {
    const lets = {
      evaluations: who !== "member",
      pilot: who !== "member",
      audit: who === "administrator",
      key: who !== "member",
    };
    const code = (ok: boolean): Target["expect"] => (ok ? 200 : 403);
    return [
      page(role, "evaluations", "/evaluations", code(lets.evaluations)),
      ...(lets.evaluations
        ? [page(role, "one comparison", `/evaluations?comparison=${ids.comparisonId}`)]
        : []),
      page(role, "pilot measures", "/pilot", code(lets.pilot)),
      page(role, "pilot measures, demonstration scope", "/pilot?scope=synthetic", code(lets.pilot)),
      page(role, "audit check", "/audit", code(lets.audit)),
      page(role, "trainer's key", "/training/key", code(lets.key)),
    ];
  };
  const everyone = (role: RoleName): Target[] => [
    page(role, "quickstart", "/quickstart"),
    page(role, "help", "/help"),
    page(role, "a page that does not exist", "/no-such-page", 404),
  ];
  const signedIn = (role: RoleName): Target[] => [
    page(role, "matters", "/matters"),
    page(role, "a matter that does not exist", "/matters/mat_0000000000000000", 404),
    ...everyone(role),
  ];

  return [
    // A visitor: the sign-in page is the answer to every page that needs a person.
    page("visitor", "sign-in", "/"),
    ...everyone("visitor"),

    // The associate and the reviewing attorney see the same pages, each in the shape of their role.
    ...(["associate", "reviewer"] as const).flatMap((role) => [
      ...signedIn(role),
      ...matterPages(role, "demo matter, reviewed", L),
      ...matterPages(role, "demonstration matter, decided and exported", X),
      ...matterPages(role, "baseline matter", ids.baseline),
      ...matterPages(role, "training matter", ids.training),
      ...matterPages(role, "matter with nothing in it", ids.empty),
      page(role, "another person's matter", `/matters/${ids.other.matterId}`, 404),
      ...globals(role, "member"),
    ]),

    // The viewer: reads, cannot decide. Not on the baseline or training matter.
    ...signedIn("viewer"),
    ...matterPages("viewer", "demo matter, reviewed", L),
    ...matterPages("viewer", "demonstration matter, decided and exported", X),
    ...matterPages("viewer", "matter with nothing in it", ids.empty),
    page("viewer", "a matter the viewer is not on", `/matters/${ids.baseline.matterId}`, 404),
    ...globals("viewer", "member"),

    // The legal engineer: owner of one matter, the trainer (a viewer) of the training matter.
    ...signedIn("legal engineer"),
    ...matterPages("legal engineer", "own matter", ids.other),
    ...matterPages("legal engineer", "training matter, as its trainer", ids.training),
    page("legal engineer", "a matter the engineer is not on", `/matters/${L.matterId}`, 404),
    ...globals("legal engineer", "legal engineer"),

    // The administrator: no matter of their own; the pages that need the role.
    ...signedIn("administrator"),
    page("administrator", "a matter the administrator is not on", `/matters/${L.matterId}`, 404),
    ...globals("administrator", "administrator"),
  ];
}
