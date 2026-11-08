import { describe, expect, it } from "vitest";
import { urls } from "../../src/server/urls.js";
import { checkInvariants } from "./invariants.js";
import { attr, byId, byTag, first, formsTo, readable, section, withClass } from "./html.js";
import { matterPage } from "./render.js";
import {
  IDS,
  buildMatterSummary,
  buildMatterView,
  buildRunSummary,
  buildStaleMatterView,
} from "./support.js";

const page = (view = buildMatterView()) => checkInvariants(matterPage(view));

describe("the form that runs a review again", () => {
  it("says the findings are replaced and the decisions made on them stop counting", () => {
    const text = readable(byId(page(), "start-replaces")!);
    expect(text).toContain("replaces the findings");
    expect(text).toContain("Decisions already made on them stop counting");
    expect(text).toContain("decided again");
    // The memo is not mentioned until there is one.
    expect(text).not.toContain("exported stays on record");
  });

  it("says the exported memo stays on record when there is one", () => {
    const root = page(buildMatterView({ matter: buildMatterSummary({ status: "exported" }) }));
    expect(readable(byId(root, "start-replaces")!)).toContain(
      "The memo already exported stays on record as the memo of the earlier review.",
    );
  });

  it("is said for a review being decided, too", () => {
    const root = page(
      buildMatterView({ matter: buildMatterSummary({ status: "review_complete" }) }),
    );
    expect(byId(root, "start-replaces")).toBeDefined();
  });

  it("is not said when there is nothing to replace", () => {
    const fresh = page(
      buildMatterView({
        matter: buildMatterSummary({ status: "ready" }),
        currentRun: null,
        runs: [],
      }),
    );
    expect(byId(fresh, "start-replaces")).toBeUndefined();
    // The banner of a matter that is already out of date has said it.
    expect(byId(page(buildStaleMatterView()), "start-replaces")).toBeUndefined();
    // And the form still posts where it did.
    expect(formsTo(page(), urls.runs(IDS.matter))).toHaveLength(1);
  });
});

describe("the banner of a matter whose first review was stopped by a change", () => {
  const view = (): ReturnType<typeof buildStaleMatterView> => {
    const stopped = buildRunSummary({ status: "superseded", current: false, findingCount: 0 });
    return {
      ...buildStaleMatterView(),
      staleReason: "The stated date of a document changed while the review was running.",
      runs: [stopped],
    };
  };

  it("does not talk about decisions that were never made", () => {
    const banner = withClass(page(view()), "banner-stale")[0]!;
    expect(readable(banner)).toContain("changed while the review was running");
    expect(readable(banner)).not.toContain("Earlier decisions no longer apply");
    expect(readable(banner)).toContain("no decisions to lose");
    // The re-run button is still there.
    expect(
      attr(
        first(banner, (el) => el.name === "form"),
        "action",
      ),
    ).toBe(urls.runs(IDS.matter));
    expect(byTag(section(page(view()), "start"), "form")).toHaveLength(1);
  });

  it("keeps saying so when there were decisions", () => {
    const banner = withClass(page(buildStaleMatterView()), "banner-stale")[0]!;
    expect(readable(banner)).toContain("Earlier decisions no longer apply");
  });
});
