import { afterAll, describe, expect, it, vi } from "vitest";
import { FIELDS } from "../../src/server/pages/forms.js";
import { REFUSAL_PHRASES, REFUSAL_TODO } from "../../src/server/routes/notices.js";
import { urls } from "../../src/server/urls.js";
import { expectAccessible } from "../a11y/rules.js";
import { all, attr, parseHtml, readable, withClass } from "../pages/html.js";
import { simulatedModel, trainingMatterIds } from "../training/support.js";
import { IDS, cleanup, fingerprint, makeSite } from "./support.js";

/**
 * An installation whose training documents are missing. The folder the application reads them from
 * is replaced by one that does not exist, for this file only. The person is told in words, with the
 * status of a conflict, that the operator has to look at it; nothing is made, and no path is named.
 */

const MISSING = "/nonexistent-parol-training-folder";

vi.mock("../../src/training/files.js", async (original) => ({
  ...(await original<typeof import("../../src/training/files.js")>()),
  DEFAULT_TRAINING_DIR: "/nonexistent-parol-training-folder",
}));

afterAll(cleanup);

describe("POST /training without the training documents", () => {
  it("is answered 409 with the sentence for whoever runs the server, names no path, and makes nothing", async () => {
    const site = makeSite({ model2: simulatedModel() });
    const who = await site.as(IDS.associate);
    const before = fingerprint(site);
    const response = await who.send("POST", urls.training(), {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        [FIELDS.reviewerUserId]: IDS.reviewer,
        _csrf: await who.apiToken(),
      }).toString(),
    });
    expect(response.status).toBe(409);
    const html = await response.text();
    expectAccessible(html);
    const alerts = all(parseHtml(html), (el) => attr(el, "role") === "alert");
    expect(alerts).toHaveLength(1);
    expect(readable(alerts[0]!)).toBe(`Problem ${REFUSAL_PHRASES["training_files_missing"]}`);
    expect(withClass(alerts[0]!, "todo").map((el) => readable(el))).toEqual([
      REFUSAL_TODO["training_files_missing"],
    ]);
    expect(html).not.toContain(MISSING);
    expect(trainingMatterIds(site.w.repo)).toEqual([]);
    expect(fingerprint(site)).toEqual(before);
    // The log carries the template of the route and no path of ours.
    expect(site.logs.join("\n")).not.toContain(MISSING);
  });
});
